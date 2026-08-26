/**
 * Apply Update — the Lifecycle Operation that replaces one Registration's recorded Validation
 * Snapshot according to one complete Update Plan and atomically applies every disclosed
 * disclosed consequence.
 * See CONTEXT.md: Apply Update, Update Plan, Lifecycle Operation, Rejected as Stale, Attempt Fence.
 *
 * Guarantees:
 * - One single atomic commit: the new snapshot becomes authoritative together with every
 *   updated / disabled / removed Installation — never a partial application across revisions.
 * - The exact State Revision bound by the plan is re-verified under CAS; any movement rejects
 *   the attempt as stale without merging.
 * - For local sources the candidate fingerprint is re-verified against the live tree before the
 *   durable mutation (a mismatch is a Blocking Finding — Stale Snapshot never substitutes).
 */

import {
  acquireAttemptFence,
} from '../registration/fence.js';
import { CODE, RULE, blocking, sortFindings, type ValidationFinding } from '../registration/findings.js';
import { createReceipt, type AttemptReceipt } from '../registration/receipt.js';
import { buildGitSnapshot, buildLocalSnapshot } from '../registration/snapshot.js';
import { SourceCache } from '../cache/source-cache.js';
import { commitBridgeState, readBridgeState } from '../bridge-state/store.js';
import type { BridgeState } from '../bridge-state/types.js';
import type { LifecycleFlowOptions, UpdateCandidate } from './refresh.js';
import type { UpdatePlan } from './update-plan.js';

export type ApplyUpdateOptions = LifecycleFlowOptions;

export type ApplyUpdateOutcome =
  | { status: 'completed'; receipt: AttemptReceipt; newRevision: string }
  | { status: 'blocked'; findings: ValidationFinding[]; receipt: AttemptReceipt }
  | { status: 'rejected-as-stale'; receipt: AttemptReceipt }
  | { status: 'persistence-failed'; receipt: AttemptReceipt; isIndeterminate: boolean };

function operationFor(plan: UpdatePlan): string {
  return plan.kind === 'rebind' ? 'Registration Rebind' : 'Apply Update';
}

function finding(code: string, rule: string, target: ValidationFinding['target'], outcome: string): ValidationFinding {
  return blocking({ code, rule, target, pointer: '', outcome, phase: 'persistence' });
}

function blocked(plan: UpdatePlan, findings: ValidationFinding[], observedRevision?: string): ApplyUpdateOutcome {
  return {
    status: 'blocked',
    findings: sortFindings(findings),
    receipt: createReceipt({
      operation: operationFor(plan),
      trigger: `${plan.kind} ${plan.registrationId}`,
      expectedStateRevision: plan.stateRevision,
      observedStateRevision: observedRevision,
      validationSnapshot: plan.candidate.snapshot.fingerprint,
      summary: 'Blocked',
      findings,
    }),
  };
}

function stale(plan: UpdatePlan, outcomeText: string, observedRevision?: string): ApplyUpdateOutcome {
  return {
    status: 'rejected-as-stale',
    receipt: createReceipt({
      operation: operationFor(plan),
      trigger: `${plan.kind} ${plan.registrationId}`,
      expectedStateRevision: plan.stateRevision,
      observedStateRevision: observedRevision,
      validationSnapshot: plan.candidate.snapshot.fingerprint,
      summary: 'Rejected as Stale',
      findings: [finding(CODE.REJECTED_AS_STALE, RULE.REJECTED_AS_STALE, 'attempt', outcomeText)],
      stateChanged: false,
    }),
  };
}

