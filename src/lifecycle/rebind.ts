/**
 * Registration Rebind — explicit replacement of a Marketplace Registration's source locator or
 * Git Selector under the preserved Registration ID.
 * See CONTEXT.md: Registration Rebind, Update Plan, Apply Update, Source Key.
 *
 * The rebind preflight is a non-mutating validation of the REPLACEMENT source: fresh validation,
 * a fresh Registration Confirmation and a complete Update Plan are required before the atomic
 * commit performed by `applyUpdate` (plan kind `rebind`). Prior activation consent never carries
 * over. Duplicate detection runs against every OTHER Registration in the scope.
 */

import { readBridgeState } from '../bridge-state/store.js';
import type { Registration, Scope } from '../bridge-state/types.js';
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
import { selectorInputFromStored } from './refresh.js';
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

function blocked(scope: Scope, trigger: string, revision: string, findings: ValidationFinding[]): RebindPreflightResult {
  return {
    ok: false,
    outcome: {
      status: 'blocked',
      findings: sortFindings(findings),
      receipt: createReceipt({
        operation: OPERATION,
        scope,
        trigger,
        expectedStateRevision: revision,
        summary: 'Blocked',
        findings,
      }),
    },
  };
}

/** Inspection only reads the Registration's identity when an explicit root + snapshot are given. */
function identityProbe(registrationId: string): Registration {
  return { id: registrationId } as Registration;
}

function marketplaceNameOf(registrationId: string, marketplaceId: string | undefined): string {
  return marketplaceId && marketplaceId.startsWith(`${registrationId}/`)
    ? marketplaceId.slice(registrationId.length + 1)
    : '';
}

/**
 * Validate a replacement Marketplace Source for one existing Registration. Non-mutating: no fence,
 * no writes; consent and atomic application happen through the Update Plan and `applyUpdate`.
 */
export async function preflightRebind(
  scope: Scope,
  registrationId: string,
  target: RebindTarget,
  opts: LifecycleFlowOptions = {},
): Promise<RebindPreflightResult> {
  const read = await readBridgeState(scope, { cwd: opts.cwd, agentDir: opts.agentDir });
  if (read.status !== 'ok' && read.status !== 'missing') {
    const findings: ValidationFinding[] = [
      blocking({
        code: CODE.PERSISTENCE_INDETERMINATE,
        rule: 'PERSIST-01',
        target: 'attempt',
        pointer: '',
        outcome: read.error ?? 'Bridge State is not readable; neither previous nor target verifiable',
        scope,
        phase: 'persistence',
      }),
    ];
    return {
      ok: false,
      outcome: {
        status: 'persistence-failed',
        findings,
        receipt: createReceipt({ operation: OPERATION, scope, trigger: `rebind ${registrationId}`, expectedStateRevision: '?', summary: 'Persistence Indeterminate', findings }),
        isIndeterminate: true,
      },
    };
  }
  const state = read.state!;
  const revision = state.stateRevision;
  const registration = state.registrations.find((item) => item.id === registrationId);
  if (!registration) {
    return blocked(scope, `rebind ${registrationId}`, revision, [
      blocking({ code: CODE.REGISTRATION_NOT_FOUND, rule: RULE.REGISTRATION_NOT_FOUND, target: 'registration', pointer: '', outcome: `Registration '${registrationId}' is not in ${scope} Bridge State`, scope, phase: 'admission' }),
    ]);
  }

  // Duplicate detection runs against every OTHER Registration — the rebound one keeps its identity.
  const others = state.registrations.filter((item) => item.id !== registrationId);
  if (target.kind === 'local') {
    return rebindToLocal(scope, registrationId, target.rootPath, others, revision);
  }
  return rebindToGit(scope, registrationId, target.locator, target.selector, others, revision, opts);
}

