/**
 * Repair State — Recovery Action to verify Bridge State and reconstruct a degraded Receipt Journal.
 * See CONTEXT.md: Persistence Indeterminate, Receipt Journal, Recovery Action.
 *
 * Checks whether the state file on disk is readable and schema-valid, atomically
 * retains validated Receipt lines, and resolves an eligible recovery chain.
 */

import { existsSync, readFileSync } from 'node:fs';

import { getStatePath } from './paths.js';
import { parseJson, validateSchema } from './schema.js';
import type { BridgeState, Scope } from './types.js';
import { acquireAttemptFence } from '../registration/fence.js';
import { appendReceipt, pruneReceiptJournal, readReceiptJournal } from '../journal/journal.js';
import { createReceipt, type AttemptReceipt } from '../registration/receipt.js';
import { blocking, CODE, RULE, type ValidationFinding } from '../registration/findings.js';

export interface RepairStateResult {
  success: boolean;
  state?: BridgeState;
  error?: string;
  receipt: AttemptReceipt;
}

async function repairCorruptedJournalLines(
  scope: Scope,
  journal: Awaited<ReturnType<typeof readReceiptJournal>>,
  opts: { cwd?: string; agentDir?: string; fenceTimeoutMs?: number },
): Promise<ValidationFinding[]> {
  if (!journal.isDegraded) return [];
  if (journal.error) {
    throw new Error(`Receipt Journal cannot be read safely: ${journal.error}`);
  }

  // The journal is non-authoritative. Rewrite only receipts that passed the complete
  // Receipt validator; pruning preserves every parsed active recovery chain.
  await pruneReceiptJournal(scope, 100, opts);
  const verified = await readReceiptJournal(scope, opts);
  if (verified.isDegraded) {
    throw new Error('Receipt Journal remained degraded after atomic reconstruction');
  }
  return journal.findings;
}

export async function repairBridgeState(
  scope: Scope,
  opts: { cwd?: string; agentDir?: string; fenceTimeoutMs?: number } = {},
): Promise<RepairStateResult> {
  const fence = await acquireAttemptFence(scope, opts);
  if (!fence.ok) {
    const receipt = createReceipt({
      kind: 'State Repair',
      operation: 'Repair State',
      scope,
      trigger: `repair state ${scope}`,
      expectedStateRevision: '?',
      summary: 'Blocked',
      findings: [fence.finding!],
    });
    await appendReceipt(scope, receipt, opts);
    return { success: false, error: fence.finding?.outcome, receipt };
  }

  const handle = fence.handle!;
  const statePath = getStatePath(scope, opts);

  try {
    const journal = await readReceiptJournal(scope, opts);
    const indetChain = journal.activeChains.find(
      (c) => c.condition === 'persistence-indeterminate' || c.condition === 'journal-degradation',
    );

    if (!existsSync(statePath)) {
      // Empty / missing state is valid (reconstructed as revision 0)
      const journalRepairFindings = await repairCorruptedJournalLines(scope, journal, opts);
      const receipt = createReceipt({
        kind: 'State Repair',
        operation: 'Repair State',
        scope,
        trigger: `repair state ${scope}`,
        expectedStateRevision: '0',
        observedStateRevision: '0',
        durableOutcome: 'unchanged',
        runtimeOutcome: 'none',
        summary: journalRepairFindings.length > 0 ? 'Completed with diagnostics' : 'Completed',
        findings: journalRepairFindings,
        recoversReceiptId: indetChain?.rootReceiptId,
      });
      await appendReceipt(scope, receipt, opts);
      handle.release();
      return { success: true, receipt };
    }

    let content: string;
    try {
      content = readFileSync(statePath, 'utf-8');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const finding: ValidationFinding = blocking({
        code: CODE.PERSISTENCE_INDETERMINATE,
        phase: 'persistence',
        target: 'attempt',
        scope,
        pointer: statePath,
        rule: RULE.STATE_CORRUPT,
        outcome: `Failed to read ${statePath}: ${msg}`,
      });
      const receipt = createReceipt({
        kind: 'State Repair',
        operation: 'Repair State',
        scope,
        trigger: `repair state ${scope}`,
        expectedStateRevision: '?',
        durableOutcome: 'indeterminate',
        summary: 'Persistence Indeterminate',
        findings: [finding],
      });
      await appendReceipt(scope, receipt, opts);
      handle.release();
      return { success: false, error: msg, receipt };
    }

    const parsed = parseJson(content);
    if (!parsed.ok) {
      const finding: ValidationFinding = blocking({
        code: CODE.PERSISTENCE_INDETERMINATE,
        phase: 'persistence',
        target: 'attempt',
        scope,
        pointer: statePath,
        rule: RULE.STATE_CORRUPT,
        outcome: `Corrupted JSON: ${parsed.error}`,
      });
      const receipt = createReceipt({
        kind: 'State Repair',
        operation: 'Repair State',
        scope,
        trigger: `repair state ${scope}`,
        expectedStateRevision: '?',
        durableOutcome: 'indeterminate',
        summary: 'Persistence Indeterminate',
        findings: [finding],
      });
      await appendReceipt(scope, receipt, opts);
      handle.release();
      return { success: false, error: parsed.error, receipt };
    }

    const validation = validateSchema(parsed.value);
    if (!validation.ok) {
      const finding: ValidationFinding = blocking({
        code: CODE.PERSISTENCE_INDETERMINATE,
        phase: 'persistence',
        target: 'attempt',
        scope,
        pointer: statePath,
        rule: validation.code === 'INCOMPATIBLE_SCHEMA_VERSION' ? RULE.STATE_SCHEMA_UNKNOWN : RULE.STATE_CORRUPT,
        outcome: `Invalid schema: ${validation.error}`,
      });
      const receipt = createReceipt({
        kind: 'State Repair',
        operation: 'Repair State',
        scope,
        trigger: `repair state ${scope}`,
        expectedStateRevision: '?',
        durableOutcome: 'indeterminate',
        summary: 'Persistence Indeterminate',
        findings: [finding],
      });
      await appendReceipt(scope, receipt, opts);
      handle.release();
      return { success: false, error: validation.error, receipt };
    }

    const validState = parsed.value as BridgeState;
    const journalRepairFindings = await repairCorruptedJournalLines(scope, journal, opts);
    const receipt = createReceipt({
      kind: 'State Repair',
      operation: 'Repair State',
      scope,
      trigger: `repair state ${scope}`,
      expectedStateRevision: validState.stateRevision,
      observedStateRevision: validState.stateRevision,
      durableOutcome: 'unchanged',
      runtimeOutcome: 'none',
      summary: journalRepairFindings.length > 0 ? 'Completed with diagnostics' : 'Completed',
      findings: journalRepairFindings,
      recoversReceiptId: indetChain?.rootReceiptId,
    });
    await appendReceipt(scope, receipt, opts);
    handle.release();
    return { success: true, state: validState, receipt };
  } catch (e) {
    handle.release();
    const msg = e instanceof Error ? e.message : String(e);
    const receipt = createReceipt({
      kind: 'State Repair',
      operation: 'Repair State',
      scope,
      trigger: `repair state ${scope}`,
      expectedStateRevision: '?',
      durableOutcome: 'indeterminate',
      summary: 'Persistence Indeterminate',
    });
    await appendReceipt(scope, receipt, opts);
    return { success: false, error: msg, receipt };
  }
}
