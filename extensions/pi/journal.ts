/**
 * TUI flows for Receipt Journal inspection and State Repair action (Issue #23).
 */

import type { ExtensionCommandContext, ExtensionUIContext } from '@earendil-works/pi-coding-agent';

import { checkGlobalPendingBarrier } from '../../src/barrier/global-barrier.js';
import type { BridgeState, Scope } from '../../src/bridge-state/types.js';
import { readBridgeState } from '../../src/bridge-state/store.js';
import { inspectMarketplaceEntries } from '../../src/installation/inspection.js';
import { appendReceipt, readReceiptJournal } from '../../src/journal/journal.js';
import { repairBridgeState } from '../../src/bridge-state/repair.js';
import { requestRuntimeApplication } from '../../src/projection/project.js';
import { acquireAttemptFence } from '../../src/registration/fence.js';
import { blocking, CODE, RULE, type ValidationFinding } from '../../src/registration/findings.js';
import { createReceipt } from '../../src/registration/receipt.js';
import { fullValidationDisclosureLines, reportOutcome } from './registration.js';
import { quoteTerminalText } from './terminal-presentation.js';
import { openTransactionSheet, type TransactionSheetModel } from './transaction-sheet.js';

function quote(value: string): string {
  return quoteTerminalText(value);
}

async function pickScope(
  ui: ExtensionUIContext,
  prompt: string,
  explicit?: Scope,
): Promise<Scope | undefined> {
  if (explicit) return explicit;
  const labels = new Map<string, Scope>([
    ['Global Scope', 'global'],
    ['Project Scope', 'project'],
  ]);
  const selected = await ui.select(prompt, [...labels.keys()]);
  return selected ? labels.get(selected) : undefined;
}

async function showTransactionStep(ctx: ExtensionCommandContext, model: TransactionSheetModel): Promise<boolean> {
  return await openTransactionSheet(ctx, model) === 'continue';
}

async function reportDeclinedRepair(
  ctx: ExtensionCommandContext,
  scope: Scope,
  stateRevision: string,
): Promise<void> {
  const receipt = createReceipt({
    kind: 'State Repair',
    operation: 'Repair State',
    scope,
    trigger: `declined repair ${scope} Bridge State`,
    expectedStateRevision: stateRevision,
    summary: 'Declined',
    stateChanged: false,
  });
  await appendReceipt(scope, receipt, { cwd: ctx.cwd });
  await reportOutcome(ctx, { receipt });
}

function retryFinding(
  scope: Scope,
  code: string,
  rule: string,
  outcome: string,
  phase: ValidationFinding['phase'] = 'admission',
): ValidationFinding {
  return blocking({
    code,
    rule,
    target: 'attempt',
    pointer: '',
    outcome,
    scope,
    phase,
  });
}

/** Revalidate that the bound snapshot still describes live source material in this authority. */
function exactValidationSnapshotStillValid(
  scope: Scope,
  state: BridgeState,
  validationSnapshot: string,
): boolean {
  try {
    for (const registration of state.registrations) {
      if (registration.validationSnapshot !== validationSnapshot) continue;
      const inspection = inspectMarketplaceEntries(registration, scope);
      if (inspection.treeFingerprint === validationSnapshot) return true;
    }

    for (const installation of state.installations) {
      if (installation.validationSnapshot !== validationSnapshot || !installation.registrationId) continue;
      const registration = state.registrations.find((candidate) =>
        candidate.id === installation.registrationId);
      if (!registration) continue;
      const inspection = inspectMarketplaceEntries(registration, scope);
      const entry = inspection.entries.find((candidate) =>
        candidate.plugin?.marketplaceEntryId === installation.marketplaceEntryId);
      if (
        inspection.snapshot?.fingerprint === validationSnapshot
        && entry?.plugin
        && !entry.unavailableReason
        && !entry.findings.some((finding) => finding.classification === 'blocking')
      ) return true;
    }
  } catch {
    return false;
  }
  return false;
}

