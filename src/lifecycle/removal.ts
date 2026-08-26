/**
 * Removal lifecycle — Registration Removal and Installation Removal.
 * See CONTEXT.md: Registration Removal, Installation Removal, Lifecycle Operation, Attempt Fence.
 *
 * Registration Removal deletes one Registration together with ALL of its Installations as one
 * disclosed atomic effect.
 *
 * Installation Removal deletes exactly one Installation while retaining its Registration.
 *
 * Both follow the preflight → explicit confirm pattern with the Attempt Fence held between them,
 * confirmation bound to the observed State Revision, Default No.
 */

import { commitBridgeState, readBridgeState } from '../bridge-state/store.js';
import type { Installation } from '../bridge-state/types.js';
import { SourceCache } from '../cache/source-cache.js';
import { acquireAttemptFence, type AttemptFenceHandle } from '../registration/fence.js';
import { CODE, RULE, blocking, type ValidationFinding } from '../registration/findings.js';
import { createReceipt, type AttemptReceipt } from '../registration/receipt.js';
import type { LifecycleFlowOptions } from './refresh.js';

export interface RemovalFlowOptions extends LifecycleFlowOptions {}

export interface RegistrationRemovalPreflight {
  registrationId: string;
  registrationSource?: string;
  /** Every Installation removed by the single atomic commit. */
  affectedInstallations: Installation[];
  stateRevision: string;
  fence: AttemptFenceHandle;
  terminal: boolean;
}

export interface InstallationRemovalPreflight {
  installation: Installation;
  registrationId?: string;
  stateRevision: string;
  fence: AttemptFenceHandle;
  terminal: boolean;
}

export type RemovalOutcome =
  | { status: 'completed'; receipt: AttemptReceipt; newRevision: string }
  | { status: 'declined'; receipt: AttemptReceipt }
  | { status: 'blocked'; findings: ValidationFinding[]; receipt: AttemptReceipt }
  | { status: 'rejected-as-stale'; receipt: AttemptReceipt }
  | { status: 'persistence-failed'; receipt: AttemptReceipt; isIndeterminate: boolean };

export type RemovalPreflightResult<P> =
  | { ok: true; preflight: P }
  | {
      ok: false;
      outcome:
        | { status: 'blocked'; findings: ValidationFinding[]; receipt: AttemptReceipt }
        | { status: 'persistence-failed'; receipt: AttemptReceipt; isIndeterminate: boolean };
    };

function persistenceBlocked(operation: string, trigger: string, error?: string): RemovalPreflightResult<never> {
  const receiptFindings: ValidationFinding[] = [
    blocking({ code: CODE.PERSISTENCE_INDETERMINATE, rule: 'PERSIST-01', target: 'attempt', pointer: '', outcome: error ?? 'Bridge State is not readable; neither previous nor target verifiable', phase: 'persistence' }),
  ];
  return {
    ok: false,
    outcome: {
      status: 'persistence-failed',
      isIndeterminate: true,
      receipt: createReceipt({ operation, trigger, expectedStateRevision: '?', summary: 'Persistence Indeterminate', findings: receiptFindings }),
    },
  };
}

function staleReceipt(operation: string, trigger: string, expected: string, observed?: string): RemovalOutcome {
  return {
    status: 'rejected-as-stale',
    receipt: createReceipt({
      operation,
      trigger,
      expectedStateRevision: expected,
      observedStateRevision: observed,
      summary: 'Rejected as Stale',
      findings: [blocking({ code: CODE.REJECTED_AS_STALE, rule: RULE.REJECTED_AS_STALE, target: 'attempt', pointer: '', outcome: `State Revision changed (${expected} → ${observed ?? '?'}); re-run preflight and confirmation — no automatic merge`, phase: 'persistence' })],
      stateChanged: false,
    }),
  };
}

