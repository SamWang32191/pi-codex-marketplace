/**
 * Bridge Ledger presentation model and Pi TUI component.
 *
 * The two ReadResults in BridgeLedgerSnapshot are the only Bridge State authority.
 * Effective State, action availability, labels, counts, journals, and rendering are
 * derived presentation data and are never persisted by this module.
 */

import type { Theme } from '@earendil-works/pi-coding-agent';
import { Key, matchesKey, wrapTextWithAnsi, type Component, type TUI } from '@earendil-works/pi-tui';

import { checkGlobalPendingBarrier, type GlobalBarrierStatus } from '../../src/barrier/global-barrier.js';
import { readBothStates } from '../../src/bridge-state/store.js';
import type {
  BridgeState,
  ReadResult,
  Registration,
  Scope,
  ScopeOverride,
} from '../../src/bridge-state/types.js';
import type {
  CompatiblePlugin,
  PluginClassification,
} from '../../src/compatibility/profile.js';
import {
  inspectMarketplaceEntries,
  type InspectedMarketplaceEntry,
  type MarketplaceInspection,
} from '../../src/installation/inspection.js';
import { readReceiptJournal } from '../../src/journal/journal.js';
import type { JournalReadResult } from '../../src/journal/types.js';
import { computeEffectiveState, type EffectiveState } from '../../src/projection/effective-state.js';
import type { ValidationFinding } from '../../src/registration/findings.js';
import type { AttemptReceipt } from '../../src/registration/receipt.js';
import {
  fitTerminalLine,
  quoteTerminalText,
  renderBadge,
  renderPanel,
  renderSelectableRow,
  renderSideBySidePanels,
} from './terminal-presentation.js';

export type LedgerSectionId =
  | 'observe'
  | 'sources'
  | 'plugins'
  | 'scope-inheritance'
  | 'recovery-receipts';

export type LedgerActionId =
  | 'observe-partitions'
  | 'observe-effective-state'
  | 'register-local'
  | 'register-git'
  | 'refresh-registration'
  | 'rebind-registration'
  | 'remove-registration'
  | 'install-disabled'
  | 'install-and-enable'
  | 'enable-installation'
  | 'disable-installation'
  | 'remove-installation'
  | 'create-scope-override'
  | 'remove-scope-override'
  | 'view-receipt-journal'
  | 'repair-state'
  | 'retry-application'
  | 'inspect-receipt';

export type LedgerTargetKind =
  | 'scope'
  | 'registration'
  | 'marketplace-entry'
  | 'installation'
  | 'scope-override'
  | 'receipt';

export interface LedgerActionIntent {
  actionId: LedgerActionId;
  mode: 'read' | 'mutation';
  scope?: Scope;
  targetKind?: LedgerTargetKind;
  targetId?: string;
  /** Canonical parent Registration for a Marketplace Entry action. */
  registrationId?: string;
  /** Snapshot-scoped catalog pointer such as /plugins/0. */
  entryPointer?: string;
  desiredInstallationState?: 'disabled' | 'enabled';
  /** Revision visible when the mutation was selected; domain flows must still revalidate. */
  stateRevision?: string;
  /** Exact presentation inspection fingerprint bound when a Marketplace Entry action is selected. */
  validationSnapshot?: string;
}

export interface LedgerActionRow {
  id: string;
  label: string;
  detail?: string;
  intent: LedgerActionIntent;
  enabled: boolean;
  disabledReason?: string;
}

export interface LedgerObjectRow {
  /** Presentation identity built from stable canonical domain identity, never a display label. */
  id: string;
  label: string;
  detail?: string;
  scope?: Scope;
  targetKind?: LedgerTargetKind;
  targetId?: string;
  actions: LedgerActionRow[];
}

export interface LedgerSection {
  id: LedgerSectionId;
  label: string;
  description: string;
  rows: LedgerObjectRow[];
}

export type LedgerHealth = 'healthy' | 'incompatible' | 'indeterminate';

export interface LedgerAuthorityRail {
  scope: Scope;
  label: string;
  revision: string;
  registrationCount: number;
  installationEnabledCount: number;
  installationDisabledCount: number;
  overrideCount: number;
  health: LedgerHealth;
  healthText: string;
  trustText: string;
}

export interface BridgeLedgerSnapshot {
  global: ReadResult;
  project: ReadResult;
  projectTrusted: boolean;
  barrier: GlobalBarrierStatus;
  journals: Record<Scope, JournalReadResult>;
  marketplaceEntries: Record<Scope, LedgerMarketplaceItem[]>;
  effective?: EffectiveState;
}

export interface LedgerMarketplaceEntry {
  scope: Scope;
  registrationId: string;
  entryPointer: string;
  marketplaceEntryId: string;
  validationSnapshot?: string;
  name: string;
  classification: PluginClassification | 'unavailable';
  plugin?: CompatiblePlugin;
  findings: ValidationFinding[];
  unavailableReason?: string;
}

export interface LedgerMarketplaceDiagnostic {
  scope: Scope;
  registrationId: string;
  name: string;
  classification: 'unavailable';
  findings: ValidationFinding[];
}

export type LedgerMarketplaceItem = LedgerMarketplaceEntry | LedgerMarketplaceDiagnostic;

export interface BridgeLedgerModel {
  rails: Record<Scope, LedgerAuthorityRail>;
  projectTrusted: boolean;
  barrier: { active: boolean; text: string };
  effective: {
    registrationCount: number;
    installationCount: number;
    suppressedCount: number;
    excludedCount: number;
  };
  sections: LedgerSection[];
}

