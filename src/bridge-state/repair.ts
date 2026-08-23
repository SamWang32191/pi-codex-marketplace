/**
 * Repair State — Recovery Action to verify Bridge State and reconstruct a degraded Receipt Journal.
 * See CONTEXT.md: Persistence Indeterminate, Receipt Journal, Recovery Action.
 */

import { getStatePath } from './paths.js';
import { withBridgeStateLock } from './store.js';
import type { BridgeState, ReadResult, ReadStatus, Scope } from './types.js';
import { acquireAttemptFence } from '../registration/fence.js';
import {
  appendReceipt,
  commitJournalRepair,
  readReceiptJournal,
  type JournalOptions,
} from '../journal/journal.js';
import type { JournalAppendResult, JournalReadResult, JournalRevision } from '../journal/types.js';
import { createReceipt, type AttemptReceipt } from '../registration/receipt.js';
import { blocking, CODE, RULE, type ValidationFinding } from '../registration/findings.js';

export type JournalRepairEligibility = 'healthy' | 'repairable' | 'unreadable';

export interface RepairStateExpectation {
  stateStatus: ReadStatus;
  stateRevision?: string;
  journalRevision: JournalRevision;
  journalEligibility: JournalRepairEligibility;
}

export interface RepairStateOptions extends Omit<JournalOptions, 'expectedRevision'> {
  fenceTimeoutMs?: number;
  /** State lock timeout for the exact observation-to-Receipt transaction (default 5000). */
  stateLockTimeoutMs?: number;
  /** State and Journal observation disclosed by the transaction sheet. */
  expected?: RepairStateExpectation;
}

export interface RepairStateResult {
  success: boolean;
  status: 'completed' | 'rejected-as-stale' | 'blocked' | 'persistence-indeterminate' | 'journal-persistence-failed';
  state?: BridgeState;
  error?: string;
  receipt: AttemptReceipt;
  /** Whether the returned Receipt itself reached the durable Journal. */
  receiptPersisted?: boolean;
  /** True only when degraded Journal bytes were reconstructed before later drift. */
  journalRepaired?: boolean;
}

function journalEligibility(journal: JournalReadResult): JournalRepairEligibility {
  if (journal.error || journal.revision === undefined || journal.revision === 'read-error') return 'unreadable';
  return journal.isDegraded ? 'repairable' : 'healthy';
}

export function createRepairStateExpectation(
  state: ReadResult,
  journal: JournalReadResult,
): RepairStateExpectation {
  return {
    stateStatus: state.status,
    stateRevision: state.state?.stateRevision,
    journalRevision: journal.revision ?? 'read-error',
    journalEligibility: journalEligibility(journal),
  };
}

function sameExpectation(left: RepairStateExpectation, right: RepairStateExpectation): boolean {
  return left.stateStatus === right.stateStatus
    && left.stateRevision === right.stateRevision
    && left.journalRevision === right.journalRevision
    && left.journalEligibility === right.journalEligibility;
}

function withJournalFailureFinding(
  receipt: AttemptReceipt,
  finding: ValidationFinding | undefined,
): AttemptReceipt {
  if (!finding) return receipt;
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
    findings: [...receipt.findings, finding],
    summary: receipt.summary,
    recoveryActions: receipt.recoveryActions,
    stateChanged: receipt.stateChanged,
    recoversReceiptId: receipt.recoversReceiptId,
    supersedesReceiptId: receipt.supersedesReceiptId,
  });
}

function journalPersistenceFailure(
  receipt: AttemptReceipt,
  appended: JournalAppendResult,
  journalRepaired?: boolean,
): RepairStateResult {
  return {
    success: false,
    status: 'journal-persistence-failed',
    error: appended.error ?? 'Attempt Receipt did not reach the durable Receipt Journal',
    receipt: withJournalFailureFinding(receipt, appended.finding),
    receiptPersisted: false,
    journalRepaired,
  };
}

