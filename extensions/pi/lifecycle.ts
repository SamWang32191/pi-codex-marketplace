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
import type { Installation, Scope } from '../../src/bridge-state/types.js';
import { appendReceipt } from '../../src/journal/journal.js';
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
import { createReceipt, type AttemptReceipt } from '../../src/registration/receipt.js';
import {
  fullValidationDisclosureLines,
  reportOutcome,
  validationDisclosureLines,
} from './registration.js';
import { quoteTerminalText } from './terminal-presentation.js';
import { openTransactionSheet, type TransactionSheetModel } from './transaction-sheet.js';

function quote(value: string): string {
  return quoteTerminalText(value);
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
  const findings = [...new Map(
    [
      ...candidate.inspection.findings,
      ...candidate.inspection.entries.flatMap((entry) => entry.findings),
    ].map((finding) => [
      [
        finding.classification,
        finding.scope,
        finding.phase,
        finding.target,
        finding.pointer,
        finding.code,
        finding.rule,
        finding.outcome,
      ].join('\u001f'),
      finding,
    ]),
  ).values()];
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
  lines.push(...fullValidationDisclosureLines(findings));
  for (const entry of candidate.inspection.entries) {
    lines.push(`  ${quote(entry.entry.entryId)} ${entry.plugin ? `· ${quote(entry.plugin.manifestName)} ` : ''}— ${entry.unavailableReason ? `unavailable (${quote(entry.unavailableReason)})` : '可安裝'}`);
  }
  return lines.join('\n');
}

export async function attemptReport(
  ctx: ExtensionCommandContext,
  outcome: { receipt: AttemptReceipt },
): Promise<void> {
  const journal = await appendReceipt(outcome.receipt.scope, outcome.receipt, { cwd: ctx.cwd });
  await reportOutcome(ctx, outcome);
  if (!journal.success) {
    ctx.ui.notify(`Receipt Journal 寫入失敗：${quote(journal.error ?? 'unknown error')}`, 'warning');
  }
}

async function showTransactionStep(ctx: ExtensionCommandContext, model: TransactionSheetModel): Promise<boolean> {
  return await openTransactionSheet(ctx, model) === 'continue';
}

function lifecycleOptions(ctx: ExtensionCommandContext): LifecycleFlowOptions {
  return { cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() };
}

async function pickScope(ui: ExtensionUIContext): Promise<Scope | undefined> {
  const labels = new Map<string, Scope>([
    ['Global Scope', 'global'],
    ['Project Scope', 'project'],
  ]);
  const choice = await ui.select('選擇 Scope', [...labels.keys()]);
  return choice ? labels.get(choice) : undefined;
}