export interface LoadBridgeLedgerSnapshotOptions {
  cwd: string;
  agentDir?: string;
  projectTrusted: boolean;
  inspectMarketplaceEntries?: typeof inspectMarketplaceEntries;
}

export async function loadBridgeLedgerSnapshot(
  options: LoadBridgeLedgerSnapshotOptions,
): Promise<BridgeLedgerSnapshot> {
  const io = { cwd: options.cwd, agentDir: options.agentDir };
  const [states, barrier, globalJournal, projectJournal] = await Promise.all([
    readBothStates(io),
    checkGlobalPendingBarrier(io),
    readReceiptJournal('global', io),
    readReceiptJournal('project', io),
  ]);
  const globalReadable = readableState(states.global);
  const projectReadable = readableState(states.project);
  const effective = globalReadable && projectReadable
    ? computeEffectiveState(globalReadable, projectReadable, {
        projectTrusted: options.projectTrusted,
      })
    : undefined;
  let marketplaceEntries: Record<Scope, LedgerMarketplaceItem[]> | undefined;

  return {
    ...states,
    projectTrusted: options.projectTrusted,
    barrier,
    journals: { global: globalJournal, project: projectJournal },
    get marketplaceEntries() {
      marketplaceEntries ??= {
        global: inspectLedgerEntries(
          'global',
          globalReadable,
          options.agentDir,
          options.inspectMarketplaceEntries,
        ),
        project: inspectLedgerEntries(
          'project',
          projectReadable,
          options.agentDir,
          options.inspectMarketplaceEntries,
        ),
      };
      return marketplaceEntries;
    },
    effective,
  };
}

function inspectLedgerEntries(
  scope: Scope,
  state: BridgeState | undefined,
  agentDir?: string,
  inspector = inspectMarketplaceEntries,
): LedgerMarketplaceItem[] {
  return (state?.registrations ?? []).flatMap((registration) => {
    const inspection = inspector(registration, scope, { agentDir });
    return mapMarketplaceInspectionToLedgerItems(scope, registration, inspection);
  });
}

export function mapMarketplaceInspectionToLedgerItems(
  scope: Scope,
  registration: Registration,
  inspection: MarketplaceInspection,
): LedgerMarketplaceItem[] {
  const entries = inspection.entries.map((item: InspectedMarketplaceEntry): LedgerMarketplaceEntry => ({
    scope,
    registrationId: registration.id,
    entryPointer: item.entry.entryId,
    marketplaceEntryId: inspection.marketplaceId
      ? `${inspection.marketplaceId}${item.entry.entryId}`
      : `${registration.id}${item.entry.entryId}`,
    validationSnapshot: inspection.snapshot?.fingerprint,
    name: item.entry.name ?? item.plugin?.manifestName ?? item.entry.entryId,
    classification: item.classification ?? (item.plugin ? 'compatible' : 'unavailable'),
    plugin: item.plugin,
    findings: item.findings,
    unavailableReason: item.unavailableReason,
  }));
  if (entries.length > 0) return entries;
  return [{
    scope,
    registrationId: registration.id,
    name: registrationName(registration),
    classification: 'unavailable',
    findings: inspection.findings,
  }];
}

function readableState(result: ReadResult): BridgeState | undefined {
  return (result.status === 'ok' || result.status === 'missing') ? result.state : undefined;
}

function rail(scope: Scope, result: ReadResult, projectTrusted: boolean): LedgerAuthorityRail {
  const state = readableState(result);
  const health: LedgerHealth = result.status === 'incompatible'
    ? 'incompatible'
    : result.status === 'corrupted'
      ? 'indeterminate'
      : 'healthy';
  const healthText = health === 'healthy'
    ? result.status === 'missing' ? 'Healthy (empty initial state)' : 'Healthy'
    : health === 'incompatible'
      ? `Incompatible: ${result.error ?? 'unknown schema'}`
      : `Persistence Indeterminate: ${result.error ?? 'unreadable Bridge State'}`;
  return {
    scope,
    label: scope === 'global' ? 'Global Scope' : 'Project Scope',
    revision: state?.stateRevision ?? 'unavailable',
    registrationCount: state?.registrations.length ?? 0,
    installationEnabledCount:
      state?.installations.filter((item) => item.installationState === 'enabled').length ?? 0,
    installationDisabledCount:
      state?.installations.filter((item) => item.installationState === 'disabled').length ?? 0,
    overrideCount: state?.scopeOverrides.length ?? 0,
    health,
    healthText,
    trustText: scope === 'global'
      ? 'Project Trust: not applicable'
      : projectTrusted ? 'Project Trust: granted' : 'Project Trust: not granted',
  };
}

