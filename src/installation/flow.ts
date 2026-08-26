/**
 * Plugin Installation lifecycle seam.
 *
 * A preflight holds the Attempt Fence and binds the exact State Revision plus Validation
 * Snapshot. `Install Disabled` commits immediately after that disclosure; `Install and Enable`
 * and disabled → enabled require a separate, explicit Activation Confirmation.
 */

import type { CompatiblePlugin } from '../compatibility/profile.js';
import { commitBridgeState, readBridgeState } from '../bridge-state/store.js';
import type { Installation, Registration } from '../bridge-state/types.js';
import { CODE, RULE, blocking, hasBlocking, sortFindings, type ValidationFinding } from '../registration/findings.js';
import { acquireAttemptFence, type AttemptFenceHandle } from '../registration/fence.js';
import { createReceipt, type AttemptReceipt } from '../registration/receipt.js';
import { appendReceipt } from '../journal/journal.js';
import type { SourceCache } from '../cache/source-cache.js';
import type { ValidationSnapshot } from '../registration/snapshot.js';
import { inspectMarketplaceEntries } from './inspection.js';

export interface InstallationFlowOptions {
  agentDir?: string;
  cache?: SourceCache;
  fenceTimeoutMs?: number;
  /** State Revision bound to a structured intent or disclosed before disablement Commit. */
  expectedStateRevision?: string;
  /** Complete Marketplace Entry identity bound to a structured installation intent. */
  expectedMarketplaceEntryId?: string;
  /** Exact presentation inspection fingerprint bound to the selected Marketplace Entry. */
  expectedValidationSnapshot?: string;
  /** Installation state from which a structured state-change intent was selected. */
  expectedInstallationState?: Installation['installationState'];
  /** Integration synchronization seam; production callers leave this undefined. */
  beforeDisableCommit?: () => void | Promise<void>;
  beforeInstallationCommit?: () => void | Promise<void>;
}

export interface PluginInstallationPreflight {
  registration: Registration;
  plugin: CompatiblePlugin;
  snapshot: ValidationSnapshot;
  stateRevision: string;
  findings: ValidationFinding[];
  /** Exact activation material rendered by the TUI before an Activation Confirmation. */
  disclosure: { plugin: CompatiblePlugin; projectedPrecedence: 'Pi → Global'; findings: ValidationFinding[] };
  fence: AttemptFenceHandle;
  terminal: boolean;
  operation: 'install' | 'enable';
  existingInstallation?: Installation;
}