async function pickRegistration(
  ctx: ExtensionCommandContext,
  scope: Scope,
  registrationId?: string,
): Promise<{
  registrationId: string;
  stateRevision: string;
  validationSnapshot?: string;
  opts: LifecycleFlowOptions;
} | undefined> {
  const ui = ctx.ui;
  const opts = lifecycleOptions(ctx);
  const state = await readBridgeState(scope, opts);
  if (state.status !== 'ok' && state.status !== 'missing') {
    ui.notify(`Bridge State 不可讀：${quote(state.error ?? 'Persistence Indeterminate')}`, 'error');
    return undefined;
  }
  const registrations = state.state?.registrations ?? [];
  if (registrationId) {
    return {
      registrationId,
      stateRevision: state.state?.stateRevision ?? '?',
      validationSnapshot: registrations.find((registration) => registration.id === registrationId)?.validationSnapshot,
      opts,
    };
  }
  if (registrations.length === 0) {
    ui.notify('此 Scope 尚無 Marketplace Registration。', 'info');
    return undefined;
  }
  const labels = registrations.map((r) => `${quote(r.alias ?? r.marketplaceName ?? r.id)} · ${r.sourceKind ?? '?'} · ${r.id}`);
  const chosen = await ui.select('選擇 Marketplace Registration', labels);
  if (!chosen) return undefined;
  const registration = registrations[labels.indexOf(chosen)]!;
  return {
    registrationId: registration.id,
    stateRevision: state.state!.stateRevision,
    validationSnapshot: registration.validationSnapshot,
    opts,
  };
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
  transaction: { intentShown?: boolean } = {},
): Promise<void> {
  const ui = ctx.ui;
  const opts = lifecycleOptions(ctx);
  const state = await readBridgeState(scope, opts);
  if (state.status !== 'ok' && state.status !== 'missing') return void ui.notify(`Bridge State 不可讀：${quote(state.error ?? 'Persistence Indeterminate')}`, 'error');

  // Strictly this Registration's own scope-local Installations — independent Registrations and
  // Installations are never combined into a batch (CONTEXT.md: Lifecycle Operation).
  const installations = (state.state?.installations ?? []).filter((i) => i.registrationId === candidate.registrationId);

  const actionLabel = kind === 'rebind' ? 'Registration Rebind' : 'Apply Update';
  const commonModel = {
    actionLabel,
    authority: scope,
    target: candidate.registrationId,
    stateRevision,
    validationSnapshot: candidate.snapshot.fingerprint,
  } satisfies Omit<TransactionSheetModel, 'step'>;

  const concludeWithoutCommit = async (
    summary: 'Declined' | 'Blocked',
    findings: AttemptReceipt['findings'] = [],
  ): Promise<void> => {
    await attemptReport(ctx, {
      receipt: createReceipt({
        operation: actionLabel,
        scope,
        trigger: `${kind} ${candidate.registrationId}`,
        expectedStateRevision: stateRevision,
        validationSnapshot: candidate.snapshot.fingerprint,
        summary,
        findings,
        stateChanged: false,
      }),
    });
  };

  if (!transaction.intentShown && !await showTransactionStep(ctx, {
    ...commonModel,
    step: 'Intent',
    details: [kind === 'rebind' ? 'Replace the Registration source while preserving its canonical ID' : 'Apply the exact Update Candidate in one Lifecycle Operation'],
  })) {
    await concludeWithoutCommit('Declined');
    return;
  }

  if (!await showTransactionStep(ctx, {
    ...commonModel,
    step: 'Validation',
    details: candidateSummary(candidate).split('\n'),
  })) {
    await concludeWithoutCommit('Declined');
    return;
  }

  ui.notify(`Validation Disclosure（新快照）：\n${candidateSummary(candidate)}`, 'info');

  if (!await showTransactionStep(ctx, {
    ...commonModel,
    step: 'Consent',
    details: ['Registration Confirmation and every required Activation Confirmation remain separate Default No decisions'],
  })) {
    await concludeWithoutCommit('Declined');
    return;
  }

  // Fresh Registration Confirmation — Default No, bound to the candidate snapshot + revision.
  const registrationConfirmed = await ui.confirm(
    'Registration Confirmation — 預設 No（綁定新 Validation Snapshot + State Revision）',
    `接受此新的 Validation Snapshot 作為 Registration ${candidate.registrationId.slice(0, 8)}… 的授權來源？`,
  );
  if (!registrationConfirmed) {
    await concludeWithoutCommit('Declined');
    return;
  }

  if (!await showTransactionStep(ctx, {
    ...commonModel,
    step: 'Plan',
    details: [`Installations requiring an explicit outcome: ${installations.length}`],
  })) {
    await concludeWithoutCommit('Declined');
    return;
  }

  // One explicit outcome per existing Installation — never batched, no default.
  const choices: Record<string, InstallationChoice> = {};
  const activationConfirmations: Record<string, boolean> = {};
  for (const { installation, options } of planChoicesFor(installations, candidate)) {
    const selectable = options.filter((o) => o.enabled);
    const picked = await ui.select(
      `Installation ${quote(installation.manifestName ?? installation.pluginId)}（${installation.installationState}）— 選擇更新結果`,
      selectable.map((o) => o.label),
    );
    if (!picked) {
      await concludeWithoutCommit('Declined');
      return;
    }
    choices[installation.id] = selectable.find((o) => o.label === picked)!.value;
  }

  // Activation Confirmation per enabled installation that remains enabled — Default No.
  for (const installation of installations) {
    const willStayEnabled = installation.installationState === 'enabled' && choices[installation.id] === 'update';
    if (!willStayEnabled) continue;
    const confirmed = await ui.confirm(
      'Activation Confirmation — 預設 No（舊同意不沿用）',
      `啟用的 ${quote(installation.manifestName ?? installation.pluginId)} 將在新快照下保持啟用。確認其 Activation？`,
    );
    activationConfirmations[installation.id] = confirmed;
    if (!confirmed) {
      await concludeWithoutCommit('Declined');
      return;
    }
  }

  const plan = buildUpdatePlan(candidate, installations, stateRevision, {
    registrationConfirmed,
    kind,
    rebindSource,
    choices,
    activationConfirmations,
  });
  if (!plan.ok) {
    await concludeWithoutCommit('Blocked', plan.problems);
    return;
  }

  // Final checklist review before the single atomic commit.
  const checklist = plan.plan.entries
    .map((entry) => `· ${entry.installationId.slice(0, 16)}… → ${entry.choice}${entry.choice === 'update' ? `（${entry.installationState}）` : ''}`)
    .join('\n');

  if (!await showTransactionStep(ctx, {
    ...commonModel,
    step: 'Commit',
    details: [
      'The complete Update Plan will commit atomically after the final Default No confirmation',
      ...(checklist ? checklist.split('\n') : ['No existing Installation consequences']),
    ],
  })) {
    await concludeWithoutCommit('Declined');
    return;
  }

  const proceed = await ui.confirm(
    kind === 'rebind' ? 'Apply Rebind — 單次原子提交' : 'Apply Update — 單次原子提交',
    `將以單一 Lifecycle Operation 原子替換快照並套用所有披露後果：\n${checklist || '（無既有 Installation）'}\n\n確認提交？`,
  );
  if (!proceed) {
    await concludeWithoutCommit('Declined');
    return;
  }

  await attemptReport(ctx, await applyUpdate(plan.plan, opts));
}

