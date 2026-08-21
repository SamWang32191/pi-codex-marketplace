/**
 * Plugin Installation lifecycle seam.
 *
 * A preflight holds the scope Attempt Fence and binds the exact State Revision plus Validation
 * Snapshot.  `Install Disabled` commits immediately after that disclosure; `Install and Enable`
 * and disabled → enabled require a separate, explicit Activation Confirmation.
 */

import type { CompatiblePlugin } from '../compatibility/profile.js';
import { commitBridgeState, readBridgeState } from '../bridge-state/store.js';
import type { Installation, Registration, Scope } from '../bridge-state/types.js';
import { CODE, RULE, blocking, hasBlocking, sortFindings, type ValidationFinding } from '../registration/findings.js';
import { acquireAttemptFence, type AttemptFenceHandle } from '../registration/fence.js';
import { createReceipt, type AttemptReceipt } from '../registration/receipt.js';
import type { ValidationSnapshot } from '../registration/snapshot.js';
import { inspectMarketplaceEntries } from './inspection.js';

export interface InstallationFlowOptions {
  cwd?: string;
  agentDir?: string;
  projectTrusted?: boolean;
  fenceTimeoutMs?: number;
  /** Integration synchronization seam; production callers leave this undefined. */
  beforeDisableCommit?: () => void | Promise<void>;
  beforeInstallationCommit?: () => void | Promise<void>;
}

export interface PluginInstallationPreflight {
  scope: Scope;
  registration: Registration;
  plugin: CompatiblePlugin;
  snapshot: ValidationSnapshot;
  stateRevision: string;
  findings: ValidationFinding[];
  /** Exact activation material rendered by the TUI before an Activation Confirmation. */
  disclosure: { plugin: CompatiblePlugin; projectedPrecedence: 'Pi → Project Scope → Global Scope'; findings: ValidationFinding[] };
  fence: AttemptFenceHandle;
  terminal: boolean;
  operation: 'install' | 'enable';
  existingInstallation?: Installation;
}

export type InstallationOutcome =
  | { status: 'completed'; installation: Installation; receipt: AttemptReceipt; newRevision: string }
  | { status: 'declined'; receipt: AttemptReceipt }
  | { status: 'blocked'; findings: ValidationFinding[]; receipt: AttemptReceipt }
  | { status: 'rejected-as-stale'; receipt: AttemptReceipt }
  | { status: 'persistence-failed'; receipt: AttemptReceipt; isIndeterminate: boolean };

export type InstallationPreflightResult =
  | { ok: true; preflight: PluginInstallationPreflight }
  | { ok: false; outcome: InstallationOutcome };

type LifecycleOperation = 'install' | 'enable' | 'disable';

function receiptOperation(operation: LifecycleOperation): string {
  return operation === 'install' ? 'Plugin Installation'
    : operation === 'enable' ? 'Plugin Enablement'
      : 'Plugin Disablement';
}

function triggerFor(operation: LifecycleOperation, registrationId: string, entryId: string): string {
  return operation === 'disable' ? `disable ${entryId}` : `${operation} ${registrationId}#${entryId}`;
}

function blocked(
  operation: LifecycleOperation,
  scope: Scope,
  registrationId: string,
  entryId: string,
  revision: string,
  findings: ValidationFinding[],
  fence: AttemptFenceHandle | null = null,
): InstallationPreflightResult {
  fence?.release();
  return {
    ok: false,
    outcome: {
      status: 'blocked',
      findings,
      receipt: createReceipt({
        operation: receiptOperation(operation),
        scope,
        trigger: triggerFor(operation, registrationId, entryId),
        expectedStateRevision: revision,
        summary: 'Blocked',
        findings,
      }),
    },
  };
}

