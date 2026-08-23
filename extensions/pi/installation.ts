/** TUI flow for Compatibility Profile v1 Plugin Installation and state toggles. */

import type { ExtensionCommandContext, ExtensionUIContext } from '@earendil-works/pi-coding-agent';

import { readBridgeState } from '../../src/bridge-state/store.js';
import {
  confirmPluginDisable,
  confirmPluginEnable,
  confirmPluginInstallation,
  declinePluginDisable,
  declinePluginInstallation,
  installationDisclosure,
  preflightPluginDisable,
  preflightPluginEnable,
  preflightPluginInstallation,
  type InstallationFlowOptions,
  type PluginDisablePreflight,
  type PluginInstallationPreflight,
} from '../../src/installation/flow.js';
import { inspectMarketplaceEntries } from '../../src/installation/inspection.js';
import type { SourceCache } from '../../src/cache/source-cache.js';
import type { Installation, Registration, Scope } from '../../src/bridge-state/types.js';
import {
  fullValidationDisclosureLines,
  reportOutcome,
  reportTerminalPreflightOutcome,
  validationDisclosureLines,
} from './registration.js';
import { quoteTerminalText } from './terminal-presentation.js';
import { openTransactionSheet, type TransactionSheetModel } from './transaction-sheet.js';

interface EntryChoice {
  label: string;
  pointer?: string;
  marketplaceEntryId?: string;
  validationSnapshot?: string;
}

function labelText(value: string): string { return quoteTerminalText(value); }

async function transactionStep(
  ctx: ExtensionCommandContext,
  model: TransactionSheetModel,
  cancel?: () => void | Promise<void>,
): Promise<boolean> {
  if (await openTransactionSheet(ctx, model) === 'continue') return true;
  if (cancel) await cancel();
  else ctx.ui.notify('已取消 Transaction；Bridge State 未變更。', 'info');
  return false;
}

export async function entryChoices(
  registration: Registration,
  scope: Scope,
  opts: { cwd?: string; agentDir?: string; projectTrusted?: boolean; cache?: SourceCache } = {},
): Promise<EntryChoice[]> {
  const inspection = inspectMarketplaceEntries(registration, scope, { agentDir: opts.agentDir, cache: opts.cache });
  if (!inspection.marketplaceId) {
    return [{
      label: `${labelText(registration.alias ?? registration.id)} — ` +
        `Unavailable (${labelText(inspection.findings[0]?.outcome ?? 'Marketplace Catalog cannot be read')})`,
    }];
  }
  return inspection.entries.map((item) => {
    const status = item.unavailableReason ? `Unavailable (${item.unavailableReason})` : '可安裝';
    const marketplaceEntryId = `${inspection.marketplaceId}${item.entry.entryId}`;
    return {
      label: `${labelText(marketplaceEntryId)} · ` +
        `${labelText(item.entry.name ?? item.plugin?.manifestName ?? 'unnamed')} — ${labelText(status)}`,
      pointer: item.unavailableReason ? undefined : item.entry.entryId,
      marketplaceEntryId: item.unavailableReason ? undefined : marketplaceEntryId,
      validationSnapshot: item.unavailableReason ? undefined : inspection.snapshot?.fingerprint,
    };
  });
}