function availability(
  intent: LedgerActionIntent,
  snapshot: BridgeLedgerSnapshot,
): Pick<LedgerActionRow, 'enabled' | 'disabledReason'> {
  if (intent.mode !== 'mutation' || intent.scope === undefined) return { enabled: true };
  if (intent.scope === 'project' && snapshot.barrier.active) {
    return {
      enabled: false,
      disabledReason: `Global Pending Barrier: ${snapshot.barrier.reason ?? 'global recovery is required'}; ` +
        'open Recovery & receipts and complete an eligible Global Recovery Action',
    };
  }
  if (intent.scope === 'project' && !snapshot.projectTrusted) {
    return {
      enabled: false,
      disabledReason: 'Project Trust is not granted; Project Scope mutation is unavailable',
    };
  }
  const authority = intent.scope === 'global' ? snapshot.global : snapshot.project;
  if (intent.actionId === 'retry-application') {
    const chain = snapshot.journals[intent.scope].activeChains.find(
      (candidate) => candidate.rootReceiptId === intent.targetId,
    );
    if (!chain?.receipts[0]?.validationSnapshot) {
      return {
        enabled: false,
        disabledReason: 'Pending Application has no bound Validation Snapshot; start a fresh validated Lifecycle Intent instead of replaying it',
      };
    }
  }
  if (intent.actionId === 'repair-state') {
    if (authority.status === 'corrupted') return { enabled: true };
    if (authority.status === 'incompatible') {
      return {
        enabled: false,
        disabledReason: `Bridge State schema is incompatible: ${authority.error ?? 'unknown schema'}; update the Bridge Package`,
      };
    }
    if (snapshot.journals[intent.scope].isDegraded) return { enabled: true };
    const repairable = snapshot.journals[intent.scope].activeChains.find(
      (chain) => chain.condition === 'persistence-indeterminate' || chain.condition === 'journal-degradation',
    );
    if (repairable) return { enabled: true };
    const activeConditions = snapshot.journals[intent.scope].activeChains.map((chain) =>
      chain.condition === 'pending-application'
        ? 'Pending Application'
        : chain.condition === 'persistence-failed'
          ? 'Persistence Failed'
          : chain.condition,
    );
    return {
      enabled: false,
      disabledReason: activeConditions.length > 0
        ? `State Repair is not eligible for ${activeConditions.join(', ')}; use the exact declared Recovery Action`
        : 'State Repair has no eligible Persistence Indeterminate recovery chain or unreadable state',
    };
  }
  if (authority.status === 'incompatible') {
    return {
      enabled: false,
      disabledReason: `Bridge State is incompatible: ${authority.error ?? 'unknown schema'}; update the Bridge Package before mutation`,
    };
  }
  if (authority.status === 'corrupted') {
    return {
      enabled: false,
      disabledReason: `Persistence Indeterminate: ${authority.error ?? 'Bridge State is unreadable'}; use Repair State`,
    };
  }
  return { enabled: true };
}

const ACTION_LABELS: Record<LedgerActionId, string> = {
  'observe-partitions': 'Inspect authority partitions',
  'observe-effective-state': 'Inspect Effective State and Projected Skills',
  'register-local': 'Register local Marketplace',
  'register-git': 'Register Git Marketplace',
  'refresh-registration': 'Refresh Marketplace',
  'rebind-registration': 'Rebind Registration',
  'remove-registration': 'Remove Registration',
  'install-disabled': 'Install Disabled',
  'install-and-enable': 'Install and Enable',
  'enable-installation': 'Enable Installation',
  'disable-installation': 'Disable Installation',
  'remove-installation': 'Remove Installation',
  'create-scope-override': 'Create Scope Override',
  'remove-scope-override': 'Remove Scope Override',
  'view-receipt-journal': 'View Receipt Journal',
  'repair-state': 'Repair Bridge State',
  'retry-application': 'Retry Runtime Application',
  'inspect-receipt': 'Inspect Attempt Receipt',
};

function action(snapshot: BridgeLedgerSnapshot, intent: LedgerActionIntent): LedgerActionRow {
  if (intent.mode === 'mutation' && intent.scope === undefined) {
    throw new Error(`Mutation action ${intent.actionId} requires an explicit scope`);
  }
  const authority = intent.scope === undefined
    ? undefined
    : readableState(intent.scope === 'global' ? snapshot.global : snapshot.project);
  const boundIntent: LedgerActionIntent = intent.mode === 'mutation' && authority
    ? { ...intent, stateRevision: authority.stateRevision }
    : intent;
  return {
    id: [intent.actionId, intent.scope, intent.targetKind, intent.targetId]
      .filter((part): part is string => part !== undefined)
      .join(':'),
    label: ACTION_LABELS[intent.actionId],
    intent: boundIntent,
    ...availability(intent, snapshot),
  };
}

function registrationName(registration: Registration): string {
  return registration.alias ?? registration.marketplaceName ?? registration.id;
}

function scopeRegistrationRows(
  scope: Scope,
  state: BridgeState | undefined,
  snapshot: BridgeLedgerSnapshot,
): LedgerObjectRow[] {
  const createRow: LedgerObjectRow = {
    id: `registration-create:${scope}`,
    label: `${scope === 'global' ? 'Global' : 'Project'} registration actions`,
    scope,
    targetKind: 'scope',
    targetId: scope,
    actions: [
      action(snapshot, { actionId: 'register-local', mode: 'mutation', scope, targetKind: 'scope', targetId: scope }),
      action(snapshot, { actionId: 'register-git', mode: 'mutation', scope, targetKind: 'scope', targetId: scope }),
    ],
  };
  const records = (state?.registrations ?? []).map((registration): LedgerObjectRow => ({
    id: `registration:${scope}:${registration.id}`,
    label: registrationName(registration),
    detail: `${registration.sourceKind ?? 'unknown source'} · ${registration.source ?? '(source unavailable)'}`,
    scope,
    targetKind: 'registration',
    targetId: registration.id,
    actions: [
      action(snapshot, { actionId: 'refresh-registration', mode: 'read', scope, targetKind: 'registration', targetId: registration.id }),
      action(snapshot, { actionId: 'rebind-registration', mode: 'mutation', scope, targetKind: 'registration', targetId: registration.id }),
      action(snapshot, { actionId: 'remove-registration', mode: 'mutation', scope, targetKind: 'registration', targetId: registration.id }),
    ],
  }));
  return [createRow, ...records];
}