function scopeDenied(scope: Scope, opts: InstallationFlowOptions): ValidationFinding | undefined {
  if (scope !== 'project' || opts.projectTrusted === true) return undefined;
  return blocking({
    code: CODE.PROJECT_TRUST_DENIED,
    rule: RULE.PROJECT_TRUST_DENIED,
    target: 'installation',
    pointer: '',
    outcome: 'Project Trust is not granted by the Pi host; no Project Scope Lifecycle Operation may mutate Bridge State',
    scope,
    phase: 'admission',
  });
}

function operationFinding(
  scope: Scope,
  code: string,
  rule: string,
  outcome: string,
  target: ValidationFinding['target'] = 'installation',
  phase: ValidationFinding['phase'] = 'validation',
): ValidationFinding {
  return blocking({ code, rule, target, pointer: '', outcome, scope, phase });
}

async function makePreflight(
  scope: Scope,
  registrationId: string,
  entryPointer: string,
  opts: InstallationFlowOptions,
  operation: 'install' | 'enable',
  existingInstallation?: Installation,
): Promise<InstallationPreflightResult> {
  const read = await readBridgeState(scope, { cwd: opts.cwd, agentDir: opts.agentDir });
  if (read.status !== 'ok' && read.status !== 'missing') {
    const receipt = createReceipt({
      operation: receiptOperation(operation),
      scope,
      trigger: triggerFor(operation, registrationId, entryPointer),
      expectedStateRevision: '?',
      summary: 'Persistence Indeterminate',
      findings: [operationFinding(scope, CODE.PERSISTENCE_INDETERMINATE, 'PERSIST-01', read.error ?? 'Bridge State is not readable', 'attempt', 'persistence')],
    });
    return { ok: false, outcome: { status: 'persistence-failed', receipt, isIndeterminate: true } };
  }
  const state = read.state!;
  const trust = scopeDenied(scope, opts);
  if (trust) return blocked(operation, scope, registrationId, entryPointer, state.stateRevision, [trust]);
  const registration = state.registrations.find((item) => item.id === registrationId);
  if (!registration) {
    return blocked(operation, scope, registrationId, entryPointer, state.stateRevision, [
      operationFinding(scope, CODE.INSTALLATION_NOT_FOUND, RULE.INSTALLATION_NOT_FOUND, `Registration '${registrationId}' is not in ${scope} Bridge State`, 'registration'),
    ]);
  }
  if (registration.sourceKind !== 'local' || !registration.source) {
    return blocked(operation, scope, registrationId, entryPointer, state.stateRevision, [
      operationFinding(scope, CODE.SOURCE_REACQUISITION_REQUIRED, RULE.SOURCE_REACQUISITION_REQUIRED, 'This Registration has no retained local Validation Snapshot tree; Git Installation waits for the Source Cache lifecycle', 'registration'),
    ]);
  }

  const fenceResult = await acquireAttemptFence(scope, { cwd: opts.cwd, agentDir: opts.agentDir, fenceTimeoutMs: opts.fenceTimeoutMs });
  if (!fenceResult.ok) return blocked(operation, scope, registrationId, entryPointer, state.stateRevision, [fenceResult.finding!]);
  const fence = fenceResult.handle!;

  try {
    const inspection = inspectMarketplaceEntries(registration, scope);
    const inspected = inspection.entries.find((item) => item.entry.entryId === entryPointer);
    const rejectedFindings = inspected?.findings ?? (inspection.findings.length > 0 ? inspection.findings : [
      operationFinding(scope, CODE.INSTALLATION_NOT_FOUND, RULE.INSTALLATION_NOT_FOUND, `Marketplace Entry '${entryPointer}' is Unavailable`, 'entry'),
    ]);
    if (!inspected || !inspection.snapshot || !inspected.plugin || inspected.unavailableReason || hasBlocking(inspected.findings)) {
      return blocked(operation, scope, registrationId, entryPointer, state.stateRevision, rejectedFindings, fence);
    }
    const findings = inspected.findings;
    const plugin = inspected.plugin;
    const installationId = `${scope}/${plugin.id}`;
    const currentInstallation = state.installations.find((item) => item.id === installationId);
    if (operation === 'install' && currentInstallation) {
      return blocked(operation, scope, registrationId, entryPointer, state.stateRevision, [
        operationFinding(scope, CODE.INSTALLATION_ALREADY_EXISTS, RULE.INSTALLATION_ALREADY_EXISTS, `Installation '${installationId}' already exists; use enable or disable lifecycle actions`),
      ], fence);
    }
    if (operation === 'enable' && (!currentInstallation || currentInstallation.installationState !== 'disabled')) {
      return blocked(operation, scope, registrationId, entryPointer, state.stateRevision, [
        operationFinding(scope, CODE.INSTALLATION_NOT_FOUND, RULE.INSTALLATION_NOT_FOUND, `Disabled Installation '${installationId}' is no longer current`),
      ], fence);
    }
    return {
      ok: true,
      preflight: {
        scope,
        registration,
        plugin,
        snapshot: inspection.snapshot,
        stateRevision: state.stateRevision,
        findings,
        disclosure: { plugin, projectedPrecedence: 'Pi → Project Scope → Global Scope', findings },
        fence,
        terminal: false,
        operation,
        existingInstallation: currentInstallation,
      },
    };
  } catch (error) {
    return blocked(operation, scope, registrationId, entryPointer, state.stateRevision, [
      operationFinding(scope, CODE.INSTALLATION_NOT_FOUND, RULE.INSTALLATION_NOT_FOUND, error instanceof Error ? error.message : String(error)),
    ], fence);
  }
}

