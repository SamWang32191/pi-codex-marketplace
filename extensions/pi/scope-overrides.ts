/**
 * TUI flow for Scope Override management and the Effective State / projection view.
 *
 * Scope Overrides suppress inherited Global Scope records without modifying them: a
 * Registration override suppresses its marketplace subtree, an Installation override
 * suppresses only that single Plugin, and removing either reveals the inherited record again.
 * The Effective State view marks every record's participating source and suppression reason,
 * and lists Projected Skills with their collision outcome and Skill Availability.
 */

import type { ExtensionCommandContext, ExtensionUIContext } from '@earendil-works/pi-coding-agent';

import { readBridgeState } from '../../src/bridge-state/store.js';
import type { BridgeState } from '../../src/bridge-state/types.js';
import { computeEffectiveState, type EffectiveState } from '../../src/projection/effective-state.js';
import { createScopeOverride, removeScopeOverride, type OverrideKind } from '../../src/projection/overrides.js';
import { projectEffectiveState } from '../../src/projection/project.js';

function quote(value: string): string {
  return JSON.stringify(value);
}

/** One row of the inherited-Global listing shown before creating an override. */
export interface InheritedRecordRow {
  label: string;
  kind: OverrideKind;
  targetId: string;
  /** true when a Project Scope Override currently suppresses this record. */
  suppressedByOverride: boolean;
  /** true when an enabled project Installation supersedes this record by precedence. */
  supersededByProject: boolean;
  selectable: boolean;
}

/**
 * Build the inherited Global Scope listing: every global Registration and enabled global
 * Installation annotated with why it is not participating in Effective State.
 */
export function inheritedRecordRows(
  global: BridgeState,
  project: BridgeState,
  projectTrusted: boolean,
): InheritedRecordRow[] {
  const effective = computeEffectiveState(global, project, { projectTrusted });
  const suppressedKinds = new Map(effective.suppressed.map((item) => [`${item.kind}/${item.targetId}`, item.reason]));
  const rows: InheritedRecordRow[] = [];
  for (const registration of global.registrations) {
    const reason = suppressedKinds.get(`registration/${registration.id}`);
    rows.push({
      kind: 'registration',
      targetId: registration.id,
      label: `${quote(registration.alias ?? registration.marketplaceName ?? registration.id)} · Registration ${registration.id.slice(0, 8)}…${reason === 'scope-override-registration' ? ' — 已抑制（子樹）' : ''}`,
      suppressedByOverride: reason === 'scope-override-registration',
      supersededByProject: false,
      selectable: true,
    });
  }
  for (const installation of global.installations) {
    if (installation.installationState !== 'enabled') continue; // disabled never participates
    const reason = suppressedKinds.get(`installation/${installation.id}`);
    rows.push({
      kind: 'installation',
      targetId: installation.id,
      label: `${quote(installation.manifestName ?? installation.pluginId)} · Installation ${installation.id.slice(0, 8)}…${
        reason === 'scope-override-installation' ? ' — 已抑制（單一 Plugin）'
          : reason === 'scope-override-registration' ? ' — 已抑制（隸屬被覆蓋的 Registration 子樹）'
            : reason === 'project-precedence' ? ' — 由 Project 同名 Plugin 優先取代' : ''
      }`,
      suppressedByOverride: reason === 'scope-override-installation' || reason === 'scope-override-registration',
      supersededByProject: reason === 'project-precedence',
      selectable: true,
    });
  }
  return rows;
}

/** Compact multi-line summary of one projection result for disclosure / notification. */
export function formatProjectionSummary(state: EffectiveState, plugins: ReturnType<typeof projectEffectiveState>['plugins'], findings: ReturnType<typeof projectEffectiveState>['findings']): string {
  const lines = [
    `Effective State: ${state.registrations.length} registrations · ${state.installations.length} installations 參與`,
    ...state.suppressed.map((item) => `⊘ suppressed ${item.kind} ${item.targetId.slice(0, 8)}… (${item.reason})`),
  ];
  if (plugins.length === 0) lines.push('Projected Plugins: none');
  for (const plugin of plugins) {
    lines.push(`▸ ${quote(plugin.pluginId)} · ${plugin.sourceScope}`);
    for (const skill of plugin.skills) {
      const status = skill.status === 'projected' ? 'projected' : 'unavailable（碰撞）';
      lines.push(`    ${quote(skill.name)} · ${status} · availability: ${skill.availability}`);
    }
  }
  if (findings.length > 0) {
    lines.push(`Findings: ${findings.map((f) => `${f.classification} ${f.code}`).join(' | ')}`);
  }
  return lines.join('\n');
}

async function readBoth(ctx: { cwd?: string; agentDir?: string }): Promise<{ ok: boolean; global?: BridgeState; project?: BridgeState; error?: string }> {
  const opts = { cwd: ctx.cwd, agentDir: ctx.agentDir };
  const [globalRead, projectRead] = await Promise.all([readBridgeState('global', opts), readBridgeState('project', opts)]);
  const bad = [globalRead, projectRead].find((read) => read.status !== 'ok' && read.status !== 'missing');
  if (bad) return { ok: false, error: bad.error ?? 'Bridge State is not readable (Persistence Indeterminate)' };
  return { ok: true, global: globalRead.state!, project: projectRead.state! };
}