function pluginRows(
  scope: Scope,
  state: BridgeState | undefined,
  snapshot: BridgeLedgerSnapshot,
): LedgerObjectRow[] {
  const installRows = snapshot.marketplaceEntries[scope].map((entry): LedgerObjectRow => {
    if (!('marketplaceEntryId' in entry)) {
      const findings = entry.findings.length > 0
        ? entry.findings.map((finding) =>
            `${finding.code} · ${finding.rule} · ${finding.outcome}`,
          ).join('; ')
        : 'no Marketplace Entries were reported';
      return {
        id: `marketplace-diagnostic:${scope}:${entry.registrationId}`,
        label: entry.name,
        detail: `Unavailable · ${findings}`,
        scope,
        targetKind: 'registration',
        targetId: entry.registrationId,
        actions: [],
      };
    }
    const compatiblePluginId = entry.classification === 'compatible'
      ? entry.plugin?.id
      : undefined;
    const installed = compatiblePluginId !== undefined &&
      (state?.installations ?? []).some((installation) =>
        installation.pluginId === compatiblePluginId);
    const skillDetail = entry.plugin?.skills.length
      ? entry.plugin.skills.map((skill) =>
          `${skill.name} ${skill.invocationPolicy} resources ${skill.resources.length > 0 ? skill.resources.join(', ') : 'none'}`,
        ).join('; ')
      : 'skills none';
    const unavailableReason = installed
      ? 'this Marketplace Entry already has a scope-local Installation'
      : entry.unavailableReason
        ?? (entry.classification === 'compatible' && !entry.validationSnapshot
          ? 'Validation Snapshot is unavailable; reopen Plugins after source inspection'
          : entry.classification === 'compatible' ? undefined : `${entry.classification} Marketplace Entry`);
    const installAction = (
      actionId: 'install-disabled' | 'install-and-enable',
      desiredInstallationState: 'disabled' | 'enabled',
    ): LedgerActionRow => {
      const candidate = action(snapshot, {
        actionId,
        mode: 'mutation',
        scope,
        targetKind: 'marketplace-entry',
        targetId: entry.marketplaceEntryId,
        registrationId: entry.registrationId,
        entryPointer: entry.entryPointer,
        desiredInstallationState,
        validationSnapshot: entry.validationSnapshot,
      });
      return unavailableReason && candidate.enabled
        ? { ...candidate, enabled: false, disabledReason: unavailableReason }
        : candidate;
    };
    return {
      id: `marketplace-entry:${scope}:${entry.marketplaceEntryId}`,
      label: entry.name,
      detail: `${entry.classification} · ${entry.marketplaceEntryId} · ${skillDetail}`,
      scope,
      targetKind: 'marketplace-entry',
      targetId: entry.marketplaceEntryId,
      actions: [
        installAction('install-disabled', 'disabled'),
        installAction('install-and-enable', 'enabled'),
      ],
    };
  });
  const installationRows = (state?.installations ?? []).map((installation): LedgerObjectRow => ({
    id: `installation:${scope}:${installation.id}`,
    label: installation.manifestName ?? installation.pluginId,
    detail: `${installation.installationState} · ${installation.id}`,
    scope,
    targetKind: 'installation',
    targetId: installation.id,
    actions: [
      action(snapshot, {
        actionId: installation.installationState === 'enabled'
          ? 'disable-installation'
          : 'enable-installation',
        mode: 'mutation',
        scope,
        targetKind: 'installation',
        targetId: installation.id,
      }),
      action(snapshot, { actionId: 'remove-installation', mode: 'mutation', scope, targetKind: 'installation', targetId: installation.id }),
    ],
  }));
  return [...installRows, ...installationRows];
}

function createOverrideRow(
  kind: ScopeOverride['kind'],
  targetId: string,
  label: string,
  snapshot: BridgeLedgerSnapshot,
): LedgerObjectRow {
  return {
    id: `inherited:${kind}:${targetId}`,
    label,
    detail: `Inherited Global ${kind} · canonical target ${targetId}`,
    scope: 'global',
    targetKind: kind,
    targetId,
    actions: [
      action(snapshot, {
        actionId: 'create-scope-override',
        mode: 'mutation',
        scope: 'project',
        targetKind: kind,
        targetId,
      }),
    ],
  };
}

function overrideRows(
  globalState: BridgeState | undefined,
  projectState: BridgeState | undefined,
  snapshot: BridgeLedgerSnapshot,
): LedgerObjectRow[] {
  const existingOverrides = new Set(
    (projectState?.scopeOverrides ?? []).map((override) => `${override.kind}/${override.targetId}`),
  );
  const inherited = [
    ...(globalState?.registrations ?? [])
      .filter((registration) => !existingOverrides.has(`registration/${registration.id}`))
      .map((registration) =>
        createOverrideRow('registration', registration.id, registrationName(registration), snapshot)),
    ...(globalState?.installations ?? [])
      .filter((installation) =>
        installation.installationState === 'enabled' &&
        !existingOverrides.has(`installation/${installation.id}`))
      .map((installation) =>
        createOverrideRow('installation', installation.id, installation.manifestName ?? installation.pluginId, snapshot)),
  ];
  const overrides = (projectState?.scopeOverrides ?? []).map((override): LedgerObjectRow => {
    const canonicalOverrideId = `${override.kind}/${override.targetId}`;
    return {
      id: `scope-override:${canonicalOverrideId}`,
      label: `${override.kind} override`,
      detail: `Suppresses inherited ${override.targetId}`,
      scope: 'project',
      targetKind: 'scope-override',
      targetId: canonicalOverrideId,
      actions: [
        action(snapshot, {
          actionId: 'remove-scope-override',
          mode: 'mutation',
          scope: 'project',
          targetKind: 'scope-override',
          targetId: canonicalOverrideId,
        }),
      ],
    };
  });
  return [...inherited, ...overrides];
}

