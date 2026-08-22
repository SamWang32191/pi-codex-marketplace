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
import type { BridgeState } from '../bridge-state/types.js';
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
  resolveGitRevision,
  type GitExecutor,
} from '../registration/git-acquisition.js';
import { SourceCache } from '../cache/source-cache.js';
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
  /** Injected Source Cache (defaults to a cache under the given agentDir). */
  cache?: SourceCache;
}

/**
 * A newly validated source state for one Registration that differs from its recorded
 * Validation Snapshot. Applied only by a separate Lifecycle Operation (Apply Update /
 * Registration Rebind) under a complete Update Plan.
 */
export interface UpdateCandidate {
  scope: Scope;
  registrationId: string;
  /** State Revision observed while this candidate was validated; plans bind exactly this. */
  stateRevision: string;
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

/** Marketplace name embedded in an inspection Marketplace ID ('<registrationId>/<name>'). */
export function marketplaceNameOf(registrationId: string, marketplaceId: string | undefined): string {
  return marketplaceId && marketplaceId.startsWith(`${registrationId}/`)
    ? marketplaceId.slice(registrationId.length + 1)
    : '';
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
    const name = marketplaceNameOf(registration.id, inspection.marketplaceId) || registration.marketplaceName || '';
    const candidate: UpdateCandidate = {
      scope,
      registrationId: registration.id,
      stateRevision: revision,
      recordedFingerprint: registration.validationSnapshot,
      recordedResolvedRevision: registration.resolvedRevision,
      snapshot: snap.snapshot,
      marketplaceName: name,
      catalog: { name, entries: inspection.entries.map((item) => item.entry) },
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

/** Reconstruct the full Source Key for a Registration at an exact Resolved Revision. */
function sourceKeyAt(registration: Registration, resolvedRevision: string): SourceKey {
  return { ...registration.sourceKey!, resolvedRevision };
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
  const locator = locRes.locator!;
  const selector = selRes.selector!;
  const cache = opts.cache ?? new SourceCache({ agentDir: opts.agentDir });

  const noChangeReceipt = () =>
    createReceipt({
      operation: OPERATION,
      scope,
      trigger: `refresh ${registration.id}`,
      expectedStateRevision: revision,
      validationSnapshot: registration.validationSnapshot,
      summary: 'Completed',
      findings: [],
      stateChanged: false,
    });

  // Cheap resolution first — a hit path never needs a clone.
  const resolution = await resolveGitRevision(locator, selector, scope, { executor: opts.executor });

  if (!resolution.ok) {
    // Offline / unreachable remote: only an exact fingerprint hit may be reused. The cached
    // tree is re-hashed and must equal the recorded Validation Snapshot exactly — any mismatch
    // is Source Drift (Blocking Finding); a Stale Snapshot is never converted into success.
    const offline = registration.validationSnapshot
      ? await cache.offlineHit(locator.canonicalUrl, selector.canonical, registration.validationSnapshot)
      : null;
    if (offline) {
      const verified = buildGitSnapshot(offline.path, sourceKeyAt(registration, registration.resolvedRevision!), scope, {
        canonicalLocator: locator.canonicalUrl,
        resolvedRevision: registration.resolvedRevision!,
        selectorCanonical: selector.canonical,
      });
      if (verified.ok && verified.snapshot!.fingerprint === registration.validationSnapshot) {
        return { status: 'no-change', receipt: noChangeReceipt() };
      }
      return blocked(scope, registration.id, revision, [
        finding(scope, CODE.SOURCE_DRIFT, RULE.SOURCE_DRIFT, 'registration', '', `Source Drift: cached tree at fingerprint ${String(registration.validationSnapshot).slice(0, 16)}… no longer hashes to the recorded Validation Snapshot; Marketplace Refresh against a reachable source is required`),
      ], registration.validationSnapshot);
    }
    return blocked(scope, registration.id, revision, resolution.findings, registration.validationSnapshot);
  }

  const resolvedRevision = resolution.sha;

  if (resolvedRevision === registration.resolvedRevision && registration.validationSnapshot) {
    // Same Resolved Revision: exact-fingerprint cache hit avoids a full acquisition.
    const hit = await cache.hitExact(registration.validationSnapshot);
    if (hit) {
      const verified = buildGitSnapshot(hit.path, sourceKeyAt(registration, resolvedRevision), scope, {
        canonicalLocator: locator.canonicalUrl,
        resolvedRevision,
        selectorCanonical: selector.canonical,
      });
      if (verified.ok && verified.snapshot!.fingerprint === registration.validationSnapshot) {
        return { status: 'no-change', receipt: noChangeReceipt() };
      }
      // Tampered/evicted-in-place entry: fall through to full acquisition below.
    }
  }

  // Full non-executing acquisition (clone).
  const acq = await acquireGitSource({
    scope,
    locator,
    selector,
    executor: opts.executor,
  });
  if (!acq.ok) return blocked(scope, registration.id, revision, acq.findings, registration.validationSnapshot);

  try {
    const resolvedRevision = acq.resolvedRevision!;
    const root = acq.acquiredPath!;
    if (resolvedRevision === registration.resolvedRevision) {
      // Cache the re-validated tree under its recorded fingerprint for future exact hits.
      if (registration.validationSnapshot) {
        await cache.storeTree(root, registration.validationSnapshot);
        cache.recordIndex({
          fingerprint: registration.validationSnapshot,
          resolvedRevision,
          canonicalLocator: locator.canonicalUrl,
          selectorCanonical: selector.canonical,
        });
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

    // Resolved Revision changed ⇒ new validation is mandatory before any confirmation.
    const newSourceKey: SourceKey = { ...registration.sourceKey, resolvedRevision };
    const snap = buildGitSnapshot(root, newSourceKey, scope, {
      canonicalLocator: locator.canonicalUrl,
      resolvedRevision,
      selectorCanonical: selector.canonical,
    });
    if (!snap.ok || !snap.snapshot) {
      return blocked(scope, registration.id, revision, snap.findings, registration.validationSnapshot);
    }
    const inspection = inspectMarketplaceEntries(registration, scope, {
      root,
      baseSnapshot: snap.snapshot,
      ignoreRecordedDrift: true,
    });
    const name = marketplaceNameOf(registration.id, inspection.marketplaceId) || registration.marketplaceName || '';
    const candidate: UpdateCandidate = {
      scope,
      registrationId: registration.id,
      stateRevision: revision,
      recordedFingerprint: registration.validationSnapshot,
      recordedResolvedRevision: registration.resolvedRevision,
      snapshot: snap.snapshot,
      marketplaceName: name,
      catalog: { name, entries: inspection.entries.map((item) => item.entry) },
      inspection,
      sourceKey: newSourceKey,
      canonicalLocator: locator.canonicalUrl,
      resolvedRevision,
      selectorCanonical: selector.canonical,
    };
    // Persist the candidate tree in the cache and pin its fingerprint as a pending Update
    // Candidate — pinned entries are never evicted by LRU pruning.
    await cache.storeTree(root, snap.snapshot!.fingerprint);
    cache.recordIndex({
      fingerprint: snap.snapshot!.fingerprint,
      resolvedRevision,
      canonicalLocator: locator.canonicalUrl,
      selectorCanonical: selector.canonical,
    });
    cache.recordPendingUpdate({ scope, registrationId: registration.id, fingerprint: snap.snapshot!.fingerprint });
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
