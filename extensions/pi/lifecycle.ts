/**
 * TUI flows for the #21 lifecycle: Marketplace Refresh → Update Candidate → Update Plan
 * Checklist → Apply Update, plus Registration Rebind and Registration / Installation Removal.
 *
 * All consent surfaces Default No and are bound to Validation Snapshot + State Revision by the
 * underlying src/lifecycle seams; this layer only collects explicit user outcomes and reports
 * Attempt Summary receipts.
 */

import type { ExtensionCommandContext, ExtensionUIContext } from '@earendil-works/pi-coding-agent';

import { readBridgeState } from '../../src/bridge-state/store.js';
import type { Installation, Registration, Scope } from '../../src/bridge-state/types.js';
import {
  applyUpdate,
  preflightRebind,
  refreshRegistration,
  registrationRemovalDisclosure,
  installationRemovalDisclosure,
  confirmRegistrationRemoval,
  confirmInstallationRemoval,
  preflightRegistrationRemoval,
  preflightInstallationRemoval,
  type LifecycleFlowOptions,
  type RebindTarget,
  type UpdateCandidate,
} from '../../src/lifecycle/index.js';
import { buildUpdatePlan, compatibleCandidateIds, type InstallationChoice } from '../../src/lifecycle/update-plan.js';

function quote(value: string): string {
  return JSON.stringify(value);
}

/** Pure helper: per-installation choice options, 'update' only when a Compatible candidate exists. */
export function planChoicesFor(
  installations: Installation[],
  candidate: UpdateCandidate,
): { installation: Installation; options: { label: string; value: InstallationChoice; enabled: boolean }[] }[] {
  const compatible = compatibleCandidateIds(candidate);
  return installations.map((installation) => ({
    installation,
    options: [
      { label: `update — 套用新快照（${compatible.has(installation.pluginId) ? '有 Compatible candidate' : '無 candidate → 不可選'}）`, value: 'update', enabled: compatible.has(installation.pluginId) },
      { label: 'disable — 停用並保留 Installation ID', value: 'disable', enabled: true },
      { label: 'remove — 移除此 Installation', value: 'remove', enabled: true },
    ],
  }));
}

/** Pure helper: candidate disclosure summary for the checklist surface. */
export function candidateSummary(candidate: UpdateCandidate): string {
  const lines = [
    `Scope: ${candidate.scope}`,
    `Registration: ${candidate.registrationId.slice(0, 8)}…`,
    `Marketplace: ${quote(candidate.marketplaceName || '(unchanged name)')}`,
    `New Validation Snapshot: ${candidate.snapshot.fingerprint.slice(0, 16)}…`,
    `Recorded Snapshot: ${(candidate.recordedFingerprint ?? '(none)').slice(0, 16)}…`,
  ];
  if (candidate.resolvedRevision) {
    lines.push(`Resolved Revision: ${candidate.recordedResolvedRevision ?? '(none)'.slice(0, 12)} → ${candidate.resolvedRevision}`);
  }
  const available = candidate.inspection.entries.filter((item) => item.plugin && !item.unavailableReason).length;
  lines.push(`Entries: ${candidate.inspection.entries.length}（${available} 可安裝）`);
  const blocking = candidate.inspection.findings.filter((f) => f.classification === 'blocking');
  lines.push(`Findings: ${blocking.length} blocking`);
  for (const entry of candidate.inspection.entries) {
    lines.push(`  ${entry.entry.entryId} ${entry.plugin ? `· ${quote(entry.plugin.manifestName)} ` : ''}— ${entry.unavailableReason ? `unavailable (${entry.unavailableReason})` : '可安裝'}`);
  }
  return lines.join('\n');
}