/** Draft the whole disclosed consequence set in one state transform — committed once or not at all. */
function draftNextState(state: BridgeState, plan: UpdatePlan): BridgeState {
  const candidate: UpdateCandidate = plan.candidate;
  const registrations = state.registrations.map((registration) => {
    if (registration.id !== plan.registrationId) return registration;
    const next = {
      ...registration,
      marketplaceName: candidate.marketplaceName || registration.marketplaceName,
      validationSnapshot: candidate.snapshot.fingerprint,
      snapshotBinds: {
        profile: candidate.snapshot.profile,
        ruleset: candidate.snapshot.ruleset,
        budget: candidate.snapshot.budget,
      },
    };
    if (candidate.resolvedRevision) next.resolvedRevision = candidate.resolvedRevision;
    if (plan.rebindSource) {
      next.sourceKind = plan.rebindSource.sourceKind;
      next.source = plan.rebindSource.source;
      next.sourceKey = plan.rebindSource.sourceKey;
      next.canonicalLocator = plan.rebindSource.canonicalLocator;
      next.gitSelector = plan.rebindSource.gitSelector;
      next.resolvedRevision = plan.rebindSource.resolvedRevision;
    }
    return next;
  });

  let installations = [...state.installations];
  for (const entry of plan.entries) {
    if (entry.choice === 'remove') {
      installations = installations.filter((installation) => installation.id !== entry.installationId);
      continue;
    }
    installations = installations.map((installation) => {
      if (installation.id !== entry.installationId) return installation;
      if (entry.choice === 'disable') return { ...installation, installationState: 'disabled' as const };
      return {
        ...installation,
        installationState: entry.installationState,
        validationSnapshot: entry.newSnapshot!.fingerprint,
        snapshotBinds: {
          profile: entry.newSnapshot!.profile,
          ruleset: entry.newSnapshot!.ruleset,
          budget: entry.newSnapshot!.budget,
        },
        marketplaceEntryId: entry.newMarketplaceEntryId ?? installation.marketplaceEntryId,
        manifestName: entry.manifestName ?? installation.manifestName,
      };
    });
  }

  return { ...state, registrations, installations };
}

/**
 * Commit one complete Update Plan atomically. The plan must come from `buildUpdatePlan`; this
 * function performs no disclosure of its own — everything it will do was disclosed by the plan.
 */
