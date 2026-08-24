/**
 * TUI flows for Receipt Journal inspection and State Repair action (Issue #23).
 * All user-visible strings come from the centralized ui-strings module (Issue #41).
 */

import type { ExtensionCommandContext, ExtensionUIContext } from '@earendil-works/pi-coding-agent';

import { checkGlobalPendingBarrier } from '../../src/barrier/global-barrier.js';
import type { BridgeState, Scope } from '../../src/bridge-state/types.js';
import { readBridgeState } from '../../src/bridge-state/store.js';
import { inspectMarketplaceEntries } from '../../src/installation/inspection.js';
import { appendReceipt, readReceiptJournal } from '../../src/journal/journal.js';
import type { JournalAppendResult } from '../../src/journal/types.js';
import { createRepairStateExpectation, repairBridgeState } from '../../src/bridge-state/repair.js';
import { requestRuntimeApplication } from '../../src/projection/project.js';
import { acquireAttemptFence } from '../../src/registration/fence.js';
import { blocking, CODE, notice, RULE, type ValidationFinding } from '../../src/registration/findings.js';
import { createReceipt, type AttemptReceipt } from '../../src/registration/receipt.js';
import { fullValidationDisclosureLines, reportOutcome } from './registration.js';
import { attemptSummaryText, uiText } from './ui-strings.js';
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
    [uiText('common.scope.global'), 'global'],
    [uiText('common.scope.project'), 'project'],
  ]);
  const selected = await ui.select(prompt, [...labels.keys()]);
  return selected ? labels.get(selected) : undefined;
}

async function showTransactionStep(ctx: ExtensionCommandContext, model: TransactionSheetModel): Promise<boolean> {
  return await openTransactionSheet(ctx, model) === 'continue';
}

function receiptPersistenceFailureFinding(
  receipt: AttemptReceipt,
  appended: JournalAppendResult,
): ValidationFinding {
  return appended.finding ?? notice({
    code: CODE.RECEIPT_PERSISTENCE_FAILED,
    phase: 'post-commit',
    target: 'attempt',
    scope: receipt.scope,
    pointer: '',
    rule: RULE.RECEIPT_PERSISTENCE_FAILED,
    outcome: uiText('journal.finding.persistFailed', {
      error: appended.error ?? uiText('common.unknown'),
    }),
  });
}

/** Rebuild the non-durable presentation Receipt without mutating the original Attempt Receipt. */
export function receiptAfterJournalAppendFailure(
  receipt: AttemptReceipt,
  appended: JournalAppendResult,
): AttemptReceipt {
  const journalFinding = receiptPersistenceFailureFinding(receipt, appended);
  return createReceipt({
    id: receipt.id,
    kind: receipt.kind,
    operation: receipt.operation,
    scope: receipt.scope,
    trigger: receipt.trigger,
    startedAt: receipt.startedAt,
    completedAt: receipt.completedAt,
    expectedStateRevision: receipt.expectedStateRevision,
    targetStateRevision: receipt.targetStateRevision,
    observedStateRevision: receipt.observedStateRevision,
    validationSnapshot: receipt.validationSnapshot,
    snapshotFingerprints: receipt.snapshotFingerprints,
    durableOutcome: receipt.durableOutcome,
    runtimeOutcome: receipt.runtimeOutcome,
    findings: [...receipt.findings, journalFinding],
    summary: 'Persistence Failed',
    stateChanged: receipt.stateChanged,
    recoversReceiptId: receipt.recoversReceiptId,
    supersedesReceiptId: receipt.supersedesReceiptId,
  });
}

