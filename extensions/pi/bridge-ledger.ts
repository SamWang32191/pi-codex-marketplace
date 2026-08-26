/**
 * Bridge Ledger presentation model and Pi TUI component.
 *
 * The single ReadResult in BridgeLedgerSnapshot is the only Bridge State authority.
 * Effective State, action availability, labels, counts, journals, and rendering are
 * derived presentation data and are never persisted by this module.
 *
 * Global-only (#61): one authority rail, one document, one journal.
 */

import type { Theme } from '@earendil-works/pi-coding-agent';
import { Key, matchesKey, wrapTextWithAnsi, type Component, type TUI } from '@earendil-works/pi-tui';

import { readBridgeState } from '../../src/bridge-state/store.js';
import type {
  BridgeState,
  ReadResult,
  Registration,
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
import { attemptSummaryText, findingOutcomeText, uiText } from './ui-strings.js';

export type LedgerSectionId =
  | 'observe'
  | 'sources'
  | 'plugins'
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
  | 'view-receipt-journal'
  | 'repair-state'
  | 'retry-application'
  | 'inspect-receipt';

export type LedgerTargetKind =
  | 'scope'
  | 'registration'
  | 'marketplace-entry'
  | 'installation'
  | 'receipt';

export interface LedgerActionIntent {
  actionId: LedgerActionId;
  mode: 'read' | 'mutation';
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
  label: string;
  revision: string;
  registrationCount: number;
  installationEnabledCount: number;
  installationDisabledCount: number;
  health: LedgerHealth;
  healthText: string;
}

export interface BridgeLedgerSnapshot {
  global: ReadResult;
  journal: JournalReadResult;
  marketplaceEntries: LedgerMarketplaceItem[];
  effective?: EffectiveState;
}

export interface LedgerMarketplaceEntry {
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
  registrationId: string;
  name: string;
  classification: 'unavailable';
  findings: ValidationFinding[];
}

export type LedgerMarketplaceItem = LedgerMarketplaceEntry | LedgerMarketplaceDiagnostic;

export interface BridgeLedgerModel {
  rail: LedgerAuthorityRail;
  effective: {
    registrationCount: number;
    installationCount: number;
  };
  sections: LedgerSection[];
}

export interface LoadBridgeLedgerSnapshotOptions {
  agentDir?: string;
  inspectMarketplaceEntries?: typeof inspectMarketplaceEntries;
}

export async function loadBridgeLedgerSnapshot(
  options: LoadBridgeLedgerSnapshotOptions = {},
): Promise<BridgeLedgerSnapshot> {
  const [state, journal] = await Promise.all([
    readBridgeState({ agentDir: options.agentDir }),
    readReceiptJournal({ agentDir: options.agentDir }),
  ]);
  const readable = readableState(state);
  const effective = readable ? computeEffectiveState(readable) : undefined;
  let marketplaceEntries: LedgerMarketplaceItem[] | undefined;

  return {
    global: state,
    journal,
    // Lazy once per snapshot: Plugins-section rendering triggers the single inspection pass;
    // a fresh reload rebuilds the snapshot and re-inspects.
    get marketplaceEntries() {
      marketplaceEntries ??= inspectLedgerEntries(
        readable,
        options.agentDir,
        options.inspectMarketplaceEntries,
      );
      return marketplaceEntries;
    },
    effective,
  };
}

function inspectLedgerEntries(
  state: BridgeState | undefined,
  agentDir?: string,
  inspector = inspectMarketplaceEntries,
): LedgerMarketplaceItem[] {
  return (state?.registrations ?? []).flatMap((registration) => {
    const inspection = inspector(registration, { agentDir });
    return mapMarketplaceInspectionToLedgerItems(registration, inspection);
  });
}

export function mapMarketplaceInspectionToLedgerItems(
  registration: Registration,
  inspection: MarketplaceInspection,
): LedgerMarketplaceItem[] {
  const entries = inspection.entries.map((item: InspectedMarketplaceEntry): LedgerMarketplaceEntry => ({
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
    registrationId: registration.id,
    name: registrationName(registration),
    classification: 'unavailable',
    findings: inspection.findings,
  }];
}

function readableState(result: ReadResult): BridgeState | undefined {
  return (result.status === 'ok' || result.status === 'missing') ? result.state : undefined;
}

function rail(result: ReadResult): LedgerAuthorityRail {
  const state = readableState(result);
  const health: LedgerHealth = result.status === 'incompatible'
    ? 'incompatible'
    : result.status === 'corrupted'
      ? 'indeterminate'
      : 'healthy';
  const healthText = health === 'healthy'
    ? result.status === 'missing'
      ? uiText('ledger.rail.health.healthyEmpty')
      : uiText('ledger.rail.health.healthy')
    : health === 'incompatible'
      ? uiText('ledger.rail.health.incompatible', { error: result.error ?? uiText('common.unknown') })
      : uiText('ledger.rail.health.indeterminate', { error: result.error ?? uiText('common.unknown') });
  return {
    label: uiText('common.scope.global'),
    revision: state?.stateRevision ?? uiText('ledger.revision.unavailable'),
    registrationCount: state?.registrations.length ?? 0,
    installationEnabledCount:
      state?.installations.filter((item) => item.installationState === 'enabled').length ?? 0,
    installationDisabledCount:
      state?.installations.filter((item) => item.installationState === 'disabled').length ?? 0,
    health,
    healthText,
  };
}

function availability(
  intent: LedgerActionIntent,
  snapshot: BridgeLedgerSnapshot,
): Pick<LedgerActionRow, 'enabled' | 'disabledReason'> {
  if (intent.mode !== 'mutation') return { enabled: true };
  const authority = snapshot.global;
  if (intent.actionId === 'retry-application') {
    const chain = snapshot.journal.activeChains.find(
      (candidate) => candidate.rootReceiptId === intent.targetId,
    );
    if (!chain?.receipts[0]?.validationSnapshot) {
      return {
        enabled: false,
        disabledReason: uiText('ledger.disabledReason.retryNoSnapshot'),
      };
    }
  }
  if (intent.actionId === 'repair-state') {
    if (authority.status === 'corrupted') return { enabled: true };
    if (authority.status === 'incompatible') {
      return {
        enabled: false,
        disabledReason: uiText('ledger.disabledReason.incompatible', {
          error: authority.error ?? uiText('common.unknown'),
        }),
      };
    }
    if (snapshot.journal.isDegraded) return { enabled: true };
    const repairable = snapshot.journal.activeChains.find(
      (chain) => chain.condition === 'persistence-indeterminate' || chain.condition === 'journal-degradation',
    );
    if (repairable) return { enabled: true };
    const activeConditions = snapshot.journal.activeChains.map((chain) =>
      chain.condition === 'pending-application'
        ? uiText('ledger.condition.pending-application')
        : chain.condition === 'persistence-failed'
          ? uiText('ledger.condition.persistence-failed')
          : chain.condition,
    );
    return {
      enabled: false,
      disabledReason: activeConditions.length > 0
        ? uiText('ledger.disabledReason.repairIneligible', { conditions: activeConditions.join(', ') })
        : uiText('ledger.disabledReason.repairNothing'),
    };
  }
  if (authority.status === 'incompatible') {
    return {
      enabled: false,
      disabledReason: uiText('ledger.disabledReason.incompatibleMutation', {
        error: authority.error ?? uiText('common.unknown'),
      }),
    };
  }
  if (authority.status === 'corrupted') {
    return {
      enabled: false,
      disabledReason: uiText('ledger.disabledReason.corrupted', {
        error: authority.error ?? uiText('ledger.disabledReason.corruptState'),
      }),
    };
  }
  return { enabled: true };
}

const ACTION_LABELS: Record<LedgerActionId, string> = {
  'observe-partitions': uiText('ledger.action.observe-partitions'),
  'observe-effective-state': uiText('ledger.action.observe-effective-state'),
  'register-local': uiText('ledger.action.register-local'),
  'register-git': uiText('ledger.action.register-git'),
  'refresh-registration': uiText('ledger.action.refresh-registration'),
  'rebind-registration': uiText('ledger.action.rebind-registration'),
  'remove-registration': uiText('ledger.action.remove-registration'),
  'install-disabled': uiText('ledger.action.install-disabled'),
  'install-and-enable': uiText('ledger.action.install-and-enable'),
  'enable-installation': uiText('ledger.action.enable-installation'),
  'disable-installation': uiText('ledger.action.disable-installation'),
  'remove-installation': uiText('ledger.action.remove-installation'),
  'view-receipt-journal': uiText('ledger.action.view-receipt-journal'),
  'repair-state': uiText('ledger.action.repair-state'),
  'retry-application': uiText('ledger.action.retry-application'),
  'inspect-receipt': uiText('ledger.action.inspect-receipt'),
};

function action(snapshot: BridgeLedgerSnapshot, intent: LedgerActionIntent): LedgerActionRow {
  const authority = intent.mode === 'mutation' ? readableState(snapshot.global) : undefined;
  const boundIntent: LedgerActionIntent = intent.mode === 'mutation' && authority
    ? { ...intent, stateRevision: authority.stateRevision }
    : intent;
  return {
    id: [intent.actionId, intent.targetKind, intent.targetId]
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

function registrationRows(
  state: BridgeState | undefined,
  snapshot: BridgeLedgerSnapshot,
): LedgerObjectRow[] {
  const createRow: LedgerObjectRow = {
    id: 'registration-create',
    label: uiText('ledger.row.registrationActions', {
      scopeWord: uiText('common.scope.word.global'),
    }),
    targetKind: 'scope',
    targetId: 'global',
    actions: [
      action(snapshot, { actionId: 'register-local', mode: 'mutation', targetKind: 'scope', targetId: 'global' }),
      action(snapshot, { actionId: 'register-git', mode: 'mutation', targetKind: 'scope', targetId: 'global' }),
    ],
  };
  const records = (state?.registrations ?? []).map((registration): LedgerObjectRow => ({
    id: `registration:${registration.id}`,
    label: registrationName(registration),
    detail: `${registration.sourceKind ?? uiText('ledger.row.registration.sourceUnknown')} · ${registration.source ?? uiText('ledger.row.registration.sourceUnavailable')}`,
    targetKind: 'registration',
    targetId: registration.id,
    actions: [
      action(snapshot, { actionId: 'refresh-registration', mode: 'read', targetKind: 'registration', targetId: registration.id }),
      action(snapshot, { actionId: 'rebind-registration', mode: 'mutation', targetKind: 'registration', targetId: registration.id }),
      action(snapshot, { actionId: 'remove-registration', mode: 'mutation', targetKind: 'registration', targetId: registration.id }),
    ],
  }));
  return [createRow, ...records];
}

function pluginRows(
  state: BridgeState | undefined,
  snapshot: BridgeLedgerSnapshot,
): LedgerObjectRow[] {
  const installRows = snapshot.marketplaceEntries.map((entry): LedgerObjectRow => {
    if (!('marketplaceEntryId' in entry)) {
      const findings = entry.findings.length > 0
        ? entry.findings.map((finding) =>
            `${finding.code} · ${finding.rule} · ${findingOutcomeText(finding)}`,
          ).join('; ')
        : uiText('ledger.row.diagnostic.noEntries');
      return {
        id: `marketplace-diagnostic:${entry.registrationId}`,
        label: entry.name,
        detail: uiText('ledger.row.diagnostic.unavailable', { findings }),
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
          uiText('ledger.row.skills.resources', {
            name: skill.name,
            policy: skill.invocationPolicy,
            resources: skill.resources.length > 0 ? skill.resources.join(', ') : uiText('ledger.row.skills.noResources'),
          }),
        ).join('; ')
      : uiText('ledger.row.skills.none');
    const unavailableReason = installed
      ? uiText('ledger.row.install.alreadyInstalled')
      : entry.unavailableReason
        ?? (entry.classification === 'compatible' && !entry.validationSnapshot
          ? uiText('ledger.row.install.snapshotMissing')
          : entry.classification === 'compatible'
            ? undefined
            : uiText('ledger.row.install.classification', { classification: entry.classification }));
    const installAction = (
      actionId: 'install-disabled' | 'install-and-enable',
      desiredInstallationState: 'disabled' | 'enabled',
    ): LedgerActionRow => {
      const candidate = action(snapshot, {
        actionId,
        mode: 'mutation',
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
      id: `marketplace-entry:${entry.marketplaceEntryId}`,
      label: entry.name,
      detail: `${entry.classification} · ${entry.marketplaceEntryId} · ${skillDetail}`,
      targetKind: 'marketplace-entry',
      targetId: entry.marketplaceEntryId,
      actions: [
        installAction('install-disabled', 'disabled'),
        installAction('install-and-enable', 'enabled'),
      ],
    };
  });
  const installationRows = (state?.installations ?? []).map((installation): LedgerObjectRow => ({
    id: `installation:${installation.id}`,
    label: installation.manifestName ?? installation.pluginId,
    detail: `${installation.installationState} · ${installation.id}`,
    targetKind: 'installation',
    targetId: installation.id,
    actions: [
      action(snapshot, {
        actionId: installation.installationState === 'enabled'
          ? 'disable-installation'
          : 'enable-installation',
        mode: 'mutation',
        targetKind: 'installation',
        targetId: installation.id,
      }),
      action(snapshot, { actionId: 'remove-installation', mode: 'mutation', targetKind: 'installation', targetId: installation.id }),
    ],
  }));
  return [...installRows, ...installationRows];
}

function receiptRow(receipt: AttemptReceipt, snapshot: BridgeLedgerSnapshot): LedgerObjectRow {
  return {
    id: `receipt:${receipt.id}`,
    label: `${attemptSummaryText(receipt.summary)} · ${receipt.operation}`,
    detail: `${receipt.createdAt} · ${receipt.id}`,
    targetKind: 'receipt',
    targetId: receipt.id,
    actions: [
      action(snapshot, { actionId: 'inspect-receipt', mode: 'read', targetKind: 'receipt', targetId: receipt.id }),
    ],
  };
}

function retryApplicationRows(snapshot: BridgeLedgerSnapshot): LedgerObjectRow[] {
  return snapshot.journal.activeChains
    .filter((chain) => chain.condition === 'pending-application')
    .map((chain): LedgerObjectRow => ({
      id: `retry-application:${chain.rootReceiptId}`,
      label: uiText('ledger.row.retry.label', {
        scopeWord: uiText('common.scope.word.global'),
      }),
      detail: uiText('ledger.row.retry.detail', {
        receiptId: chain.rootReceiptId,
        revision: chain.stateRevision,
      }),
      targetKind: 'receipt',
      targetId: chain.rootReceiptId,
      actions: [action(snapshot, {
        actionId: 'retry-application',
        mode: 'mutation',
        targetKind: 'receipt',
        targetId: chain.rootReceiptId,
      })],
    }));
}

export function buildBridgeLedgerModel(snapshot: BridgeLedgerSnapshot): BridgeLedgerModel {
  const globalState = readableState(snapshot.global);
  const effective = snapshot.effective;
  const observe: LedgerSection = {
    id: 'observe',
    label: uiText('ledger.section.observe.label'),
    description: uiText('ledger.section.observe.description'),
    rows: [
      {
        id: 'observe:partitions',
        label: uiText('ledger.row.observe.partitions'),
        detail: uiText('ledger.row.observe.partitionsDetail', {
          global: snapshot.global.state?.stateRevision ?? uiText('ledger.revision.unavailable'),
          project: uiText('ledger.revision.unavailable'),
        }),
        actions: [action(snapshot, { actionId: 'observe-partitions', mode: 'read' })],
      },
      {
        id: 'observe:effective',
        label: uiText('ledger.row.observe.effective'),
        detail: uiText('ledger.row.observe.effectiveDetail', {
          registrations: effective?.registrations.length ?? 0,
          installations: effective?.installations.length ?? 0,
          suppressed: 0,
          excluded: 0,
        }),
        actions: [action(snapshot, { actionId: 'observe-effective-state', mode: 'read' })],
      },
    ],
  };
  const sources: LedgerSection = {
    id: 'sources',
    label: uiText('ledger.section.sources.label'),
    description: uiText('ledger.section.sources.description'),
    rows: registrationRows(globalState, snapshot),
  };
  let pluginRowCache: LedgerObjectRow[] | undefined;
  const plugins: LedgerSection = {
    id: 'plugins',
    label: uiText('ledger.section.plugins.label'),
    description: uiText('ledger.section.plugins.description'),
    get rows() {
      pluginRowCache ??= pluginRows(globalState, snapshot);
      return pluginRowCache;
    },
  };
  const recovery: LedgerSection = {
    id: 'recovery-receipts',
    label: uiText('ledger.section.recovery-receipts.label'),
    description: uiText('ledger.section.recovery-receipts.description'),
    rows: [
      {
        id: 'journal:global',
        label: uiText('ledger.row.journal.label', {
          scopeWord: uiText('common.scope.word.global'),
        }),
        detail: uiText('ledger.row.journal.detail', {
          receipts: snapshot.journal.receipts.length,
          chains: snapshot.journal.activeChains.length,
          degraded: snapshot.journal.isDegraded ? uiText('common.yes') : uiText('common.no'),
        }),
        targetKind: 'scope',
        targetId: 'global',
        actions: [action(snapshot, { actionId: 'view-receipt-journal', mode: 'read', targetKind: 'scope', targetId: 'global' })],
      },
      {
        id: 'repair:global',
        label: uiText('ledger.row.repair.label', {
          scopeWord: uiText('common.scope.word.global'),
        }),
        targetKind: 'scope',
        targetId: 'global',
        actions: [action(snapshot, { actionId: 'repair-state', mode: 'mutation', targetKind: 'scope', targetId: 'global' })],
      },
      ...retryApplicationRows(snapshot),
      ...snapshot.journal.receipts.map((receipt) => receiptRow(receipt, snapshot)),
    ],
  };

  return {
    rail: rail(snapshot.global),
    effective: {
      registrationCount: effective?.registrations.length ?? 0,
      installationCount: effective?.installations.length ?? 0,
    },
    sections: [observe, sources, plugins, recovery],
  };
}

// The custom component is added below the presentation model so callers can use the
// pure buildBridgeLedgerModel seam independently of Pi's runtime objects.

/** Widths at or above this breakpoint render the two-column panel workspace. */
const WIDE_WORKSPACE_WIDTH = 96;

const HEALTH_BADGES: Record<LedgerHealth, { tone: 'success' | 'warning' | 'error'; labelId: Parameters<typeof uiText>[0] }> = {
  healthy: { tone: 'success', labelId: 'ledger.badge.healthy' },
  incompatible: { tone: 'error', labelId: 'ledger.badge.incompatible' },
  indeterminate: { tone: 'warning', labelId: 'ledger.badge.indeterminate' },
};

const AVAILABILITY = {
  ready: { icon: '\u25cf', token: 'success', word: uiText('ledger.availability.ready') },
  blocked: { icon: '\u25cb', token: 'warning', word: uiText('ledger.availability.blocked') },
} as const;

export class BridgeLedgerComponent implements Component {
  private readonly model: BridgeLedgerModel;
  private readonly theme: Theme;
  private readonly tui: Pick<TUI, 'requestRender'>;
  private readonly onDone: (intent?: LedgerActionIntent) => void;
  private sectionIndex = 0;
  private rowIndex = 0;
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
        title: uiText('ledger.panel.help'),
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

  // --- Authority rail ------------------------------------------------------

  private railPanels(width: number): string[] {
    return [
      ...renderPanel(this.theme, {
        title: this.model.rail.label,
        lines: this.railContentLines(width - 3),
        width,
        borderToken: 'borderAccent',
      }),
    ];
  }

  private railContentLines(width: number): string[] {
    const rail = this.model.rail;
    const marker = 'G';
    const fitDim = (text: string): string => this.fit(text, width, 'dim');
    const lines = [
      this.railBadge(),
      uiText('ledger.rail.revision', { marker, revision: quoteTerminalText(rail.revision) }),
      uiText('ledger.rail.registrations', { count: rail.registrationCount }),
      uiText('ledger.rail.installations', {
        enabled: rail.installationEnabledCount,
        disabled: rail.installationDisabledCount,
      }),
    ];
    if (rail.health !== 'healthy') lines.push(fitDim(quoteTerminalText(rail.healthText)));
    return lines;
  }

  private railBadge(): string {
    const badges = [renderBadge(this.theme, HEALTH_BADGES[this.model.rail.health].tone, uiText(HEALTH_BADGES[this.model.rail.health].labelId))];
    return badges.join(' ');
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
        title: uiText('ledger.panel.navigation'),
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
        title: uiText('ledger.panel.sections'),
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
    if (rows.length === 0) return [this.fit(uiText('ledger.rows.empty'), width, 'muted')];
    let actionIndex = 0;
    const lines: string[] = [];
    for (const row of rows) {
      if (row.actions.length === 0) {
        lines.push(
          this.fit(`${AVAILABILITY.blocked.icon} ${uiText('ledger.entry.unavailableRow', { label: quoteTerminalText(row.label) })}`, width, 'warning'),
          this.fit(`   ${quoteTerminalText(row.detail ?? uiText('ledger.entry.noFindings'))}`, width, 'dim'),
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
            `\u21b3 ${uiText('ledger.entry.blocked', { reason: quoteTerminalText(action.disabledReason ?? uiText('common.unavailable')) })}`,
            width, 'warning', 4));
        }
        if (this.metadataExpanded) {
          const intent = action.intent;
          const meta = [
            uiText('ledger.meta.target', {
              kind: intent.targetKind ?? row.targetKind ?? uiText('common.none'),
              target: quoteTerminalText(intent.targetId ?? row.targetId ?? uiText('common.none')),
            }),
            uiText('ledger.meta.mode', { mode: intent.mode }),
          ];
          if (row.detail !== undefined) meta.push(uiText('ledger.meta.detail', { detail: quoteTerminalText(row.detail) }));
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
      uiText('ledger.help.move'),
      uiText('ledger.help.sections'),
      uiText('ledger.help.enter'),
      uiText('ledger.help.metadata'),
      uiText('ledger.help.close'),
    ];
  }

  private visibleRows(section = this.currentSection()): LedgerObjectRow[] {
    return section.rows;
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
    const pane = this.lastWidth >= WIDE_WORKSPACE_WIDTH || this.sectionDetail
      ? uiText('ledger.status.pane.actions')
      : uiText('ledger.status.pane.sections');
    return uiText('ledger.status.browsing', {
      marker: 'G',
      section: section.label,
      pane,
    });
  }

  private keyHints(): string {
    if (this.helpVisible) return uiText('ledger.keys.help');
    if (this.lastWidth < WIDE_WORKSPACE_WIDTH && !this.sectionDetail) {
      return uiText('ledger.keys.drilldown');
    }
    return uiText('ledger.keys.wide');
  }
}
