/**
 * Plugin Installation lifecycle seam.
 *
 * A preflight holds the scope Attempt Fence and binds the exact State Revision plus Validation
 * Snapshot.  `Install Disabled` commits immediately after that disclosure; `Install and Enable`
 * and disabled → enabled require a separate, explicit Activation Confirmation.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { classifyPlugin, type CompatiblePlugin } from '../compatibility/profile.js';
import { commitBridgeState, readBridgeState } from '../bridge-state/store.js';
import type { Installation, Registration, Scope } from '../bridge-state/types.js';
import { parseCatalog } from '../registration/catalog.js';
import { resolveContained } from '../registration/contained.js';
import { CODE, RULE, blocking, hasBlocking, sortFindings, type ValidationFinding } from '../registration/findings.js';
import { acquireAttemptFence, type AttemptFenceHandle } from '../registration/fence.js';
import { createReceipt, type AttemptReceipt } from '../registration/receipt.js';
import { localSourceKey } from '../registration/source-key.js';
import { buildLocalSnapshot, type ValidationSnapshot } from '../registration/snapshot.js';

export interface InstallationFlowOptions {
  cwd?: string;
  agentDir?: string;
  projectTrusted?: boolean;
  fenceTimeoutMs?: number;
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

const OPERATION = 'Plugin Installation';

function triggerFor(registrationId: string, entryId: string): string {
  return `install ${registrationId}#${entryId}`;
}

function blocked(
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
        operation: OPERATION,
        scope,
        trigger: triggerFor(registrationId, entryId),
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
      operation: OPERATION,
      scope,
      trigger: triggerFor(registrationId, entryPointer),
      expectedStateRevision: '?',
      summary: 'Persistence Indeterminate',
      findings: [operationFinding(scope, CODE.PERSISTENCE_INDETERMINATE, 'PERSIST-01', read.error ?? 'Bridge State is not readable', 'attempt', 'persistence')],
    });
    return { ok: false, outcome: { status: 'persistence-failed', receipt, isIndeterminate: true } };
  }
  const state = read.state!;
  const trust = scopeDenied(scope, opts);
  if (trust) return blocked(scope, registrationId, entryPointer, state.stateRevision, [trust]);
  const registration = state.registrations.find((item) => item.id === registrationId);
  if (!registration) {
    return blocked(scope, registrationId, entryPointer, state.stateRevision, [
      operationFinding(scope, CODE.INSTALLATION_NOT_FOUND, RULE.INSTALLATION_NOT_FOUND, `Registration '${registrationId}' is not in ${scope} Bridge State`, 'registration'),
    ]);
  }
  if (registration.sourceKind !== 'local' || !registration.source) {
    return blocked(scope, registrationId, entryPointer, state.stateRevision, [
      operationFinding(scope, CODE.SOURCE_REACQUISITION_REQUIRED, RULE.SOURCE_REACQUISITION_REQUIRED, 'This Registration has no retained local Validation Snapshot tree; Git Installation waits for the Source Cache lifecycle', 'registration'),
    ]);
  }

  const fenceResult = await acquireAttemptFence(scope, { cwd: opts.cwd, agentDir: opts.agentDir, fenceTimeoutMs: opts.fenceTimeoutMs });
  if (!fenceResult.ok) return blocked(scope, registrationId, entryPointer, state.stateRevision, [fenceResult.finding!]);
  const fence = fenceResult.handle!;

  try {
    const key = localSourceKey(registration.source);
    if (!key.ok) {
      return blocked(scope, registrationId, entryPointer, state.stateRevision, [
        operationFinding(scope, CODE.SOURCE_REACQUISITION_REQUIRED, RULE.SOURCE_REACQUISITION_REQUIRED, key.error ?? 'Marketplace Root cannot be revalidated', 'registration'),
      ], fence);
    }
    const root = key.sourceKey!.canonicalPath!;
    let catalogValue: unknown;
    try {
      catalogValue = JSON.parse(readFileSync(join(root, '.agents', 'plugins', 'marketplace.json'), 'utf8'));
    } catch {
      return blocked(scope, registrationId, entryPointer, state.stateRevision, [
        operationFinding(scope, CODE.CATALOG_MISSING, RULE.CATALOG_MISSING, 'Marketplace Catalog cannot be read during Installation preflight', 'catalog'),
      ], fence);
    }
    const catalogResult = parseCatalog(catalogValue, { scope });
    if (!catalogResult.ok) return blocked(scope, registrationId, entryPointer, state.stateRevision, catalogResult.findings, fence);
    const catalog = catalogResult.catalog!;
    const entry = catalog.entries.find((item) => item.entryId === entryPointer);
    if (!entry || !entry.available || entry.type !== 'local' || !entry.path) {
      return blocked(scope, registrationId, entryPointer, state.stateRevision, [
        operationFinding(scope, CODE.INSTALLATION_NOT_FOUND, RULE.INSTALLATION_NOT_FOUND, `Marketplace Entry '${entryPointer}' is Unavailable`, 'entry'),
      ], fence);
    }
    const contained = resolveContained(root, entry.path, 'directory');
    if (contained.outcome.kind !== 'ok') {
      return blocked(scope, registrationId, entryPointer, state.stateRevision, [
        operationFinding(scope, CODE.INSTALLATION_NOT_FOUND, RULE.INSTALLATION_NOT_FOUND, `Marketplace Entry '${entryPointer}' cannot resolve to a contained Plugin directory`, 'entry'),
      ], fence);
    }
    const marketplaceId = `${registration.id}/${catalog.name}`;
    const marketplaceEntryId = `${marketplaceId}${entry.entryId}`;
    const classification = classifyPlugin(contained.outcome.canonicalPath, { scope, marketplaceId, marketplaceEntryId });
    const snapshotResult = buildLocalSnapshot(root, key.sourceKey!, scope);
    const driftFindings: ValidationFinding[] = [];
    if (registration.validationSnapshot && snapshotResult.snapshot?.fingerprint !== registration.validationSnapshot) {
      driftFindings.push(blocking({ code: CODE.REJECTED_AS_STALE, rule: RULE.REJECTED_AS_STALE_SNAPSHOT, target: 'registration', pointer: '', outcome: 'Registered Validation Snapshot no longer matches the source tree; only Marketplace Refresh may produce an Update Candidate', scope, phase: 'validation' }));
    }
    const collisionFindings: ValidationFinding[] = [];
    if (classification.plugin) {
      for (const other of catalog.entries) {
        if (other.entryId === entry.entryId || !other.available || other.type !== 'local' || !other.path) continue;
        const otherPath = resolveContained(root, other.path, 'directory');
        if (otherPath.outcome.kind !== 'ok') continue;
        const otherClassification = classifyPlugin(otherPath.outcome.canonicalPath, {
          scope,
          marketplaceId,
          marketplaceEntryId: `${marketplaceId}${other.entryId}`,
        });
        if (otherClassification.plugin?.id === classification.plugin.id) {
          collisionFindings.push(blocking({
            code: CODE.PLUGIN_ID_COLLISION,
            rule: RULE.PLUGIN_ID_COLLISION,
            target: 'plugin',
            pointer: entry.entryId,
            outcome: `Plugin ID '${classification.plugin.id}' collides with Marketplace Entry '${other.entryId}'; neither entry is activatable`,
            scope,
            phase: 'identity',
          }));
        }
      }
    }
    const findings = sortFindings([...catalogResult.findings, ...classification.findings, ...collisionFindings, ...driftFindings, ...snapshotResult.findings]);
    if (!snapshotResult.ok || classification.classification !== 'compatible' || hasBlocking(findings)) {
      return blocked(scope, registrationId, entryPointer, state.stateRevision, findings, fence);
    }
    const plugin = classification.plugin!;
    const installationId = `${scope}/${plugin.id}`;
    const currentInstallation = state.installations.find((item) => item.id === installationId);
    if (operation === 'install' && currentInstallation) {
      return blocked(scope, registrationId, entryPointer, state.stateRevision, [
        operationFinding(scope, CODE.INSTALLATION_ALREADY_EXISTS, RULE.INSTALLATION_ALREADY_EXISTS, `Installation '${installationId}' already exists; use enable or disable lifecycle actions`),
      ], fence);
    }
    if (operation === 'enable' && (!currentInstallation || currentInstallation.installationState !== 'disabled')) {
      return blocked(scope, registrationId, entryPointer, state.stateRevision, [
        operationFinding(scope, CODE.INSTALLATION_NOT_FOUND, RULE.INSTALLATION_NOT_FOUND, `Disabled Installation '${installationId}' is no longer current`),
      ], fence);
    }
    return {
      ok: true,
      preflight: {
        scope,
        registration,
        plugin,
        snapshot: snapshotResult.snapshot!,
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
    return blocked(scope, registrationId, entryPointer, state.stateRevision, [
      operationFinding(scope, CODE.INSTALLATION_NOT_FOUND, RULE.INSTALLATION_NOT_FOUND, error instanceof Error ? error.message : String(error)),
    ], fence);
  }
}

export function installationDisclosure(preflight: PluginInstallationPreflight): string {
  const plugin = preflight.plugin;
  const lines = [
    `Scope: ${preflight.scope}`,
    `Plugin: ${plugin.manifestName} (${plugin.id})`,
    `Source: ${preflight.registration.source ?? preflight.registration.canonicalLocator ?? 'unavailable'}`,
    `Marketplace Entry: ${plugin.marketplaceEntryId}`,
    `State Revision: ${preflight.stateRevision}`,
    `Validation Snapshot: ${preflight.snapshot.fingerprint.slice(0, 16)}…`,
    `Classification: Compatible`,
    `Projected precedence: Pi → Project Scope → Global Scope`,
    `Skills: ${plugin.skills.length}`,
  ];
  for (const skill of plugin.skills) {
    lines.push(`  ${skill.name} · ${skill.invocationPolicy} · resources: ${skill.resources.length === 0 ? 'none' : skill.resources.join(', ')}`);
  }
  lines.push(`Findings: ${preflight.findings.length === 0 ? 'none' : preflight.findings.map((finding) => `${finding.classification} ${finding.code}: ${finding.outcome}`).join(' | ')}`);
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
      operation: OPERATION,
      scope: preflight.scope,
      trigger: triggerFor(preflight.registration.id, preflight.plugin.marketplaceEntryId),
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
    const result = blocked(preflight.scope, preflight.registration.id, preflight.plugin.marketplaceEntryId, preflight.stateRevision, [
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
        operation: OPERATION,
        scope: preflight.scope,
        trigger: triggerFor(preflight.registration.id, preflight.plugin.marketplaceEntryId),
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
  if ((current.status !== 'ok' && current.status !== 'missing') || current.state!.stateRevision !== preflight.stateRevision) {
    return rejectedAsStale(preflight, 'State Revision changed since Installation disclosure; re-run preflight and confirmation');
  }
  const root = preflight.registration.source!;
  const key = localSourceKey(root);
  const fresh = key.ok ? buildLocalSnapshot(key.sourceKey!.canonicalPath!, key.sourceKey!, preflight.scope) : undefined;
  if (!fresh?.ok || fresh.snapshot!.fingerprint !== preflight.snapshot.fingerprint) {
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
  const write = await commitBridgeState(preflight.scope, (state) => ({
    ...state,
    installations: preflight.operation === 'enable'
      ? state.installations.map((item) => item.id === installation.id ? installation : item)
      : [...state.installations, installation],
  }), { cwd: opts.cwd, agentDir: opts.agentDir, lockTimeoutMs: opts.fenceTimeoutMs });
  preflight.fence.release();
  if (!write.success) {
    const summary = write.isIndeterminate ? 'Persistence Indeterminate' : 'Persistence Failed';
    return {
      status: 'persistence-failed',
      isIndeterminate: write.isIndeterminate ?? false,
      receipt: createReceipt({ operation: OPERATION, scope: preflight.scope, trigger: triggerFor(preflight.registration.id, preflight.plugin.marketplaceEntryId), expectedStateRevision: preflight.stateRevision, validationSnapshot: preflight.snapshot.fingerprint, summary, findings: [] }),
    };
  }
  return {
    status: 'completed',
    installation,
    newRevision: write.newRevision!,
    receipt: createReceipt({ operation: OPERATION, scope: preflight.scope, trigger: triggerFor(preflight.registration.id, preflight.plugin.marketplaceEntryId), expectedStateRevision: preflight.stateRevision, targetStateRevision: write.newRevision, observedStateRevision: write.newRevision, validationSnapshot: preflight.snapshot.fingerprint, summary: preflight.findings.length > 0 ? 'Completed with diagnostics' : 'Completed', findings: preflight.findings, stateChanged: true }),
  };
}

export async function preflightPluginEnable(scope: Scope, installationId: string, opts: InstallationFlowOptions = {}): Promise<InstallationPreflightResult> {
  const read = await readBridgeState(scope, { cwd: opts.cwd, agentDir: opts.agentDir });
  if (read.status !== 'ok' && read.status !== 'missing') {
    const receipt = createReceipt({ operation: OPERATION, scope, trigger: installationId, expectedStateRevision: '?', summary: 'Persistence Indeterminate', findings: [operationFinding(scope, CODE.PERSISTENCE_INDETERMINATE, 'PERSIST-01', read.error ?? 'Bridge State is not readable', 'attempt', 'persistence')] });
    return { ok: false, outcome: { status: 'persistence-failed', receipt, isIndeterminate: true } };
  }
  const existing = read.state?.installations.find((item) => item.id === installationId);
  if (!existing?.registrationId || !existing.marketplaceEntryId) {
    return blocked(scope, 'unknown', installationId, read.state?.stateRevision ?? '?', [
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
  const read = await readBridgeState(scope, { cwd: opts.cwd, agentDir: opts.agentDir });
  if (read.status !== 'ok' && read.status !== 'missing') {
    return { status: 'persistence-failed', isIndeterminate: true, receipt: createReceipt({ operation: 'Plugin Disablement', scope, trigger: installationId, expectedStateRevision: '?', summary: 'Persistence Indeterminate', findings: [operationFinding(scope, CODE.PERSISTENCE_INDETERMINATE, 'PERSIST-01', read.error ?? 'Bridge State is not readable', 'attempt', 'persistence')] }) };
  }
  const trust = scopeDenied(scope, opts);
  if (trust) {
    const result = blocked(scope, 'unknown', installationId, read.state!.stateRevision, [trust]);
    if (!result.ok) return result.outcome;
    throw new Error('unreachable blocked Installation preflight result');
  }
  const fence = await acquireAttemptFence(scope, { cwd: opts.cwd, agentDir: opts.agentDir, fenceTimeoutMs: opts.fenceTimeoutMs });
  if (!fence.ok) {
    const result = blocked(scope, 'unknown', installationId, read.state!.stateRevision, [fence.finding!]);
    if (!result.ok) return result.outcome;
    throw new Error('unreachable blocked Installation preflight result');
  }
  const installation = read.state?.installations.find((item) => item.id === installationId);
  if (!installation) {
    const result = blocked(scope, 'unknown', installationId, read.state?.stateRevision ?? '?', [operationFinding(scope, CODE.INSTALLATION_NOT_FOUND, RULE.INSTALLATION_NOT_FOUND, `Installation '${installationId}' was not found`)], fence.handle!);
    if (!result.ok) return result.outcome;
    throw new Error('unreachable blocked Installation preflight result');
  }
  const write = await commitBridgeState(scope, (state) => ({
    ...state,
    installations: state.installations.map((item) => item.id === installationId ? { ...item, installationState: 'disabled' } : item),
  }), { cwd: opts.cwd, agentDir: opts.agentDir, lockTimeoutMs: opts.fenceTimeoutMs });
  fence.handle!.release();
  if (!write.success) {
    return { status: 'persistence-failed', isIndeterminate: write.isIndeterminate ?? false, receipt: createReceipt({ operation: 'Plugin Disablement', scope, trigger: installationId, expectedStateRevision: read.state!.stateRevision, summary: write.isIndeterminate ? 'Persistence Indeterminate' : 'Persistence Failed' }) };
  }
  const disabled = { ...installation, installationState: 'disabled' as const };
  return { status: 'completed', installation: disabled, newRevision: write.newRevision!, receipt: createReceipt({ operation: 'Plugin Disablement', scope, trigger: installationId, expectedStateRevision: read.state!.stateRevision, targetStateRevision: write.newRevision, observedStateRevision: write.newRevision, summary: 'Completed', stateChanged: true }) };
}
