/**
 * Scope Override lifecycle — Project Scope records that explicitly suppress inherited
 * Global Scope records without modifying them.
 * See CONTEXT.md: Scope Override, Project Trust, Lifecycle Operation, Attempt Fence, State Revision.
 *
 * A Registration override suppresses its marketplace subtree; an Installation override
 * suppresses only that single Plugin. Removing either reveals the inherited record again at
 * the next read — inheritance is restored by Effective State recomputation, never by rewriting
 * the global document. Both operations are Project Scope Lifecycle Operations: they require
 * Project Trust, run under the scope Attempt Fence, bind the exact State Revision at admission,
 * commit atomically to the project document only, and produce an immutable Attempt Receipt.
 */

import { readBridgeState, commitBridgeState } from '../bridge-state/store.js';
import type { BridgeState, ScopeOverride } from '../bridge-state/types.js';
import { acquireAttemptFence } from '../registration/fence.js';
import { CODE, RULE, blocking, type ValidationFinding } from '../registration/findings.js';
import { createReceipt, type AttemptReceipt } from '../registration/receipt.js';
import { appendReceipt } from '../journal/journal.js';
import type { JournalAppendResult } from '../journal/types.js';

export type OverrideKind = ScopeOverride['kind'];

export interface ScopeOverrideFlowOptions {
  cwd?: string;
  agentDir?: string;
  projectTrusted?: boolean;
  fenceTimeoutMs?: number;
  /** Receipt Journal lock timeout (default 5000). */
  journalLockTimeoutMs?: number;
  /** Project State Revision disclosed by the transaction sheet. */
  expectedStateRevision?: string;
  /** Integration synchronization seam; production callers leave this undefined. */
  beforeCommit?: () => void | Promise<void>;
}

type JournalPersistenceFailureOutcome =
  | {
      status: 'journal-persistence-failed';
      receipt: AttemptReceipt;
      receiptPersisted: false;
      stateCommitted: false;
      isIndeterminate: boolean;
      error: string;
    }
  | {
      status: 'journal-persistence-failed';
      receipt: AttemptReceipt;
      receiptPersisted: false;
      stateCommitted: true;
      isIndeterminate: true;
      newRevision: string;
      error: string;
    };

export type OverrideOutcome =
  | { status: 'completed'; receipt: AttemptReceipt; newRevision: string }
  | { status: 'blocked'; findings: ValidationFinding[]; receipt: AttemptReceipt }
  | { status: 'rejected-as-stale'; receipt: AttemptReceipt }
  | { status: 'persistence-failed'; receipt: AttemptReceipt; isIndeterminate: boolean }
  | JournalPersistenceFailureOutcome;

const OPERATION_NAME = {
  createRegistration: 'Registration Override Creation',
  createInstallation: 'Installation Override Creation',
  removeRegistration: 'Registration Override Removal',
  removeInstallation: 'Installation Override Removal',
} as const;

function operationName(kind: OverrideKind, direction: 'create' | 'remove'): string {
  if (kind === 'registration') return direction === 'create' ? OPERATION_NAME.createRegistration : OPERATION_NAME.removeRegistration;
  return direction === 'create' ? OPERATION_NAME.createInstallation : OPERATION_NAME.removeInstallation;
}

function admissionFinding(code: string, rule: string, outcome: string, target: ValidationFinding['target']): ValidationFinding {
  return blocking({ code, rule, target, pointer: '', outcome, scope: 'project', phase: 'admission' });
}

function withJournalFailureFinding(
  receipt: AttemptReceipt,
  finding: ValidationFinding | undefined,
): AttemptReceipt {
  if (!finding) return receipt;
  return createReceipt({
    id: receipt.id,
    kind: receipt.kind,
    operation: receipt.operation,
    scope: receipt.scope,
    trigger: receipt.trigger,
    startedAt: receipt.startedAt,
    completedAt: receipt.completedAt,
    expectedStateRevision: receipt.expectedStateRevision,
    targetStateRevision: receipt.targetStateRevision,
    observedStateRevision: receipt.observedStateRevision,
    validationSnapshot: receipt.validationSnapshot,
    snapshotFingerprints: receipt.snapshotFingerprints,
    durableOutcome: receipt.durableOutcome,
    runtimeOutcome: receipt.runtimeOutcome,
    findings: [...receipt.findings, finding],
    summary: receipt.summary,
    recoveryActions: receipt.recoveryActions,
    stateChanged: receipt.stateChanged,
    recoversReceiptId: receipt.recoversReceiptId,
    supersedesReceiptId: receipt.supersedesReceiptId,
  });
}