async function reportRetryTerminal(
  ctx: ExtensionCommandContext,
  input: {
    scope: Scope;
    receiptId: string;
    stateRevision: string;
    summary: 'Declined' | 'Blocked' | 'Rejected as Stale' | 'Persistence Indeterminate';
    validationSnapshot?: string;
    findings?: ValidationFinding[];
    attachToChain?: boolean;
  },
): Promise<void> {
  const receipt = createReceipt({
    kind: 'Runtime Application',
    operation: 'Runtime Application',
    scope: input.scope,
    trigger: `retry application ${input.receiptId}`,
    expectedStateRevision: input.stateRevision,
    validationSnapshot: input.validationSnapshot,
    summary: input.summary,
    findings: input.findings,
    stateChanged: false,
    recoversReceiptId: input.attachToChain ? input.receiptId : undefined,
  });
  await appendReceipt(input.scope, receipt, { cwd: ctx.cwd });
  await reportOutcome(ctx, { receipt });
}

export interface ReceiptJournalViewTarget {
  scope?: Scope;
  receiptId?: string;
}

export interface RetryApplicationTarget {
  scope: Scope;
  receiptId: string;
}

/** Explicit Retry Application for one exact active Pending Application recovery chain. */
export async function runRetryApplicationFlow(
  ctx: ExtensionCommandContext,
  target: RetryApplicationTarget,
): Promise<void> {
  const fence = await acquireAttemptFence(target.scope, {
    cwd: ctx.cwd,
    projectTrusted: ctx.isProjectTrusted(),
  });
  if (!fence.ok) {
    const state = await readBridgeState(target.scope, { cwd: ctx.cwd });
    await reportRetryTerminal(ctx, {
      scope: target.scope,
      receiptId: target.receiptId,
      stateRevision: state.state?.stateRevision ?? '?',
      summary: 'Blocked',
      findings: fence.finding ? [fence.finding] : undefined,
      attachToChain: true,
    });
    return;
  }

  try {
    await runRetryApplicationUnderFence(ctx, target);
  } finally {
    fence.handle!.release();
  }
}