export interface PluginDisablePreflight {
  installation: Installation;
  stateRevision: string;
  fence: AttemptFenceHandle;
  terminal: boolean;
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

export type InstallationDisablePreflightResult =
  | { ok: true; preflight: PluginDisablePreflight }
  | { ok: false; outcome: InstallationOutcome };

type LifecycleOperation = 'install' | 'enable' | 'disable';

function receiptOperation(operation: LifecycleOperation): string {
  return operation === 'install' ? 'Plugin Installation'
    : operation === 'enable' ? 'Plugin Enablement'
      : 'Plugin Disablement';
}

function triggerFor(operation: LifecycleOperation, registrationId: string, entryId: string): string {
  return operation === 'disable' || registrationId === 'unknown' || entryId.startsWith(`${registrationId}/`)
    ? `${operation} ${entryId}`
    : `${operation} ${registrationId}#${entryId}`;
}

async function blocked(
  operation: LifecycleOperation,
  registrationId: string,
  entryId: string,
  revision: string,
  findings: ValidationFinding[],
  fence: AttemptFenceHandle | null = null,
  opts: InstallationFlowOptions = {},
): Promise<InstallationPreflightResult> {
  fence?.release();
  const receipt = createReceipt({
    operation: receiptOperation(operation),
    trigger: triggerFor(operation, registrationId, entryId),
    expectedStateRevision: revision,
    summary: 'Blocked',
    findings,
  });
  await appendReceipt(receipt, { agentDir: opts.agentDir });
  return {
    ok: false,
    outcome: {
      status: 'blocked',
      findings,
      receipt,
    },
  };
}

async function stalePreflight(
  operation: LifecycleOperation,
  registrationId: string,
  entryId: string,
  expectedStateRevision: string,
  observedStateRevision: string,
  outcome: string,
  opts: InstallationFlowOptions,
  fence: AttemptFenceHandle | null = null,
): Promise<{ ok: false; outcome: Extract<InstallationOutcome, { status: 'rejected-as-stale' }> }> {
  fence?.release();
  const receipt = createReceipt({
    operation: receiptOperation(operation),
    trigger: triggerFor(operation, registrationId, entryId),
    expectedStateRevision,
    observedStateRevision,
    validationSnapshot: opts.expectedValidationSnapshot,
    summary: 'Rejected as Stale',
    findings: [operationFinding(
      CODE.REJECTED_AS_STALE,
      RULE.REJECTED_AS_STALE,
      outcome,
      'installation',
      'admission',
    )],
  });
  await appendReceipt(receipt, { agentDir: opts.agentDir });
  return { ok: false, outcome: { status: 'rejected-as-stale', receipt } };
}

function operationFinding(
  code: string,
  rule: string,
  outcome: string,
  target: ValidationFinding['target'] = 'installation',
  phase: ValidationFinding['phase'] = 'validation',
): ValidationFinding {
  return blocking({ code, rule, target, pointer: '', outcome, phase });
}

async function makePreflight(
  registrationId: string,
  entryPointer: string,
  opts: InstallationFlowOptions,
  operation: 'install' | 'enable',
  existingInstallation?: Installation,
): Promise<InstallationPreflightResult> {
  const intentEntryId = opts.expectedMarketplaceEntryId ?? entryPointer;
  const read = await readBridgeState({ agentDir: opts.agentDir });
  if (read.status !== 'ok' && read.status !== 'missing') {
    const receipt = createReceipt({
      operation: receiptOperation(operation),
      trigger: triggerFor(operation, registrationId, intentEntryId),
      expectedStateRevision: opts.expectedStateRevision ?? '?',
      summary: 'Persistence Indeterminate',
      findings: [operationFinding(CODE.PERSISTENCE_INDETERMINATE, 'PERSIST-01', read.error ?? 'Bridge State is not readable', 'attempt', 'persistence')],
    });
    await appendReceipt(receipt, { agentDir: opts.agentDir });
    return { ok: false, outcome: { status: 'persistence-failed', receipt, isIndeterminate: true } };
  }
  const state = read.state!;
  if (
    opts.expectedStateRevision !== undefined
    && state.stateRevision !== opts.expectedStateRevision
  ) {
    return stalePreflight(
      operation,
      registrationId,
      intentEntryId,
      opts.expectedStateRevision,
      state.stateRevision,
      'State Revision changed since the Marketplace Entry intent was selected; reopen the Bridge Ledger',
      opts,
    );
  }
  const registration = state.registrations.find((item) => item.id === registrationId);
  if (!registration) {
    return blocked(operation, registrationId, intentEntryId, state.stateRevision, [
      operationFinding(CODE.INSTALLATION_NOT_FOUND, RULE.INSTALLATION_NOT_FOUND, `Registration '${registrationId}' is not in Bridge State`, 'registration'),
    ], null, opts);
  }

  const fenceResult = await acquireAttemptFence({ agentDir: opts.agentDir, fenceTimeoutMs: opts.fenceTimeoutMs });
  if (!fenceResult.ok) return blocked(operation, registrationId, intentEntryId, state.stateRevision, [fenceResult.finding!], null, opts);
  const fence = fenceResult.handle!;

  try {
    const inspection = inspectMarketplaceEntries(registration, {
      agentDir: opts.agentDir,
      cache: opts.cache,
    });
    const inspected = inspection.entries.find((item) => item.entry.entryId === entryPointer);
    const observedMarketplaceEntryId = inspected && inspection.marketplaceId
      ? `${inspection.marketplaceId}${inspected.entry.entryId}`
      : undefined;
    if (opts.expectedMarketplaceEntryId !== undefined && observedMarketplaceEntryId === undefined) {
      const findings = inspection.findings.length > 0
        ? inspection.findings
        : [operationFinding(
            CODE.INSTALLATION_NOT_FOUND,
            RULE.INSTALLATION_NOT_FOUND,
            `Marketplace Entry '${entryPointer}' is Unavailable`,
            'entry',
          )];
      return blocked(operation, registrationId, intentEntryId, state.stateRevision, findings, fence, opts);
    }
    if (
      opts.expectedMarketplaceEntryId !== undefined
      && observedMarketplaceEntryId !== opts.expectedMarketplaceEntryId
    ) {
      return stalePreflight(
        operation,
        registrationId,
        intentEntryId,
        opts.expectedStateRevision ?? state.stateRevision,
        state.stateRevision,
        'Marketplace Entry identity changed since the intent was selected; reopen the Bridge Ledger',
        opts,
        fence,
      );
    }
    const rejectedFindings = inspected && inspected.findings.length > 0
      ? inspected.findings
      : inspection.findings.length > 0
        ? inspection.findings
        : [operationFinding(
            CODE.INSTALLATION_NOT_FOUND,
            RULE.INSTALLATION_NOT_FOUND,
            `Marketplace Entry '${entryPointer}' is Unavailable` +
              (inspected?.unavailableReason ? `: ${inspected.unavailableReason}` : ''),
            'entry',
          )];
    if (!inspected || !inspection.snapshot || !inspected.plugin || inspected.unavailableReason || hasBlocking(inspected.findings)) {
      return blocked(operation, registrationId, intentEntryId, state.stateRevision, rejectedFindings, fence, opts);
    }
    if (
      opts.expectedValidationSnapshot !== undefined
      && inspection.snapshot.fingerprint !== opts.expectedValidationSnapshot
    ) {
      return stalePreflight(
        operation,
        registrationId,
        intentEntryId,
        opts.expectedStateRevision ?? state.stateRevision,
        state.stateRevision,
        'Validation Snapshot changed since the Marketplace Entry intent was selected; reopen the Bridge Ledger',
        opts,
        fence,
      );
    }
    const findings = inspected.findings;
    const plugin = inspected.plugin;
    // Canonical Installation ID is the Plugin ID itself (Global-only); legacy documents may
    // still persist the retired '<scope>/<pluginId>' form and remain recognizable by pluginId.
    const installationId = plugin.id;
    const currentInstallation = state.installations.find((item) => item.pluginId === plugin.id);
    if (operation === 'install' && currentInstallation) {
      return blocked(operation, registrationId, intentEntryId, state.stateRevision, [
        operationFinding(CODE.INSTALLATION_ALREADY_EXISTS, RULE.INSTALLATION_ALREADY_EXISTS, `Installation '${currentInstallation.id}' already exists; use enable or disable lifecycle actions`),
      ], fence, opts);
    }
    if (operation === 'enable' && (!currentInstallation || currentInstallation.installationState !== 'disabled')) {
      return blocked(operation, registrationId, intentEntryId, state.stateRevision, [
        operationFinding(CODE.INSTALLATION_NOT_FOUND, RULE.INSTALLATION_NOT_FOUND, `Disabled Installation '${installationId}' is no longer current`),
      ], fence, opts);
    }
    return {
      ok: true,
      preflight: {
        registration,
        plugin,
        snapshot: inspection.snapshot,
        stateRevision: state.stateRevision,
        findings,
        disclosure: { plugin, projectedPrecedence: 'Pi → Global', findings },
        fence,
        terminal: false,
        operation,
        existingInstallation: currentInstallation,
      },
    };
  } catch (error) {
    return blocked(operation, registrationId, intentEntryId, state.stateRevision, [
      operationFinding(CODE.INSTALLATION_NOT_FOUND, RULE.INSTALLATION_NOT_FOUND, error instanceof Error ? error.message : String(error)),
    ], fence, opts);
  }
}

function disclosureText(value: string): string {
  return JSON.stringify(value);
}

export function installationDisclosure(preflight: PluginInstallationPreflight): string {
  const plugin = preflight.plugin;
  const lines = [
    `Plugin: ${disclosureText(plugin.manifestName)} (${disclosureText(plugin.id)})`,
    `Source: ${disclosureText(preflight.registration.source ?? preflight.registration.canonicalLocator ?? 'unavailable')}`,
    `Marketplace Entry: ${disclosureText(plugin.marketplaceEntryId)}`,
    `State Revision: ${preflight.stateRevision}`,
    `Validation Snapshot: ${preflight.snapshot.fingerprint.slice(0, 16)}…`,
    `Classification: Compatible`,
    `Projected precedence: Pi → Global`,
    `Skills: ${plugin.skills.length}`,
  ];
  for (const skill of plugin.skills) {
    lines.push(`  ${disclosureText(skill.name)} · ${skill.invocationPolicy} · resources: ${skill.resources.length === 0 ? 'none' : skill.resources.map(disclosureText).join(', ')}`);
  }
  lines.push(`Findings: ${preflight.findings.length === 0 ? 'none' : preflight.findings.map((finding) => `${finding.classification} ${finding.code}: ${disclosureText(finding.outcome)}`).join(' | ')}`);
  return lines.join('\n');
}

export async function preflightPluginInstallation(
  registrationId: string,
  entryPointer: string,
  opts: InstallationFlowOptions = {},
): Promise<InstallationPreflightResult> {
  return makePreflight(registrationId, entryPointer, opts, 'install');
}

async function rejectedAsStale(
  preflight: PluginInstallationPreflight,
  outcome: string,
  observedStateRevision: string | undefined,
  opts: InstallationFlowOptions = {},
): Promise<InstallationOutcome> {
  const receipt = createReceipt({
    operation: receiptOperation(preflight.operation),
    trigger: triggerFor(preflight.operation, preflight.registration.id, preflight.plugin.marketplaceEntryId),
    expectedStateRevision: preflight.stateRevision,
    observedStateRevision,
    validationSnapshot: preflight.snapshot.fingerprint,
    summary: 'Rejected as Stale',
    findings: [blocking({
      code: CODE.REJECTED_AS_STALE,
      rule: RULE.REJECTED_AS_STALE,
      target: 'installation',
      pointer: '',
      outcome,
      phase: 'persistence',
    })],
  });
  await appendReceipt(receipt, { agentDir: opts.agentDir });
  return {
    status: 'rejected-as-stale',
    receipt,
  };
}

/**
 * Finalize a disclosed Installation/Enablement preflight after presentation cancellation.
 * Esc declines the transaction itself, including Install Disabled, and must never commit.
 */
export async function declinePluginInstallation(
  preflight: PluginInstallationPreflight,
  opts: InstallationFlowOptions = {},
): Promise<InstallationOutcome> {
  if (preflight.terminal) {
    const result = await blocked(
      preflight.operation,
      preflight.registration.id,
      preflight.plugin.marketplaceEntryId,
      preflight.stateRevision,
      [operationFinding(
        CODE.ATTEMPT_IN_PROGRESS,
        RULE.ATTEMPT_IN_PROGRESS,
        'attempt already reached a terminal outcome',
        'attempt',
        'admission',
      )],
      null,
      opts,
    );
    if (!result.ok) return result.outcome;
    throw new Error('unreachable blocked Installation cancellation result');
  }

  preflight.terminal = true;
  preflight.fence.release();
  const receipt = createReceipt({
    operation: receiptOperation(preflight.operation),
    trigger: triggerFor(
      preflight.operation,
      preflight.registration.id,
      preflight.plugin.marketplaceEntryId,
    ),
    expectedStateRevision: preflight.stateRevision,
    validationSnapshot: preflight.snapshot.fingerprint,
    summary: 'Declined',
    findings: preflight.findings,
    stateChanged: false,
  });
  await appendReceipt(receipt, { agentDir: opts.agentDir });
  return { status: 'declined', receipt };
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
    const result = await blocked(
      preflight.operation,
      preflight.registration.id,
      preflight.plugin.marketplaceEntryId,
      preflight.stateRevision,
      [operationFinding(
        CODE.ATTEMPT_IN_PROGRESS,
        RULE.ATTEMPT_IN_PROGRESS,
        'attempt already reached a terminal outcome',
        'attempt',
        'admission',
      )],
      null,
      opts,
    );
    if (!result.ok) return result.outcome;
    throw new Error('unreachable blocked Installation preflight result');
  }
  preflight.terminal = true;
  try {
    if (targetState === 'enabled' && !activationConfirmed) {
      const receipt = createReceipt({
        operation: receiptOperation(preflight.operation),
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
          phase: 'admission',
        })],
      });
      await appendReceipt(receipt, { agentDir: opts.agentDir });
      return {
        status: 'declined',
        receipt,
      };
    }
    const current = await readBridgeState({ agentDir: opts.agentDir });
    if (current.status !== 'ok' && current.status !== 'missing') {
      const receipt = createReceipt({
        operation: receiptOperation(preflight.operation),
        trigger: triggerFor(preflight.operation, preflight.registration.id, preflight.plugin.marketplaceEntryId),
        expectedStateRevision: preflight.stateRevision,
        validationSnapshot: preflight.snapshot.fingerprint,
        summary: 'Persistence Indeterminate',
        findings: [operationFinding(
          CODE.PERSISTENCE_INDETERMINATE,
          'PERSIST-01',
          current.error ?? 'Bridge State is not readable',
          'attempt',
          'persistence',
        )],
      });
      await appendReceipt(receipt, { agentDir: opts.agentDir });
      return { status: 'persistence-failed', isIndeterminate: true, receipt };
    }
    if (current.state!.stateRevision !== preflight.stateRevision) {
      return rejectedAsStale(
        preflight,
        'State Revision changed since Installation disclosure; re-run preflight and confirmation',
        current.state!.stateRevision,
        opts,
      );
    }
    const fresh = inspectMarketplaceEntries(preflight.registration, {
      agentDir: opts.agentDir,
      cache: opts.cache,
    });
    if (!fresh.snapshot || fresh.snapshot.fingerprint !== preflight.snapshot.fingerprint) {
      return rejectedAsStale(
        preflight,
        'Validation Snapshot changed since Installation disclosure; re-run preflight and confirmation',
        current.state!.stateRevision,
        opts,
      );
    }
    const installation: Installation = {
      // Preserve the persisted Installation ID when re-enabling a legacy-recorded Installation;
      // fresh Installations use the canonical Plugin-ID-only form.
      id: preflight.existingInstallation?.id ?? preflight.plugin.id,
      pluginId: preflight.plugin.id,
      installationState: targetState,
      registrationId: preflight.registration.id,
      marketplaceEntryId: preflight.plugin.marketplaceEntryId,
      validationSnapshot: preflight.snapshot.fingerprint,
      snapshotBinds: {
        profile: preflight.snapshot.profile,
        ruleset: preflight.snapshot.ruleset,
        budget: preflight.snapshot.budget,
      },
      manifestName: preflight.plugin.manifestName,
    };
    try {
      await opts.beforeInstallationCommit?.();
    } catch (error) {
      const receipt = createReceipt({
        operation: receiptOperation(preflight.operation),
        trigger: triggerFor(preflight.operation, preflight.registration.id, preflight.plugin.marketplaceEntryId),
        expectedStateRevision: preflight.stateRevision,
        observedStateRevision: preflight.stateRevision,
        validationSnapshot: preflight.snapshot.fingerprint,
        summary: 'Persistence Failed',
        findings: [operationFinding(
          CODE.PERSISTENCE_FAILED,
          'PERSIST-02',
          error instanceof Error ? error.message : String(error),
          'attempt',
          'persistence',
        )],
      });
      await appendReceipt(receipt, { agentDir: opts.agentDir });
      throw error;
    }
    const write = await commitBridgeState((state) => ({
      ...state,
      installations: preflight.operation === 'enable'
        ? state.installations.map((item) => item.id === installation.id ? installation : item)
        : [...state.installations, installation],
    }), {
      agentDir: opts.agentDir,
      lockTimeoutMs: opts.fenceTimeoutMs,
      expectedStateRevision: preflight.stateRevision,
    });
    if (write.isStale) {
      return rejectedAsStale(
        preflight,
        'State Revision changed after Installation confirmation; re-run preflight and confirmation',
        write.observedRevision,
        opts,
      );
    }
    if (!write.success) {
      const summary = write.isIndeterminate ? 'Persistence Indeterminate' : 'Persistence Failed';
      const receipt = createReceipt({
        operation: receiptOperation(preflight.operation),
        trigger: triggerFor(preflight.operation, preflight.registration.id, preflight.plugin.marketplaceEntryId),
        expectedStateRevision: preflight.stateRevision,
        validationSnapshot: preflight.snapshot.fingerprint,
        summary,
        findings: [],
      });
      await appendReceipt(receipt, { agentDir: opts.agentDir });
      return {
        status: 'persistence-failed',
        isIndeterminate: write.isIndeterminate ?? false,
        receipt,
      };
    }
    const receipt = createReceipt({
      operation: receiptOperation(preflight.operation),
      trigger: triggerFor(preflight.operation, preflight.registration.id, preflight.plugin.marketplaceEntryId),
      expectedStateRevision: preflight.stateRevision,
      targetStateRevision: write.newRevision,
      observedStateRevision: write.newRevision,
      validationSnapshot: preflight.snapshot.fingerprint,
      summary: preflight.findings.length > 0 ? 'Completed with diagnostics' : 'Completed',
      findings: preflight.findings,
      stateChanged: true,
    });
    await appendReceipt(receipt, { agentDir: opts.agentDir });
    return {
      status: 'completed',
      installation,
      newRevision: write.newRevision!,
      receipt,
    };
  } finally {
    preflight.fence.release();
  }
}