/** Create fine-grained Scope Overrides against inherited Global registrations / installations. */
export async function runScopeOverrideFlow(ctx: ExtensionCommandContext): Promise<void> {
  const ui: ExtensionUIContext = ctx.ui;
  const opts = { cwd: ctx.cwd, agentDir: undefined, projectTrusted: ctx.isProjectTrusted() };
  const docs = await readBoth({ cwd: ctx.cwd });
  if (!docs.ok) return void ui.notify(`Bridge State 不可讀：${docs.error}`, 'error');

  if (!ctx.isProjectTrusted()) {
    return void ui.notify('Project Trust 未由 Pi host 授予——無法執行任何 Project Scope Lifecycle Operation（紀錄仍保存但不參與 Effective State）。', 'warning');
  }

  const rows = inheritedRecordRows(docs.global!, docs.project!, ctx.isProjectTrusted());
  const chosen = await ui.select('建立 Scope Override — 選擇要抑制的繼承全域紀錄', rows.map((row) => row.label));
  if (!chosen) return;
  const row = rows.find((item) => item.label === chosen)!;
  if (row.suppressedByOverride) return void ui.notify('此紀錄已被現有 Scope Override 抑制。', 'warning');

  const cascade = row.kind === 'registration'
    ? '\n\nRegistration Override 會抑制整顆 Marketplace 子樹（該 Registration 及其所有 Installations）。'
    : '\n\nInstallation Override 僅抑制此單一 Plugin。';
  const confirmed = await ui.confirm(
    'Scope Override Disclosure — 預設 No',
    `將於 Project Scope 建立 ${row.kind} Scope Override，抑制繼承的全域紀錄：\n${row.targetId}${cascade}\n\n不會修改全域文件；移除 Override 即可還原繼承。`,
  );
  if (!confirmed) return void ui.notify('Attempt Summary: Declined — state unchanged.', 'info');

  const outcome = await createScopeOverride(row.kind, row.targetId, opts);
  if (outcome.status === 'completed') {
    ui.notify(`Attempt Summary: Completed · ${row.kind} Scope Override 已建立 · Project State Revision ${outcome.newRevision}\nReceipt ${outcome.receipt.id} — immutable, non-authoritative.`, 'info');
  } else if (outcome.status === 'rejected-as-stale') {
    ui.notify('Attempt Summary: Rejected as Stale — 請重新執行覆蓋操作；不自動合併。', 'warning');
  } else if (outcome.status === 'persistence-failed') {
    ui.notify(`Attempt Summary: ${outcome.isIndeterminate ? 'Persistence Indeterminate' : 'Persistence Failed'} — Bridge State 未變更。`, 'error');
  } else {
    ui.notify(`Attempt Summary: Blocked — ${outcome.findings[0]?.code}: ${outcome.findings[0]?.outcome ?? ''}`, 'error');
  }
}

/** Remove existing Scope Overrides; inheritance restores immediately via recomputation. */
export async function runRemoveScopeOverrideFlow(ctx: ExtensionCommandContext): Promise<void> {
  const ui: ExtensionUIContext = ctx.ui;
  const opts = { cwd: ctx.cwd, agentDir: undefined, projectTrusted: ctx.isProjectTrusted() };
  const docs = await readBoth({ cwd: ctx.cwd });
  if (!docs.ok) return void ui.notify(`Bridge State 不可讀：${docs.error}`, 'error');
  const overrides = docs.project!.scopeOverrides;
  if (overrides.length === 0) return void ui.notify('Project Scope 目前沒有任何 Scope Override。', 'info');

  const labels = overrides.map((item) => `${item.kind} Override → ${item.targetId.slice(0, 8)}…`);
  const chosen = await ui.select('移除 Scope Override — 移除後立即還原繼承（不改寫全域文件）', labels);
  if (!chosen) return;
  const target = overrides[labels.indexOf(chosen)]!;

  const confirmed = await ui.confirm('Override Removal — 預設 No', `移除 ${target.kind} Scope Override？\n被抑制的繼承全域紀錄將立即在 Effective State 中恢復。`);
  if (!confirmed) return void ui.notify('Attempt Summary: Declined — state unchanged.', 'info');

  const outcome = await removeScopeOverride(target.kind, target.targetId, opts);
  if (outcome.status === 'completed') {
    ui.notify(`Attempt Summary: Completed · 繼承已還原 · Project State Revision ${outcome.newRevision}\nReceipt ${outcome.receipt.id} — immutable, non-authoritative.`, 'info');
  } else if (outcome.status === 'persistence-failed') {
    ui.notify(`Attempt Summary: ${outcome.isIndeterminate ? 'Persistence Indeterminate' : 'Persistence Failed'} — Bridge State 未變更。`, 'error');
  } else if (outcome.status === 'rejected-as-stale') {
    ui.notify('Attempt Summary: Rejected as Stale — 請重新執行移除操作。', 'warning');
  } else {
    ui.notify(`Attempt Summary: Blocked — ${outcome.findings[0]?.code}: ${outcome.findings[0]?.outcome ?? ''}`, 'error');
  }
}

/** Read-only Effective State + Projected Skills / collision diagnostics view. */
export async function runEffectiveStateView(ctx: ExtensionCommandContext): Promise<void> {
  const ui: ExtensionUIContext = ctx.ui;
  const trusted = ctx.isProjectTrusted();
  const docs = await readBoth({ cwd: ctx.cwd });
  if (!docs.ok) return void ui.notify(`Bridge State 不可讀：${docs.error}`, 'error');
  const effective = computeEffectiveState(docs.global!, docs.project!, { projectTrusted: trusted });
  const projection = projectEffectiveState(docs.global!, docs.project!, { projectTrusted: trusted });
  const trustNote = trusted ? '' : '\n\n⚠ Project Trust 未授予——Project Scope 紀錄仍保存但不參與 Effective State。';
  ui.notify(
    `${formatProjectionSummary(effective, projection.plugins, projection.findings)}${trustNote}\n\nAvailable 僅由宿主獨立證據確立；碰撞僅影響技能粒度，不改變 Plugin 分類。`,
    projection.findings.length > 0 ? 'warning' : 'info',
  );
}