function receiptRow(receipt: AttemptReceipt, snapshot: BridgeLedgerSnapshot): LedgerObjectRow {
  return {
    id: `receipt:${receipt.scope}:${receipt.id}`,
    label: `${receipt.summary} · ${receipt.operation}`,
    detail: `${receipt.createdAt} · ${receipt.id}`,
    scope: receipt.scope,
    targetKind: 'receipt',
    targetId: receipt.id,
    actions: [
      action(snapshot, { actionId: 'inspect-receipt', mode: 'read', scope: receipt.scope, targetKind: 'receipt', targetId: receipt.id }),
    ],
  };
}

function retryApplicationRows(snapshot: BridgeLedgerSnapshot): LedgerObjectRow[] {
  return (['global', 'project'] as const).flatMap((scope) =>
    snapshot.journals[scope].activeChains
      .filter((chain) => chain.condition === 'pending-application')
      .map((chain): LedgerObjectRow => ({
        id: `retry-application:${scope}:${chain.rootReceiptId}`,
        label: `${scope === 'global' ? 'Global' : 'Project'} Pending Application`,
        detail: `Active recovery chain ${chain.rootReceiptId} · revision ${chain.stateRevision}`,
        scope,
        targetKind: 'receipt',
        targetId: chain.rootReceiptId,
        actions: [action(snapshot, {
          actionId: 'retry-application',
          mode: 'mutation',
          scope,
          targetKind: 'receipt',
          targetId: chain.rootReceiptId,
        })],
      })),
  );
}

export function buildBridgeLedgerModel(snapshot: BridgeLedgerSnapshot): BridgeLedgerModel {
  const globalState = readableState(snapshot.global);
  const projectState = readableState(snapshot.project);
  const effective = snapshot.effective;
  const observe: LedgerSection = {
    id: 'observe',
    label: 'Observe',
    description: 'Inspect authoritative partitions and the derived Effective State',
    rows: [
      {
        id: 'observe:partitions',
        label: 'Global / Project authority partitions',
        detail: `Global revision ${snapshot.global.state?.stateRevision ?? 'unavailable'} · ` +
          `Project revision ${snapshot.project.state?.stateRevision ?? 'unavailable'}`,
        actions: [action(snapshot, { actionId: 'observe-partitions', mode: 'read' })],
      },
      {
        id: 'observe:effective',
        label: 'Effective State and Projected Skills',
        detail: `registrations ${effective?.registrations.length ?? 0} · ` +
          `installations ${effective?.installations.length ?? 0} · ` +
          `suppressed ${effective?.suppressed.length ?? 0} · excluded ${effective?.excluded.length ?? 0}`,
        actions: [action(snapshot, { actionId: 'observe-effective-state', mode: 'read' })],
      },
    ],
  };
  const sources: LedgerSection = {
    id: 'sources',
    label: 'Sources',
    description: 'Marketplace Registrations and source lifecycle actions',
    rows: [
      ...scopeRegistrationRows('global', globalState, snapshot),
      ...scopeRegistrationRows('project', projectState, snapshot),
    ],
  };
  let pluginRowCache: LedgerObjectRow[] | undefined;
  const plugins: LedgerSection = {
    id: 'plugins',
    label: 'Plugins',
    description: 'Compatible candidates and scope-local Installation state',
    get rows() {
      pluginRowCache ??= [
        ...pluginRows('global', globalState, snapshot),
        ...pluginRows('project', projectState, snapshot),
      ];
      return pluginRowCache;
    },
  };
  const inheritance: LedgerSection = {
    id: 'scope-inheritance',
    label: 'Scope & inheritance',
    description: 'Project Scope overrides suppress inherited Global records without mutating them',
    rows: overrideRows(globalState, projectState, snapshot),
  };
  const recovery: LedgerSection = {
    id: 'recovery-receipts',
    label: 'Recovery & receipts',
    description: 'Non-authoritative Attempt Receipt history and explicit State Repair',
    rows: [
      ...(['global', 'project'] as const).flatMap((scope): LedgerObjectRow[] => [
        {
          id: `journal:${scope}`,
          label: `${scope === 'global' ? 'Global' : 'Project'} Receipt Journal`,
          detail: `${snapshot.journals[scope].receipts.length} receipts · ` +
            `${snapshot.journals[scope].activeChains.length} active recovery chains · ` +
            `degraded ${snapshot.journals[scope].isDegraded ? 'yes' : 'no'}`,
          scope,
          targetKind: 'scope',
          targetId: scope,
          actions: [action(snapshot, { actionId: 'view-receipt-journal', mode: 'read', scope, targetKind: 'scope', targetId: scope })],
        },
        {
          id: `repair:${scope}`,
          label: `${scope === 'global' ? 'Global' : 'Project'} State Repair`,
          scope,
          targetKind: 'scope',
          targetId: scope,
          actions: [action(snapshot, { actionId: 'repair-state', mode: 'mutation', scope, targetKind: 'scope', targetId: scope })],
        },
      ]),
      ...retryApplicationRows(snapshot),
      ...snapshot.journals.global.receipts.map((receipt) => receiptRow(receipt, snapshot)),
      ...snapshot.journals.project.receipts.map((receipt) => receiptRow(receipt, snapshot)),
    ],
  };

  return {
    rails: {
      global: rail('global', snapshot.global, snapshot.projectTrusted),
      project: rail('project', snapshot.project, snapshot.projectTrusted),
    },
    projectTrusted: snapshot.projectTrusted,
    barrier: {
      active: snapshot.barrier.active,
      text: snapshot.barrier.active
        ? snapshot.barrier.reason ?? 'global recovery is required'
        : 'Clear',
    },
    effective: {
      registrationCount: effective?.registrations.length ?? 0,
      installationCount: effective?.installations.length ?? 0,
      suppressedCount: effective?.suppressed.length ?? 0,
      excludedCount: effective?.excluded.length ?? 0,
    },
    sections: [observe, sources, plugins, inheritance, recovery],
  };
}