function journalPersistenceFailure(
  receipt: AttemptReceipt,
  appended: JournalAppendResult,
  state:
    | { stateCommitted: false; isIndeterminate: boolean }
    | { stateCommitted: true; newRevision: string },
): JournalPersistenceFailureOutcome {
  const common = {
    status: 'journal-persistence-failed' as const,
    receipt: withJournalFailureFinding(receipt, appended.finding),
    receiptPersisted: false as const,
    error: appended.error ?? 'Attempt Receipt did not reach the durable Receipt Journal',
  };
  if (state.stateCommitted) {
    return {
      ...common,
      stateCommitted: true,
      isIndeterminate: true,
      newRevision: state.newRevision,
    };
  }
  return {
    ...common,
    stateCommitted: false,
    isIndeterminate: state.isIndeterminate,
  };
}

async function blocked(operation: string, targetId: string, revision: string, findings: ValidationFinding[], opts: ScopeOverrideFlowOptions = {}): Promise<OverrideOutcome> {
  const receipt = createReceipt({
    operation,
    scope: 'project',
    trigger: `${operation.toLowerCase()} ${targetId}`,
    expectedStateRevision: revision,
    summary: 'Blocked',
    findings,
  });
  const appended = await appendReceipt('project', receipt, opts);
  if (!appended.success) {
    return journalPersistenceFailure(receipt, appended, {
      stateCommitted: false,
      isIndeterminate: false,
    });
  }
  return {
    status: 'blocked',
    findings,
    receipt,
  };
}

async function persistenceFailed(operation: string, targetId: string, isIndeterminate: boolean, error?: string, opts: ScopeOverrideFlowOptions = {}): Promise<OverrideOutcome> {
  const receipt = createReceipt({
    operation,
    scope: 'project',
    trigger: `${operation.toLowerCase()} ${targetId}`,
    expectedStateRevision: opts.expectedStateRevision ?? '?',
    summary: isIndeterminate ? 'Persistence Indeterminate' : 'Persistence Failed',
    findings: isIndeterminate
      ? [admissionFinding(CODE.PERSISTENCE_INDETERMINATE, 'PERSIST-01', error ?? 'Bridge State is not readable', 'attempt')]
      : [],
  });
  const appended = await appendReceipt('project', receipt, opts);
  if (!appended.success) {
    return journalPersistenceFailure(receipt, appended, {
      stateCommitted: false,
      isIndeterminate,
    });
  }
  return {
    status: 'persistence-failed',
    isIndeterminate,
    receipt,
  };
}

async function rejectedAsStale(
  operation: string,
  kind: OverrideKind,
  targetId: string,
  expectedStateRevision: string,
  observedStateRevision: string | undefined,
  opts: ScopeOverrideFlowOptions,
): Promise<OverrideOutcome> {
  const receipt = createReceipt({
    operation,
    scope: 'project',
    trigger: `${operation.toLowerCase()} ${targetId}`,
    expectedStateRevision,
    observedStateRevision,
    summary: 'Rejected as Stale',
    findings: [blocking({
      code: CODE.REJECTED_AS_STALE,
      rule: RULE.REJECTED_AS_STALE,
      target: kind === 'registration' ? 'registration' : 'installation',
      pointer: '',
      outcome: `Project State Revision changed after ${operation} disclosure; re-run the lifecycle operation`,
      scope: 'project',
      phase: 'persistence',
    })],
  });
  const appended = await appendReceipt('project', receipt, opts);
  if (!appended.success) {
    return journalPersistenceFailure(receipt, appended, {
      stateCommitted: false,
      isIndeterminate: false,
    });
  }
  return { status: 'rejected-as-stale', receipt };
}

