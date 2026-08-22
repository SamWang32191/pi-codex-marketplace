/**
 * Removal lifecycle — Registration Removal and Installation Removal.
 * See CONTEXT.md: Registration Removal, Installation Removal, Lifecycle Operation, Attempt Fence.
 *
 * Registration Removal deletes one scope-local Registration together with ALL of its same-scope
 * Installations as one disclosed atomic effect; other scopes are never mutated (references left
 * elsewhere fail closed as unavailable and surface diagnostics until repaired or removed).
 *
 * Installation Removal deletes exactly one scope-local Installation while retaining its
 * Registration, and its disclosure identifies any inherited Installation that becomes effective
 * afterward (Effective State precedence: project over global for the same Plugin ID).
 *
 * Both follow the preflight → explicit confirm pattern with the Attempt Fence held between them,
 * confirmation bound to the observed State Revision, Default No.
 */

import { commitBridgeState, readBridgeState } from '../bridge-state/store.js';
import type { Installation, Scope } from '../bridge-state/types.js';
import { acquireAttemptFence, type AttemptFenceHandle } from '../registration/fence.js';
import { CODE, RULE, blocking, sortFindings, type ValidationFinding } from '../registration/findings.js';
import { createReceipt, type AttemptReceipt } from '../registration/receipt.js';
import type { LifecycleFlowOptions } from './refresh.js';

export interface RemovalFlowOptions extends LifecycleFlowOptions {
  /** Host-owned Project Trust decision; omitted means NOT granted (fail-closed). */
  projectTrusted?: boolean;
}

export interface RegistrationRemovalPreflight {
  scope: Scope;
  registrationId: string;
  registrationSource?: string;
  /** Every same-scope Installation removed by the single atomic commit. */
  affectedInstallations: Installation[];
  stateRevision: string;
  fence: AttemptFenceHandle;
  terminal: boolean;
}