async function runRetryApplicationUnderFence(
  ctx: ExtensionCommandContext,
  target: RetryApplicationTarget,
): Promise<void> {
  const { scope, receiptId } = target;
  const [journal, state] = await Promise.all([
    readReceiptJournal(scope, { cwd: ctx.cwd }),
    readBridgeState(scope, { cwd: ctx.cwd }),
  ]);
  const chain = journal.activeChains.find(
    (candidate) => candidate.rootReceiptId === receiptId && candidate.condition === 'pending-application',
  );
  if (!chain) {
    await reportRetryTerminal(ctx, {
      scope,
      receiptId,
      stateRevision: state.state?.stateRevision ?? '?',
      summary: 'Rejected as Stale',
      findings: [retryFinding(
        scope,
        CODE.REJECTED_AS_STALE,
        RULE.REJECTED_AS_STALE,
        'The selected Pending Application recovery chain is no longer active; reopen the Bridge Ledger',
      )],
    });
    return;
  }
  const rootReceipt = chain.receipts[0]!;
  const rootValidationSnapshot = rootReceipt.validationSnapshot;
  if (state.status !== 'ok' && state.status !== 'missing') {
    await reportRetryTerminal(ctx, {
      scope,
      receiptId,
      stateRevision: chain.stateRevision,
      validationSnapshot: rootValidationSnapshot,
      summary: 'Persistence Indeterminate',
      findings: [retryFinding(
        scope,
        CODE.PERSISTENCE_INDETERMINATE,
        RULE.STATE_CORRUPT,
        state.error ?? 'Bridge State is unreadable; Runtime Application cannot be verified',
        'persistence',
      )],
      attachToChain: true,
    });
    return;
  }
  if (state.state!.stateRevision !== chain.stateRevision) {
    await reportRetryTerminal(ctx, {
      scope,
      receiptId,
      stateRevision: chain.stateRevision,
      validationSnapshot: rootValidationSnapshot,
      summary: 'Rejected as Stale',
      findings: [retryFinding(
        scope,
        CODE.REJECTED_AS_STALE,
        RULE.REJECTED_AS_STALE,
        `State Revision changed (${chain.stateRevision} → ${state.state!.stateRevision}); reopen the Bridge Ledger`,
        'persistence',
      )],
      attachToChain: true,
    });
    return;
  }
  if (!rootValidationSnapshot) {
    await reportRetryTerminal(ctx, {
      scope,
      receiptId,
      stateRevision: chain.stateRevision,
      summary: 'Rejected as Stale',
      findings: [retryFinding(
        scope,
        CODE.REJECTED_AS_STALE,
        RULE.REJECTED_AS_STALE,
        'The active Pending Application root has no bound Validation Snapshot; fail closed and revalidate from a fresh Intent',
      )],
      attachToChain: true,
    });
    return;
  }
  if (!exactValidationSnapshotStillValid(scope, state.state!, rootValidationSnapshot)) {
    await reportRetryTerminal(ctx, {
      scope,
      receiptId,
      stateRevision: chain.stateRevision,
      validationSnapshot: rootValidationSnapshot,
      summary: 'Rejected as Stale',
      findings: [retryFinding(
        scope,
        CODE.REJECTED_AS_STALE,
        RULE.REJECTED_AS_STALE_SNAPSHOT,
        'The bound Validation Snapshot no longer matches live source material; reopen the Bridge Ledger and revalidate',
        'validation',
      )],
      attachToChain: true,
    });
    return;
  }
  if (scope === 'project' && !ctx.isProjectTrusted()) {
    await reportRetryTerminal(ctx, {
      scope,
      receiptId,
      stateRevision: chain.stateRevision,
      validationSnapshot: rootValidationSnapshot,
      summary: 'Blocked',
      findings: [retryFinding(
        scope,
        CODE.PROJECT_TRUST_DENIED,
        RULE.PROJECT_TRUST_DENIED,
        'Project Trust is not granted; Project Runtime Application is unavailable',
      )],
      attachToChain: true,
    });
    return;
  }
  if (scope === 'project') {
    const barrier = await checkGlobalPendingBarrier({ cwd: ctx.cwd });
    if (barrier.active) {
      await reportRetryTerminal(ctx, {
        scope,
        receiptId,
        stateRevision: chain.stateRevision,
        validationSnapshot: rootValidationSnapshot,
        summary: 'Blocked',
        findings: [barrier.finding ?? retryFinding(
          scope,
          CODE.GLOBAL_PENDING_BARRIER,
          RULE.GLOBAL_PENDING_BARRIER,
          barrier.reason ?? 'Global recovery is required first',
        )],
        attachToChain: true,
      });
      return;
    }
  }

  const model = {
    actionLabel: 'Retry Runtime Application',
    authority: scope,
    target: receiptId,
    stateRevision: chain.stateRevision,
    validationSnapshot: rootValidationSnapshot,
  } satisfies Omit<TransactionSheetModel, 'step'>;
  const decline = async () => reportRetryTerminal(ctx, {
    scope,
    receiptId,
    stateRevision: chain.stateRevision,
    validationSnapshot: rootValidationSnapshot,
    summary: 'Declined',
    attachToChain: true,
  });

  if (!await showTransactionStep(ctx, {
    ...model,
    step: 'Intent',
    details: ['Retry only the selected active Pending Application chain; Bridge State is not rewritten'],
  })) return void await decline();
  if (!await showTransactionStep(ctx, {
    ...model,
    step: 'Validation',
    details: [
      ...fullValidationDisclosureLines(rootReceipt.findings),
      `Active recovery root ${quote(receiptId)}`,
      `Exact State Revision ${quote(chain.stateRevision)}`,
      `Bound Validation Snapshot ${quote(rootReceipt.validationSnapshot ?? '(not recorded)')}`,
    ],
  })) return void await decline();
  if (!await showTransactionStep(ctx, {
    ...model,
    step: 'Consent',
    details: ['Retry Application Confirmation is explicit and defaults to No'],
  })) return void await decline();
  if (!await ctx.ui.confirm(
    'Retry Application Confirmation — 預設 No',
    `重新載入 Bridge resources 並驗證 ${scope} State Revision ${quote(chain.stateRevision)}？`,
  )) return void await decline();
  if (!await showTransactionStep(ctx, {
    ...model,
    step: 'Plan',
    details: ['Ask the Pi host to reload, then verify Bridge re-entry at the exact bound State Revision'],
  })) return void await decline();
  if (!await showTransactionStep(ctx, {
    ...model,
    step: 'Commit',
    details: ['No Bridge State write; append a resolving Receipt only after exact post-reload verification'],
  })) return void await decline();

  // Consent can remain open while either Bridge State or live source material changes.
  // Revalidate at the last possible point before invoking the host reload seam.
  const preReloadState = await readBridgeState(scope, { cwd: ctx.cwd });
  if (preReloadState.status !== 'ok' && preReloadState.status !== 'missing') {
    await reportRetryTerminal(ctx, {
      scope,
      receiptId,
      stateRevision: chain.stateRevision,
      validationSnapshot: rootValidationSnapshot,
      summary: 'Persistence Indeterminate',
      findings: [retryFinding(
        scope,
        CODE.PERSISTENCE_INDETERMINATE,
        RULE.STATE_CORRUPT,
        preReloadState.error ?? 'Bridge State became unreadable before Runtime Application',
        'persistence',
      )],
      attachToChain: true,
    });
    return;
  }
  if (preReloadState.state!.stateRevision !== chain.stateRevision) {
    await reportRetryTerminal(ctx, {
      scope,
      receiptId,
      stateRevision: chain.stateRevision,
      validationSnapshot: rootValidationSnapshot,
      summary: 'Rejected as Stale',
      findings: [retryFinding(
        scope,
        CODE.REJECTED_AS_STALE,
        RULE.REJECTED_AS_STALE,
        `State Revision changed during confirmation (${chain.stateRevision} → ${preReloadState.state!.stateRevision}); Runtime Application was not requested`,
        'persistence',
      )],
      attachToChain: true,
    });
    return;
  }
  if (!exactValidationSnapshotStillValid(scope, preReloadState.state!, rootValidationSnapshot)) {
    await reportRetryTerminal(ctx, {
      scope,
      receiptId,
      stateRevision: chain.stateRevision,
      validationSnapshot: rootValidationSnapshot,
      summary: 'Rejected as Stale',
      findings: [retryFinding(
        scope,
        CODE.REJECTED_AS_STALE,
        RULE.REJECTED_AS_STALE_SNAPSHOT,
        'The bound Validation Snapshot changed during confirmation; Runtime Application was not requested',
        'validation',
      )],
      attachToChain: true,
    });
    return;
  }

  const outcome = await requestRuntimeApplication(async () => {
    try {
      await ctx.reload();
    } catch {
      return false;
    }
    const observed = await readBridgeState(scope, { cwd: ctx.cwd });
    return (observed.status === 'ok' || observed.status === 'missing')
      && observed.state!.stateRevision === chain.stateRevision
      && exactValidationSnapshotStillValid(scope, observed.state!, rootValidationSnapshot);
  }, {
    scope,
    stateRevision: chain.stateRevision,
    validationSnapshot: rootValidationSnapshot,
    cwd: ctx.cwd,
    recoversReceiptId: receiptId,
    wholePluginFindings: rootReceipt.findings,
  });
  await reportOutcome(ctx, outcome);
}