export function attemptReport(ctx: ExtensionCommandContext, outcome: { status: string; receipt?: { id: string; summary: string }; newRevision?: string; isIndeterminate?: boolean; findings?: { code: string; outcome: string }[] }): void {
  if (outcome.status === 'completed') {
    ctx.ui.notify(`Attempt Summary: ${outcome.receipt?.summary ?? 'Completed'} · State Revision ${outcome.newRevision}\nReceipt ${outcome.receipt?.id} — immutable, non-authoritative.`, 'info');
  } else if (outcome.status === 'declined') {
    ctx.ui.notify(`Attempt Summary: Declined — state unchanged. Receipt ${outcome.receipt?.id}`, 'info');
  } else if (outcome.status === 'rejected-as-stale') {
    ctx.ui.notify('Attempt Summary: Rejected as Stale — 重新執行 Refresh 與確認；不自動合併。', 'warning');
  } else if (outcome.status === 'persistence-failed') {
    ctx.ui.notify(`Attempt Summary: ${outcome.isIndeterminate ? 'Persistence Indeterminate' : 'Persistence Failed'} — Bridge State 未變更。`, 'error');
  } else {
    const first = outcome.findings?.[0];
    ctx.ui.notify(`Attempt Summary: Blocked — ${first?.code ?? '?'}: ${first?.outcome ?? ''}`, 'error');
  }
}

async function pickScope(ui: ExtensionUIContext): Promise<Scope | undefined> {
  const choice = await ui.select('選擇 Scope', ['Global Scope', 'Project Scope']);
  if (!choice) return undefined;
  return choice.startsWith('Global') ? 'global' : 'project';
}

async function pickRegistration(ctx: ExtensionCommandContext, scope: Scope): Promise<{ registration: Registration; opts: LifecycleFlowOptions } | undefined> {
  const ui = ctx.ui;
  const opts: LifecycleFlowOptions = { cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() };
  const state = await readBridgeState(scope, opts);
  if (state.status !== 'ok' && state.status !== 'missing') {
    ui.notify(`Bridge State 不可讀：${state.error ?? 'Persistence Indeterminate'}`, 'error');
    return undefined;
  }
  const registrations = state.state?.registrations ?? [];
  if (registrations.length === 0) {
    ui.notify('此 Scope 尚無 Marketplace Registration。', 'info');
    return undefined;
  }
  const labels = registrations.map((r) => `${r.alias ?? r.marketplaceName ?? r.id} · ${r.sourceKind ?? '?'} · ${r.id}`);
  const chosen = await ui.select('選擇 Marketplace Registration', labels);
  if (!chosen) return undefined;
  return { registration: registrations[labels.indexOf(chosen)]!, opts };
}

/**
 * Update Plan Checklist — collects fresh Registration Confirmation, one explicit outcome per
 * existing Installation, and an Activation Confirmation per enabled installation that remains
 * enabled. Submits only when the complete plan validates.
 */