function persistenceFailure(operation: string, trigger: string, expected: string, write: { isIndeterminate?: boolean; error?: string }): RemovalOutcome {
  const summary = write.isIndeterminate ? 'Persistence Indeterminate' : 'Persistence Failed';
  return {
    status: 'persistence-failed',
    isIndeterminate: write.isIndeterminate ?? false,
    receipt: createReceipt({
      operation,
      trigger,
      expectedStateRevision: expected,
      summary,
      findings: [blocking({ code: write.isIndeterminate ? CODE.PERSISTENCE_INDETERMINATE : CODE.PERSISTENCE_FAILED, rule: write.isIndeterminate ? 'PERSIST-01' : 'PERSIST-02', target: 'attempt', pointer: '', outcome: write.error ?? summary, phase: 'persistence' })],
      stateChanged: false,
    }),
  };
}

/**
 * Preflight a Registration Removal: disclose every Installation the single atomic
 * commit will delete.
 */
export async function preflightRegistrationRemoval(
  registrationId: string,
  opts: RemovalFlowOptions = {},
): Promise<RemovalPreflightResult<RegistrationRemovalPreflight>> {
  const OPERATION = 'Registration Removal';
  const trigger = `remove registration ${registrationId}`;
  const read = await readBridgeState({ agentDir: opts.agentDir });
  if (read.status !== 'ok' && read.status !== 'missing') return persistenceBlocked(OPERATION, trigger, read.error);
  const state = read.state!;

  const registration = state.registrations.find((item) => item.id === registrationId);
  if (!registration) {
    const findings: ValidationFinding[] = [
      blocking({ code: CODE.REGISTRATION_NOT_FOUND, rule: RULE.REGISTRATION_NOT_FOUND, target: 'registration', pointer: '', outcome: `Registration '${registrationId}' is not in Bridge State`, phase: 'admission' }),
    ];
    return {
      ok: false,
      outcome: {
        status: 'blocked',
        findings,
        receipt: createReceipt({ operation: OPERATION, trigger, expectedStateRevision: state.stateRevision, summary: 'Blocked', findings }),
      },
    };
  }

  const fence = await acquireAttemptFence({ agentDir: opts.agentDir, fenceTimeoutMs: opts.fenceTimeoutMs });
  if (!fence.ok) {
    const findings = [fence.finding!];
    return { ok: false, outcome: { status: 'blocked', findings, receipt: createReceipt({ operation: OPERATION, trigger, expectedStateRevision: state.stateRevision, summary: 'Blocked', findings }) } };
  }

  return {
    ok: true,
    preflight: {
      registrationId,
      registrationSource: registration.source,
      affectedInstallations: state.installations.filter((installation) => installation.registrationId === registrationId),
      stateRevision: state.stateRevision,
      fence: fence.handle!,
      terminal: false,
    },
  };
}

/** Full cascade disclosure for the confirmation surface. */
export function registrationRemovalDisclosure(preflight: RegistrationRemovalPreflight): string {
  const lines = [
    `Registration: ${preflight.registrationId.slice(0, 8)}…${preflight.registrationSource ? ` · ${JSON.stringify(preflight.registrationSource)}` : ''}`,
    `State Revision: ${preflight.stateRevision}`,
    `Installations removed atomically: ${preflight.affectedInstallations.length}`,
  ];
  for (const installation of preflight.affectedInstallations) {
    lines.push(`  ${JSON.stringify(installation.id)} · ${JSON.stringify(installation.pluginId)} · ${installation.installationState}`);
  }
  return lines.join('\n');
}

function terminalGuard<P extends { terminal: boolean; fence: AttemptFenceHandle; stateRevision: string }>(
  preflight: P,
  operation: string,
  trigger: string,
): RemovalOutcome | undefined {
  if (!preflight.terminal) return undefined;
  preflight.fence.release();
  const findings: ValidationFinding[] = [
    blocking({ code: CODE.ATTEMPT_IN_PROGRESS, rule: RULE.ATTEMPT_IN_PROGRESS, target: 'attempt', pointer: '', outcome: 'attempt already reached a terminal outcome', phase: 'admission' }),
  ];
  return {
    status: 'blocked',
    findings,
    receipt: createReceipt({ operation, trigger, expectedStateRevision: preflight.stateRevision, summary: 'Blocked', findings }),
  };
}