async function rejectedAsStale(
  scope: Scope,
  expected: RepairStateExpectation,
  observed: RepairStateExpectation,
  opts: RepairStateOptions,
): Promise<RepairStateResult> {
  const finding = blocking({
    code: CODE.REJECTED_AS_STALE,
    phase: 'persistence',
    target: 'attempt',
    scope,
    pointer: '',
    rule: RULE.REJECTED_AS_STALE,
    outcome: `Repair State observation changed after disclosure: State ${expected.stateStatus}/${expected.stateRevision ?? '?'} → ${observed.stateStatus}/${observed.stateRevision ?? '?'}; Journal ${expected.journalRevision}/${expected.journalEligibility} → ${observed.journalRevision}/${observed.journalEligibility}. No State or Journal repair was performed`,
  });
  const receipt = createReceipt({
    kind: 'State Repair',
    operation: 'Repair State',
    scope,
    trigger: `repair state ${scope}`,
    expectedStateRevision: expected.stateRevision ?? '?',
    observedStateRevision: observed.stateRevision,
    summary: 'Rejected as Stale',
    stateChanged: false,
    findings: [finding],
  });
  // The stale Receipt is the only allowed write after the bound observation changed.
  const appended = await appendReceipt(scope, receipt, opts);
  if (!appended.success) {
    return journalPersistenceFailure(receipt, appended);
  }
  return { success: false, status: 'rejected-as-stale', receipt, receiptPersisted: true };
}

async function appendConditionally(
  scope: Scope,
  receipt: AttemptReceipt,
  expected: RepairStateExpectation,
  observed: RepairStateExpectation,
  opts: RepairStateOptions,
): Promise<RepairStateResult | undefined> {
  const appended = await appendReceipt(scope, receipt, {
    ...opts,
    expectedRevision: observed.journalRevision,
  });
  if (appended.success) return undefined;
  if (appended.isStale) {
    return rejectedAsStale(scope, expected, {
      ...observed,
      journalRevision: appended.observedRevision!,
    }, opts);
  }
  return journalPersistenceFailure(receipt, appended);
}

function indeterminateFinding(
  scope: Scope,
  statePath: string,
  state: ReadResult,
): ValidationFinding {
  return blocking({
    code: CODE.PERSISTENCE_INDETERMINATE,
    phase: 'persistence',
    target: 'attempt',
    scope,
    pointer: statePath,
    rule: state.status === 'incompatible' ? RULE.STATE_SCHEMA_UNKNOWN : RULE.STATE_CORRUPT,
    outcome: state.error ?? `Bridge State is ${state.status}`,
  });
}

async function journalChangedAfterPrune(
  scope: Scope,
  stateRevision: string,
  result: Extract<Awaited<ReturnType<typeof commitJournalRepair>>, { status: 'stale'; stage: 'after-prune' }>,
  recoversReceiptId: string | undefined,
  opts: RepairStateOptions,
): Promise<RepairStateResult> {
  const error = `Receipt Journal reconstruction completed, but exact success binding became indeterminate when Journal bytes changed before the success Receipt append (${result.postPruneRevision} → ${result.observedRevision}); the intervening bytes were preserved and Repair State must be rerun`;
  const finding = blocking({
    code: CODE.RECEIPT_PERSISTENCE_FAILED,
    phase: 'post-commit',
    target: 'attempt',
    scope,
    pointer: '',
    rule: RULE.RECEIPT_PERSISTENCE_FAILED,
    outcome: error,
  });
  const receipt = createReceipt({
    kind: 'State Repair',
    operation: 'Repair State',
    scope,
    trigger: `repair state ${scope}`,
    expectedStateRevision: stateRevision,
    observedStateRevision: stateRevision,
    durableOutcome: 'unchanged',
    runtimeOutcome: 'none',
    summary: 'Persistence Indeterminate',
    stateChanged: false,
    findings: [finding],
    recoversReceiptId,
  });
  const appended = await appendReceipt(scope, receipt, opts);
  if (!appended.success) return journalPersistenceFailure(receipt, appended, true);
  return {
    success: false,
    status: 'persistence-indeterminate',
    error,
    receipt,
    receiptPersisted: true,
    journalRepaired: true,
  };
}

