/**
 * Lifecycle module — Refresh / Update Candidate / Apply Update / Rebind / Removal.
 * See CONTEXT.md: Marketplace Refresh, Update Candidate, Update Plan, Apply Update,
 * Registration Rebind, Registration Removal, Installation Removal, Lifecycle Operation.
 *
 * Marketplace Refresh is a non-mutating inspection: it never writes Bridge State and never
 * acquires the Attempt Fence (checks and Refresh stay available while mutations are barred).
 * It produces either no change or an Update Candidate applied only by a separate
 * Lifecycle Operation bound to a complete Update Plan.
 */

import { readBridgeState } from '../bridge-state/store.js';
import type { Registration, Scope } from '../bridge-state/types.js';
import type { MarketplaceInspection } from '../installation/inspection.js';
import { inspectMarketplaceEntries } from '../installation/inspection.js';
import type { Catalog } from '../registration/catalog.js';
import {
  CODE,
  RULE,
  blocking,
  sortFindings,
  type ValidationFinding,
} from '../registration/findings.js';
import {
  acquireGitSource,
  cleanupAcquisition,
  type GitExecutor,
} from '../registration/git-acquisition.js';
import { normalizeGitLocator } from '../registration/git-locator.js';
import {
  normalizeGitSelector,
  type GitSelectorInput,
} from '../registration/git-selector.js';
import { createReceipt, type AttemptReceipt } from '../registration/receipt.js';
import {
  buildGitSnapshot,
  buildLocalSnapshot,
  type ValidationSnapshot,
} from '../registration/snapshot.js';
import type { SourceKey } from '../registration/source-key.js';

export interface LifecycleFlowOptions {
  cwd?: string;
  agentDir?: string;
  /** Host-owned Project Trust decision; refresh is non-mutating so it stays readable without it. */
  projectTrusted?: boolean;
  fenceTimeoutMs?: number;
  /** Injected git executor for tests. */
  executor?: GitExecutor;
}

/**
 * A newly validated source state for one Registration that differs from its recorded
 * Validation Snapshot. Applied only by a separate Lifecycle Operation (Apply Update /
 * Registration Rebind) under a complete Update Plan.
 */
export interface UpdateCandidate {
  scope: Scope;
  registrationId: string;
  /** Recorded Validation Snapshot fingerprint before the refresh. */
  recordedFingerprint?: string;
  recordedResolvedRevision?: string;
  /** Newly validated snapshot with full tree + binds (base-tree fingerprint, as registered). */
  snapshot: ValidationSnapshot;
  marketplaceName: string;
  catalog: Catalog;
  inspection: MarketplaceInspection;
  sourceKey: SourceKey;
  /** Git-only binds of the candidate state. */
  canonicalLocator?: string;
  resolvedRevision?: string;
  selectorCanonical?: string;
}

export type RefreshOutcome =
  | { status: 'no-change'; receipt: AttemptReceipt }
  | { status: 'update-candidate'; candidate: UpdateCandidate; receipt: AttemptReceipt }
  | { status: 'blocked'; findings: ValidationFinding[]; receipt: AttemptReceipt };

const OPERATION = 'Marketplace Refresh';

function finding(scope: Scope, code: string, rule: string, target: ValidationFinding['target'], pointer: string, outcome: string): ValidationFinding {
  return blocking({ code, rule, target, pointer, outcome, scope, phase: 'validation' });
}

function blocked(scope: Scope, registrationId: string, revision: string, findings: ValidationFinding[], snapshot?: string): RefreshOutcome {
  return {
    status: 'blocked',
    findings: sortFindings(findings),
    receipt: createReceipt({
      operation: OPERATION,
      scope,
      trigger: `refresh ${registrationId}`,
      expectedStateRevision: revision,
      validationSnapshot: snapshot,
      summary: 'Blocked',
      findings,
    }),
  };
}