export interface InstallationRemovalPreflight {
  scope: Scope;
  installation: Installation;
  registrationId?: string;
  /** Inherited Installations that become effective after this removal (disclosed, not mutated). */
  resumingInheritedInstallations: Installation[];
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

function trustFinding(scope: Scope): ValidationFinding | undefined {
  if (scope !== 'project') return undefined;
  return blocking({
    code: CODE.PROJECT_TRUST_DENIED,
    rule: RULE.PROJECT_TRUST_DENIED,
    target: 'installation',
    pointer: '',
    outcome: 'Project Trust is not granted by the Pi host; project records remain stored but excluded from Effective State, and no Project Scope Lifecycle Operation may mutate them',
    scope,
    phase: 'admission',
  });
}

function persistenceBlocked(scope: Scope, operation: string, trigger: string, error?: string): RemovalPreflightResult<never> {
  const receiptFindings: ValidationFinding[] = [
    blocking({ code: CODE.PERSISTENCE_INDETERMINATE, rule: 'PERSIST-01', target: 'attempt', pointer: '', outcome: error ?? 'Bridge State is not readable; neither previous nor target verifiable', scope, phase: 'persistence' }),
  ];
  return {
    ok: false,
    outcome: {
      status: 'persistence-failed',
      isIndeterminate: true,
      receipt: createReceipt({ operation, scope, trigger, expectedStateRevision: '?', summary: 'Persistence Indeterminate', findings: receiptFindings }),
    },
  };
}

function staleReceipt(operation: string, scope: Scope, trigger: string, expected: string, observed?: string): RemovalOutcome {
  return {
    status: 'rejected-as-stale',
    receipt: createReceipt({
      operation,
      scope,
      trigger,
      expectedStateRevision: expected,
      observedStateRevision: observed,
      summary: 'Rejected as Stale',
      findings: [blocking({ code: CODE.REJECTED_AS_STALE, rule: RULE.REJECTED_AS_STALE, target: 'attempt', pointer: '', outcome: `State Revision changed (${expected} → ${observed ?? '?'}); re-run preflight and confirmation — no automatic merge`, scope, phase: 'persistence' })],
      stateChanged: false,
    }),
  };
}

function persistenceFailure(operation: string, scope: Scope, trigger: string, expected: string, write: { isIndeterminate?: boolean; error?: string }): RemovalOutcome {
  const summary = write.isIndeterminate ? 'Persistence Indeterminate' : 'Persistence Failed';
  return {
    status: 'persistence-failed',
    isIndeterminate: write.isIndeterminate ?? false,
    receipt: createReceipt({
      operation,
      scope,
      trigger,
      expectedStateRevision: expected,
      summary,
      findings: [blocking({ code: write.isIndeterminate ? CODE.PERSISTENCE_INDETERMINATE : CODE.PERSISTENCE_FAILED, rule: write.isIndeterminate ? 'PERSIST-01' : 'PERSIST-02', target: 'attempt', pointer: '', outcome: write.error ?? summary, scope, phase: 'persistence' })],
      stateChanged: false,
    }),
  };
}

/**
 * Preflight a Registration Removal: disclose every same-scope Installation the single atomic
 * commit will delete. Other scopes are never listed nor mutated.
 */
export async function preflightRegistrationRemoval(
  scope: Scope,
  registrationId: string,
  opts: RemovalFlowOptions = {},
): Promise<RemovalPreflightResult<RegistrationRemovalPreflight>> {
  const OPERATION = 'Registration Removal';
  const trigger = `remove registration ${registrationId}`;
  const read = await readBridgeState(scope, { cwd: opts.cwd, agentDir: opts.agentDir });
  if (read.status !== 'ok' && read.status !== 'missing') return persistenceBlocked(scope, OPERATION, trigger, read.error);
  const state = read.state!;

  const trust = trustFinding(scope);
  if (trust && opts.projectTrusted !== true) {
    const findings: ValidationFinding[] = [trust];
    return {
      ok: false,
      outcome: {
        status: 'blocked',
        findings,
        receipt: createReceipt({ operation: OPERATION, scope, trigger, expectedStateRevision: state.stateRevision, summary: 'Blocked', findings }),
      },
    };
  }

  const registration = state.registrations.find((item) => item.id === registrationId);
  if (!registration) {
    const findings: ValidationFinding[] = [
      blocking({ code: CODE.REGISTRATION_NOT_FOUND, rule: RULE.REGISTRATION_NOT_FOUND, target: 'registration', pointer: '', outcome: `Registration '${registrationId}' is not in ${scope} Bridge State`, scope, phase: 'admission' }),
    ];
    return {
      ok: false,
      outcome: {
        status: 'blocked',
        findings,
        receipt: createReceipt({ operation: OPERATION, scope, trigger, expectedStateRevision: state.stateRevision, summary: 'Blocked', findings }),
      },
    };
  }

  const fence = await acquireAttemptFence(scope, { cwd: opts.cwd, agentDir: opts.agentDir, fenceTimeoutMs: opts.fenceTimeoutMs });
  if (!fence.ok) {
    const findings = [fence.finding!];
    return { ok: false, outcome: { status: 'blocked', findings, receipt: createReceipt({ operation: OPERATION, scope, trigger, expectedStateRevision: state.stateRevision, summary: 'Blocked', findings }) } };
  }

  return {
    ok: true,
    preflight: {
      scope,
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
    `Scope: ${preflight.scope}`,
    `Registration: ${preflight.registrationId.slice(0, 8)}…${preflight.registrationSource ? ` · ${JSON.stringify(preflight.registrationSource)}` : ''}`,
    `State Revision: ${preflight.stateRevision}`,
    `Same-scope Installations removed atomically: ${preflight.affectedInstallations.length}`,
  ];
  for (const installation of preflight.affectedInstallations) {
    lines.push(`  ${JSON.stringify(installation.id)} · ${JSON.stringify(installation.pluginId)} · ${installation.installationState}`);
  }
  lines.push('Other scopes are never mutated; references left there fail closed as unavailable until repaired or removed.');
  return lines.join('\n');
}

function terminalGuard<P extends { terminal: boolean; fence: AttemptFenceHandle; stateRevision: string; scope: Scope }>(
  preflight: P,
  operation: string,
  trigger: string,
): RemovalOutcome | undefined {
  if (!preflight.terminal) return undefined;
  preflight.fence.release();
  const findings: ValidationFinding[] = [
    blocking({ code: CODE.ATTEMPT_IN_PROGRESS, rule: RULE.ATTEMPT_IN_PROGRESS, target: 'attempt', pointer: '', outcome: 'attempt already reached a terminal outcome', scope: preflight.scope, phase: 'admission' }),
  ];
  return {
    status: 'blocked',
    findings,
    receipt: createReceipt({ operation, scope: preflight.scope, trigger, expectedStateRevision: preflight.stateRevision, summary: 'Blocked', findings }),
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
      scope: preflight.scope,
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
  const fresh = await readBridgeState(preflight.scope, { cwd: opts.cwd, agentDir: opts.agentDir });
  if (fresh.status !== 'ok' && fresh.status !== 'missing') {
    preflight.fence.release();
    const findings: ValidationFinding[] = [
      blocking({ code: CODE.PERSISTENCE_INDETERMINATE, rule: 'PERSIST-01', target: 'attempt', pointer: '', outcome: fresh.error ?? 'Bridge State is not readable; neither previous nor target verifiable', scope: preflight.scope, phase: 'persistence' }),
    ];
    return { status: 'persistence-failed', isIndeterminate: true, receipt: createReceipt({ operation: OPERATION, scope: preflight.scope, trigger, expectedStateRevision: preflight.stateRevision, summary: 'Persistence Indeterminate', findings, stateChanged: false }) };
  }
  if (fresh.state!.stateRevision !== preflight.stateRevision) {
    const outcome = staleReceipt(OPERATION, preflight.scope, trigger, preflight.stateRevision, fresh.state!.stateRevision);
    preflight.fence.release();
    return outcome;
  }

  const write = await commitBridgeState(
    preflight.scope,
    (current) => ({
      ...current,
      registrations: current.registrations.filter((r) => r.id !== preflight.registrationId),
      installations: current.installations.filter((i) => i.registrationId !== preflight.registrationId),
    }),
    { cwd: opts.cwd, agentDir: opts.agentDir, lockTimeoutMs: opts.fenceTimeoutMs, expectedStateRevision: preflight.stateRevision },
  );
  preflight.fence.release();
  if (write.isStale) return staleReceipt(OPERATION, preflight.scope, trigger, preflight.stateRevision, write.observedRevision);
  if (!write.success) return persistenceFailure(OPERATION, preflight.scope, trigger, preflight.stateRevision, write);

  const newRevision = write.newRevision!;
  // A removed Registration's pending Update Candidate pin is no longer meaningful (#22).
  if (preflight.registrationId) opts.cache?.clearPendingUpdate(preflight.scope, preflight.registrationId);
  return {
    status: 'completed',
    newRevision,
    receipt: createReceipt({
      operation: OPERATION,
      scope: preflight.scope,
      trigger,
      expectedStateRevision: preflight.stateRevision,
      targetStateRevision: newRevision,
      observedStateRevision: newRevision,
      summary: 'Completed',
      stateChanged: true,
    }),
  };
}

/** Inherited Installations that become effective once this one is removed. */
async function resumingInherited(scope: Scope, installation: Installation, opts: RemovalFlowOptions): Promise<Installation[]> {
  if (scope !== 'project') return [];
  const [global, project] = await Promise.all([
    readBridgeState('global', { cwd: opts.cwd, agentDir: opts.agentDir }),
    readBridgeState('project', { cwd: opts.cwd, agentDir: opts.agentDir }),
  ]);
  if (global.status !== 'ok' && global.status !== 'missing') return [];
  // Suppressions live in the PROJECT document and reveal/hide inherited records by ID.
  const projectOverrides = project.state?.scopeOverrides ?? [];
  const suppressedInstallations = new Set(projectOverrides.filter((o) => o.kind === 'installation').map((o) => o.targetId));
  const suppressedRegistrations = new Set(projectOverrides.filter((o) => o.kind === 'registration').map((o) => o.targetId));
  return (global.state?.installations ?? []).filter(
    (candidate) =>
      candidate.pluginId === installation.pluginId &&
      candidate.installationState === 'enabled' &&
      !suppressedInstallations.has(candidate.id) &&
      !(candidate.registrationId && suppressedRegistrations.has(candidate.registrationId)),
  );
}

/** Preflight an Installation Removal with its inherited-resumption disclosure. */
export async function preflightInstallationRemoval(
  scope: Scope,
  installationId: string,
  opts: RemovalFlowOptions = {},
): Promise<RemovalPreflightResult<InstallationRemovalPreflight>> {
  const OPERATION = 'Installation Removal';
  const trigger = `remove installation ${installationId}`;
  const read = await readBridgeState(scope, { cwd: opts.cwd, agentDir: opts.agentDir });
  if (read.status !== 'ok' && read.status !== 'missing') return persistenceBlocked(scope, OPERATION, trigger, read.error);
  const state = read.state!;

  const trust = trustFinding(scope);
  if (trust && opts.projectTrusted !== true) {
    const findings = [trust];
    return { ok: false, outcome: { status: 'blocked', findings, receipt: createReceipt({ operation: OPERATION, scope, trigger, expectedStateRevision: state.stateRevision, summary: 'Blocked', findings }) } };
  }

  const installation = state.installations.find((item) => item.id === installationId);
  if (!installation) {
    const findings: ValidationFinding[] = [
      blocking({ code: CODE.INSTALLATION_NOT_FOUND, rule: RULE.INSTALLATION_NOT_FOUND, target: 'installation', pointer: '', outcome: `Installation '${installationId}' is not in ${scope} Bridge State`, scope, phase: 'admission' }),
    ];
    return { ok: false, outcome: { status: 'blocked', findings, receipt: createReceipt({ operation: OPERATION, scope, trigger, expectedStateRevision: state.stateRevision, summary: 'Blocked', findings }) } };
  }

  const fence = await acquireAttemptFence(scope, { cwd: opts.cwd, agentDir: opts.agentDir, fenceTimeoutMs: opts.fenceTimeoutMs });
  if (!fence.ok) {
    const findings = [fence.finding!];
    return { ok: false, outcome: { status: 'blocked', findings, receipt: createReceipt({ operation: OPERATION, scope, trigger, expectedStateRevision: state.stateRevision, summary: 'Blocked', findings }) } };
  }

  const resuming = await resumingInherited(scope, installation, opts);

  return {
    ok: true,
    preflight: {
      scope,
      installation,
      registrationId: installation.registrationId,
      resumingInheritedInstallations: resuming,
      stateRevision: state.stateRevision,
      fence: fence.handle!,
      terminal: false,
    },
  };
}

/** Full disclosure for the confirmation surface. */
export function installationRemovalDisclosure(preflight: InstallationRemovalPreflight): string {
  const lines = [
    `Scope: ${preflight.scope}`,
    `Installation: ${JSON.stringify(preflight.installation.id)} · ${JSON.stringify(preflight.installation.pluginId)} · ${preflight.installation.installationState}`,
    `Registration retained: ${preflight.registrationId ? preflight.registrationId.slice(0, 8) + '…' : '(none)'}`,
    `State Revision: ${preflight.stateRevision}`,
  ];
  if (preflight.resumingInheritedInstallations.length > 0) {
    lines.push('Inherited Installations that become effective afterward:');
    for (const inherited of preflight.resumingInheritedInstallations) {
      lines.push(`  ${JSON.stringify(inherited.id)} · ${JSON.stringify(inherited.pluginId)}`);
    }
  } else {
    lines.push('No inherited Installation becomes effective afterward.');
  }
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
      scope: preflight.scope,
      trigger,
      expectedStateRevision: preflight.stateRevision,
      summary: 'Declined',
      findings: [],
      stateChanged: false,
    });
    preflight.fence.release();
    return { status: 'declined', receipt };
  }