export async function runReceiptJournalView(
  ctx: ExtensionCommandContext,
  target: ReceiptJournalViewTarget = {},
): Promise<void> {
  const ui: ExtensionUIContext = ctx.ui;
  const scope = await pickScope(ui, 'Receipt Journal — 選擇 Scope', target.scope);
  if (!scope) return;

  const journal = await readReceiptJournal(scope, { cwd: ctx.cwd });
  if (target.receiptId) {
    const receipt = journal.receipts.find((item) => item.id === target.receiptId);
    if (!receipt) {
      ui.notify(`Receipt Journal 找不到精確 Receipt ID ${quote(target.receiptId)}。`, 'warning');
      return;
    }
    await reportOutcome(ctx, { receipt });
    return;
  }

  const lines: string[] = [
    `=== ${scope === 'global' ? 'Global' : 'Project'} Receipt Journal ===`,
    `Total Receipts: ${journal.receipts.length}`,
    `Degraded: ${journal.isDegraded ? `Yes (${journal.corruptedLineCount} corrupted lines)` : 'No'}`,
    `Active Recovery Chains: ${journal.activeChains.length === 0 ? 'None' : ''}`,
  ];

  for (const chain of journal.activeChains) {
    lines.push(`  Chain ${quote(chain.rootReceiptId)} condition: ${quote(chain.condition)} (length: ${chain.receipts.length})`);
  }

  lines.push('');
  lines.push('--- Recent Receipts ---');
  const recent = journal.receipts.slice(-10).reverse();
  if (recent.length === 0) {
    lines.push('  (Journal is empty)');
  } else {
    for (const rc of recent) {
      lines.push(`${quote(rc.id)} ${quote(rc.completedAt)} · ${quote(rc.operation)} (${rc.scope})`);
      lines.push(`  Summary: ${quote(rc.summary)} | Durable: ${quote(rc.durableOutcome)} | Runtime: ${quote(rc.runtimeOutcome)}`);
      lines.push(`  Revision: ${quote(rc.expectedStateRevision)} → ${quote(rc.observedStateRevision ?? rc.targetStateRevision ?? '?')}`);
      if (rc.recoversReceiptId) {
        lines.push(`  Recovers: ${quote(rc.recoversReceiptId)}`);
      }
      if (rc.findings.length > 0) {
        lines.push(`  Findings: ${rc.findings.map((finding) => `${finding.classification} ${quote(finding.code)}`).join(', ')}`);
      }
      lines.push('');
    }
  }

  ui.notify(lines.join('\n'), journal.isDegraded ? 'warning' : 'info');
}

