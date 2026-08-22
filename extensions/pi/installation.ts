/** TUI flow for Compatibility Profile v1 Plugin Installation and state toggles. */

import type { ExtensionCommandContext, ExtensionUIContext } from '@earendil-works/pi-coding-agent';

import { readBridgeState } from '../../src/bridge-state/store.js';
import {
  confirmPluginEnable,
  confirmPluginInstallation,
  disablePluginInstallation,
  installationDisclosure,
  preflightPluginEnable,
  preflightPluginInstallation,
  type InstallationOutcome,
} from '../../src/installation/flow.js';
import { inspectMarketplaceEntries } from '../../src/installation/inspection.js';
import type { SourceCache } from '../../src/cache/source-cache.js';
import type { Registration, Scope } from '../../src/bridge-state/types.js';
import { reportOutcome } from './registration.js';

interface EntryChoice { label: string; pointer?: string }

function labelText(value: string): string { return JSON.stringify(value); }

export async function entryChoices(
  registration: Registration,
  scope: Scope,
  opts: { cwd?: string; agentDir?: string; projectTrusted?: boolean; cache?: SourceCache } = {},
): Promise<EntryChoice[]> {
  const inspection = inspectMarketplaceEntries(registration, scope, { agentDir: opts.agentDir, cache: opts.cache });
  if (!inspection.marketplaceId) return [{ label: `${labelText(registration.alias ?? registration.id)} — Unavailable (${labelText(inspection.findings[0]?.outcome ?? 'Marketplace Catalog cannot be read')})` }];
  return inspection.entries.map((item) => {
    const status = item.unavailableReason ? `Unavailable (${item.unavailableReason})` : '可安裝';
    return { label: `${inspection.marketplaceId}${item.entry.entryId} · ${labelText(item.entry.name ?? item.plugin?.manifestName ?? 'unnamed')} — ${labelText(status)}`, pointer: item.unavailableReason ? undefined : item.entry.entryId };
  });
}

export async function runPluginInstallationFlow(ctx: ExtensionCommandContext): Promise<void> {
  const ui: ExtensionUIContext = ctx.ui;
  const scopeChoice = await ui.select('Plugin Installation — 選擇 Scope', ['Global Scope', 'Project Scope']);
  if (!scopeChoice) return;
  const scope: Scope = scopeChoice.startsWith('Global') ? 'global' : 'project';
  const opts = { cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() };
  const state = await readBridgeState(scope, opts);
  if (state.status !== 'ok' && state.status !== 'missing') return void ui.notify(`Bridge State 不可讀：${state.error ?? 'Persistence Indeterminate'}`, 'error');
  const registrations = state.state?.registrations ?? [];
  if (registrations.length === 0) return void ui.notify('此 Scope 尚無 Marketplace Registration。', 'info');
  const labels = registrations.map((registration) => `${registration.alias ?? registration.marketplaceName ?? registration.id} · ${registration.id}`);
  const selectedLabel = await ui.select('選擇已註冊 Marketplace', labels);
  if (!selectedLabel) return;
  const registration = registrations[labels.indexOf(selectedLabel)]!;
  const choices = await entryChoices(registration, scope, opts);
  const entryLabel = await ui.select('Marketplace Entries（顯示 Marketplace Entry ID 與可安裝/Unavailable 原因）', choices.map((item) => item.label));
  if (!entryLabel) return;
  const selected = choices.find((item) => item.label === entryLabel);
  if (!selected?.pointer) return void ui.notify('此 Marketplace Entry 為 Unavailable，無法安裝。', 'warning');
  const preflight = await preflightPluginInstallation(scope, registration.id, selected.pointer, opts);
  if (!preflight.ok) return reportOutcome(ctx, preflight.outcome);
  const path = await ui.select('Installation path', ['Install Disabled', 'Install and Enable']);
  if (!path) {
    preflight.preflight.fence.release();
    return;
  }
  const disclosure = installationDisclosure(preflight.preflight);
  if (path === 'Install Disabled') {
    ui.notify(`Validation Disclosure:\n${disclosure}\n\nInstall Disabled does not request Activation Confirmation.`, 'info');
    return reportOutcome(ctx, await confirmPluginInstallation(preflight.preflight, 'disabled', opts));
  }
  const activate = await ui.confirm('Activation Confirmation — 預設 No（獨立於 Registration Confirmation）', `Validation Disclosure:\n${disclosure}\n\n確認安裝並啟用 ${preflight.preflight.plugin.manifestName}？`);
  reportOutcome(ctx, await confirmPluginInstallation(preflight.preflight, 'enabled', activate, opts));
}

export async function runPluginStateFlow(ctx: ExtensionCommandContext): Promise<void> {
  const ui: ExtensionUIContext = ctx.ui;
  const scopeChoice = await ui.select('Installed Plugin — 選擇 Scope', ['Global Scope', 'Project Scope']);
  if (!scopeChoice) return;
  const scope: Scope = scopeChoice.startsWith('Global') ? 'global' : 'project';
  const opts = { cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() };
  const state = await readBridgeState(scope, opts);
  if (state.status !== 'ok' && state.status !== 'missing') return void ui.notify(`Bridge State 不可讀：${state.error ?? 'Persistence Indeterminate'}`, 'error');
  const installations = state.state!.installations;
  if (installations.length === 0) return void ui.notify('此 Scope 尚無 Installed Plugin。', 'info');
  const labels = installations.map((item) => `${item.manifestName ?? item.pluginId} · ${item.installationState} · ${item.id}`);
  const chosen = await ui.select('選擇 Installed Plugin', labels);
  if (!chosen) return;
  const installation = installations[labels.indexOf(chosen)]!;
  if (installation.installationState === 'enabled') return reportOutcome(ctx, await disablePluginInstallation(scope, installation.id, opts));
  const preflight = await preflightPluginEnable(scope, installation.id, opts);
  if (!preflight.ok) return reportOutcome(ctx, preflight.outcome);
  const confirmed = await ui.confirm('Activation Confirmation — 預設 No（重新驗證後才可 re-enable）', installationDisclosure(preflight.preflight));
  reportOutcome(ctx, await confirmPluginEnable(preflight.preflight, confirmed, opts));
}
