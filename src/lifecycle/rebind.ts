/**
 * Registration Rebind — explicit replacement of a Marketplace Registration's source locator or
 * Git Selector under the preserved Registration ID.
 * See CONTEXT.md: Registration Rebind, Update Plan, Apply Update, Source Key.
 *
 * The rebind preflight is a non-mutating validation of the REPLACEMENT source: fresh validation,
 * a fresh Registration Confirmation and a complete Update Plan are required before the atomic
 * commit performed by `applyUpdate` (plan kind `rebind`). Prior activation consent never carries
 * over. Duplicate detection runs against every OTHER Registration.
 */

import { readBridgeState } from '../bridge-state/store.js';
import type { Registration } from '../bridge-state/types.js';
import { inspectMarketplaceEntries } from '../installation/inspection.js';
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
import { findDuplicateRegistration, sourceKeyForLocalRoot } from '../registration/registration.js';
import { buildGitSnapshot, buildLocalSnapshot } from '../registration/snapshot.js';
import { gitSourceKey, type SourceKey } from '../registration/source-key.js';
import type { GitSelectorInput as StoredSelectorInput } from '../registration/git-selector.js';
import type { LifecycleFlowOptions, UpdateCandidate } from './refresh.js';
import { marketplaceNameOf, selectorInputFromStored } from './refresh.js';
import type { RebindSourceAttributes } from './update-plan.js';

export type RebindTarget =
  | { kind: 'local'; rootPath: string }
  | { kind: 'git'; locator: string; selector: GitSelectorInput | string };

export interface RebindPreflightOk {
  candidate: UpdateCandidate;
  /** Observed State Revision the Update Plan must bind. */
  stateRevision: string;
  rebindSource: RebindSourceAttributes;
}

export type RebindPreflightResult =
  | { ok: true; preflight: RebindPreflightOk }
  | {
      ok: false;
      outcome:
        | { status: 'blocked'; findings: ValidationFinding[]; receipt: AttemptReceipt }
        | { status: 'persistence-failed'; findings: ValidationFinding[]; receipt: AttemptReceipt; isIndeterminate: boolean };
    };

const OPERATION = 'Registration Rebind';

function blocked(trigger: string, revision: string, findings: ValidationFinding[], validationSnapshot?: string): RebindPreflightResult {
  return {
    ok: false,
    outcome: {
      status: 'blocked',
      findings: sortFindings(findings),
      receipt: createReceipt({
        operation: OPERATION,
        trigger,
        expectedStateRevision: revision,
        validationSnapshot,
        summary: 'Blocked',
        findings,
      }),
    },
  };
}

/**
 * Inspection only reads the Registration's identity (id) when an explicit root + base snapshot
 * are given, so a minimal record suffices without any cast.
 */
function identityProbe(registrationId: string): Registration {
  return { id: registrationId };
}

/**
 * Validate a replacement Marketplace Source for one existing Registration. Non-mutating: no fence,
 * no writes; consent and atomic application happen through the Update Plan and `applyUpdate`.
 */
export async function preflightRebind(
  registrationId: string,
  target: RebindTarget,
  opts: LifecycleFlowOptions = {},
): Promise<RebindPreflightResult> {
  const read = await readBridgeState({ agentDir: opts.agentDir });
  if (read.status !== 'ok' && read.status !== 'missing') {
    const findings: ValidationFinding[] = [
      blocking({
        code: CODE.PERSISTENCE_INDETERMINATE,
        rule: 'PERSIST-01',
        target: 'attempt',
        pointer: '',
        outcome: read.error ?? 'Bridge State is not readable; neither previous nor target verifiable',
        phase: 'persistence',
      }),
    ];
    return {
      ok: false,
      outcome: {
        status: 'persistence-failed',
        findings,
        receipt: createReceipt({ operation: OPERATION, trigger: `rebind ${registrationId}`, expectedStateRevision: '?', summary: 'Persistence Indeterminate', findings }),
        isIndeterminate: true,
      },
    };
  }
  const state = read.state!;
  const revision = state.stateRevision;
  const registration = state.registrations.find((item) => item.id === registrationId);
  if (!registration) {
    return blocked(`rebind ${registrationId}`, revision, [
      blocking({ code: CODE.REGISTRATION_NOT_FOUND, rule: RULE.REGISTRATION_NOT_FOUND, target: 'registration', pointer: '', outcome: `Registration '${registrationId}' is not in Bridge State`, phase: 'admission' }),
    ]);
  }

  // Duplicate detection runs against every OTHER Registration — the rebound one keeps its identity.
  const others = state.registrations.filter((item) => item.id !== registrationId);
  if (target.kind === 'local') {
    return rebindToLocal(registrationId, target.rootPath, others, revision, registration.validationSnapshot);
  }
  return rebindToGit(registrationId, target.locator, target.selector, others, revision, registration.validationSnapshot, opts);
}