export async function runRepairStateFlow(
  ctx: ExtensionCommandContext,
  target: { scope?: Scope } = {},
): Promise<void> {
  const ui: ExtensionUIContext = ctx.ui;
  const scope = await pickScope(ui, 'Repair State — 選擇 Scope', target.scope);
  if (!scope) return;

  const [initial, initialJournal] = await Promise.all([
    readBridgeState(scope, { cwd: ctx.cwd }),
    readReceiptJournal(scope, { cwd: ctx.cwd }),
  ]);
  const model = {
    actionLabel: 'Repair State',
    authority: scope,
    target: `${scope} Bridge State`,
    stateRevision: initial.state?.stateRevision,
  } satisfies Omit<TransactionSheetModel, 'step'>;
  const stateFindings = initial.status === 'ok' || initial.status === 'missing'
    ? []
    : [retryFinding(
        scope,
        initial.status === 'incompatible' ? CODE.PERSISTENCE_INDETERMINATE : CODE.PERSISTENCE_INDETERMINATE,
        initial.status === 'incompatible' ? RULE.STATE_SCHEMA_UNKNOWN : RULE.STATE_CORRUPT,
        initial.error ?? `Bridge State is ${initial.status}`,
        'persistence',
      )];
  const repairFindings = [...stateFindings, ...initialJournal.findings];
  const decline = async () => reportDeclinedRepair(
    ctx,
    scope,
    initial.state?.stateRevision ?? '?',
  );
  if (!await showTransactionStep(ctx, {
    ...model,
    step: 'Intent',
    details: ['Verify the exact authoritative Bridge State and reconstruct degraded Receipt Journal lines when eligible'],
  })) return void await decline();
  if (!await showTransactionStep(ctx, {
    ...model,
    step: 'Validation',
    details: [
      ...fullValidationDisclosureLines(repairFindings),
      `Current read status: ${initial.status}`,
      `Current diagnostic: ${quote(initial.error ?? 'none')}`,
      `Receipt Journal: ${initialJournal.isDegraded ? `${initialJournal.corruptedLineCount} corrupted line(s)` : 'healthy'}`,
      'The domain Recovery Action will revalidate under the Attempt Fence; this presentation result does not authorize repair',
    ],
  })) return void await decline();
  if (!await showTransactionStep(ctx, {
    ...model,
    step: 'Consent',
    details: ['Repair State Confirmation remains a separate Default No decision'],
  })) return void await decline();

  const confirmed = await ui.confirm(
    'Repair State Confirmation — 預設 No',
    `執行 ${scope === 'global' ? 'Global' : 'Project'} Scope 的 State Repair？\n將在 Attempt Fence 保護下驗證 Bridge State，重建可辨識的 Receipt Journal，並解除相應的 Indeterminate/Degraded recovery chain。`,
  );
  if (!confirmed) {
    return void await decline();
  }

  if (!await showTransactionStep(ctx, {
    ...model,
    step: 'Plan',
    details: ['Validate state readability/schema and atomically retain only verified Receipt lines; do not retry a lifecycle operation or roll state back'],
  })) return void await decline();
  if (!await showTransactionStep(ctx, {
    ...model,
    step: 'Commit',
    details: ['The domain guard will acquire the scope Attempt Fence and append the resulting immutable Receipt'],
  })) return void await decline();

  const res = await repairBridgeState(scope, {
    cwd: ctx.cwd,
  });

  await reportOutcome(ctx, { receipt: res.receipt });
}