/** Confirm the disclosed Registration Removal. yes=false declines with no state mutation. */
export async function confirmRegistrationRemoval(
  preflight: RegistrationRemovalPreflight,
  yes: boolean,
  opts: RemovalFlowOptions = {},
): Promise<RemovalOutcome> {
  const OPERATION = 'Registration Removal';
  const trigger = `remove registration ${preflight.registrationId}`;
  const early = terminalGuard(preflight, OPERATION, trigger);
  if (early) return early;
  preflight.terminal = true;

  if (!yes) {
    const receipt = createReceipt({
      operation: OPERATION,
      trigger,
      expectedStateRevision: preflight.stateRevision,
      validationSnapshot: undefined,
      summary: 'Declined',
      findings: [],
      stateChanged: false,
    });
    preflight.fence.release();
    return { status: 'declined', receipt };
  }

  // Re-verify exact State Revision under the held confirmation binding.
  const fresh = await readBridgeState({ agentDir: opts.agentDir });
  if (fresh.status !== 'ok' && fresh.status !== 'missing') {
    preflight.fence.release();
    const findings: ValidationFinding[] = [
      blocking({ code: CODE.PERSISTENCE_INDETERMINATE, rule: 'PERSIST-01', target: 'attempt', pointer: '', outcome: fresh.error ?? 'Bridge State is not readable; neither previous nor target verifiable', phase: 'persistence' }),
    ];
    return { status: 'persistence-failed', isIndeterminate: true, receipt: createReceipt({ operation: OPERATION, trigger, expectedStateRevision: preflight.stateRevision, summary: 'Persistence Indeterminate', findings, stateChanged: false }) };
  }
  if (fresh.state!.stateRevision !== preflight.stateRevision) {
    const outcome = staleReceipt(OPERATION, trigger, preflight.stateRevision, fresh.state!.stateRevision);
    preflight.fence.release();
    return outcome;
  }

  const write = await commitBridgeState(
    (current) => ({
      ...current,
      registrations: current.registrations.filter((r) => r.id !== preflight.registrationId),
      installations: current.installations.filter((i) => i.registrationId !== preflight.registrationId),
    }),
    { agentDir: opts.agentDir, lockTimeoutMs: opts.fenceTimeoutMs, expectedStateRevision: preflight.stateRevision },
  );
  preflight.fence.release();
  if (write.isStale) return staleReceipt(OPERATION, trigger, preflight.stateRevision, write.observedRevision);
  if (!write.success) return persistenceFailure(OPERATION, trigger, preflight.stateRevision, write);

  const newRevision = write.newRevision!;
  // A removed Registration's pending Update Candidate pin is no longer meaningful (#22).
  if (preflight.registrationId) {
    const cache = opts.cache ?? new SourceCache({ agentDir: opts.agentDir });
    cache.clearPendingUpdate(preflight.registrationId);
  }
  return {
    status: 'completed',
    newRevision,
    receipt: createReceipt({
      operation: OPERATION,
      trigger,
      expectedStateRevision: preflight.stateRevision,
      targetStateRevision: newRevision,
      observedStateRevision: newRevision,
      summary: 'Completed',
      stateChanged: true,
    }),
  };
}

/** Preflight an Installation Removal. */
export async function preflightInstallationRemoval(
  installationId: string,
  opts: RemovalFlowOptions = {},
): Promise<RemovalPreflightResult<InstallationRemovalPreflight>> {
  const OPERATION = 'Installation Removal';
  const trigger = `remove installation ${installationId}`;
  const read = await readBridgeState({ agentDir: opts.agentDir });
  if (read.status !== 'ok' && read.status !== 'missing') return persistenceBlocked(OPERATION, trigger, read.error);
  const state = read.state!;

  // Resolve by exact persisted ID first, then by Plugin ID (legacy '<scope>/<pluginId>' forms).
  const installation = state.installations.find((item) => item.id === installationId)
    ?? state.installations.find((item) => item.pluginId === installationId);
  if (!installation) {
    const findings: ValidationFinding[] = [
      blocking({ code: CODE.INSTALLATION_NOT_FOUND, rule: RULE.INSTALLATION_NOT_FOUND, target: 'installation', pointer: '', outcome: `Installation '${installationId}' is not in Bridge State`, phase: 'admission' }),
    ];
    return { ok: false, outcome: { status: 'blocked', findings, receipt: createReceipt({ operation: OPERATION, trigger, expectedStateRevision: state.stateRevision, summary: 'Blocked', findings }) } };
  }

  const fence = await acquireAttemptFence({ agentDir: opts.agentDir, fenceTimeoutMs: opts.fenceTimeoutMs });
  if (!fence.ok) {
    const findings = [fence.finding!];
    return { ok: false, outcome: { status: 'blocked', findings, receipt: createReceipt({ operation: OPERATION, trigger, expectedStateRevision: state.stateRevision, summary: 'Blocked', findings }) } };
  }

  return {
    ok: true,
    preflight: {
      installation,
      registrationId: installation.registrationId,
      stateRevision: state.stateRevision,
      fence: fence.handle!,
      terminal: false,
    },
  };
}

