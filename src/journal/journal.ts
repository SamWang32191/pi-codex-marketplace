/**
 * Receipt Journal implementation — append-only durable history of Attempt Receipts.
 * See CONTEXT.md: Receipt Journal, Attempt Receipt, Receipt Resolution.
 *
 * File location:
 * - Global:  {getAgentDir()}/codex-marketplace/receipts.jsonl
 * - Project: {cwd}/.pi/codex-marketplace/receipts.jsonl
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { dirname } from 'node:path';

import { atomicWriteFile } from '../bridge-state/atomic.js';
import { getReceiptsJournalPath } from '../bridge-state/paths.js';
import type { Scope } from '../bridge-state/types.js';
import { CODE, notice, RULE, type ValidationFinding } from '../registration/findings.js';
import { isAttemptReceipt, type AttemptReceipt } from '../registration/receipt.js';
import { findActiveRecoveryChains } from './active-chains.js';
import type {
  JournalAppendResult,
  JournalPruneResult,
  JournalReadResult,
} from './types.js';

export interface JournalOptions {
  cwd?: string;
  agentDir?: string;
}

/** Append an Attempt Receipt to the scope's Receipt Journal with fsync durability. */
export async function appendReceipt(
  scope: Scope,
  receipt: AttemptReceipt,
  opts: JournalOptions = {},
): Promise<JournalAppendResult> {
  const journalPath = getReceiptsJournalPath(scope, opts);
  try {
    mkdirSync(dirname(journalPath), { recursive: true });
    const line = JSON.stringify(receipt) + '\n';
    appendFileSync(journalPath, line, 'utf-8');

    // fsync file for durability
    try {
      const fd = openSync(journalPath, 'r');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch {}

    return { success: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const finding: ValidationFinding = notice({
      code: CODE.RECEIPT_PERSISTENCE_FAILED,
      phase: 'post-commit',
      target: 'attempt',
      scope,
      pointer: journalPath,
      rule: RULE.RECEIPT_PERSISTENCE_FAILED,
      outcome: `Failed to persist Attempt Receipt to journal: ${msg}`,
    });
    return { success: false, error: msg, finding };
  }
}

/** Read the scope's Receipt Journal, parsing line-by-line with tolerance for single-line corruptions. */
export async function readReceiptJournal(
  scope: Scope,
  opts: JournalOptions = {},
): Promise<JournalReadResult> {
  const journalPath = getReceiptsJournalPath(scope, opts);

  if (!existsSync(journalPath)) {
    return {
      receipts: [],
      activeChains: [],
      allChains: [],
      corruptedLineCount: 0,
      isDegraded: false,
      findings: [],
    };
  }

  let content: string;
  try {
    content = readFileSync(journalPath, 'utf-8');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      receipts: [],
      activeChains: [],
      allChains: [],
      corruptedLineCount: 1,
      isDegraded: true,
      findings: [
        notice({
          code: CODE.RECEIPT_CORRUPT,
          phase: 'post-commit',
          target: 'attempt',
          scope,
          pointer: journalPath,
          rule: RULE.RECEIPT_CORRUPT,
          outcome: `Failed to read receipts journal: ${msg}`,
        }),
      ],
      error: msg,
    };
  }

  const lines = content.split('\n');
  const receipts: AttemptReceipt[] = [];
  const findings: ValidationFinding[] = [];
  let corruptedLineCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length === 0) continue;

    try {
      const parsed = JSON.parse(line);
      if (isAttemptReceipt(parsed)) {
        receipts.push(parsed);
      } else {
        corruptedLineCount++;
        findings.push(
          notice({
            code: CODE.RECEIPT_CORRUPT,
            phase: 'post-commit',
            target: 'attempt',
            scope,
            pointer: `${journalPath}:${i + 1}`,
            rule: RULE.RECEIPT_CORRUPT,
            outcome: `Corrupted receipt line ${i + 1}: missing required receipt fields`,
          }),
        );
      }
    } catch (e) {
      corruptedLineCount++;
      findings.push(
        notice({
          code: CODE.RECEIPT_CORRUPT,
          phase: 'post-commit',
          target: 'attempt',
          scope,
          pointer: `${journalPath}:${i + 1}`,
          rule: RULE.RECEIPT_CORRUPT,
          outcome: `Corrupted receipt line ${i + 1}: invalid JSON`,
        }),
      );
    }
  }

  const { activeChains, allChains } = findActiveRecoveryChains(receipts);
  const isDegraded = corruptedLineCount > 0;

  return {
    receipts,
    activeChains,
    allChains,
    corruptedLineCount,
    isDegraded,
    findings,
  };
}

/** Prune resolved receipts outside active chains while preserving ALL active recovery chains. */
export async function pruneReceiptJournal(
  scope: Scope,
  keepCount = 100,
  opts: JournalOptions = {},
): Promise<JournalPruneResult> {
  const current = await readReceiptJournal(scope, opts);
  const activeReceiptIds = new Set<string>();

  for (const chain of current.activeChains) {
    for (const r of chain.receipts) {
      activeReceiptIds.add(r.id);
    }
  }

  const outsideActive: AttemptReceipt[] = [];
  for (const r of current.receipts) {
    if (!activeReceiptIds.has(r.id)) {
      outsideActive.push(r);
    }
  }

  // Keep latest N outside active chains
  const retainOutside = outsideActive.slice(-keepCount);
  const retainOutsideIds = new Set(retainOutside.map((r) => r.id));

  // Build final retained receipts preserving chronological order
  const retained = current.receipts.filter(
    (r) => activeReceiptIds.has(r.id) || retainOutsideIds.has(r.id),
  );

  const prunedCount = current.receipts.length - retained.length;
  const journalPath = getReceiptsJournalPath(scope, opts);

  const content = retained.map((r) => JSON.stringify(r)).join('\n') + (retained.length > 0 ? '\n' : '');
  mkdirSync(dirname(journalPath), { recursive: true });
  atomicWriteFile(journalPath, content);

  return { prunedCount, retainedCount: retained.length };
}

/** Reconstruct or initialize the Receipt Journal from state. */
export async function reconstructJournalFromState(
  scope: Scope,
  opts: JournalOptions = {},
): Promise<JournalReadResult> {
  return readReceiptJournal(scope, opts);
}