export async function runPluginInstallationFlow(
  ctx: ExtensionCommandContext,
  target: {
    scope?: Scope;
    registrationId?: string;
    entryPointer?: string;
    marketplaceEntryId?: string;
    targetState?: 'disabled' | 'enabled';
    expectedStateRevision?: string;
    expectedValidationSnapshot?: string;
  } = {},
): Promise<void> {
  const ui: ExtensionUIContext = ctx.ui;
  let scope = target.scope;
  if (!scope) {
    const scopeLabels = new Map<string, Scope>([
      ['Global Scope', 'global'],
      ['Project Scope', 'project'],
    ]);
    const scopeChoice = await ui.select('Plugin Installation — 選擇 Scope', [...scopeLabels.keys()]);
    if (!scopeChoice) return;
    scope = scopeLabels.get(scopeChoice);
    if (!scope) return;
  }
  const opts = { cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() };
  const structuredIntent = target.marketplaceEntryId !== undefined;
  let registrationId: string;
  let entryPointer: string;
  let intentTarget: string;
  let intentStateRevision: string | undefined;
  let intentValidationSnapshot: string | undefined;
  if (structuredIntent) {
    if (!target.registrationId || !target.entryPointer || !target.targetState || !target.expectedValidationSnapshot) {
      throw new Error('Structured Plugin Installation requires complete Marketplace Entry identity, target state, and Validation Snapshot');
    }
    registrationId = target.registrationId;
    entryPointer = target.entryPointer;
    intentTarget = target.marketplaceEntryId!;
    intentStateRevision = target.expectedStateRevision;
    intentValidationSnapshot = target.expectedValidationSnapshot;
  } else {
    const state = await readBridgeState(scope, opts);
    if (state.status !== 'ok' && state.status !== 'missing') return void ui.notify(`Bridge State 不可讀：${labelText(state.error ?? 'Persistence Indeterminate')}`, 'error');
    const registrations = state.state?.registrations ?? [];
    if (registrations.length === 0) return void ui.notify('此 Scope 尚無 Marketplace Registration。', 'info');
    let registration: Registration | undefined;
    if (target.registrationId) {
      registration = registrations.find((item) => item.id === target.registrationId);
      if (!registration) return void ui.notify(`找不到 Marketplace Registration ${labelText(target.registrationId)}。`, 'warning');
    } else {
      const labels = registrations.map((item) => `${labelText(item.alias ?? item.marketplaceName ?? item.id)} · ${labelText(item.id)}`);
      const selectedLabel = await ui.select('選擇已註冊 Marketplace', labels);
      if (!selectedLabel) return;
      registration = registrations[labels.indexOf(selectedLabel)];
      if (!registration) return;
    }
    const choices = await entryChoices(registration, scope, opts);
    let selected: EntryChoice | undefined;
    if (target.entryPointer) {
      selected = choices.find((item) => item.pointer === target.entryPointer);
    } else {
      const entryLabel = await ui.select(
        'Marketplace Entries（顯示 Marketplace Entry ID 與可安裝/Unavailable 原因）',
        choices.map((item) => item.label),
      );
      if (!entryLabel) return;
      selected = choices[choices.map((item) => item.label).indexOf(entryLabel)];
    }
    if (!selected?.pointer || !selected.marketplaceEntryId || !selected.validationSnapshot) {
      return void ui.notify('此 Marketplace Entry 為 Unavailable，無法安裝。', 'warning');
    }
    registrationId = registration.id;
    entryPointer = selected.pointer;
    intentTarget = selected.marketplaceEntryId;
    intentStateRevision = state.state?.stateRevision;
    intentValidationSnapshot = selected.validationSnapshot;
  }
  const installationPaths = new Map<string, 'disabled' | 'enabled'>([
    ['Install Disabled', 'disabled'],
    ['Install and Enable', 'enabled'],
  ]);
  let targetState = target.targetState;
  if (!targetState) {
    const pathChoice = await ui.select('Installation path', [...installationPaths.keys()]);
    if (!pathChoice) return;
    targetState = installationPaths.get(pathChoice);
  }
  if (!targetState) return;
  const actionLabel = targetState === 'disabled' ? 'Install Disabled' : 'Install and Enable';
  if (!await transactionStep(ctx, {
    step: 'Intent',
    actionLabel,
    authority: scope,
    target: intentTarget,
    stateRevision: intentStateRevision,
    details: [
      `Registration ${quoteTerminalText(registrationId)}`,
      `Marketplace Entry ${quoteTerminalText(entryPointer)}`,
      `Target state ${quoteTerminalText(targetState)}`,
    ],
  })) return;
  const preflight = await preflightPluginInstallation(scope, registrationId, entryPointer, {
    ...opts,
    expectedStateRevision: intentStateRevision,
    expectedMarketplaceEntryId: intentTarget,
    expectedValidationSnapshot: intentValidationSnapshot,
  });
  if (!preflight.ok) return await reportTerminalPreflightOutcome(ctx, preflight.outcome);
  const pf = preflight.preflight;
  const boundModel = {
    actionLabel,
    authority: scope,
    target: pf.plugin.marketplaceEntryId,
    stateRevision: pf.stateRevision,
    validationSnapshot: pf.snapshot.fingerprint,
  };
  const cancel = async () => {
    await reportOutcome(ctx, await declinePluginInstallation(pf, opts));
  };
  if (!await transactionStep(ctx, {
    ...boundModel,
    step: 'Validation',
    details: [
      ...fullValidationDisclosureLines(pf.findings),
      ...installationDisclosure(pf).split('\n'),
    ],
  }, cancel)) return;
  if (!await transactionStep(ctx, {
    ...boundModel,
    step: 'Consent',
    details: targetState === 'disabled'
      ? ['Activation Confirmation: N/A — Install Disabled']
      : ['Activation Confirmation: separate Default No host gate'],
  }, cancel)) return;

  let activationConfirmed = false;
  if (targetState === 'enabled') {
    activationConfirmed = await ui.confirm(
      'Activation Confirmation — 預設 No（獨立於 Registration Confirmation）',
      `Validation Disclosure:\n${installationDisclosure(pf).split('\n').map(quoteTerminalText).join('\n')}\n\n確認安裝並啟用 ${quoteTerminalText(pf.plugin.manifestName)}？`,
    );
    if (!activationConfirmed) {
      await reportOutcome(ctx, await confirmPluginInstallation(pf, 'enabled', false, opts));
      return;
    }
  }
  if (!await transactionStep(ctx, {
    ...boundModel,
    step: 'Plan',
    details: ['Update Plan: N/A — Plugin Installation does not replace a Registration snapshot'],
  }, cancel)) return;
  if (!await transactionStep(ctx, {
    ...boundModel,
    step: 'Commit',
    details: [`Write authority ${scope} at State Revision ${quoteTerminalText(pf.stateRevision)}`],
  }, cancel)) return;
  const outcome = targetState === 'enabled'
    ? await confirmPluginInstallation(pf, 'enabled', activationConfirmed, opts)
    : await confirmPluginInstallation(pf, 'disabled', opts);
  await reportOutcome(ctx, outcome);
}