// The custom component is added below the presentation model so callers can use the
// pure buildBridgeLedgerModel seam independently of Pi's runtime objects.

/** Widths at or above this breakpoint render the two-column panel workspace. */
const WIDE_WORKSPACE_WIDTH = 96;

const HEALTH_BADGES: Record<LedgerHealth, { tone: 'success' | 'warning' | 'error'; label: string }> = {
  healthy: { tone: 'success', label: 'HEALTHY' },
  incompatible: { tone: 'error', label: 'INCOMPATIBLE' },
  indeterminate: { tone: 'warning', label: 'INDETERMINATE' },
};

const AVAILABILITY = {
  ready: { icon: '\u25cf', token: 'success', word: 'Ready' },
  blocked: { icon: '\u25cb', token: 'warning', word: 'Blocked' },
} as const;

export class BridgeLedgerComponent implements Component {
  private readonly model: BridgeLedgerModel;
  private readonly theme: Theme;
  private readonly tui: Pick<TUI, 'requestRender'>;
  private readonly onDone: (intent?: LedgerActionIntent) => void;
  private sectionIndex = 0;
  private rowIndex = 0;
  private browseFocus: Scope = 'global';
  private helpVisible = false;
  /** Single-column drill-down state for sub-96-column workspaces. */
  private sectionDetail = false;
  /** Expanded metadata layer for the selected entry; never consulted by dispatch. */
  private metadataExpanded = false;
  private lastWidth = 80;