/** Resolve an Installation by exact persisted ID or by Plugin ID (legacy '<scope>/<pluginId>' forms resolve by their Plugin ID). */
function findInstallation(state: { installations: Installation[] }, ref: string): Installation | undefined {
  return state.installations.find((item) => item.id === ref)
    ?? state.installations.find((item) => item.pluginId === ref);
}

export async function preflightPluginEnable(installationId: string, opts: InstallationFlowOptions = {}): Promise<InstallationPreflightResult> {
  const read = await readBridgeState({ agentDir: opts.agentDir });
  if (read.status !== 'ok' && read.status !== 'missing') {
    const receipt = createReceipt({ operation: receiptOperation('enable'), trigger: `enable ${installationId}`, expectedStateRevision: opts.expectedStateRevision ?? '?', summary: 'Persistence Indeterminate', findings: [operationFinding(CODE.PERSISTENCE_INDETERMINATE, 'PERSIST-01', read.error ?? 'Bridge State is not readable', 'attempt', 'persistence')] });
    await appendReceipt(receipt, { agentDir: opts.agentDir });
    return { ok: false, outcome: { status: 'persistence-failed', receipt, isIndeterminate: true } };
  }
  if (
    opts.expectedStateRevision !== undefined
    && read.state!.stateRevision !== opts.expectedStateRevision
  ) {
    return stalePreflight(
      'enable',
      'unknown',
      installationId,
      opts.expectedStateRevision,
      read.state!.stateRevision,
      'State Revision changed since the enablement intent was selected; reopen the Bridge Ledger',
      opts,
    );
  }
  const existing = findInstallation(read.state!, installationId);
  if (!existing?.registrationId || !existing.marketplaceEntryId || !existing.validationSnapshot) {
    return blocked('enable', 'unknown', installationId, read.state?.stateRevision ?? '?', [
      operationFinding(CODE.INSTALLATION_NOT_FOUND, RULE.INSTALLATION_NOT_FOUND, `Disabled Installation '${installationId}' has no revalidatable provenance`),
    ], null, opts);
  }
  const entryPointer = existing.marketplaceEntryId.slice(existing.marketplaceEntryId.indexOf('/plugins/'));
  return makePreflight(existing.registrationId, entryPointer, {
    ...opts,
    expectedMarketplaceEntryId: existing.marketplaceEntryId,
    expectedValidationSnapshot: existing.validationSnapshot,
  }, 'enable', existing as Installation);
}

