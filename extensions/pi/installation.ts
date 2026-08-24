/** TUI flow for Compatibility Profile v1 Plugin Installation and state toggles.
 *
 * All user-visible strings come from the centralized ui-strings module (Issue #41).
 */

import type { ExtensionCommandContext, ExtensionUIContext } from '@earendil-works/pi-coding-agent';

import { readBridgeState } from '../../src/bridge-state/store.js';
import {
  confirmPluginDisable,
  confirmPluginEnable,
  confirmPluginInstallation,
  declinePluginDisable,
  declinePluginInstallation,
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
import { findingOutcomeText, uiText,
  scopeOptions } from './ui-strings.js';
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
  else ctx.ui.notify(uiText('common.cancelled.transaction'), 'info');
  return false;
}

/** Localized presentation of the activation material for one installation preflight. */
export function localizedInstallationDisclosure(pf: PluginInstallationPreflight): string[] {
  const plugin = pf.plugin;
  const lines = [
    uiText('inst.disclosure.scope', { scope: pf.scope }),
    uiText('inst.disclosure.plugin', {
      name: labelText(plugin.manifestName),
      id: labelText(plugin.id),
    }),
    uiText('inst.disclosure.source', {
      source: labelText(pf.registration.source ?? pf.registration.canonicalLocator ?? uiText('common.unavailable')),
    }),
    uiText('inst.disclosure.marketplaceEntry', { entryId: labelText(plugin.marketplaceEntryId) }),
    uiText('life.removal.disclosure.revision', { revision: pf.stateRevision }),
    uiText('reg.detail.snapshotShort', { snapshot: pf.snapshot.fingerprint.slice(0, 16) }),
    uiText('inst.disclosure.classification'),
    uiText('inst.disclosure.precedence'),
    uiText('inst.disclosure.skills', { count: plugin.skills.length }),
  ];
  for (const skill of plugin.skills) {
    lines.push('  ' + uiText('inst.disclosure.skill', {
      name: labelText(skill.name),
      policy: skill.invocationPolicy,
      resources: skill.resources.length === 0
        ? uiText('common.none')
        : skill.resources.map(labelText).join(', '),
    }));
  }
  lines.push(uiText('inst.disclosure.findings', {
    findings: pf.findings.length === 0
      ? uiText('common.none')
      : pf.findings.map((finding) =>
          `${finding.classification} ${finding.code}: ${findingOutcomeText(finding)}`,
        ).join(' | '),
  }));
  return lines;
}