export async function appendAndReportReceipt(
  ctx: ExtensionCommandContext,
  receipt: AttemptReceipt,
): Promise<void> {
  const appended = await appendReceipt(receipt.scope, receipt, { cwd: ctx.cwd });
  await reportOutcome(ctx, {
    receipt: appended.success ? receipt : receiptAfterJournalAppendFailure(receipt, appended),
  });
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
  await appendAndReportReceipt(ctx, receipt);
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
  await appendAndReportReceipt(ctx, receipt);
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
        uiText('journal.retry.chainStale'),
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
        state.error ?? uiText('journal.retry.unreadable'),
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
        uiText('journal.retry.staleDuringConfirm', {
          expected: chain.stateRevision,
          observed: state.state!.stateRevision,
        }),
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
        uiText('journal.retry.noSnapshot'),
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
        uiText('journal.retry.snapshotMismatch'),
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
        uiText('journal.retry.trustDenied'),
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
          barrier.reason ?? uiText('journal.retry.barrierRequired'),
        )],
        attachToChain: true,
      });
      return;
    }
  }

  const model = {
    actionLabel: uiText('ledger.action.retry-application'),
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
    details: [uiText('journal.retry.intent.details')],
  })) return void await decline();
  if (!await showTransactionStep(ctx, {
    ...model,
    step: 'Validation',
    details: [
      ...fullValidationDisclosureLines(rootReceipt.findings),
      uiText('journal.retry.validation.root', { receiptId: quote(receiptId) }),
      uiText('journal.retry.validation.revision', { revision: quote(chain.stateRevision) }),
      uiText('journal.retry.validation.snapshot', {
        snapshot: quote(rootReceipt.validationSnapshot ?? uiText('journal.retry.validation.snapshotMissing')),
      }),
    ],
  })) return void await decline();
  if (!await showTransactionStep(ctx, {
    ...model,
    step: 'Consent',
    details: [uiText('journal.retry.consent.details')],
  })) return void await decline();
  if (!await ctx.ui.confirm(
    uiText('journal.retry.consent.title'),
    uiText('journal.retry.consent.body', { scope, revision: quote(chain.stateRevision) }),
  )) return void await decline();
  if (!await showTransactionStep(ctx, {
    ...model,
    step: 'Plan',
    details: [uiText('journal.retry.plan.details')],
  })) return void await decline();
  if (!await showTransactionStep(ctx, {
    ...model,
    step: 'Commit',
    details: [uiText('journal.retry.commit.details')],
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
        preReloadState.error ?? uiText('journal.retry.persistenceBeforeReload'),
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
        uiText('journal.retry.staleDuringConfirm', {
          expected: chain.stateRevision,
          observed: preReloadState.state!.stateRevision,
        }),
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
        uiText('journal.retry.staleDuringConfirmSnapshot'),
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
        uiText('journal.retry.trustRevoked'),
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
          barrier.reason ?? uiText('journal.retry.barrierDuringConfirm'),
        )],
        attachToChain: true,
      });
      return;
    }
  }

  const postReloadGuardBlocked = Symbol('post-reload-project-guard-blocked');
  let postReloadGuardFinding: ValidationFinding | undefined;
  try {
    const outcome = await requestRuntimeApplication(async () => {
      try {
        await ctx.reload();
      } catch {
        return false;
      }
      const observed = await readBridgeState(scope, { cwd: ctx.cwd });
      const reentered = (observed.status === 'ok' || observed.status === 'missing')
        && observed.state!.stateRevision === chain.stateRevision
        && exactValidationSnapshotStillValid(scope, observed.state!, rootValidationSnapshot);
      if (!reentered) return false;
      if (scope === 'project' && !ctx.isProjectTrusted()) {
        postReloadGuardFinding = retryFinding(
          scope,
          CODE.PROJECT_TRUST_DENIED,
          RULE.PROJECT_TRUST_DENIED,
          uiText('journal.retry.trustRevokedReload'),
        );
        throw postReloadGuardBlocked;
      }
      if (scope === 'project') {
        const barrier = await checkGlobalPendingBarrier({ cwd: ctx.cwd });
        if (barrier.active) {
          postReloadGuardFinding = barrier.finding ?? retryFinding(
            scope,
            CODE.GLOBAL_PENDING_BARRIER,
            RULE.GLOBAL_PENDING_BARRIER,
            barrier.reason ?? uiText('journal.retry.barrierDuringReload'),
          );
          throw postReloadGuardBlocked;
        }
      }
      return true;
    }, {
      scope,
      stateRevision: chain.stateRevision,
      validationSnapshot: rootValidationSnapshot,
      cwd: ctx.cwd,
      recoversReceiptId: receiptId,
      wholePluginFindings: rootReceipt.findings,
    });
    await reportOutcome(ctx, outcome);
  } catch (error) {
    if (error !== postReloadGuardBlocked || !postReloadGuardFinding) throw error;
    await reportRetryTerminal(ctx, {
      scope,
      receiptId,
      stateRevision: chain.stateRevision,
      validationSnapshot: rootValidationSnapshot,
      summary: 'Blocked',
      findings: [postReloadGuardFinding],
      attachToChain: true,
    });
  }
}

