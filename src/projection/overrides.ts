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

export type OverrideKind = ScopeOverride['kind'];

export interface ScopeOverrideFlowOptions {
  cwd?: string;
  agentDir?: string;
  projectTrusted?: boolean;
  fenceTimeoutMs?: number;
  /** Integration synchronization seam; production callers leave this undefined. */
  beforeCommit?: () => void | Promise<void>;
}

export type OverrideOutcome =
  | { status: 'completed'; receipt: AttemptReceipt; newRevision: string }
  | { status: 'blocked'; findings: ValidationFinding[]; receipt: AttemptReceipt }
  | { status: 'rejected-as-stale'; receipt: AttemptReceipt }
  | { status: 'persistence-failed'; receipt: AttemptReceipt; isIndeterminate: boolean };

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

function blocked(operation: string, targetId: string, revision: string, findings: ValidationFinding[]): OverrideOutcome {
  return {
    status: 'blocked',
    findings,
    receipt: createReceipt({
      operation,
      scope: 'project',
      trigger: `${operation.toLowerCase()} ${targetId}`,
      expectedStateRevision: revision,
      summary: 'Blocked',
      findings,
    }),
  };
}

function persistenceFailed(operation: string, targetId: string, isIndeterminate: boolean, error?: string): OverrideOutcome {
  return {
    status: 'persistence-failed',
    isIndeterminate,
    receipt: createReceipt({
      operation,
      scope: 'project',
      trigger: `${operation.toLowerCase()} ${targetId}`,
      expectedStateRevision: '?',
      summary: isIndeterminate ? 'Persistence Indeterminate' : 'Persistence Failed',
      findings: isIndeterminate
        ? [admissionFinding(CODE.PERSISTENCE_INDETERMINATE, 'PERSIST-01', error ?? 'Bridge State is not readable', 'attempt')]
        : [],
    }),
  };
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
    return blocked(operation, targetId, '?', [
      admissionFinding(CODE.PROJECT_TRUST_DENIED, RULE.PROJECT_TRUST_DENIED, 'Project Trust is not granted by the Pi host; no Project Scope Lifecycle Operation may mutate Bridge State', kind === 'registration' ? 'registration' : 'installation'),
    ]);
  }

  const storeOpts = { cwd: opts.cwd, agentDir: opts.agentDir };
  const fence = await acquireAttemptFence('project', { ...storeOpts, fenceTimeoutMs: opts.fenceTimeoutMs });
  if (!fence.ok) return blocked(operation, targetId, '?', [fence.finding!]);

  try {
    const projectRead = await readBridgeState('project', storeOpts);
    const globalRead = await readBridgeState('global', storeOpts);
    if (projectRead.status !== 'ok' && projectRead.status !== 'missing') {
      return persistenceFailed(operation, targetId, true, projectRead.error);
    }
    if (globalRead.status !== 'ok' && globalRead.status !== 'missing') {
      return persistenceFailed(operation, targetId, true, globalRead.error);
    }

    const projectState = projectRead.state!;
    const denial = validate(projectState, globalRead.state!);
    if (denial) return blocked(operation, targetId, projectState.stateRevision, [denial]);

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
      { ...storeOpts, lockTimeoutMs: opts.fenceTimeoutMs, expectedStateRevision: projectState.stateRevision },
    );

    if (write.isStale) {
      return {
        status: 'rejected-as-stale',
        receipt: createReceipt({
          operation,
          scope: 'project',
          trigger: `${operation.toLowerCase()} ${targetId}`,
          expectedStateRevision: projectState.stateRevision,
          observedStateRevision: write.observedRevision,
          summary: 'Rejected as Stale',
          findings: [blocking({ code: CODE.REJECTED_AS_STALE, rule: RULE.REJECTED_AS_STALE, target: kind === 'registration' ? 'registration' : 'installation', pointer: '', outcome: `State Revision changed after ${operation} admission; re-run the lifecycle operation`, scope: 'project', phase: 'persistence' })],
        }),
      };
    }
    if (!write.success) return persistenceFailed(operation, targetId, write.isIndeterminate ?? false, write.error);

    return {
      status: 'completed',
      newRevision: write.newRevision!,
      receipt: createReceipt({
        operation,
        scope: 'project',
        trigger: `${operation.toLowerCase()} ${targetId}`,
        expectedStateRevision: projectState.stateRevision,
        targetStateRevision: write.newRevision,
        observedStateRevision: write.newRevision,
        summary: 'Completed',
        stateChanged: true,
      }),
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