async function completePluginEnableFlow(
  ctx: ExtensionCommandContext,
  pf: PluginInstallationPreflight,
  opts: InstallationFlowOptions,
): Promise<void> {
  const installation = pf.existingInstallation;
  if (!installation) throw new Error('Plugin Enablement preflight requires an existing Installation');
  const actionLabel = 'Plugin Enablement';
  const boundModel = {
    actionLabel,
    authority: pf.scope,
    target: installation.id,
    stateRevision: pf.stateRevision,
    validationSnapshot: pf.snapshot.fingerprint,
  };
  const cancel = async () => {
    await reportOutcome(ctx, await declinePluginInstallation(pf, opts));
  };
  if (!await transactionStep(ctx, {
    ...boundModel,
    step: 'Validation',
    details: [
      ...fullValidationDisclosureLines(pf.findings),
      ...installationDisclosure(pf).split('\n'),
    ],
  }, cancel)) return;
  if (!await transactionStep(ctx, {
    ...boundModel,
    step: 'Consent',
    details: ['Activation Confirmation: separate Default No host gate'],
  }, cancel)) return;
  const confirmed = await ctx.ui.confirm(
    'Activation Confirmation — 預設 No（重新驗證後才可 re-enable）',
    installationDisclosure(pf).split('\n').map(quoteTerminalText).join('\n'),
  );
  if (!confirmed) {
    await reportOutcome(ctx, await confirmPluginEnable(pf, false, opts));
    return;
  }
  if (!await transactionStep(ctx, {
    ...boundModel,
    step: 'Plan',
    details: ['Update Plan: N/A — Installation state-only operation'],
  }, cancel)) return;
  if (!await transactionStep(ctx, {
    ...boundModel,
    step: 'Commit',
    details: [`Write authority ${pf.scope} at State Revision ${quoteTerminalText(pf.stateRevision)}`],
  }, cancel)) return;
  await reportOutcome(ctx, await confirmPluginEnable(pf, true, opts));
}

async function completePluginDisableFlow(
  ctx: ExtensionCommandContext,
  preflight: PluginDisablePreflight,
  opts: InstallationFlowOptions,
): Promise<void> {
  const { scope, installation, stateRevision } = preflight;
  const initialModel = {
    actionLabel: 'Plugin Disablement',
    authority: scope,
    target: installation.id,
    stateRevision,
    validationSnapshot: installation.validationSnapshot,
  };
  const decline = async (): Promise<void> => {
    await reportOutcome(ctx, await declinePluginDisable(preflight, opts));
  };
  if (!await transactionStep(ctx, {
    ...initialModel,
    step: 'Validation',
    details: [
      ...validationDisclosureLines([]),
      'Validation Snapshot: N/A — disablement removes runtime participation',
    ],
  }, decline)) return;
  if (!await transactionStep(ctx, {
    ...initialModel,
    step: 'Consent',
    details: ['Activation Confirmation: N/A — disablement does not activate a Plugin'],
  }, decline)) return;
  if (!await transactionStep(ctx, {
    ...initialModel,
    step: 'Plan',
    details: ['Update Plan: N/A — Installation state-only operation'],
  }, decline)) return;
  if (!await transactionStep(ctx, {
    ...initialModel,
    step: 'Commit',
    details: [`Write authority ${scope} at State Revision ${quoteTerminalText(stateRevision)}`],
  }, decline)) return;
  await reportOutcome(ctx, await confirmPluginDisable(preflight, opts));
}