/** Quote all Marketplace-controlled text so one value can never create a new disclosure line. */
function disclosureText(value: string): string {
  return JSON.stringify(value);
}

export function installationDisclosure(preflight: PluginInstallationPreflight): string {
  const plugin = preflight.plugin;
  const lines = [
    `Scope: ${preflight.scope}`,
    `Plugin: ${disclosureText(plugin.manifestName)} (${disclosureText(plugin.id)})`,
    `Source: ${disclosureText(preflight.registration.source ?? preflight.registration.canonicalLocator ?? 'unavailable')}`,
    `Marketplace Entry: ${disclosureText(plugin.marketplaceEntryId)}`,
    `State Revision: ${preflight.stateRevision}`,
    `Validation Snapshot: ${preflight.snapshot.fingerprint.slice(0, 16)}…`,
    `Classification: Compatible`,
    `Projected precedence: Pi → Project Scope → Global Scope`,
    `Skills: ${plugin.skills.length}`,
  ];
  for (const skill of plugin.skills) {
    lines.push(`  ${disclosureText(skill.name)} · ${skill.invocationPolicy} · resources: ${skill.resources.length === 0 ? 'none' : skill.resources.map(disclosureText).join(', ')}`);
  }
  lines.push(`Findings: ${preflight.findings.length === 0 ? 'none' : preflight.findings.map((finding) => `${finding.classification} ${finding.code}: ${disclosureText(finding.outcome)}`).join(' | ')}`);
  return lines.join('\n');
}

export async function preflightPluginInstallation(
  scope: Scope,
  registrationId: string,
  entryPointer: string,
  opts: InstallationFlowOptions = {},
): Promise<InstallationPreflightResult> {
  return makePreflight(scope, registrationId, entryPointer, opts, 'install');
}

function rejectedAsStale(preflight: PluginInstallationPreflight, outcome: string): InstallationOutcome {
  preflight.fence.release();
  return {
    status: 'rejected-as-stale',
    receipt: createReceipt({
      operation: receiptOperation(preflight.operation),
      scope: preflight.scope,
      trigger: triggerFor(preflight.operation, preflight.registration.id, preflight.plugin.marketplaceEntryId),
      expectedStateRevision: preflight.stateRevision,
      validationSnapshot: preflight.snapshot.fingerprint,
      summary: 'Rejected as Stale',
      findings: [blocking({
        code: CODE.REJECTED_AS_STALE,
        rule: RULE.REJECTED_AS_STALE,
        target: 'installation',
        pointer: '',
        outcome,
        scope: preflight.scope,
        phase: 'persistence',
      })],
    }),
  };
}