function rebindToLocal(
  scope: Scope,
  registrationId: string,
  rootPath: string,
  others: Registration[],
  revision: string,
): RebindPreflightResult {
  const trigger = `rebind ${registrationId}`;
  const keyRes = sourceKeyForLocalRoot(rootPath, scope);
  if (!keyRes.ok) return blocked(scope, trigger, revision, keyRes.findings);
  const sourceKey = keyRes.sourceKey!;

  const dup = findDuplicateRegistration(scope, sourceKey, others);
  if (dup.duplicate) return blocked(scope, trigger, revision, [dup.finding!]);

  const snap = buildLocalSnapshot(sourceKey.canonicalPath!, sourceKey, scope);
  if (!snap.ok || !snap.snapshot) return blocked(scope, trigger, revision, snap.findings);

  const inspection = inspectMarketplaceEntries(identityProbe(registrationId), scope, {
    root: sourceKey.canonicalPath!,
    baseSnapshot: snap.snapshot,
    ignoreRecordedDrift: true,
  });
  const name = marketplaceNameOf(registrationId, inspection.marketplaceId);
  if (!inspection.marketplaceId || inspection.findings.some((f) => f.classification === 'blocking')) {
    return blocked(scope, trigger, revision, inspection.findings.length > 0 ? inspection.findings : [
      blocking({ code: CODE.CATALOG_MISSING, rule: RULE.CATALOG_MISSING, target: 'catalog', pointer: '', outcome: 'replacement source has no readable Marketplace Catalog', scope, phase: 'validation' }),
    ]);
  }

  const candidate: UpdateCandidate = {
    scope,
    registrationId,
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
  scope: Scope,
  registrationId: string,
  locatorInput: string,
  selectorInput: GitSelectorInput | string,
  others: Registration[],
  revision: string,
  opts: LifecycleFlowOptions,
): Promise<RebindPreflightResult> {
  const trigger = `rebind ${registrationId}`;
  const locRes = normalizeGitLocator(locatorInput, scope);
  if (!locRes.ok) return blocked(scope, trigger, revision, locRes.findings);

  let selRes;
  if (typeof selectorInput === 'string') {
    selRes = await import('../registration/git-selector.js').then((m) => m.parseGitSelectorString(selectorInput, scope));
  } else {
    selRes = normalizeGitSelector(selectorInput as StoredSelectorInput, scope);
  }
  if (!selRes.ok) return blocked(scope, trigger, revision, selRes.findings);
  const selector = selRes.selector!;

  const sourceKey = gitSourceKey(locRes.locator!, selector);

  const dup = findDuplicateRegistration(scope, sourceKey, others);
  if (dup.duplicate) return blocked(scope, trigger, revision, [dup.finding!]);

  const acq = await acquireGitSource({
    scope,
    locator: locRes.locator!,
    selector,
    executor: opts.executor,
  });
  if (!acq.ok) return blocked(scope, trigger, revision, acq.findings);

  try {
    const resolvedRevision = acq.resolvedRevision!;
    const boundKey: SourceKey = {
      ...sourceKey,
      resolvedRevision,
      canonicalUrl: locRes.locator!.canonicalUrl,
      selector: selector.canonical,
    };
    const snap = buildGitSnapshot(acq.acquiredPath!, boundKey, scope, {
      canonicalLocator: locRes.locator!.canonicalUrl,
      resolvedRevision,
      selectorCanonical: selector.canonical,
    });
    if (!snap.ok || !snap.snapshot) return blocked(scope, trigger, revision, snap.findings);

    const inspection = inspectMarketplaceEntries(identityProbe(registrationId), scope, {
      root: acq.acquiredPath!,
      baseSnapshot: snap.snapshot,
      ignoreRecordedDrift: true,
    });
    const name = marketplaceNameOf(registrationId, inspection.marketplaceId);
    if (!inspection.marketplaceId || inspection.findings.some((f) => f.classification === 'blocking')) {
      return blocked(scope, trigger, revision, inspection.findings);
    }

    const candidate: UpdateCandidate = {
      scope,
      registrationId,
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