export async function runUpdatePlanChecklist(
  ctx: ExtensionCommandContext,
  scope: Scope,
  candidate: UpdateCandidate,
  stateRevision: string,
  kind: 'apply-update' | 'rebind',
  rebindSource?: Parameters<typeof buildUpdatePlan>[3] extends never ? never : NonNullable<Parameters<typeof buildUpdatePlan>[3]['rebindSource']>,
): Promise<void> {
  const ui = ctx.ui;
  const opts: LifecycleFlowOptions = { cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() };
  const state = await readBridgeState(scope, opts);
  if (state.status !== 'ok' && state.status !== 'missing') return void ui.notify(`Bridge State 不可讀：${state.error ?? 'Persistence Indeterminate'}`, 'error');

  // Strictly this Registration's own scope-local Installations — independent Registrations and
  // Installations are never combined into a batch (CONTEXT.md: Lifecycle Operation).
  const installations = (state.state?.installations ?? []).filter((i) => i.registrationId === candidate.registrationId);

  ui.notify(`Validation Disclosure（新快照）：\n${candidateSummary(candidate)}`, 'info');

  // Fresh Registration Confirmation — Default No, bound to the candidate snapshot + revision.
  const registrationConfirmed = await ui.confirm(
    'Registration Confirmation — 預設 No（綁定新 Validation Snapshot + State Revision）',
    `接受此新的 Validation Snapshot 作為 Registration ${candidate.registrationId.slice(0, 8)}… 的授權來源？`,
  );
  if (!registrationConfirmed) return void ui.notify('Attempt Summary: Declined — 未取得 Registration Confirmation，狀態未變更。', 'info');

  // One explicit outcome per existing Installation — never batched, no default.
  const choices: Record<string, InstallationChoice> = {};
  const activationConfirmations: Record<string, boolean> = {};
  for (const { installation, options } of planChoicesFor(installations, candidate)) {
    const selectable = options.filter((o) => o.enabled);
    const picked = await ui.select(
      `Installation ${installation.manifestName ?? installation.pluginId}（${installation.installationState}）— 選擇更新結果`,
      selectable.map((o) => o.label),
    );
    if (!picked) return void ui.notify('已取消 — Update Plan 放棄（每個 Installation 皆需明確抉擇）。', 'info');
    choices[installation.id] = selectable.find((o) => o.label === picked)!.value;
  }

  // Activation Confirmation per enabled installation that remains enabled — Default No.
  for (const installation of installations) {
    const willStayEnabled = installation.installationState === 'enabled' && choices[installation.id] === 'update';
    if (!willStayEnabled) continue;
    const confirmed = await ui.confirm(
      'Activation Confirmation — 預設 No（舊同意不沿用）',
      `啟用的 ${installation.manifestName ?? installation.pluginId} 將在新快照下保持啟用。確認其 Activation？`,
    );
    activationConfirmations[installation.id] = confirmed;
  }

  const plan = buildUpdatePlan(candidate, installations, stateRevision, {
    registrationConfirmed,
    kind,
    rebindSource,
    choices,
    activationConfirmations,
  });
  if (!plan.ok) {
    return void ui.notify(`Update Plan 無法成立（放棄提交）：\n${plan.problems.map((p) => `- [${p.code}] ${p.outcome}`).join('\n')}`, 'warning');
  }

  // Final checklist review before the single atomic commit.
  const checklist = plan.plan.entries
    .map((entry) => `· ${entry.installationId.slice(0, 16)}… → ${entry.choice}${entry.choice === 'update' ? `（${entry.installationState}）` : ''}`)
    .join('\n');
  const proceed = await ui.confirm(
    kind === 'rebind' ? 'Apply Rebind — 單次原子提交' : 'Apply Update — 單次原子提交',
    `將以單一 Lifecycle Operation 原子替換快照並套用所有披露後果：\n${checklist || '（無既有 Installation）'}\n\n確認提交？`,
  );
  if (!proceed) return void ui.notify('Attempt Summary: Declined — 未提交。', 'info');

  attemptReport(ctx, await applyUpdate(plan.plan, opts));
}

/** Marketplace Refresh on a single Registration — non-mutating; produces an Update Candidate or reports no change. */
export async function runRefreshFlow(ctx: ExtensionCommandContext): Promise<void> {
  const ui = ctx.ui;
  const scope = await pickScope(ui);
  if (!scope) return;
  const picked = await pickRegistration(ctx, scope);
  if (!picked) return;

  const outcome = await refreshRegistration(scope, picked.registration.id, picked.opts);
  if (outcome.status === 'no-change') {
    ui.notify(`Attempt Summary: Completed — 無變更（recorded snapshot 仍為權威）。\nReceipt ${outcome.receipt.id}`, 'info');
    return;
  }
  if (outcome.status === 'blocked') {
    const first = outcome.findings[0];
    return void ui.notify(`Attempt Summary: Blocked — ${first?.code}: ${first?.outcome}`, 'error');
  }
  ui.notify('Update Candidate 已產生（非變異檢查，Bridge State 未寫入）。', 'info');
  // Bind the plan to the exact State Revision the candidate was validated against.
  await runUpdatePlanChecklist(ctx, scope, outcome.candidate, outcome.candidate.stateRevision, 'apply-update');
}

