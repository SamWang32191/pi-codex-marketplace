/** TUI flow for Compatibility Profile v1 Plugin Installation and state toggles. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ExtensionCommandContext, ExtensionUIContext } from '@earendil-works/pi-coding-agent';

import { classifyPlugin } from '../../src/compatibility/profile.js';
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
import { parseCatalog } from '../../src/registration/catalog.js';
import { resolveContained } from '../../src/registration/contained.js';
import { localSourceKey } from '../../src/registration/source-key.js';
import type { Registration, Scope } from '../../src/bridge-state/types.js';

interface EntryChoice { label: string; pointer?: string }

function report(ctx: ExtensionCommandContext, outcome: InstallationOutcome): void {
  if (outcome.status === 'completed') {
    ctx.ui.notify(`Attempt Summary: ${outcome.receipt.summary} · ${outcome.installation.manifestName ?? outcome.installation.pluginId} is ${outcome.installation.installationState} · State Revision ${outcome.newRevision}\nReceipt ${outcome.receipt.id} — immutable, non-authoritative.`, 'info');
  } else if (outcome.status === 'declined') {
    ctx.ui.notify(`Attempt Summary: Declined — state unchanged. Receipt ${outcome.receipt.id}`, 'info');
  } else if (outcome.status === 'rejected-as-stale') {
    ctx.ui.notify('Attempt Summary: Rejected as Stale — re-run validation disclosure and confirmation; no automatic merge.', 'warning');
  } else if (outcome.status === 'persistence-failed') {
    ctx.ui.notify(`Attempt Summary: ${outcome.isIndeterminate ? 'Persistence Indeterminate' : 'Persistence Failed'} — Bridge State was not changed automatically.`, 'error');
  } else {
    const first = outcome.findings[0];
    ctx.ui.notify(`Attempt Summary: Blocked — ${first?.code ?? '?'}: ${first?.outcome ?? ''}`, 'error');
  }
}

function entryChoices(registration: Registration, scope: Scope): EntryChoice[] {
  if (registration.sourceKind !== 'local' || !registration.source) {
    return [{ label: `${registration.alias ?? registration.id} — Unavailable (Git Source Cache lifecycle is not available yet)` }];
  }
  const source = localSourceKey(registration.source);
  if (!source.ok) return [{ label: `${registration.alias ?? registration.id} — Unavailable (Marketplace Root cannot be revalidated)` }];
  const root = source.sourceKey!.canonicalPath!;
  try {
    const parsed = parseCatalog(JSON.parse(readFileSync(join(root, '.agents', 'plugins', 'marketplace.json'), 'utf8')), { scope });
    if (!parsed.ok) return [{ label: `${registration.alias ?? registration.id} — Unavailable (invalid Marketplace Catalog)` }];
    const marketplaceId = `${registration.id}/${parsed.catalog!.name}`;
    const inspected = parsed.catalog!.entries.map((entry) => {
      if (!entry.available || entry.type !== 'local' || !entry.path) {
        return { entry, classification: undefined, unavailable: entry.unavailableReason ?? 'unsupported source kind' };
      }
      const contained = resolveContained(root, entry.path, 'directory');
      if (contained.outcome.kind !== 'ok') return { entry, classification: undefined, unavailable: 'cannot resolve Plugin' };
      const classified = classifyPlugin(contained.outcome.canonicalPath, { scope, marketplaceId, marketplaceEntryId: `${marketplaceId}${entry.entryId}` });
      return { entry, classification: classified, unavailable: classified.classification === 'compatible' ? undefined : classified.classification };
    });
    const compatibleIds = new Map<string, number>();
    for (const item of inspected) {
      const id = item.classification?.plugin?.id;
      if (id) compatibleIds.set(id, (compatibleIds.get(id) ?? 0) + 1);
    }
    return inspected.map((item) => {
      const plugin = item.classification?.plugin;
      const collision = plugin && (compatibleIds.get(plugin.id) ?? 0) > 1;
      const reason = collision ? 'Plugin ID collision' : item.unavailable;
      const status = reason ? `Unavailable (${reason})` : '可安裝';
      return { label: `${item.entry.entryId} · ${item.entry.name ?? plugin?.manifestName ?? 'unnamed'} — ${status}`, pointer: reason ? undefined : item.entry.entryId };
    });
  } catch {
    return [{ label: `${registration.alias ?? registration.id} — Unavailable (Marketplace Catalog cannot be read)` }];
  }
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
  const choices = entryChoices(registration, scope);
  const entryLabel = await ui.select('Marketplace Entries（顯示 Marketplace Entry ID 與可安裝/Unavailable 原因）', choices.map((item) => item.label));
  if (!entryLabel) return;
  const selected = choices.find((item) => item.label === entryLabel);
  if (!selected?.pointer) return void ui.notify('此 Marketplace Entry 為 Unavailable，無法安裝。', 'warning');
  const preflight = await preflightPluginInstallation(scope, registration.id, selected.pointer, opts);
  if (!preflight.ok) return report(ctx, preflight.outcome);
  const path = await ui.select('Installation path', ['Install Disabled', 'Install and Enable']);
  if (!path) {
    preflight.preflight.fence.release();
    return;
  }
  const disclosure = installationDisclosure(preflight.preflight);
  if (path === 'Install Disabled') {
    ui.notify(`Validation Disclosure:\n${disclosure}\n\nInstall Disabled does not request Activation Confirmation.`, 'info');
    return report(ctx, await confirmPluginInstallation(preflight.preflight, 'disabled', opts));
  }
  const activate = await ui.confirm('Activation Confirmation — 預設 No（獨立於 Registration Confirmation）', `Validation Disclosure:\n${disclosure}\n\n確認安裝並啟用 ${preflight.preflight.plugin.manifestName}？`);
  report(ctx, await confirmPluginInstallation(preflight.preflight, 'enabled', activate, opts));
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
  if (installation.installationState === 'enabled') return report(ctx, await disablePluginInstallation(scope, installation.id, opts));
  const preflight = await preflightPluginEnable(scope, installation.id, opts);
  if (!preflight.ok) return report(ctx, preflight.outcome);
  const confirmed = await ui.confirm('Activation Confirmation — 預設 No（重新驗證後才可 re-enable）', installationDisclosure(preflight.preflight));
  report(ctx, await confirmPluginEnable(preflight.preflight, confirmed, opts));
}