export async function repairBridgeState(
  scope: Scope,
  opts: RepairStateOptions = {},
): Promise<RepairStateResult> {
  const fence = await acquireAttemptFence(scope, opts);
  if (!fence.ok) {
    const receipt = createReceipt({
      kind: 'State Repair',
      operation: 'Repair State',
      scope,
      trigger: `repair state ${scope}`,
      expectedStateRevision: opts.expected?.stateRevision ?? '?',
      summary: 'Blocked',
      findings: [fence.finding!],
    });
    const appended = await appendReceipt(scope, receipt, opts);
    if (!appended.success) return journalPersistenceFailure(receipt, appended);
    return {
      success: false,
      status: 'blocked',
      error: fence.finding?.outcome,
      receipt,
      receiptPersisted: true,
    };
  }

  const handle = fence.handle!;
  const statePath = getStatePath(scope, opts);
  let observed: RepairStateExpectation | undefined;
  let recoveryRootReceiptId: string | undefined;

  try {
    // Lock order is fixed: Attempt Fence (already held) → State lock → Journal lock(s) below.
    return await withBridgeStateLock(scope, opts, async (stateRead) => {
      try {
        const journal = await readReceiptJournal(scope, opts);
        observed = createRepairStateExpectation(stateRead, journal);
        const expected = opts.expected ?? observed;
        if (!sameExpectation(expected, observed)) {
          return await rejectedAsStale(scope, expected, observed, opts);
        }

        const indetChain = journal.activeChains.find(
          (chain) => chain.condition === 'persistence-indeterminate' || chain.condition === 'journal-degradation',
        );
        recoveryRootReceiptId = indetChain?.rootReceiptId;

        if (stateRead.status !== 'ok' && stateRead.status !== 'missing') {
          const finding = indeterminateFinding(scope, statePath, stateRead);
          const receipt = createReceipt({
            kind: 'State Repair',
            operation: 'Repair State',
            scope,
            trigger: `repair state ${scope}`,
            expectedStateRevision: expected.stateRevision ?? '?',
            durableOutcome: 'indeterminate',
            summary: 'Persistence Indeterminate',
            findings: [finding],
            recoversReceiptId: recoveryRootReceiptId,
          });
          const stale = await appendConditionally(scope, receipt, expected, observed, opts);
          return stale ?? {
            success: false,
            status: 'persistence-indeterminate',
            error: stateRead.error,
            receipt,
            receiptPersisted: true,
          };
        }

        const stateRevision = stateRead.state!.stateRevision;
        const journalFindings = journal.isDegraded ? journal.findings : [];
        const receipt = createReceipt({
          kind: 'State Repair',
          operation: 'Repair State',
          scope,
          trigger: `repair state ${scope}`,
          expectedStateRevision: stateRevision,
          observedStateRevision: stateRevision,
          durableOutcome: 'unchanged',
          runtimeOutcome: 'none',
          summary: journalFindings.length > 0 ? 'Completed with diagnostics' : 'Completed',
          findings: journalFindings,
          recoversReceiptId: indetChain?.rootReceiptId,
        });
        const committed = await commitJournalRepair(
          scope,
          receipt,
          expected.journalRevision,
          100,
          opts,
        );
        if (committed.status === 'stale') {
          if (committed.stage === 'after-prune') {
            return await journalChangedAfterPrune(
              scope,
              stateRevision,
              committed,
              recoveryRootReceiptId,
              opts,
            );
          }
          return await rejectedAsStale(scope, expected, {
            ...observed,
            journalRevision: committed.observedRevision,
          }, opts);
        }

        return {
          success: true,
          status: 'completed',
          state: stateRead.status === 'ok' ? stateRead.state : undefined,
          receipt,
          receiptPersisted: true,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const receipt = createReceipt({
          kind: 'State Repair',
          operation: 'Repair State',
          scope,
          trigger: `repair state ${scope}`,
          expectedStateRevision: opts.expected?.stateRevision ?? observed?.stateRevision ?? '?',
          durableOutcome: 'indeterminate',
          summary: 'Persistence Indeterminate',
          recoversReceiptId: recoveryRootReceiptId,
        });
        const appended = await appendReceipt(scope, receipt, opts);
        if (!appended.success) return journalPersistenceFailure(receipt, appended);
        return {
          success: false,
          status: 'persistence-indeterminate',
          error: message,
          receipt,
          receiptPersisted: true,
        };
      }
    });
  } catch (error) {
    // State-lock acquisition or the under-lock read failed before an exact observation was made.
    const message = error instanceof Error ? error.message : String(error);
    const receipt = createReceipt({
      kind: 'State Repair',
      operation: 'Repair State',
      scope,
      trigger: `repair state ${scope}`,
      expectedStateRevision: opts.expected?.stateRevision ?? '?',
      durableOutcome: 'indeterminate',
      summary: 'Persistence Indeterminate',
    });
    const appended = await appendReceipt(scope, receipt, opts);
    if (!appended.success) return journalPersistenceFailure(receipt, appended);
    return {
      success: false,
      status: 'persistence-indeterminate',
      error: message,
      receipt,
      receiptPersisted: true,
    };
  } finally {
    handle.release();
  }
}