/** Marketplace Refresh on a single Registration — non-mutating; produces an Update Candidate or reports no change. */
export async function runRefreshFlow(
  ctx: ExtensionCommandContext,
  target: { scope?: Scope; registrationId?: string } = {},
): Promise<void> {
  const ui = ctx.ui;
  const scope = target.scope ?? await pickScope(ui);
  if (!scope) return;
  const picked = await pickRegistration(ctx, scope, target.registrationId);
  if (!picked) return;

  const model = {
    actionLabel: 'Marketplace Refresh',
    authority: scope,
    target: picked.registrationId,
    stateRevision: picked.stateRevision,
    validationSnapshot: picked.validationSnapshot,
  } satisfies Omit<TransactionSheetModel, 'step'>;
  if (!await showTransactionStep(ctx, {
    ...model,
    step: 'Intent',
    details: [
      'Run an explicit non-mutating inspection for this Registration only',
      'Bridge State will not be written by Marketplace Refresh',
    ],
  })) return;

  const outcome = await refreshRegistration(scope, picked.registrationId, picked.opts);
  const validationDetails = outcome.status === 'update-candidate'
    ? candidateSummary(outcome.candidate).split('\n')
    : [
        `Refresh outcome: ${outcome.status}`,
        ...fullValidationDisclosureLines(outcome.receipt.findings),
      ];
  const validationContinued = await showTransactionStep(ctx, {
    ...model,
    stateRevision: outcome.receipt.expectedStateRevision,
    validationSnapshot: outcome.receipt.validationSnapshot,
    step: 'Validation',
    details: validationDetails,
  });
  await attemptReport(ctx, outcome);
  if (!validationContinued) return;
  if (outcome.status === 'no-change') {
    return;
  }
  if (outcome.status === 'blocked') {
    return;
  }
  ui.notify('Update Candidate 已產生（非變異檢查，Bridge State 未寫入）。', 'info');
  // Bind the plan to the exact State Revision the candidate was validated against.
  await runUpdatePlanChecklist(ctx, scope, outcome.candidate, outcome.candidate.stateRevision, 'apply-update');
}