export async function entryChoices(
  registration: Registration,
  scope: Scope,
  opts: { cwd?: string; agentDir?: string; projectTrusted?: boolean; cache?: SourceCache } = {},
): Promise<EntryChoice[]> {
  const inspection = inspectMarketplaceEntries(registration, scope, { agentDir: opts.agentDir, cache: opts.cache });
  if (!inspection.marketplaceId) {
    return [{
      label: uiText('inst.choice.unavailable', {
        name: labelText(registration.alias ?? registration.id),
        reason: labelText(inspection.findings[0]?.outcome ?? uiText('inst.choice.readFailure')),
      }),
    }];
  }
  return inspection.entries.map((item) => {
    const status = item.unavailableReason
      ? `${uiText('common.unavailable')}（${labelText(item.unavailableReason)}）`
      : uiText('inst.entry.available');
    const marketplaceEntryId = `${inspection.marketplaceId}${item.entry.entryId}`;
    return {
      label: `${labelText(marketplaceEntryId)} · ` +
        `${labelText(item.entry.name ?? item.plugin?.manifestName ?? `(${uiText('common.none')})`)} — ${status}`,
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
    const scopeLabels = scopeOptions();
    const scopeChoice = await ui.select(uiText('inst.select.scope'), [...scopeLabels.keys()]);
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
    if (state.status !== 'ok' && state.status !== 'missing') {
      return void ui.notify(
        uiText('common.bridgeState.unreadable', { error: labelText(state.error ?? 'Persistence Indeterminate') }),
        'error',
      );
    }
    const registrations = state.state?.registrations ?? [];
    if (registrations.length === 0) return void ui.notify(uiText('common.registration.none'), 'info');
    let registration: Registration | undefined;
    if (target.registrationId) {
      registration = registrations.find((item) => item.id === target.registrationId);
      if (!registration) {
        return void ui.notify(uiText('inst.notFound.registration', { id: labelText(target.registrationId) }), 'warning');
      }
    } else {
      const labels = registrations.map((item) => `${labelText(item.alias ?? item.marketplaceName ?? item.id)} · ${labelText(item.id)}`);
      const selectedLabel = await ui.select(uiText('inst.select.registered'), labels);
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
        uiText('inst.select.entry'),
        choices.map((item) => item.label),
      );
      if (!entryLabel) return;
      selected = choices[choices.map((item) => item.label).indexOf(entryLabel)];
    }
    if (!selected?.pointer || !selected.marketplaceEntryId || !selected.validationSnapshot) {
      return void ui.notify(uiText('inst.entry.unavailableNotice'), 'warning');
    }
    registrationId = registration.id;
    entryPointer = selected.pointer;
    intentTarget = selected.marketplaceEntryId;
    intentStateRevision = state.state?.stateRevision;
    intentValidationSnapshot = selected.validationSnapshot;
  }
  const installationPaths = new Map<string, 'disabled' | 'enabled'>([
    [uiText('inst.path.disabled'), 'disabled'],
    [uiText('inst.path.enabled'), 'enabled'],
  ]);
  let targetState = target.targetState;
  if (!targetState) {
    const pathChoice = await ui.select(uiText('inst.select.path'), [...installationPaths.keys()]);
    if (!pathChoice) return;
    targetState = installationPaths.get(pathChoice);
  }
  if (!targetState) return;
  const actionLabel = targetState === 'disabled'
    ? uiText('inst.actionLabel.disabled')
    : uiText('inst.actionLabel.enabled');
  if (!await transactionStep(ctx, {
    step: 'Intent',
    actionLabel,
    authority: scope,
    target: intentTarget,
    stateRevision: intentStateRevision,
    details: [
      uiText('inst.detail.registration', { id: quoteTerminalText(registrationId) }),
      uiText('inst.detail.entryPointer', { pointer: quoteTerminalText(entryPointer) }),
      uiText('inst.detail.targetState', { state: quoteTerminalText(targetState) }),
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
      ...localizedInstallationDisclosure(pf),
    ],
  }, cancel)) return;
  if (!await transactionStep(ctx, {
    ...boundModel,
    step: 'Consent',
    details: [targetState === 'disabled'
      ? uiText('inst.consent.na.disabled')
      : uiText('inst.consent.activationGate')],
  }, cancel)) return;

  let activationConfirmed = false;
  if (targetState === 'enabled') {
    activationConfirmed = await ui.confirm(
      uiText('inst.activation.confirmTitle'),
      uiText('inst.activation.confirmBody', {
        disclosure: localizedInstallationDisclosure(pf).map(quoteTerminalText).join('\n'),
        name: quoteTerminalText(pf.plugin.manifestName),
      }),
    );
    if (!activationConfirmed) {
      await reportOutcome(ctx, await confirmPluginInstallation(pf, 'enabled', false, opts));
      return;
    }
  }
  if (!await transactionStep(ctx, {
    ...boundModel,
    step: 'Plan',
    details: [uiText('inst.plan.notApplicable')],
  }, cancel)) return;
  if (!await transactionStep(ctx, {
    ...boundModel,
    step: 'Commit',
    details: [uiText('inst.commit.authority', { scope, revision: quoteTerminalText(pf.stateRevision) })],
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
  const actionLabel = uiText('inst.actionLabel.enablement');
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
      ...localizedInstallationDisclosure(pf),
    ],
  }, cancel)) return;
  if (!await transactionStep(ctx, {
    ...boundModel,
    step: 'Consent',
    details: [uiText('inst.consent.activationGate')],
  }, cancel)) return;
  const confirmed = await ctx.ui.confirm(
    uiText('inst.activation.reenableTitle'),
    localizedInstallationDisclosure(pf).map(quoteTerminalText).join('\n'),
  );
  if (!confirmed) {
    await reportOutcome(ctx, await confirmPluginEnable(pf, false, opts));
    return;
  }
  if (!await transactionStep(ctx, {
    ...boundModel,
    step: 'Plan',
    details: [uiText('inst.plan.stateOnly')],
  }, cancel)) return;
  if (!await transactionStep(ctx, {
    ...boundModel,
    step: 'Commit',
    details: [uiText('inst.commit.authority', { scope: pf.scope, revision: quoteTerminalText(pf.stateRevision) })],
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
    actionLabel: uiText('inst.actionLabel.disablement'),
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
      uiText('inst.validation.noSnapshot'),
    ],
  }, decline)) return;
  if (!await transactionStep(ctx, {
    ...initialModel,
    step: 'Consent',
    details: [uiText('inst.consent.na.disablement')],
  }, decline)) return;
  if (!await transactionStep(ctx, {
    ...initialModel,
    step: 'Plan',
    details: [uiText('inst.plan.stateOnly')],
  }, decline)) return;
  if (!await transactionStep(ctx, {
    ...initialModel,
    step: 'Commit',
    details: [uiText('inst.commit.authority', { scope, revision: quoteTerminalText(stateRevision) })],
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
    const scopeLabels = scopeOptions();
    const scopeChoice = await ui.select(uiText('inst.select.installedScope'), [...scopeLabels.keys()]);
    if (!scopeChoice) return;
    scope = scopeLabels.get(scopeChoice);
    if (!scope) return;
  }
  const opts = { cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() };
  if (target.installationId && target.desiredState === 'disabled') {
    if (!await transactionStep(ctx, {
      step: 'Intent',
      actionLabel: uiText('inst.actionLabel.disablement'),
      authority: scope,
      target: target.installationId,
      stateRevision: target.expectedStateRevision,
      details: [
        uiText('inst.detail.installation', { id: quoteTerminalText(target.installationId) }),
        uiText('inst.detail.requestedState', { state: quoteTerminalText('disabled') }),
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
      actionLabel: uiText('inst.actionLabel.enablement'),
      authority: scope,
      target: target.installationId,
      stateRevision: target.expectedStateRevision,
      details: [
        uiText('inst.detail.installation', { id: quoteTerminalText(target.installationId) }),
        uiText('inst.detail.requestedState', { state: quoteTerminalText('enabled') }),
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
  if (state.status !== 'ok' && state.status !== 'missing') {
    return void ui.notify(
      uiText('common.bridgeState.unreadable', { error: labelText(state.error ?? 'Persistence Indeterminate') }),
      'error',
    );
  }
  const installations = state.state?.installations ?? [];
  if (installations.length === 0) return void ui.notify(uiText('common.installation.none'), 'info');
  let installation: Installation | undefined;
  if (target.installationId) {
    installation = installations.find((item) => item.id === target.installationId);
    if (!installation) {
      return void ui.notify(uiText('inst.notFound.installation', { id: labelText(target.installationId) }), 'warning');
    }
  } else {
    const labels = installations.map((item) => `${labelText(item.manifestName ?? item.pluginId)} · ${item.installationState} · ${labelText(item.id)}`);
    const chosen = await ui.select(uiText('inst.select.installed'), labels);
    if (!chosen) return;
    installation = installations[labels.indexOf(chosen)];
    if (!installation) return;
  }
  const currentRevision = state.state?.stateRevision ?? '?';
  const desiredState = target.desiredState ??
    (installation.installationState === 'enabled' ? 'disabled' : 'enabled');
  const actionLabel = desiredState === 'disabled'
    ? uiText('inst.actionLabel.disablement')
    : uiText('inst.actionLabel.enablement');
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
      uiText('inst.detail.installation', { id: quoteTerminalText(installation.id) }),
      uiText('inst.detail.currentState', { state: quoteTerminalText(installation.installationState) }),
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