/** Full disclosure for the confirmation surface. */
export function installationRemovalDisclosure(preflight: InstallationRemovalPreflight): string {
  const lines = [
    `Installation: ${JSON.stringify(preflight.installation.id)} · ${JSON.stringify(preflight.installation.pluginId)} · ${preflight.installation.installationState}`,
    `Registration retained: ${preflight.registrationId ? preflight.registrationId.slice(0, 8) + '…' : '(none)'}`,
    `State Revision: ${preflight.stateRevision}`,
  ];
  return lines.join('\n');
}

/** Confirm the disclosed Installation Removal. yes=false declines with no state mutation. */
export async function confirmInstallationRemoval(
  preflight: InstallationRemovalPreflight,
  yes: boolean,
  opts: RemovalFlowOptions = {},
): Promise<RemovalOutcome> {
  const OPERATION = 'Installation Removal';
  const trigger = `remove installation ${preflight.installation.id}`;
  const early = terminalGuard(preflight, OPERATION, trigger);
  if (early) return early;
  preflight.terminal = true;

  if (!yes) {
    const receipt = createReceipt({
      operation: OPERATION,
      trigger,
      expectedStateRevision: preflight.stateRevision,
      summary: 'Declined',
      findings: [],
      stateChanged: false,
    });
    preflight.fence.release();
    return { status: 'declined', receipt };
  }

  const fresh = await readBridgeState({ agentDir: opts.agentDir });
  if (fresh.status !== 'ok' && fresh.status !== 'missing') {
    preflight.fence.release();
    const findings: ValidationFinding[] = [
      blocking({ code: CODE.PERSISTENCE_INDETERMINATE, rule: 'PERSIST-01', target: 'attempt', pointer: '', outcome: fresh.error ?? 'Bridge State is not readable; neither previous nor target verifiable', phase: 'persistence' }),
    ];
    return { status: 'persistence-failed', isIndeterminate: true, receipt: createReceipt({ operation: OPERATION, trigger, expectedStateRevision: preflight.stateRevision, summary: 'Persistence Indeterminate', findings, stateChanged: false }) };
  }
  if (fresh.state!.stateRevision !== preflight.stateRevision || !fresh.state!.installations.some((i) => i.id === preflight.installation.id)) {
    const outcome = staleReceipt(OPERATION, trigger, preflight.stateRevision, fresh.state!.stateRevision);
    preflight.fence.release();
    return outcome;
  }

  const write = await commitBridgeState(
    (current) => ({
      ...current,
      installations: current.installations.filter((i) => i.id !== preflight.installation.id),
    }),
    { agentDir: opts.agentDir, lockTimeoutMs: opts.fenceTimeoutMs, expectedStateRevision: preflight.stateRevision },
  );
  preflight.fence.release();
  if (write.isStale) return staleReceipt(OPERATION, trigger, preflight.stateRevision, write.observedRevision);
  if (!write.success) return persistenceFailure(OPERATION, trigger, preflight.stateRevision, write);

  const newRevision = write.newRevision!;
  // Installation Removal does not invalidate the pending Update Candidate: the Registration and
  // its candidate survive, so the pin must remain (fail-closed, #22).
  return {
    status: 'completed',
    newRevision,
    receipt: createReceipt({
      operation: OPERATION,
      trigger,
      expectedStateRevision: preflight.stateRevision,
      targetStateRevision: newRevision,
      observedStateRevision: newRevision,
      summary: 'Completed',
      stateChanged: true,
    }),
  };
}