export async function runReceiptJournalView(
  ctx: ExtensionCommandContext,
  target: ReceiptJournalViewTarget = {},
): Promise<void> {
  const ui: ExtensionUIContext = ctx.ui;
  const scope = await pickScope(ui, uiText('journal.pick.scope'), target.scope);
  if (!scope) return;

  const journal = await readReceiptJournal(scope, { cwd: ctx.cwd });
  if (target.receiptId) {
    const receipt = journal.receipts.find((item) => item.id === target.receiptId);
    if (!receipt) {
      ui.notify(uiText('journal.notFound', { receiptId: quote(target.receiptId) }), 'warning');
      return;
    }
    await reportOutcome(ctx, { receipt });
    return;
  }

  const lines: string[] = [
    uiText('journal.view.header', { scopeWord: scope === 'global' ? uiText('common.scope.word.global') : uiText('common.scope.word.project') }),
    uiText('journal.view.total', { count: journal.receipts.length }),
    journal.isDegraded
      ? uiText('journal.view.degraded.yes', { count: journal.corruptedLineCount })
      : uiText('journal.view.degraded.no'),
    uiText('journal.view.chains.header', {
      value: journal.activeChains.length === 0 ? uiText('journal.view.chains.none') : '',
    }),
  ];

  for (const chain of journal.activeChains) {
    lines.push('  ' + uiText('journal.view.chain.line', {
      receiptId: quote(chain.rootReceiptId),
      condition: quote(chain.condition),
      length: chain.receipts.length,
    }));
  }

  lines.push('');
  lines.push(uiText('journal.view.recent.header'));
  const recent = journal.receipts.slice(-10).reverse();
  if (recent.length === 0) {
    lines.push('  ' + uiText('journal.view.recent.empty'));
  } else {
    for (const rc of recent) {
      lines.push(`${quote(rc.id)} ${quote(rc.completedAt)} · ${quote(rc.operation)} (${rc.scope})`);
      lines.push('  ' + uiText('journal.view.receipt.summary', {
        summary: attemptSummaryText(rc.summary),
        durable: quote(rc.durableOutcome),
        runtime: quote(rc.runtimeOutcome),
      }));
      lines.push('  ' + uiText('journal.view.receipt.revision', {
        expected: quote(rc.expectedStateRevision),
        observed: quote(rc.observedStateRevision ?? rc.targetStateRevision ?? '?'),
      }));
      if (rc.recoversReceiptId) {
        lines.push('  ' + uiText('journal.view.receipt.recovers', { receiptId: quote(rc.recoversReceiptId) }));
      }
      if (rc.findings.length > 0) {
        lines.push('  ' + uiText('journal.view.receipt.findings', {
          findings: rc.findings.map((finding) => `${finding.classification} ${quote(finding.code)}`).join(', '),
        }));
      }
      lines.push('');
    }
  }

  ui.notify(lines.join('\n'), journal.isDegraded ? 'warning' : 'info');
}