async function runOverrideOperation(
  direction: 'create' | 'remove',
  kind: OverrideKind,
  targetId: string,
  opts: ScopeOverrideFlowOptions,
  /** Admission validation over both authoritative documents; returns the blocking denial, if any. */
  validate: (projectState: BridgeState, globalState: BridgeState) => ValidationFinding | undefined,
): Promise<OverrideOutcome> {
  const operation = operationName(kind, direction);
  if (opts.projectTrusted !== true) {
    return blocked(operation, targetId, opts.expectedStateRevision ?? '?', [
      admissionFinding(CODE.PROJECT_TRUST_DENIED, RULE.PROJECT_TRUST_DENIED, 'Project Trust is not granted by the Pi host; no Project Scope Lifecycle Operation may mutate Bridge State', kind === 'registration' ? 'registration' : 'installation'),
    ], opts);
  }

  const storeOpts = { cwd: opts.cwd, agentDir: opts.agentDir };
  const fence = await acquireAttemptFence('project', { ...storeOpts, fenceTimeoutMs: opts.fenceTimeoutMs, projectTrusted: opts.projectTrusted });
  if (!fence.ok) return blocked(operation, targetId, opts.expectedStateRevision ?? '?', [fence.finding!], opts);

  try {
    const projectRead = await readBridgeState('project', storeOpts);
    const globalRead = await readBridgeState('global', storeOpts);
    if (projectRead.status !== 'ok' && projectRead.status !== 'missing') {
      return persistenceFailed(operation, targetId, true, projectRead.error, opts);
    }
    if (globalRead.status !== 'ok' && globalRead.status !== 'missing') {
      return persistenceFailed(operation, targetId, true, globalRead.error, opts);
    }

    const projectState = projectRead.state!;
    const expectedStateRevision = opts.expectedStateRevision ?? projectState.stateRevision;
    if (projectState.stateRevision !== expectedStateRevision) {
      return rejectedAsStale(
        operation,
        kind,
        targetId,
        expectedStateRevision,
        projectState.stateRevision,
        opts,
      );
    }
    const denial = validate(projectState, globalRead.state!);
    if (denial) return blocked(operation, targetId, projectState.stateRevision, [denial], opts);

    await opts.beforeCommit?.();

    const write = await commitBridgeState(
      'project',
      (state) => ({
        ...state,
        scopeOverrides:
          direction === 'create'
            ? [...state.scopeOverrides.filter((item) => !(item.kind === kind && item.targetId === targetId)), { kind, targetId }]
            : state.scopeOverrides.filter((item) => !(item.kind === kind && item.targetId === targetId)),
      }),
      { ...storeOpts, lockTimeoutMs: opts.fenceTimeoutMs, expectedStateRevision },
    );

    if (write.isStale) {
      return rejectedAsStale(operation, kind, targetId, expectedStateRevision, write.observedRevision, opts);
    }
    if (!write.success) return persistenceFailed(operation, targetId, write.isIndeterminate ?? false, write.error, opts);

    const receipt = createReceipt({
      operation,
      scope: 'project',
      trigger: `${operation.toLowerCase()} ${targetId}`,
      expectedStateRevision,
      targetStateRevision: write.newRevision,
      observedStateRevision: write.newRevision,
      summary: 'Completed',
      stateChanged: true,
    });
    const appended = await appendReceipt('project', receipt, opts);
    if (!appended.success) {
      return journalPersistenceFailure(receipt, appended, {
        stateCommitted: true,
        newRevision: write.newRevision!,
      });
    }

    return {
      status: 'completed',
      newRevision: write.newRevision!,
      receipt,
    };
  } finally {
    fence.handle!.release();
  }
}

/**
 * Create one Scope Override suppressing an inherited Global record.
 * The target must exist in the inherited Global Scope and must not already be suppressed.
 */
export async function createScopeOverride(
  kind: OverrideKind,
  targetId: string,
  opts: ScopeOverrideFlowOptions = {},
): Promise<OverrideOutcome> {
  return runOverrideOperation('create', kind, targetId, opts, (projectState, globalState) => {
    if (projectState.scopeOverrides.some((item) => item.kind === kind && item.targetId === targetId)) {
      return admissionFinding(
        CODE.SCOPE_OVERRIDE_ALREADY_PRESENT,
        RULE.SCOPE_OVERRIDE_ALREADY_PRESENT,
        `A ${kind} Scope Override for '${targetId}' already exists in Project Scope`,
        kind === 'registration' ? 'registration' : 'installation',
      );
    }
    const exists = kind === 'registration'
      ? globalState.registrations.some((registration) => registration.id === targetId)
      : globalState.installations.some((installation) => installation.id === targetId);
    if (!exists) {
      return admissionFinding(
        CODE.SCOPE_OVERRIDE_TARGET_NOT_FOUND,
        RULE.SCOPE_OVERRIDE_TARGET_NOT_FOUND,
        `Suppression target '${targetId}' does not exist in the inherited Global Scope; Scope Overrides suppress inherited records only`,
        kind === 'registration' ? 'registration' : 'installation',
      );
    }
    return undefined;
  });
}

/**
 * Remove one Scope Override; inheritance is restored by Effective State recomputation without
 * rewriting the global document.
 */
export async function removeScopeOverride(
  kind: OverrideKind,
  targetId: string,
  opts: ScopeOverrideFlowOptions = {},
): Promise<OverrideOutcome> {
  return runOverrideOperation('remove', kind, targetId, opts, (projectState) => {
    if (!projectState.scopeOverrides.some((item) => item.kind === kind && item.targetId === targetId)) {
      return admissionFinding(
        CODE.SCOPE_OVERRIDE_TARGET_NOT_FOUND,
        RULE.SCOPE_OVERRIDE_TARGET_NOT_FOUND,
        `No ${kind} Scope Override for '${targetId}' exists in Project Scope`,
        kind === 'registration' ? 'registration' : 'installation',
      );
    }
    return undefined;
  });
}