  const fresh = await readBridgeState(preflight.scope, { cwd: opts.cwd, agentDir: opts.agentDir });
  if (fresh.status !== 'ok' && fresh.status !== 'missing') {
    preflight.fence.release();
    const findings: ValidationFinding[] = [
      blocking({ code: CODE.PERSISTENCE_INDETERMINATE, rule: 'PERSIST-01', target: 'attempt', pointer: '', outcome: fresh.error ?? 'Bridge State is not readable; neither previous nor target verifiable', scope: preflight.scope, phase: 'persistence' }),
    ];
    return { status: 'persistence-failed', isIndeterminate: true, receipt: createReceipt({ operation: OPERATION, scope: preflight.scope, trigger, expectedStateRevision: preflight.stateRevision, summary: 'Persistence Indeterminate', findings, stateChanged: false }) };
  }
  if (fresh.state!.stateRevision !== preflight.stateRevision || !fresh.state!.installations.some((i) => i.id === preflight.installation.id)) {
    const outcome = staleReceipt(OPERATION, preflight.scope, trigger, preflight.stateRevision, fresh.state!.stateRevision);
    preflight.fence.release();
    return outcome;
  }

  const write = await commitBridgeState(
    preflight.scope,
    (current) => ({
      ...current,
      installations: current.installations.filter((i) => i.id !== preflight.installation.id),
    }),
    { cwd: opts.cwd, agentDir: opts.agentDir, lockTimeoutMs: opts.fenceTimeoutMs, expectedStateRevision: preflight.stateRevision },
  );
  preflight.fence.release();
  if (write.isStale) return staleReceipt(OPERATION, preflight.scope, trigger, preflight.stateRevision, write.observedRevision);
  if (!write.success) return persistenceFailure(OPERATION, preflight.scope, trigger, preflight.stateRevision, write);

  const newRevision = write.newRevision!;
  // A removed Registration's pending Update Candidate pin is no longer meaningful (#22).
  if (preflight.registrationId) opts.cache?.clearPendingUpdate(preflight.scope, preflight.registrationId);
  return {
    status: 'completed',
    newRevision,
    receipt: createReceipt({
      operation: OPERATION,
      scope: preflight.scope,
      trigger,
      expectedStateRevision: preflight.stateRevision,
      targetStateRevision: newRevision,
      observedStateRevision: newRevision,
      summary: 'Completed',
      stateChanged: true,
    }),
  };
}