export async function runPluginStateFlow(
  ctx: ExtensionCommandContext,
  target: {
    scope?: Scope;
    installationId?: string;
    desiredState?: Installation['installationState'];
    expectedStateRevision?: string;
  } = {},
): Promise<void> {
  const ui: ExtensionUIContext = ctx.ui;
  let scope = target.scope;
  if (!scope) {
    const scopeLabels = new Map<string, Scope>([
      ['Global Scope', 'global'],
      ['Project Scope', 'project'],
    ]);
    const scopeChoice = await ui.select('Installed Plugin — 選擇 Scope', [...scopeLabels.keys()]);
    if (!scopeChoice) return;
    scope = scopeLabels.get(scopeChoice);
    if (!scope) return;
  }
  const opts = { cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() };
  if (target.installationId && target.desiredState === 'disabled') {
    if (!await transactionStep(ctx, {
      step: 'Intent',
      actionLabel: 'Plugin Disablement',
      authority: scope,
      target: target.installationId,
      stateRevision: target.expectedStateRevision,
      details: [
        `Installation ${quoteTerminalText(target.installationId)}`,
        'Requested state disabled',
      ],
    })) return;
    const preflight = await preflightPluginDisable(scope, target.installationId, {
      ...opts,
      expectedStateRevision: target.expectedStateRevision,
      expectedInstallationState: 'enabled',
    });
    if (!preflight.ok) return await reportTerminalPreflightOutcome(ctx, preflight.outcome);
    await completePluginDisableFlow(
      ctx,
      preflight.preflight,
      opts,
    );
    return;
  }
  if (target.installationId && target.desiredState === 'enabled') {
    if (!await transactionStep(ctx, {
      step: 'Intent',
      actionLabel: 'Plugin Enablement',
      authority: scope,
      target: target.installationId,
      stateRevision: target.expectedStateRevision,
      details: [
        `Installation ${quoteTerminalText(target.installationId)}`,
        'Requested state enabled',
      ],
    })) return;
    const preflight = await preflightPluginEnable(scope, target.installationId, {
      ...opts,
      expectedStateRevision: target.expectedStateRevision,
    });
    if (!preflight.ok) return await reportTerminalPreflightOutcome(ctx, preflight.outcome);
    await completePluginEnableFlow(ctx, preflight.preflight, opts);
    return;
  }
  const state = await readBridgeState(scope, opts);
  if (state.status !== 'ok' && state.status !== 'missing') return void ui.notify(`Bridge State 不可讀：${labelText(state.error ?? 'Persistence Indeterminate')}`, 'error');
  const installations = state.state?.installations ?? [];
  if (installations.length === 0) return void ui.notify('此 Scope 尚無 Installed Plugin。', 'info');
  let installation: Installation | undefined;
  if (target.installationId) {
    installation = installations.find((item) => item.id === target.installationId);
    if (!installation) return void ui.notify(`找不到 Installed Plugin ${labelText(target.installationId)}。`, 'warning');
  } else {
    const labels = installations.map((item) => `${labelText(item.manifestName ?? item.pluginId)} · ${item.installationState} · ${labelText(item.id)}`);
    const chosen = await ui.select('選擇 Installed Plugin', labels);
    if (!chosen) return;
    installation = installations[labels.indexOf(chosen)];
    if (!installation) return;
  }
  const currentRevision = state.state?.stateRevision ?? '?';
  const desiredState = target.desiredState ??
    (installation.installationState === 'enabled' ? 'disabled' : 'enabled');
  const actionLabel = desiredState === 'disabled' ? 'Plugin Disablement' : 'Plugin Enablement';
  const initialModel = {
    actionLabel,
    authority: scope,
    target: installation.id,
    stateRevision: state.state?.stateRevision,
    validationSnapshot: installation.validationSnapshot,
  };
  if (!await transactionStep(ctx, {
    ...initialModel,
    step: 'Intent',
    details: [
      `Installation ${quoteTerminalText(installation.id)}`,
      `Current state ${quoteTerminalText(installation.installationState)}`,
    ],
  })) return;
  if (desiredState === 'disabled') {
    const preflight = await preflightPluginDisable(scope, installation.id, {
      ...opts,
      expectedStateRevision: target.expectedStateRevision ?? currentRevision,
      expectedInstallationState: 'enabled',
    });
    if (!preflight.ok) return await reportTerminalPreflightOutcome(ctx, preflight.outcome);
    await completePluginDisableFlow(
      ctx,
      preflight.preflight,
      opts,
    );
    return;
  }
  const preflight = await preflightPluginEnable(scope, installation.id, {
    ...opts,
    expectedStateRevision: target.expectedStateRevision ?? currentRevision,
  });
  if (!preflight.ok) return await reportTerminalPreflightOutcome(ctx, preflight.outcome);
  await completePluginEnableFlow(ctx, preflight.preflight, opts);
}