/** Reconstruct a selector input from a persisted canonical Git Selector. */
export function selectorInputFromStored(gs: NonNullable<Registration['gitSelector']>): GitSelectorInput {
  switch (gs.kind) {
    case 'default':
      return { kind: 'default' };
    case 'branch':
      return { kind: 'branch', value: gs.canonical.replace(/^refs\/heads\//, '') };
    case 'tag':
      return { kind: 'tag', value: gs.canonical.replace(/^refs\/tags\//, '') };
    case 'commit':
      return { kind: 'commit', value: gs.canonical };
  }
}

async function readStateForRefresh(scope: Scope, opts: LifecycleFlowOptions) {
  return readBridgeState(scope, { cwd: opts.cwd, agentDir: opts.agentDir });
}

/**
 * Explicit, non-mutating inspection of the current Marketplace Source for one Registration.
 * Local sources re-walk the live tree; Git sources re-resolve the selector — a changed
 * Resolved Revision requires new validation (a full-commit selector cannot move, so ref
 * movement alone never produces an Update Candidate). Bridge State is never written.
 */
export async function refreshRegistration(
  scope: Scope,
  registrationId: string,
  opts: LifecycleFlowOptions = {},
): Promise<RefreshOutcome> {
  const read = await readStateForRefresh(scope, opts);
  if (read.status !== 'ok' && read.status !== 'missing') {
    return blocked(
      scope,
      registrationId,
      '?',
      [finding(scope, CODE.PERSISTENCE_INDETERMINATE, 'PERSIST-01', 'attempt', '', read.error ?? 'Bridge State is not readable; neither previous nor target verifiable')],
    );
  }
  const state = read.state!;
  const revision = state.stateRevision;
  const registration = state.registrations.find((item) => item.id === registrationId);
  if (!registration) {
    return blocked(scope, registrationId, revision, [
      finding(scope, CODE.REGISTRATION_NOT_FOUND, RULE.REGISTRATION_NOT_FOUND, 'registration', '', `Registration '${registrationId}' is not in ${scope} Bridge State`),
    ]);
  }

  if (registration.sourceKind === 'git') {
    return refreshGitRegistration(scope, registration, revision, opts);
  }
  return refreshLocalRegistration(scope, registration, revision, opts);
}

function refreshLocalRegistration(
  scope: Scope,
  registration: Registration,
  revision: string,
  opts: LifecycleFlowOptions,
): RefreshOutcome {
  if (!registration.sourceKey || !registration.source) {
    return blocked(scope, registration.id, revision, [
      finding(scope, CODE.SOURCE_REACQUISITION_REQUIRED, RULE.SOURCE_REACQUISITION_REQUIRED, 'registration', '', 'Registration has no retained local Source Key to revalidate'),
    ], registration.validationSnapshot);
  }

  const snap = buildLocalSnapshot(registration.source, registration.sourceKey, scope);
  if (!snap.ok || !snap.snapshot) {
    return blocked(scope, registration.id, revision, snap.findings, registration.validationSnapshot);
  }

  if (!registration.validationSnapshot || snap.snapshot.fingerprint !== registration.validationSnapshot) {
    const inspection = inspectMarketplaceEntries(registration, scope, { ignoreRecordedDrift: true });
    const candidate: UpdateCandidate = {
      scope,
      registrationId: registration.id,
      recordedFingerprint: registration.validationSnapshot,
      recordedResolvedRevision: registration.resolvedRevision,
      snapshot: snap.snapshot,
      marketplaceName: inspection.marketplaceId ? inspection.marketplaceId.slice(registration.id.length + 1) : registration.marketplaceName ?? '',
      catalog: { name: inspection.marketplaceId ? inspection.marketplaceId.slice(registration.id.length + 1) : registration.marketplaceName ?? '', entries: inspection.entries.map((item) => item.entry) },
      inspection,
      sourceKey: registration.sourceKey,
    };
    return {
      status: 'update-candidate',
      candidate,
      receipt: createReceipt({
        operation: OPERATION,
        scope,
        trigger: `refresh ${registration.id}`,
        expectedStateRevision: revision,
        validationSnapshot: snap.snapshot.fingerprint,
        summary: 'Completed',
        findings: inspection.findings,
        stateChanged: false,
      }),
    };
  }

  return {
    status: 'no-change',
    receipt: createReceipt({
      operation: OPERATION,
      scope,
      trigger: `refresh ${registration.id}`,
      expectedStateRevision: revision,
      validationSnapshot: registration.validationSnapshot,
      summary: 'Completed',
      stateChanged: false,
    }),
  };
}

async function refreshGitRegistration(
  scope: Scope,
  registration: Registration,
  revision: string,
  opts: LifecycleFlowOptions,
): Promise<RefreshOutcome> {
  if (!registration.canonicalLocator || !registration.gitSelector || !registration.sourceKey) {
    return blocked(scope, registration.id, revision, [
      finding(scope, CODE.SOURCE_REACQUISITION_REQUIRED, RULE.SOURCE_REACQUISITION_REQUIRED, 'registration', '', 'Registration has no retained Canonical Git Locator / Git Selector to revalidate'),
    ], registration.validationSnapshot);
  }

  const locRes = normalizeGitLocator(registration.canonicalLocator, scope);
  if (!locRes.ok) return blocked(scope, registration.id, revision, locRes.findings, registration.validationSnapshot);
  const selRes = normalizeGitSelector(selectorInputFromStored(registration.gitSelector), scope);
  if (!selRes.ok) return blocked(scope, registration.id, revision, selRes.findings, registration.validationSnapshot);

  // Re-resolve the selector through non-executing acquisition. A full-commit selector resolves
  // to its immutable object, so ref movement alone never reaches this path's candidate branch.
  const acq = await acquireGitSource({
    scope,
    locator: locRes.locator!,
    selector: selRes.selector!,
    executor: opts.executor,
  });
  if (!acq.ok) return blocked(scope, registration.id, revision, acq.findings, registration.validationSnapshot);

  try {
    const resolvedRevision = acq.resolvedRevision!;
    const root = acq.acquiredPath!;
    if (resolvedRevision === registration.resolvedRevision) {
      return {
        status: 'no-change',
        receipt: createReceipt({
          operation: OPERATION,
          scope,
          trigger: `refresh ${registration.id}`,
          expectedStateRevision: revision,
          validationSnapshot: registration.validationSnapshot,
          summary: 'Completed',
          stateChanged: false,
        }),
      };
    }

    // Resolved Revision changed ⇒ new validation is mandatory before any confirmation.
    const newSourceKey: SourceKey = { ...registration.sourceKey, resolvedRevision };
    const snap = buildGitSnapshot(root, newSourceKey, scope, {
      canonicalLocator: locRes.locator!.canonicalUrl,
      resolvedRevision,
      selectorCanonical: selRes.selector!.canonical,
    });
    if (!snap.ok || !snap.snapshot) {
      return blocked(scope, registration.id, revision, snap.findings, registration.validationSnapshot);
    }
    const inspection = inspectMarketplaceEntries(registration, scope, {
      root,
      baseSnapshot: snap.snapshot,
      ignoreRecordedDrift: true,
    });
    const name = inspection.marketplaceId ? inspection.marketplaceId.slice(registration.id.length + 1) : registration.marketplaceName ?? '';
    const candidate: UpdateCandidate = {
      scope,
      registrationId: registration.id,
      recordedFingerprint: registration.validationSnapshot,
      recordedResolvedRevision: registration.resolvedRevision,
      snapshot: snap.snapshot,
      marketplaceName: name,
      catalog: { name, entries: inspection.entries.map((item) => item.entry) },
      inspection,
      sourceKey: newSourceKey,
      canonicalLocator: locRes.locator!.canonicalUrl,
      resolvedRevision,
      selectorCanonical: selRes.selector!.canonical,
    };
    return {
      status: 'update-candidate',
      candidate,
      receipt: createReceipt({
        operation: OPERATION,
        scope,
        trigger: `refresh ${registration.id}`,
        expectedStateRevision: revision,
        validationSnapshot: snap.snapshot.fingerprint,
        summary: 'Completed',
        findings: inspection.findings,
        stateChanged: false,
      }),
    };
  } finally {
    cleanupAcquisition(acq.acquiredPath!);
  }
}