/** Registration Rebind — replace locator/selector under the preserved Registration ID. */
export async function runRebindFlow(ctx: ExtensionCommandContext): Promise<void> {
  const ui = ctx.ui;
  const scope = await pickScope(ui);
  if (!scope) return;
  const picked = await pickRegistration(ctx, scope);
  if (!picked) return;

  const kindChoice = await ui.select('新來源型別', ['本地目錄（local path）', 'Git 倉庫（locator + selector）']);
  if (!kindChoice) return;

  let target: RebindTarget;
  if (kindChoice.startsWith('本地')) {
    const rootPath = await ui.input('新的本地 Marketplace Root 路徑', '/path/to/marketplace');
    if (!rootPath) return void ui.notify('已取消 Rebind。', 'info');
    target = { kind: 'local', rootPath };
  } else {
    const locator = await ui.input('Git Locator（https:// 或 ssh，無憑證、無 query/fragment）', 'https://github.com/owner/repo.git');
    if (!locator) return void ui.notify('已取消 Rebind。', 'info');
    const selectorKind = await ui.select('Git Selector 型別', ['default', 'branch', 'tag', 'commit']);
    if (!selectorKind) return void ui.notify('已取消 Rebind。', 'info');
    let selector: Extract<RebindTarget, { kind: 'git' }>['selector'] = 'default';
    if (selectorKind === 'branch' || selectorKind === 'tag' || selectorKind === 'commit') {
      const placeholder = selectorKind === 'commit' ? '完整 40/64 hex commit' : selectorKind === 'tag' ? 'v1.2.3' : 'main';
      const value = await ui.input(`${selectorKind} 值（例：${placeholder}）`, placeholder);
      if (!value) return void ui.notify('已取消 Rebind。', 'info');
      selector = { kind: selectorKind, value };
    }
    target = { kind: 'git', locator, selector };
  }

  const pf = await preflightRebind(scope, picked.registration.id, target, picked.opts);
  if (!pf.ok) {
    const first = pf.outcome.findings?.[0];
    return void ui.notify(`Attempt Summary: Blocked — ${first?.code ?? '?'}: ${first?.outcome ?? ''}`, 'error');
  }
  ui.notify('替代來源已完成完整重驗證；需重新收集全部確認（舊 Activation 同意不沿用）。', 'info');
  // Rebind binds to the revision observed while validating the replacement source.
  await runUpdatePlanChecklist(ctx, scope, pf.preflight.candidate, pf.preflight.stateRevision, 'rebind', pf.preflight.rebindSource);
}

/** Removal flows with full cascade disclosure, Default No. */
export async function runRemovalFlow(ctx: ExtensionCommandContext): Promise<void> {
  const ui = ctx.ui;
  const scope = await pickScope(ui);
  if (!scope) return;
  const what = await ui.select('移除目標', ['整個 Registration（原子刪除同範圍所有 Installations）', '單一 Installation（保留 Registration）']);
  if (!what) return;
  const opts = { cwd: ctx.cwd, agentDir: undefined as string | undefined, projectTrusted: ctx.isProjectTrusted() };

  if (what.startsWith('整個')) {
    const picked = await pickRegistration(ctx, scope);
    if (!picked) return;
    const pf = await preflightRegistrationRemoval(scope, picked.registration.id, opts);
    if (!pf.ok) return attemptReport(ctx, pf.outcome);
    const proceed = await ui.confirm('Registration Removal — 預設 No', registrationRemovalDisclosure(pf.preflight));
    attemptReport(ctx, await confirmRegistrationRemoval(pf.preflight, proceed, opts));
    return;
  }

  const state = await readBridgeState(scope, opts);
  if (state.status !== 'ok' && state.status !== 'missing') return void ui.notify(`Bridge State 不可讀：${state.error ?? 'Persistence Indeterminate'}`, 'error');
  const installations = state.state?.installations ?? [];
  if (installations.length === 0) return void ui.notify('此 Scope 尚無 Installed Plugin。', 'info');
  const labels = installations.map((i) => `${i.manifestName ?? i.pluginId} · ${i.installationState} · ${i.id}`);
  const chosen = await ui.select('選擇要移除的 Installation', labels);
  if (!chosen) return;
  const installation = installations[labels.indexOf(chosen)]!;
  const pf = await preflightInstallationRemoval(scope, installation.id, opts);
  if (!pf.ok) return attemptReport(ctx, pf.outcome);
  const proceed = await ui.confirm('Installation Removal — 預設 No', installationRemovalDisclosure(pf.preflight));
  attemptReport(ctx, await confirmInstallationRemoval(pf.preflight, proceed, opts));
}