export interface RepairStateTarget {
  scope?: Scope;
  expectedStateRevision?: string;
}

export async function runRepairStateFlow(
  ctx: ExtensionCommandContext,
  target: RepairStateTarget = {},
): Promise<void> {
  const ui: ExtensionUIContext = ctx.ui;
  const scope = await pickScope(ui, uiText('journal.repair.pick.scope'), target.scope);
  if (!scope) return;

  const [initial, initialJournal] = await Promise.all([
    readBridgeState(scope, { cwd: ctx.cwd }),
    readReceiptJournal(scope, { cwd: ctx.cwd }),
  ]);
  const initialExpectation = createRepairStateExpectation(initial, initialJournal);
  const selectedStateRevision = target.expectedStateRevision ?? initialExpectation.stateRevision;
  const expected = {
    ...initialExpectation,
    stateRevision: selectedStateRevision,
  };
  const model = {
    actionLabel: uiText('ledger.action.repair-state'),
    authority: scope,
    target: `${scope} Bridge State`,
    stateRevision: selectedStateRevision,
  } satisfies Omit<TransactionSheetModel, 'step'>;
  const stateFindings = initial.status === 'ok' || initial.status === 'missing'
    ? []
    : [retryFinding(
        scope,
        initial.status === 'incompatible' ? CODE.PERSISTENCE_INDETERMINATE : CODE.PERSISTENCE_INDETERMINATE,
        initial.status === 'incompatible' ? RULE.STATE_SCHEMA_UNKNOWN : RULE.STATE_CORRUPT,
        initial.error ?? uiText('journal.repair.stateError', { status: initial.status }),
        'persistence',
      )];
  const repairFindings = [...stateFindings, ...initialJournal.findings];
  const decline = async () => reportDeclinedRepair(
    ctx,
    scope,
    selectedStateRevision ?? '?',
  );
  if (!await showTransactionStep(ctx, {
    ...model,
    step: 'Intent',
    details: [uiText('journal.repair.intent.details')],
  })) return void await decline();
  if (!await showTransactionStep(ctx, {
    ...model,
    step: 'Validation',
    details: [
      ...fullValidationDisclosureLines(repairFindings),
      uiText('journal.repair.validation.status', { status: initial.status }),
      uiText('journal.repair.validation.diagnostic', { error: quote(initial.error ?? uiText('journal.repair.validation.diagnosticNone')) }),
      initialJournal.isDegraded
        ? uiText('journal.repair.validation.journalDegraded', { count: initialJournal.corruptedLineCount })
        : uiText('journal.repair.validation.journalHealthy'),
      uiText('journal.repair.validation.journalRevision', { revision: initialJournal.revision }),
      uiText('journal.repair.validation.eligibility', { eligibility: expected.journalEligibility }),
      uiText('journal.repair.validation.domainGuard'),
    ],
  })) return void await decline();
  if (!await showTransactionStep(ctx, {
    ...model,
    step: 'Consent',
    details: [uiText('journal.repair.consent.details')],
  })) return void await decline();

  const confirmed = await ui.confirm(
    uiText('journal.repair.consent.title'),
    uiText('journal.repair.consent.body', {
      scopeWord: scope === 'global' ? uiText('common.scope.word.global') : uiText('common.scope.word.project'),
    }),
  );
  if (!confirmed) {
    return void await decline();
  }

  if (!await showTransactionStep(ctx, {
    ...model,
    step: 'Plan',
    details: [uiText('journal.repair.plan.details')],
  })) return void await decline();
  if (!await showTransactionStep(ctx, {
    ...model,
    step: 'Commit',
    details: [uiText('journal.repair.commit.details')],
  })) return void await decline();

  const res = await repairBridgeState(scope, {
    cwd: ctx.cwd,
    expected,
  });

  await reportOutcome(ctx, { receipt: res.receipt });
}