export async function applyUpdate(plan: UpdatePlan, opts: ApplyUpdateOptions = {}): Promise<ApplyUpdateOutcome> {
  const read = await readBridgeState({ agentDir: opts.agentDir });
  if (read.status !== 'ok' && read.status !== 'missing') {
    const indeterminate = true;
    return {
      status: 'persistence-failed',
      isIndeterminate: indeterminate,
      receipt: createReceipt({
        operation: operationFor(plan),
        trigger: `${plan.kind} ${plan.registrationId}`,
        expectedStateRevision: plan.stateRevision,
        validationSnapshot: plan.candidate.snapshot.fingerprint,
        summary: 'Persistence Indeterminate',
        findings: [finding(CODE.PERSISTENCE_INDETERMINATE, 'PERSIST-01', 'attempt', read.error ?? 'Bridge State is not readable; neither previous nor target verifiable')],
        stateChanged: false,
      }),
    };
  }
  const state = read.state!;

  if (!state.registrations.some((registration) => registration.id === plan.registrationId)) {
    return blocked(plan, [
      blocking({
        code: CODE.REGISTRATION_NOT_FOUND,
        rule: RULE.REGISTRATION_NOT_FOUND,
        target: 'registration',
        pointer: '',
        outcome: `Registration '${plan.registrationId}' is no longer in Bridge State`,
        phase: 'admission',
      }),
    ], state.stateRevision);
  }

  if (state.stateRevision !== plan.stateRevision) {
    return stale(
      plan,
      `State Revision changed since the Update Plan was built (${plan.stateRevision} → ${state.stateRevision}); rebuild the plan after a fresh Marketplace Refresh`,
      state.stateRevision,
    );
  }

  // Fingerprint must still match before durable state mutation. Local sources are re-walked;
  // Git candidates are verified against the fingerprint-addressed Source Cache entry (#22).
  if (plan.candidate.snapshot.sourceKey.kind === 'local') {
    const revalidated = buildLocalSnapshot(plan.candidate.snapshot.sourceKey.canonicalPath!, plan.candidate.snapshot.sourceKey);
    if (!revalidated.ok || !revalidated.snapshot || revalidated.snapshot.fingerprint !== plan.candidate.snapshot.fingerprint) {
      return stale(
        plan,
        'Validation Snapshot fingerprint changed since the Update Candidate was produced (source drifted); run a fresh Marketplace Refresh and rebuild the plan',
      );
    }
  } else {
    // Git candidates verify against the fingerprint-addressed Source Cache (default-constructed
    // so pin hygiene and verification never depend on caller injection). Fail-closed: an absent
    // or mismatching cached tree rejects the attempt as stale — never an unverified apply.
    const cache = opts.cache ?? new SourceCache({ agentDir: opts.agentDir });
    const hit = await cache.hitExact(plan.candidate.snapshot.fingerprint);
    if (!hit) {
      return stale(
        plan,
        'No cached tree verifies the Update Candidate fingerprint (evicted or never retained); run a fresh Marketplace Refresh and rebuild the plan',
      );
    }
    const revalidated = buildGitSnapshot(hit.path, plan.candidate.snapshot.sourceKey, {
      canonicalLocator: plan.candidate.canonicalLocator ?? plan.candidate.snapshot.canonicalLocator ?? '',
      resolvedRevision: plan.candidate.resolvedRevision ?? plan.candidate.snapshot.resolvedRevision ?? '',
      selectorCanonical: plan.candidate.selectorCanonical ?? plan.candidate.snapshot.selectorCanonical ?? '',
    });
    if (!revalidated.ok || !revalidated.snapshot || revalidated.snapshot.fingerprint !== plan.candidate.snapshot.fingerprint) {
      return stale(
        plan,
        'Cached Git tree no longer hashes to the Update Candidate fingerprint (source drift); run a fresh Marketplace Refresh and rebuild the plan',
      );
    }
  }

  const fence = await acquireAttemptFence({
    agentDir: opts.agentDir,
    fenceTimeoutMs: opts.fenceTimeoutMs,
  });
  if (!fence.ok) return blocked(plan, [fence.finding!], plan.stateRevision);

  try {
    const write = await commitBridgeState(
      (current) => draftNextState(current, plan),
      { agentDir: opts.agentDir, lockTimeoutMs: opts.fenceTimeoutMs, expectedStateRevision: plan.stateRevision },
    );

    if (write.isStale) {
      return stale(
        plan,
        `State Revision changed under the Attempt Fence (${plan.stateRevision} → ${write.observedRevision ?? '?'}); rebuild the plan after a fresh Marketplace Refresh`,
        write.observedRevision,
      );
    }

    if (!write.success) {
      const summary = write.isIndeterminate ? 'Persistence Indeterminate' : 'Persistence Failed';
      return {
        status: 'persistence-failed',
        isIndeterminate: write.isIndeterminate ?? false,
        receipt: createReceipt({
          operation: operationFor(plan),
          trigger: `${plan.kind} ${plan.registrationId}`,
          expectedStateRevision: plan.stateRevision,
          targetStateRevision: '?',
          validationSnapshot: plan.candidate.snapshot.fingerprint,
          summary,
          findings: [
            finding(
              write.isIndeterminate ? CODE.PERSISTENCE_INDETERMINATE : CODE.PERSISTENCE_FAILED,
              write.isIndeterminate ? 'PERSIST-01' : 'PERSIST-02',
              'attempt',
              write.error ?? summary,
            ),
          ],
          stateChanged: false,
        }),
      };
    }

    const newRevision = write.newRevision!;
    // The Update Candidate has been applied: its pending-cache pin is no longer needed
    // (the new Registration/Installation snapshots now pin the fingerprint via Bridge State).
    (opts.cache ?? new SourceCache({ agentDir: opts.agentDir })).clearPendingUpdate(plan.registrationId);
    const diagnostics = plan.entries.some((entry) => entry.choice === 'remove' || entry.currentState === 'disabled');
    return {
      status: 'completed',
      newRevision,
      receipt: createReceipt({
        operation: operationFor(plan),
        trigger: `${plan.kind} ${plan.registrationId}`,
        expectedStateRevision: plan.stateRevision,
        targetStateRevision: newRevision,
        observedStateRevision: newRevision,
        validationSnapshot: plan.candidate.snapshot.fingerprint,
        summary: diagnostics ? 'Completed with diagnostics' : 'Completed',
        findings: [],
        stateChanged: true,
      }),
    };
  } finally {
    fence.handle!.release();
  }
}