function rebindToLocal(
  registrationId: string,
  rootPath: string,
  others: Registration[],
  revision: string,
  recordedSnapshot?: string,
): RebindPreflightResult {
  const trigger = `rebind ${registrationId}`;
  const keyRes = sourceKeyForLocalRoot(rootPath);
  if (!keyRes.ok) return blocked(trigger, revision, keyRes.findings, recordedSnapshot);
  const sourceKey = keyRes.sourceKey!;

  const dup = findDuplicateRegistration(sourceKey, others);
  if (dup.duplicate) return blocked(trigger, revision, [dup.finding!], recordedSnapshot);

  const snap = buildLocalSnapshot(sourceKey.canonicalPath!, sourceKey);
  if (!snap.ok || !snap.snapshot) return blocked(trigger, revision, snap.findings, recordedSnapshot);

  const inspection = inspectMarketplaceEntries(identityProbe(registrationId), {
    root: sourceKey.canonicalPath!,
    baseSnapshot: snap.snapshot,
    ignoreRecordedDrift: true,
  });
  const name = marketplaceNameOf(registrationId, inspection.marketplaceId);
  if (!inspection.marketplaceId || inspection.findings.some((f) => f.classification === 'blocking')) {
    return blocked(trigger, revision, inspection.findings.length > 0 ? inspection.findings : [
      blocking({ code: CODE.CATALOG_MISSING, rule: RULE.CATALOG_MISSING, target: 'catalog', pointer: '', outcome: 'replacement source has no readable Marketplace Catalog', phase: 'validation' }),
    ], snap.snapshot.fingerprint);
  }

  const candidate: UpdateCandidate = {
    registrationId,
    stateRevision: revision,
    recordedFingerprint: undefined,
    snapshot: snap.snapshot,
    marketplaceName: name,
    catalog: { name, entries: inspection.entries.map((item) => item.entry) },
    inspection,
    sourceKey,
  };

  return {
    ok: true,
    preflight: {
      candidate,
      stateRevision: revision,
      rebindSource: { sourceKind: 'local', source: sourceKey.canonicalPath!, sourceKey },
    },
  };
}

async function rebindToGit(
  registrationId: string,
  locatorInput: string,
  selectorInput: GitSelectorInput | string,
  others: Registration[],
  revision: string,
  recordedSnapshot: string | undefined,
  opts: LifecycleFlowOptions,
): Promise<RebindPreflightResult> {
  const trigger = `rebind ${registrationId}`;
  const locRes = normalizeGitLocator(locatorInput);
  if (!locRes.ok) return blocked(trigger, revision, locRes.findings, recordedSnapshot);

  let selRes;
  if (typeof selectorInput === 'string') {
    selRes = await import('../registration/git-selector.js').then((m) => m.parseGitSelectorString(selectorInput));
  } else {
    selRes = normalizeGitSelector(selectorInput as StoredSelectorInput);
  }
  if (!selRes.ok) return blocked(trigger, revision, selRes.findings, recordedSnapshot);
  const selector = selRes.selector!;

  const sourceKey = gitSourceKey(locRes.locator!, selector);

  const dup = findDuplicateRegistration(sourceKey, others);
  if (dup.duplicate) return blocked(trigger, revision, [dup.finding!]);

  const acq = await acquireGitSource({
    locator: locRes.locator!,
    selector,
    executor: opts.executor,
  });
  if (!acq.ok) return blocked(trigger, revision, acq.findings, recordedSnapshot);

  try {
    const resolvedRevision = acq.resolvedRevision!;
    const boundKey: SourceKey = {
      ...sourceKey,
      resolvedRevision,
      canonicalUrl: locRes.locator!.canonicalUrl,
      selector: selector.canonical,
    };
    const snap = buildGitSnapshot(acq.acquiredPath!, boundKey, {
      canonicalLocator: locRes.locator!.canonicalUrl,
      resolvedRevision,
      selectorCanonical: selector.canonical,
    });
    if (!snap.ok || !snap.snapshot) return blocked(trigger, revision, snap.findings, recordedSnapshot);

    const inspection = inspectMarketplaceEntries(identityProbe(registrationId), {
      root: acq.acquiredPath!,
      baseSnapshot: snap.snapshot,
      ignoreRecordedDrift: true,
    });
    const name = marketplaceNameOf(registrationId, inspection.marketplaceId);
    if (!inspection.marketplaceId || inspection.findings.some((f) => f.classification === 'blocking')) {
      return blocked(trigger, revision, inspection.findings, snap.snapshot.fingerprint);
    }

    const candidate: UpdateCandidate = {
      registrationId,
      stateRevision: revision,
      recordedFingerprint: undefined,
      snapshot: snap.snapshot,
      marketplaceName: name,
      catalog: { name, entries: inspection.entries.map((item) => item.entry) },
      inspection,
      sourceKey: boundKey,
      canonicalLocator: locRes.locator!.canonicalUrl,
      resolvedRevision,
      selectorCanonical: selector.canonical,
    };

    return {
      ok: true,
      preflight: {
        candidate,
        stateRevision: revision,
        rebindSource: {
          sourceKind: 'git',
          source: locRes.locator!.canonicalUrl,
          sourceKey: boundKey,
          canonicalLocator: locRes.locator!.canonicalUrl,
          gitSelector: { kind: selector.kind, canonical: selector.canonical, raw: selector.raw },
          resolvedRevision,
        },
      },
    };
  } finally {
    cleanupAcquisition(acq.acquiredPath!);
  }
}

// Re-exported for callers reconstructing selectors from persisted state.
export { selectorInputFromStored };