export async function confirmPluginEnable(preflight: PluginInstallationPreflight, activationConfirmed: boolean, opts: InstallationFlowOptions = {}): Promise<InstallationOutcome> {
  return confirmPluginInstallation(preflight, 'enabled', activationConfirmed, opts);
}

export async function preflightPluginDisable(
  installationId: string,
  opts: InstallationFlowOptions = {},
): Promise<InstallationDisablePreflightResult> {
  const fenceResult = await acquireAttemptFence({
    agentDir: opts.agentDir,
    fenceTimeoutMs: opts.fenceTimeoutMs,
  });
  if (!fenceResult.ok) {
    const result = await blocked(
      'disable',
      'unknown',
      installationId,
      opts.expectedStateRevision ?? '?',
      [fenceResult.finding!],
      null,
      opts,
    );
    if (!result.ok) return result;
    throw new Error('unreachable fenced Plugin Disablement preflight result');
  }
  const fence = fenceResult.handle!;
  let read: Awaited<ReturnType<typeof readBridgeState>>;
  try {
    read = await readBridgeState({ agentDir: opts.agentDir });
  } catch (error) {
    fence.release();
    throw error;
  }
  if (read.status !== 'ok' && read.status !== 'missing') {
    const receipt = createReceipt({
      operation: receiptOperation('disable'),
      trigger: triggerFor('disable', 'unknown', installationId),
      expectedStateRevision: opts.expectedStateRevision ?? '?',
      summary: 'Persistence Indeterminate',
      findings: [operationFinding(
        CODE.PERSISTENCE_INDETERMINATE,
        'PERSIST-01',
        read.error ?? 'Bridge State is not readable',
        'attempt',
        'persistence',
      )],
    });
    try {
      await appendReceipt(receipt, { agentDir: opts.agentDir });
    } finally {
      fence.release();
    }
    return { ok: false, outcome: { status: 'persistence-failed', receipt, isIndeterminate: true } };
  }
  const state = read.state!;
  if (
    opts.expectedStateRevision !== undefined
    && state.stateRevision !== opts.expectedStateRevision
  ) {
    return stalePreflight(
      'disable',
      'unknown',
      installationId,
      opts.expectedStateRevision,
      state.stateRevision,
      'State Revision changed since the disablement intent was selected; reopen the Bridge Ledger',
      opts,
      fence,
    );
  }
  const installation = findInstallation(state, installationId) as Installation | undefined;
  if (!installation) {
    const result = await blocked('disable', 'unknown', installationId, state.stateRevision, [
      operationFinding(
        CODE.INSTALLATION_NOT_FOUND,
        RULE.INSTALLATION_NOT_FOUND,
        `Installation '${installationId}' was not found`,
      ),
    ], fence, opts);
    if (!result.ok) return result;
    throw new Error('unreachable missing Plugin Disablement preflight result');
  }
  if (
    opts.expectedInstallationState !== undefined
    && installation.installationState !== opts.expectedInstallationState
  ) {
    return stalePreflight(
      'disable',
      'unknown',
      installationId,
      opts.expectedStateRevision ?? state.stateRevision,
      state.stateRevision,
      'Installation State changed since the disablement intent was selected; reopen the Bridge Ledger',
      opts,
      fence,
    );
  }
  return {
    ok: true,
    preflight: {
      installation,
      stateRevision: state.stateRevision,
      fence,
      terminal: false,
    },
  };
}