/** Confirm either path. Enabled state is impossible without explicit Activation Confirmation. */
export async function confirmPluginInstallation(
  preflight: PluginInstallationPreflight,
  targetState: 'enabled' | 'disabled',
  activationConfirmedOrOpts: boolean | InstallationFlowOptions = false,
  maybeOpts: InstallationFlowOptions = {},
): Promise<InstallationOutcome> {
  const activationConfirmed = typeof activationConfirmedOrOpts === 'boolean' ? activationConfirmedOrOpts : false;
  const opts = typeof activationConfirmedOrOpts === 'boolean' ? maybeOpts : activationConfirmedOrOpts;
  if (preflight.terminal) {
    const result = blocked(preflight.operation, preflight.scope, preflight.registration.id, preflight.plugin.marketplaceEntryId, preflight.stateRevision, [
      operationFinding(preflight.scope, CODE.ATTEMPT_IN_PROGRESS, RULE.ATTEMPT_IN_PROGRESS, 'attempt already reached a terminal outcome', 'attempt', 'admission'),
    ]);
    if (!result.ok) return result.outcome;
    throw new Error('unreachable blocked Installation preflight result');
  }
  preflight.terminal = true;
  if (targetState === 'enabled' && !activationConfirmed) {
    preflight.fence.release();
    return {
      status: 'declined',
      receipt: createReceipt({
        operation: receiptOperation(preflight.operation),
        scope: preflight.scope,
        trigger: triggerFor(preflight.operation, preflight.registration.id, preflight.plugin.marketplaceEntryId),
        expectedStateRevision: preflight.stateRevision,
        validationSnapshot: preflight.snapshot.fingerprint,
        summary: 'Declined',
        findings: [blocking({
          code: CODE.ACTIVATION_CONFIRMATION_REQUIRED,
          rule: RULE.ACTIVATION_CONFIRMATION_REQUIRED,
          target: 'installation',
          pointer: '',
          outcome: 'Install and Enable requires a separate explicit Activation Confirmation (default No)',
          scope: preflight.scope,
          phase: 'admission',
        })],
      }),
    };
  }
  const current = await readBridgeState(preflight.scope, { cwd: opts.cwd, agentDir: opts.agentDir });
  if (current.status !== 'ok' && current.status !== 'missing') {
    preflight.fence.release();
    return { status: 'persistence-failed', isIndeterminate: true, receipt: createReceipt({ operation: receiptOperation(preflight.operation), scope: preflight.scope, trigger: triggerFor(preflight.operation, preflight.registration.id, preflight.plugin.marketplaceEntryId), expectedStateRevision: preflight.stateRevision, validationSnapshot: preflight.snapshot.fingerprint, summary: 'Persistence Indeterminate', findings: [operationFinding(preflight.scope, CODE.PERSISTENCE_INDETERMINATE, 'PERSIST-01', current.error ?? 'Bridge State is not readable', 'attempt', 'persistence')] }) };
  }
  if (current.state!.stateRevision !== preflight.stateRevision) {
    return rejectedAsStale(preflight, 'State Revision changed since Installation disclosure; re-run preflight and confirmation');
  }
  const fresh = inspectMarketplaceEntries(preflight.registration, preflight.scope);
  if (!fresh.snapshot || fresh.snapshot.fingerprint !== preflight.snapshot.fingerprint) {
    return rejectedAsStale(preflight, 'Validation Snapshot changed since Installation disclosure; re-run preflight and confirmation');
  }
  const installation: Installation = {
    id: `${preflight.scope}/${preflight.plugin.id}`,
    pluginId: preflight.plugin.id,
    installationState: targetState,
    registrationId: preflight.registration.id,
    marketplaceEntryId: preflight.plugin.marketplaceEntryId,
    validationSnapshot: preflight.snapshot.fingerprint,
    snapshotBinds: { profile: preflight.snapshot.profile, ruleset: preflight.snapshot.ruleset, budget: preflight.snapshot.budget },
    manifestName: preflight.plugin.manifestName,
  };
  await opts.beforeInstallationCommit?.();
  const write = await commitBridgeState(preflight.scope, (state) => ({
    ...state,
    installations: preflight.operation === 'enable'
      ? state.installations.map((item) => item.id === installation.id ? installation : item)
      : [...state.installations, installation],
  }), { cwd: opts.cwd, agentDir: opts.agentDir, lockTimeoutMs: opts.fenceTimeoutMs, expectedStateRevision: preflight.stateRevision });
  if (write.isStale) return rejectedAsStale(preflight, 'State Revision changed after Installation confirmation; re-run preflight and confirmation');
  preflight.fence.release();
  if (!write.success) {
    const summary = write.isIndeterminate ? 'Persistence Indeterminate' : 'Persistence Failed';
    return {
      status: 'persistence-failed',
      isIndeterminate: write.isIndeterminate ?? false,
      receipt: createReceipt({ operation: receiptOperation(preflight.operation), scope: preflight.scope, trigger: triggerFor(preflight.operation, preflight.registration.id, preflight.plugin.marketplaceEntryId), expectedStateRevision: preflight.stateRevision, validationSnapshot: preflight.snapshot.fingerprint, summary, findings: [] }),
    };
  }
  return {
    status: 'completed',
    installation,
    newRevision: write.newRevision!,
    receipt: createReceipt({ operation: receiptOperation(preflight.operation), scope: preflight.scope, trigger: triggerFor(preflight.operation, preflight.registration.id, preflight.plugin.marketplaceEntryId), expectedStateRevision: preflight.stateRevision, targetStateRevision: write.newRevision, observedStateRevision: write.newRevision, validationSnapshot: preflight.snapshot.fingerprint, summary: preflight.findings.length > 0 ? 'Completed with diagnostics' : 'Completed', findings: preflight.findings, stateChanged: true }),
  };
}