/** Registration Rebind — replace locator/selector under the preserved Registration ID. */
export async function runRebindFlow(
  ctx: ExtensionCommandContext,
  targetOptions: { scope?: Scope; registrationId?: string } = {},
): Promise<void> {
  const ui = ctx.ui;
  const scope = targetOptions.scope ?? await pickScope(ui);
  if (!scope) return;
  const picked = await pickRegistration(ctx, scope, targetOptions.registrationId);
  if (!picked) return;

  if (!await showTransactionStep(ctx, {
    step: 'Intent',
    actionLabel: 'Registration Rebind',
    authority: scope,
    target: picked.registrationId,
    details: ['Replace the source locator or Git selector while preserving the canonical Registration ID'],
  })) return;

  const sourceKinds = new Map<string, RebindTarget['kind']>([
    ['本地目錄（local path）', 'local'],
    ['Git 倉庫（locator + selector）', 'git'],
  ]);
  const kindChoice = await ui.select('新來源型別', [...sourceKinds.keys()]);
  if (!kindChoice) return;
  const sourceKind = sourceKinds.get(kindChoice);
  if (!sourceKind) return;

  let target: RebindTarget;
  if (sourceKind === 'local') {
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

  const pf = await preflightRebind(scope, picked.registrationId, target, picked.opts);
  if (!pf.ok) {
    await showTransactionStep(ctx, {
      step: 'Validation',
      actionLabel: 'Registration Rebind',
      authority: scope,
      target: picked.registrationId,
      stateRevision: pf.outcome.receipt.expectedStateRevision,
      validationSnapshot: pf.outcome.receipt.validationSnapshot,
      details: fullValidationDisclosureLines(pf.outcome.receipt.findings),
    });
    await attemptReport(ctx, pf.outcome);
    return;
  }
  ui.notify('替代來源已完成完整重驗證；需重新收集全部確認（舊 Activation 同意不沿用）。', 'info');
  // Rebind binds to the revision observed while validating the replacement source.
  await runUpdatePlanChecklist(
    ctx,
    scope,
    pf.preflight.candidate,
    pf.preflight.stateRevision,
    'rebind',
    pf.preflight.rebindSource,
    { intentShown: true },
  );
}

/** Removal flows with full cascade disclosure, Default No. */
export async function runRemovalFlow(
  ctx: ExtensionCommandContext,
  target: {
    scope?: Scope;
    targetKind?: 'registration' | 'installation';
    targetId?: string;
  } = {},
): Promise<void> {
  const ui = ctx.ui;
  const scope = target.scope ?? await pickScope(ui);
  if (!scope) return;
  const opts = { cwd: ctx.cwd, agentDir: undefined as string | undefined, projectTrusted: ctx.isProjectTrusted() };
  let targetKind = target.targetKind;

  if (!targetKind && target.targetId) {
    const state = await readBridgeState(scope, opts);
    if (state.status !== 'ok' && state.status !== 'missing') return void ui.notify(`Bridge State 不可讀：${quote(state.error ?? 'Persistence Indeterminate')}`, 'error');
    if (state.state?.registrations.some((registration) => registration.id === target.targetId)) targetKind = 'registration';
    if (state.state?.installations.some((installation) => installation.id === target.targetId)) targetKind = 'installation';
    if (!targetKind) return void ui.notify(`找不到 canonical removal target ${quote(target.targetId)}。`, 'warning');
  }

  if (!targetKind) {
    const removalKinds = new Map<string, 'registration' | 'installation'>([
      ['整個 Registration（原子刪除同範圍所有 Installations）', 'registration'],
      ['單一 Installation（保留 Registration）', 'installation'],
    ]);
    const what = await ui.select('移除目標', [...removalKinds.keys()]);
    if (!what) return;
    targetKind = removalKinds.get(what);
    if (!targetKind) return;
  }

  if (targetKind === 'registration') {
    const picked = await pickRegistration(ctx, scope, target.targetId);
    if (!picked) return;

    const model = {
      actionLabel: 'Registration Removal',
      authority: scope,
      target: picked.registrationId,
    } satisfies Omit<TransactionSheetModel, 'step'>;
    if (!await showTransactionStep(ctx, {
      ...model,
      step: 'Intent',
      details: ['Remove the Registration and all of its same-scope Installations atomically'],
    })) return;

    const pf = await preflightRegistrationRemoval(scope, picked.registrationId, opts);
    if (!pf.ok) {
      await showTransactionStep(ctx, {
        ...model,
        step: 'Validation',
        stateRevision: pf.outcome.receipt.expectedStateRevision,
        details: fullValidationDisclosureLines(pf.outcome.receipt.findings),
      });
      await attemptReport(ctx, pf.outcome);
      return;
    }

    const boundModel = { ...model, stateRevision: pf.preflight.stateRevision };
    const decline = async (): Promise<void> => {
      await attemptReport(ctx, await confirmRegistrationRemoval(pf.preflight, false, opts));
    };
    if (!await showTransactionStep(ctx, {
      ...boundModel,
      step: 'Validation',
      details: [
        ...validationDisclosureLines([]),
        ...registrationRemovalDisclosure(pf.preflight).split('\n'),
      ],
    })) return decline();
    if (!await showTransactionStep(ctx, {
      ...boundModel,
      step: 'Consent',
      details: ['Registration Removal confirmation remains a separate Default No decision'],
    })) return decline();
    const proceed = await ui.confirm(
      'Registration Removal — 預設 No',
      quote(registrationRemovalDisclosure(pf.preflight)),
    );
    if (!proceed) return decline();
    if (!await showTransactionStep(ctx, {
      ...boundModel,
      step: 'Plan',
      details: registrationRemovalDisclosure(pf.preflight).split('\n'),
    })) return decline();
    if (!await showTransactionStep(ctx, {
      ...boundModel,
      step: 'Commit',
      details: ['Commit the disclosed cascade to this scope document under the held Attempt Fence'],
    })) return decline();
    await attemptReport(ctx, await confirmRegistrationRemoval(pf.preflight, true, opts));
    return;
  }

  let installationId = target.targetId;
  if (!installationId) {
    const state = await readBridgeState(scope, opts);
    if (state.status !== 'ok' && state.status !== 'missing') return void ui.notify(`Bridge State 不可讀：${quote(state.error ?? 'Persistence Indeterminate')}`, 'error');
    const installations = state.state?.installations ?? [];
    if (installations.length === 0) return void ui.notify('此 Scope 尚無 Installed Plugin。', 'info');
    const labels = installations.map((installation) => `${quote(installation.manifestName ?? installation.pluginId)} · ${installation.installationState} · ${quote(installation.id)}`);
    const chosen = await ui.select('選擇要移除的 Installation', labels);
    if (!chosen) return;
    installationId = installations[labels.indexOf(chosen)]!.id;
  }

  const model = {
    actionLabel: 'Installation Removal',
    authority: scope,
    target: installationId,
  } satisfies Omit<TransactionSheetModel, 'step'>;
  if (!await showTransactionStep(ctx, {
    ...model,
    step: 'Intent',
    details: ['Remove exactly one scope-local Installation while retaining its Registration'],
  })) return;

  const pf = await preflightInstallationRemoval(scope, installationId, opts);
  if (!pf.ok) {
    await showTransactionStep(ctx, {
      ...model,
      step: 'Validation',
      stateRevision: pf.outcome.receipt.expectedStateRevision,
      details: fullValidationDisclosureLines(pf.outcome.receipt.findings),
    });
    await attemptReport(ctx, pf.outcome);
    return;
  }
  const boundModel = { ...model, stateRevision: pf.preflight.stateRevision };
  const decline = async (): Promise<void> => {
    await attemptReport(ctx, await confirmInstallationRemoval(pf.preflight, false, opts));
  };
  if (!await showTransactionStep(ctx, {
    ...boundModel,
    step: 'Validation',
    details: [
      ...validationDisclosureLines([]),
      ...installationRemovalDisclosure(pf.preflight).split('\n'),
    ],
  })) return decline();
  if (!await showTransactionStep(ctx, {
    ...boundModel,
    step: 'Consent',
    details: ['Installation Removal confirmation remains a separate Default No decision'],
  })) return decline();
  const proceed = await ui.confirm(
    'Installation Removal — 預設 No',
    quote(installationRemovalDisclosure(pf.preflight)),
  );
  if (!proceed) return decline();
  if (!await showTransactionStep(ctx, {
    ...boundModel,
    step: 'Plan',
    details: installationRemovalDisclosure(pf.preflight).split('\n'),
  })) return decline();
  if (!await showTransactionStep(ctx, {
    ...boundModel,
    step: 'Commit',
    details: ['Commit removal to this scope document under the held Attempt Fence'],
  })) return decline();
  await attemptReport(ctx, await confirmInstallationRemoval(pf.preflight, true, opts));
}