  constructor(
    model: BridgeLedgerModel,
    theme: Theme,
    tui: Pick<TUI, 'requestRender'>,
    onDone: (intent?: LedgerActionIntent) => void,
  ) {
    this.model = model;
    this.theme = theme;
    this.tui = tui;
    this.onDone = onDone;
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'q') || matchesKey(data, Key.ctrl('c'))) {
      this.onDone(undefined);
      return;
    }
    if (matchesKey(data, Key.question)) {
      this.helpVisible = !this.helpVisible;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.escape)) {
      if (this.helpVisible) {
        this.helpVisible = false;
      } else if (this.metadataExpanded) {
        this.metadataExpanded = false;
      } else if (this.lastWidth < WIDE_WORKSPACE_WIDTH && this.sectionDetail) {
        this.sectionDetail = false;
        this.rowIndex = 0;
      } else {
        this.onDone(undefined);
        return;
      }
      this.tui.requestRender();
      return;
    }
    if (this.helpVisible) return;

    if (matchesKey(data, 'g') || matchesKey(data, 'p')) {
      const nextFocus: Scope = matchesKey(data, 'g') ? 'global' : 'project';
      if (nextFocus !== this.browseFocus) {
        this.browseFocus = nextFocus;
        this.rowIndex = 0;
        this.metadataExpanded = false;
        this.tui.requestRender();
      }
      return;
    }
    if (matchesKey(data, 'i')) {
      this.metadataExpanded = !this.metadataExpanded;
      this.tui.requestRender();
      return;
    }

    const wide = this.lastWidth >= WIDE_WORKSPACE_WIDTH;
    if (matchesKey(data, Key.right)) {
      if (!wide && !this.sectionDetail) {
        this.sectionDetail = true;
        this.rowIndex = 0;
        this.metadataExpanded = false;
        this.tui.requestRender();
      } else if (wide) {
        this.moveSection(1);
      }
      return;
    }
    if (matchesKey(data, Key.left)) {
      if (!wide && this.sectionDetail) {
        this.sectionDetail = false;
        this.rowIndex = 0;
        this.metadataExpanded = false;
        this.tui.requestRender();
      } else if (wide) {
        this.moveSection(-1);
      }
      return;
    }
    const listView = !wide && !this.sectionDetail;
    if (matchesKey(data, 'j') || matchesKey(data, Key.down)) {
      if (listView) this.moveSection(1);
      else this.moveRow(1);
      return;
    }
    if (matchesKey(data, 'k') || matchesKey(data, Key.up)) {
      if (listView) this.moveSection(-1);
      else this.moveRow(-1);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      if (listView) {
        this.sectionDetail = true;
        this.rowIndex = 0;
        this.metadataExpanded = false;
        this.tui.requestRender();
        return;
      }
      const selected = this.actionEntries()[this.rowIndex];
      if (!selected) return;
      if (!selected.action.enabled) {
        this.tui.requestRender();
        return;
      }
      this.onDone({ ...selected.action.intent });
    }
  }

  render(width: number): string[] {
    this.lastWidth = Math.max(1, Math.floor(width));
    const out = [
      this.fit('CODEX MARKETPLACE / BRIDGE LEDGER', this.lastWidth, 'accent'),
      ...this.railPanels(this.lastWidth),
    ];
    if (this.helpVisible) {
      out.push(...renderPanel(this.theme, {
        title: 'Help',
        lines: this.helpLines().map((line) => this.fit(line, Math.max(1, this.lastWidth - 3), 'text')),
        width: this.lastWidth,
      }));
    } else if (this.lastWidth >= WIDE_WORKSPACE_WIDTH) {
      out.push(...this.wideWorkspace(this.lastWidth));
    } else {
      out.push(...this.drilldownWorkspace(this.lastWidth));
    }
    out.push(this.fit(this.statusText(), this.lastWidth, 'dim'));
    out.push(this.fit(this.keyHints(), this.lastWidth, 'dim'));
    return out.map((line) => fitTerminalLine(line, this.lastWidth));
  }

  invalidate(): void {
    // This component has no render cache. Host invalidation must not cause an
    // invalidate -> requestRender loop.
  }

  private moveSection(delta: number): void {
    const count = this.model.sections.length;
    if (count === 0) return;
    this.sectionIndex = (this.sectionIndex + delta + count) % count;
    this.rowIndex = 0;
    this.metadataExpanded = false;
    this.tui.requestRender();
  }

  private moveRow(delta: number): void {
    const count = this.actionEntries().length;
    if (count === 0) return;
    this.rowIndex = (this.rowIndex + delta + count) % count;
    this.metadataExpanded = false;
    this.tui.requestRender();
  }

  private fit(text: string, width: number, token: Parameters<Theme['fg']>[0] = 'text'): string {
    return fitTerminalLine(this.theme.fg(token, text), width);
  }

  // --- Authority rails -----------------------------------------------------

  private railPanels(width: number): string[] {
    if (width < WIDE_WORKSPACE_WIDTH) {
      return [
        ...renderPanel(this.theme, {
          title: this.model.rails.global.label,
          lines: this.railContentLines('global', width - 3),
          width,
          borderToken: 'borderMuted',
        }),
        ...renderPanel(this.theme, {
          title: this.model.rails.project.label,
          lines: this.railContentLines('project', width - 3),
          width,
          borderToken: 'borderAccent',
        }),
      ];
    }
    const leftWidth = Math.max(24, Math.floor((width - 2) / 2));
    const rightWidth = Math.max(24, width - 2 - leftWidth);
    return renderSideBySidePanels(this.theme, {
      left: {
        title: this.model.rails.global.label,
        lines: this.railContentLines('global', leftWidth - 3),
        width: leftWidth,
        borderToken: 'borderMuted',
      },
      right: {
        title: this.model.rails.project.label,
        lines: this.railContentLines('project', rightWidth - 3),
        width: rightWidth,
        borderToken: 'borderAccent',
      },
      totalWidth: width,
    });
  }

  private railBadge(scope: Scope): string {
    const rail = scope === 'global' ? this.model.rails.global : this.model.rails.project;
    const badges = [renderBadge(this.theme, HEALTH_BADGES[rail.health].tone, HEALTH_BADGES[rail.health].label)];
    if (scope === 'project') {
      badges.push(renderBadge(
        this.theme,
        this.model.projectTrusted ? 'success' : 'warning',
        this.model.projectTrusted ? 'TRUST GRANTED' : 'NO PROJECT TRUST',
      ));
    } else {
      badges.push(renderBadge(this.theme, this.model.barrier.active ? 'error' : 'success',
        this.model.barrier.active ? 'BARRIER ACTIVE' : 'BARRIER CLEAR'));
    }
    return badges.join(' ');
  }

  private railContentLines(scope: Scope, width: number): string[] {
    const rail = scope === 'global' ? this.model.rails.global : this.model.rails.project;
    const marker = scope === 'global' ? 'G' : 'P';
    const fitDim = (text: string): string => this.fit(text, width, 'dim');
    const lines = [
      this.railBadge(scope),
      `${marker} rev ${quoteTerminalText(rail.revision)}`,
      `registrations ${rail.registrationCount}`,
      `installations ${rail.installationEnabledCount} enabled / ${rail.installationDisabledCount} disabled`,
    ];
    if (scope === 'project') lines.push(`overrides ${rail.overrideCount}`);
    if (rail.health !== 'healthy') lines.push(fitDim(quoteTerminalText(rail.healthText)));
    if (scope === 'project') lines.push(fitDim(rail.trustText));
    if (scope === 'global' && this.model.barrier.active) {
      lines.push(this.fit(`\u21b3 Barrier reason: ${quoteTerminalText(this.model.barrier.text)}`, width, 'warning'));
    }
    return lines;
  }

  // --- Workspaces ----------------------------------------------------------

  private sectionNavLines(width: number): string[] {
    return this.model.sections.map((section, index) =>
      renderSelectableRow(this.theme, {
        selected: index === this.sectionIndex,
        text: this.theme.fg(index === this.sectionIndex ? 'accent' : 'text', section.label),
        width,
      }));
  }

  private wideWorkspace(width: number): string[] {
    const navWidth = Math.min(34, Math.max(22, Math.floor(width * 0.28)));
    const detailWidth = Math.max(24, width - navWidth - 2);
    const section = this.currentSection();
    return renderSideBySidePanels(this.theme, {
      left: {
        title: 'Navigation',
        lines: this.sectionNavLines(navWidth - 3),
        width: navWidth,
        borderToken: 'borderMuted',
      },
      right: {
        title: section.label,
        lines: [
          this.fit(section.description, detailWidth - 3, 'dim'),
          '',
          ...this.actionEntryLines(detailWidth - 3),
        ],
        width: detailWidth,
        borderToken: 'borderAccent',
      },
      totalWidth: width,
    });
  }

  private drilldownWorkspace(width: number): string[] {
    if (!this.sectionDetail) {
      return renderPanel(this.theme, {
        title: 'Sections',
        lines: this.sectionNavLines(Math.max(1, width - 3)),
        width,
        borderToken: 'borderAccent',
      });
    }
    const section = this.currentSection();
    return renderPanel(this.theme, {
      title: section.label,
      lines: [
        this.fit(section.description, Math.max(1, width - 3), 'dim'),
        '',
        ...this.actionEntryLines(Math.max(1, width - 3)),
      ],
      width,
      borderToken: 'borderAccent',
    });
  }

  // --- Action entries ------------------------------------------------------

  /**
   * Renders every visible row in the panel visual language: availability is an
   * icon+token+word state, selection combines a background wash with a text
   * cursor, and structured field dumps live only in the expandable metadata layer.
   */
  private actionEntryLines(width: number): string[] {
    const rows = this.visibleRows();
    if (rows.length === 0) return [this.fit('No rows in this section', width, 'muted')];
    let actionIndex = 0;
    const lines: string[] = [];
    for (const row of rows) {
      if (row.actions.length === 0) {
        lines.push(
          this.fit(`${AVAILABILITY.blocked.icon} Unavailable \u00b7 ${quoteTerminalText(row.label)}`, width, 'warning'),
          this.fit(`   ${quoteTerminalText(row.detail ?? '(no findings reported)')}`, width, 'dim'),
        );
        continue;
      }
      for (const action of row.actions) {
        const selected = actionIndex === this.rowIndex;
        actionIndex += 1;
        const availability = action.enabled ? AVAILABILITY.ready : AVAILABILITY.blocked;
        const text =
          this.theme.fg(availability.token, `${availability.icon} ${availability.word} ${action.label}`) +
          this.theme.fg('dim', ` \u00b7 ${quoteTerminalText(row.label)}`);
        lines.push(renderSelectableRow(this.theme, { selected, text, width }));
        if (!selected) continue;
        if (!action.enabled) {
          lines.push(...this.wrapContext(
            `\u21b3 Blocked: ${quoteTerminalText(action.disabledReason ?? 'unavailable')}`,
            width, 'warning', 4));
        }
        if (this.metadataExpanded) {
          const intent = action.intent;
          const meta = [
            `target ${intent.targetKind ?? row.targetKind ?? 'none'} ` +
              quoteTerminalText(intent.targetId ?? row.targetId ?? '(none)'),
            `scope ${intent.scope ?? row.scope ?? 'none'}`,
            `mode ${intent.mode}`,
          ];
          if (row.detail !== undefined) meta.push(`detail ${quoteTerminalText(row.detail)}`);
          lines.push(...meta.flatMap((entry) => this.wrapContext(`  ${entry}`, width, 'muted', 4)));
        }
      }
    }
    return lines;
  }

  private wrapContext(text: string, width: number, token: Parameters<Theme['fg']>[0], maxLines: number): string[] {
    const wrapped = wrapTextWithAnsi(this.theme.fg(token, text), Math.max(1, width)).slice(0, maxLines);
    return wrapped.map((line) => fitTerminalLine(line, width));
  }

  private helpLines(): string[] {
    return [
      'Up/Down or j/k: move selection',
      'Left/Right: change section (wide layout) or drill down',
      'Enter: open section or activate available structured action',
      'i: expand or collapse the selected entry metadata',
      'g/p: browse Global/Project only; mutation authority remains explicit',
      'Esc: back/cancel | q or Ctrl-C: exit | ?: close help',
    ];
  }

  private visibleRows(section = this.currentSection()): LedgerObjectRow[] {
    const scopePartitioned = section.id === 'sources'
      || section.id === 'plugins'
      || section.id === 'recovery-receipts';
    return scopePartitioned
      ? section.rows.filter((row) => row.scope === undefined || row.scope === this.browseFocus)
      : section.rows;
  }

  private actionEntries(section = this.currentSection()): { row: LedgerObjectRow; action: LedgerActionRow }[] {
    return this.visibleRows(section)
      .flatMap((row) => row.actions.map((action) => ({ row, action })));
  }

  private currentSection(): LedgerSection {
    return this.model.sections[this.sectionIndex]!;
  }

  private statusText(): string {
    const section = this.currentSection();
    const pane = this.lastWidth >= WIDE_WORKSPACE_WIDTH || this.sectionDetail ? 'actions' : 'sections';
    return `Status: browsing ${this.browseFocus === 'global' ? 'G' : 'P'} | ${section.label} | ${pane}`;
  }

  private keyHints(): string {
    if (this.helpVisible) return 'Keys: ?/Esc close help | q/Ctrl-C exit | Esc/q cancel context';
    if (this.lastWidth < WIDE_WORKSPACE_WIDTH && !this.sectionDetail) {
      return 'Keys: Esc/q cancel | Enter drill down | j/k move | g/p | ? help';
    }
    return 'Keys: Esc/q cancel | Enter activate | j/k or arrows move | i details | g/p browse | ? help';
  }
}