export async function preflightPluginEnable(scope: Scope, installationId: string, opts: InstallationFlowOptions = {}): Promise<InstallationPreflightResult> {
  const read = await readBridgeState(scope, { cwd: opts.cwd, agentDir: opts.agentDir });
  if (read.status !== 'ok' && read.status !== 'missing') {
    const receipt = createReceipt({ operation: receiptOperation('enable'), scope, trigger: `enable ${installationId}`, expectedStateRevision: '?', summary: 'Persistence Indeterminate', findings: [operationFinding(scope, CODE.PERSISTENCE_INDETERMINATE, 'PERSIST-01', read.error ?? 'Bridge State is not readable', 'attempt', 'persistence')] });
    return { ok: false, outcome: { status: 'persistence-failed', receipt, isIndeterminate: true } };
  }
  const existing = read.state?.installations.find((item) => item.id === installationId);
  if (!existing?.registrationId || !existing.marketplaceEntryId) {
    return blocked('enable', scope, 'unknown', installationId, read.state?.stateRevision ?? '?', [
      operationFinding(scope, CODE.INSTALLATION_NOT_FOUND, RULE.INSTALLATION_NOT_FOUND, `Disabled Installation '${installationId}' has no revalidatable provenance`),
    ]);
  }
  const prefix = `${existing.registrationId}/`;
  const entryPointer = existing.marketplaceEntryId.startsWith(prefix)
    ? existing.marketplaceEntryId.slice(existing.marketplaceEntryId.indexOf('/plugins/'))
    : existing.marketplaceEntryId;
  return makePreflight(scope, existing.registrationId, entryPointer, opts, 'enable', existing);
}

export async function confirmPluginEnable(preflight: PluginInstallationPreflight, activationConfirmed: boolean, opts: InstallationFlowOptions = {}): Promise<InstallationOutcome> {
  return confirmPluginInstallation(preflight, 'enabled', activationConfirmed, opts);
}