async function disableAttemptAlreadyTerminal(
  preflight: PluginDisablePreflight,
  opts: InstallationFlowOptions,
): Promise<InstallationOutcome> {
  const result = await blocked('disable', 'unknown', preflight.installation.id, preflight.stateRevision, [
    operationFinding(
      CODE.ATTEMPT_IN_PROGRESS,
      RULE.ATTEMPT_IN_PROGRESS,
      'attempt already reached a terminal outcome',
      'attempt',
      'admission',
    ),
  ], null, opts);
  if (!result.ok) return result.outcome;
  throw new Error('unreachable terminal Plugin Disablement result');
}

export async function declinePluginDisable(
  preflight: PluginDisablePreflight,
  opts: InstallationFlowOptions = {},
): Promise<InstallationOutcome> {
  if (preflight.terminal) return disableAttemptAlreadyTerminal(preflight, opts);
  preflight.terminal = true;
  try {
    const receipt = createReceipt({
      operation: receiptOperation('disable'),
      trigger: triggerFor('disable', 'unknown', preflight.installation.id),
      expectedStateRevision: preflight.stateRevision,
      validationSnapshot: preflight.installation.validationSnapshot,
      summary: 'Declined',
      stateChanged: false,
    });
    await appendReceipt(receipt, { agentDir: opts.agentDir });
    return { status: 'declined', receipt };
  } finally {
    preflight.fence.release();
  }
}