export async function disablePluginInstallation(scope: Scope, installationId: string, opts: InstallationFlowOptions = {}): Promise<InstallationOutcome> {
  const trust = scopeDenied(scope, opts);
  if (trust) {
    const result = blocked('disable', scope, 'unknown', installationId, '?', [trust]);
    if (!result.ok) return result.outcome;
    throw new Error('unreachable blocked Installation preflight result');
  }
  const fence = await acquireAttemptFence(scope, { cwd: opts.cwd, agentDir: opts.agentDir, fenceTimeoutMs: opts.fenceTimeoutMs });
  if (!fence.ok) {
    const result = blocked('disable', scope, 'unknown', installationId, '?', [fence.finding!]);
    if (!result.ok) return result.outcome;
    throw new Error('unreachable blocked Installation preflight result');
  }
  const read = await readBridgeState(scope, { cwd: opts.cwd, agentDir: opts.agentDir });
  if (read.status !== 'ok' && read.status !== 'missing') {
    fence.handle!.release();
    return { status: 'persistence-failed', isIndeterminate: true, receipt: createReceipt({ operation: receiptOperation('disable'), scope, trigger: triggerFor('disable', 'unknown', installationId), expectedStateRevision: '?', summary: 'Persistence Indeterminate', findings: [operationFinding(scope, CODE.PERSISTENCE_INDETERMINATE, 'PERSIST-01', read.error ?? 'Bridge State is not readable', 'attempt', 'persistence')] }) };
  }
  const state = read.state!;
  const installation = state.installations.find((item) => item.id === installationId);
  if (!installation) {
    const result = blocked('disable', scope, 'unknown', installationId, state.stateRevision, [operationFinding(scope, CODE.INSTALLATION_NOT_FOUND, RULE.INSTALLATION_NOT_FOUND, `Installation '${installationId}' was not found`)], fence.handle!);
    if (!result.ok) return result.outcome;
    throw new Error('unreachable blocked Installation preflight result');
  }
  await opts.beforeDisableCommit?.();
  const write = await commitBridgeState(scope, (state) => ({
    ...state,
    installations: state.installations.map((item) => item.id === installationId ? { ...item, installationState: 'disabled' } : item),
  }), { cwd: opts.cwd, agentDir: opts.agentDir, lockTimeoutMs: opts.fenceTimeoutMs, expectedStateRevision: state.stateRevision });
  fence.handle!.release();
  if (write.isStale) {
    return {
      status: 'rejected-as-stale',
      receipt: createReceipt({
        operation: receiptOperation('disable'),
        scope,
        trigger: triggerFor('disable', 'unknown', installationId),
        expectedStateRevision: state.stateRevision,
        observedStateRevision: write.observedRevision,
        summary: 'Rejected as Stale',
        findings: [operationFinding(scope, CODE.REJECTED_AS_STALE, RULE.REJECTED_AS_STALE, 'State Revision changed after disablement admission; re-run the lifecycle operation', 'installation', 'persistence')],
      }),
    };
  }
  if (!write.success) {
    return { status: 'persistence-failed', isIndeterminate: write.isIndeterminate ?? false, receipt: createReceipt({ operation: receiptOperation('disable'), scope, trigger: triggerFor('disable', 'unknown', installationId), expectedStateRevision: state.stateRevision, summary: write.isIndeterminate ? 'Persistence Indeterminate' : 'Persistence Failed' }) };
  }
  const disabled = { ...installation, installationState: 'disabled' as const };
  return { status: 'completed', installation: disabled, newRevision: write.newRevision!, receipt: createReceipt({ operation: receiptOperation('disable'), scope, trigger: triggerFor('disable', 'unknown', installationId), expectedStateRevision: state.stateRevision, targetStateRevision: write.newRevision, observedStateRevision: write.newRevision, summary: 'Completed', stateChanged: true }) };
}