export async function confirmPluginDisable(
  preflight: PluginDisablePreflight,
  opts: InstallationFlowOptions = {},
): Promise<InstallationOutcome> {
  if (preflight.terminal) return disableAttemptAlreadyTerminal(preflight, opts);
  preflight.terminal = true;
  const { installation: selected, stateRevision: expectedStateRevision } = preflight;
  try {
    const read = await readBridgeState({ agentDir: opts.agentDir });
    if (read.status !== 'ok' && read.status !== 'missing') {
      const receipt = createReceipt({
        operation: receiptOperation('disable'),
        trigger: triggerFor('disable', 'unknown', selected.id),
        expectedStateRevision,
        summary: 'Persistence Indeterminate',
        findings: [operationFinding(CODE.PERSISTENCE_INDETERMINATE, 'PERSIST-01', read.error ?? 'Bridge State is not readable', 'attempt', 'persistence')],
      });
      await appendReceipt(receipt, { agentDir: opts.agentDir });
      return { status: 'persistence-failed', isIndeterminate: true, receipt };
    }
    const state = read.state!;
    if (state.stateRevision !== expectedStateRevision) {
      const receipt = createReceipt({
        operation: receiptOperation('disable'),
        trigger: triggerFor('disable', 'unknown', selected.id),
        expectedStateRevision,
        observedStateRevision: state.stateRevision,
        summary: 'Rejected as Stale',
        findings: [operationFinding(CODE.REJECTED_AS_STALE, RULE.REJECTED_AS_STALE, 'State Revision changed since disablement disclosure; reopen the lifecycle operation', 'installation', 'persistence')],
      });
      await appendReceipt(receipt, { agentDir: opts.agentDir });
      return { status: 'rejected-as-stale', receipt };
    }
    const current = state.installations.find((item) => item.id === selected.id);
    if (!current) {
      const findings = [operationFinding(CODE.INSTALLATION_NOT_FOUND, RULE.INSTALLATION_NOT_FOUND, `Installation '${selected.id}' was not found`)];
      const receipt = createReceipt({
        operation: receiptOperation('disable'),
        trigger: triggerFor('disable', 'unknown', selected.id),
        expectedStateRevision,
        summary: 'Blocked',
        findings,
      });
      await appendReceipt(receipt, { agentDir: opts.agentDir });
      return { status: 'blocked', findings, receipt };
    }
    if (current.installationState !== selected.installationState) {
      const receipt = createReceipt({
        operation: receiptOperation('disable'),
        trigger: triggerFor('disable', 'unknown', selected.id),
        expectedStateRevision,
        observedStateRevision: state.stateRevision,
        summary: 'Rejected as Stale',
        findings: [operationFinding(
          CODE.REJECTED_AS_STALE,
          RULE.REJECTED_AS_STALE,
          'Installation State changed since disablement disclosure; reopen the Bridge Ledger',
          'installation',
          'admission',
        )],
      });
      await appendReceipt(receipt, { agentDir: opts.agentDir });
      return { status: 'rejected-as-stale', receipt };
    }
    try {
      await opts.beforeDisableCommit?.();
    } catch (error) {
      const receipt = createReceipt({
        operation: receiptOperation('disable'),
        trigger: triggerFor('disable', 'unknown', selected.id),
        expectedStateRevision,
        observedStateRevision: expectedStateRevision,
        validationSnapshot: selected.validationSnapshot,
        summary: 'Persistence Failed',
        findings: [operationFinding(
          CODE.PERSISTENCE_FAILED,
          'PERSIST-02',
          error instanceof Error ? error.message : String(error),
          'attempt',
          'persistence',
        )],
      });
      await appendReceipt(receipt, { agentDir: opts.agentDir });
      throw error;
    }
    const write = await commitBridgeState((bridgeState) => ({
      ...bridgeState,
      installations: bridgeState.installations.map((item) =>
        item.id === selected.id ? { ...item, installationState: 'disabled' } : item),
    }), {
      agentDir: opts.agentDir,
      lockTimeoutMs: opts.fenceTimeoutMs,
      expectedStateRevision,
    });
    if (write.isStale) {
      const receipt = createReceipt({
        operation: receiptOperation('disable'),
        trigger: triggerFor('disable', 'unknown', selected.id),
        expectedStateRevision,
        observedStateRevision: write.observedRevision,
        summary: 'Rejected as Stale',
        findings: [operationFinding(CODE.REJECTED_AS_STALE, RULE.REJECTED_AS_STALE, 'State Revision changed after disablement admission; re-run the lifecycle operation', 'installation', 'persistence')],
      });
      await appendReceipt(receipt, { agentDir: opts.agentDir });
      return { status: 'rejected-as-stale', receipt };
    }
    if (!write.success) {
      const receipt = createReceipt({
        operation: receiptOperation('disable'),
        trigger: triggerFor('disable', 'unknown', selected.id),
        expectedStateRevision,
        summary: write.isIndeterminate ? 'Persistence Indeterminate' : 'Persistence Failed',
      });
      await appendReceipt(receipt, { agentDir: opts.agentDir });
      return { status: 'persistence-failed', isIndeterminate: write.isIndeterminate ?? false, receipt };
    }
    const disabled = { ...current, installationState: 'disabled' as const };
    const receipt = createReceipt({
      operation: receiptOperation('disable'),
      trigger: triggerFor('disable', 'unknown', selected.id),
      expectedStateRevision,
      targetStateRevision: write.newRevision,
      observedStateRevision: write.newRevision,
      summary: 'Completed',
      stateChanged: true,
    });
    await appendReceipt(receipt, { agentDir: opts.agentDir });
    return { status: 'completed', installation: disabled, newRevision: write.newRevision!, receipt };
  } finally {
    preflight.fence.release();
  }
}

export async function disablePluginInstallation(
  installationId: string,
  opts: InstallationFlowOptions = {},
): Promise<InstallationOutcome> {
  const preflight = await preflightPluginDisable(installationId, opts);
  if (!preflight.ok) return preflight.outcome;
  return confirmPluginDisable(preflight.preflight, opts);
}
