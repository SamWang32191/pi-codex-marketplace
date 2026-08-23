/**
 * Receipt Journal implementation — append-only durable history of Attempt Receipts.
 * See CONTEXT.md: Receipt Journal, Attempt Receipt, Receipt Resolution.
 *
 * File location:
 * - Global:  {getAgentDir()}/codex-marketplace/receipts.jsonl
 * - Project: {cwd}/.pi/codex-marketplace/receipts.jsonl
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { dirname } from 'node:path';

import { atomicWriteFile, withFileLock } from '../bridge-state/atomic.js';
import { getReceiptsJournalPath } from '../bridge-state/paths.js';
import type { Scope } from '../bridge-state/types.js';
import { CODE, notice, RULE, type ValidationFinding } from '../registration/findings.js';
import { isAttemptReceipt, type AttemptReceipt } from '../registration/receipt.js';
import { findActiveRecoveryChains } from './active-chains.js';
import type {
  JournalAppendResult,
  JournalPruneResult,
  JournalReadResult,
  JournalRepairCommitResult,
  JournalRevision,
  ObservedJournalReadResult,
} from './types.js';

export interface JournalTestHooks {
  /** @internal Runs immediately before reading Receipt Journal bytes; throwing injects read failure. */
  beforeJournalRead?: () => void;
  /** @internal Deterministic seam for exercising append-vs-rewrite concurrency. */
  beforePruneRewrite?: () => Promise<void> | void;
  /** @internal Runs after Repair rewrites degraded lines but before its bound Receipt append. */
  afterPruneRewrite?: () => Promise<void> | void;
  /** @internal Runs immediately before any Receipt fsync; throwing injects durability failure. */
  beforeReceiptFsync?: () => void;
  /** @internal Runs before Repair's final exact-revision check and Receipt append. */
  beforeRepairReceiptAppend?: () => Promise<void> | void;
  /** @internal Runs after Repair appends its Receipt but before read-back verification. */
  afterRepairReceiptAppend?: () => Promise<void> | void;
}

export interface JournalOptions {
  cwd?: string;
  agentDir?: string;
  journalLockTimeoutMs?: number;
  /** Refuse an append unless these exact raw Journal bytes are still current under lock. */
  expectedRevision?: JournalRevision;
  /** @internal Test-only coordination hooks; production callers should omit this. */
  testHooks?: JournalTestHooks;
}

function withJournalLock<T>(
  journalPath: string,
  opts: JournalOptions,
  action: () => Promise<T> | T,
): Promise<T> {
  return withFileLock(`${journalPath}.lock`, action, opts.journalLockTimeoutMs ?? 5000);
}

function revisionForBytes(bytes: Uint8Array): JournalRevision {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function readJournalRevisionUnlocked(journalPath: string): JournalRevision {
  if (!existsSync(journalPath)) return 'missing';
  try {
    return revisionForBytes(readFileSync(journalPath));
  } catch {
    return 'read-error';
  }
}

function appendReceiptUnlocked(
  journalPath: string,
  receipt: AttemptReceipt,
  opts: JournalOptions,
): void {
  mkdirSync(dirname(journalPath), { recursive: true });
  const fd = openSync(journalPath, 'a');
  try {
    writeFileSync(fd, `${JSON.stringify(receipt)}\n`, 'utf-8');
    opts.testHooks?.beforeReceiptFsync?.();
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Append an Attempt Receipt to the scope's Receipt Journal with fsync durability. */
export async function appendReceipt(
  scope: Scope,
  receipt: AttemptReceipt,
  opts: JournalOptions = {},
): Promise<JournalAppendResult> {
  const journalPath = getReceiptsJournalPath(scope, opts);
  try {
    return await withJournalLock(journalPath, opts, () => {
      if (opts.expectedRevision !== undefined) {
        const observedRevision = readJournalRevisionUnlocked(journalPath);
        if (observedRevision !== opts.expectedRevision) {
          return {
            success: false,
            isStale: true,
            expectedRevision: opts.expectedRevision,
            observedRevision,
          };
        }
      }

      appendReceiptUnlocked(journalPath, receipt, opts);

      return { success: true };
    });
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

/** Lock-free reader for callers that already hold the per-journal rewrite lock. */
function readReceiptJournalUnlocked(
  scope: Scope,
  opts: JournalOptions = {},
  journalPath = getReceiptsJournalPath(scope, opts),
): ObservedJournalReadResult {
  if (!existsSync(journalPath)) {
    return {
      revision: 'missing',
      receipts: [],
      activeChains: [],
      allChains: [],
      corruptedLineCount: 0,
      isDegraded: false,
      findings: [],
    };
  }

  let bytes: Buffer;
  try {
    opts.testHooks?.beforeJournalRead?.();
    bytes = readFileSync(journalPath);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      revision: 'read-error',
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

  const revision = revisionForBytes(bytes);
  const content = bytes.toString('utf-8');

  const lines = content.split('\n');
  const receipts: AttemptReceipt[] = [];
  const findings: ValidationFinding[] = [];
  let corruptedLineCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length === 0) continue;

    try {
      const parsed = JSON.parse(line);
      const receipt = isAttemptReceipt(parsed) ? parsed : undefined;
      if (receipt?.scope === scope) {
        receipts.push(receipt);
      } else {
        const reason = receipt
          ? `scope '${receipt.scope}' does not match requested scope '${scope}'`
          : 'missing or invalid required receipt fields';
        corruptedLineCount++;
        findings.push(
          notice({
            code: CODE.RECEIPT_CORRUPT,
            phase: 'post-commit',
            target: 'attempt',
            scope,
            pointer: `${journalPath}:${i + 1}`,
            rule: RULE.RECEIPT_CORRUPT,
            outcome: `Corrupted receipt line ${i + 1}: ${reason}`,
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
    revision,
    receipts,
    activeChains,
    allChains,
    corruptedLineCount,
    isDegraded,
    findings,
  };
}

function retainedJournalReceipts(
  current: JournalReadResult,
  keepCount: number,
): { retained: AttemptReceipt[]; prunedCount: number } {
  const activeReceiptIds = new Set<string>();
  for (const chain of current.activeChains) {
    for (const receipt of chain.receipts) activeReceiptIds.add(receipt.id);
  }

  const outsideActive = current.receipts.filter((receipt) => !activeReceiptIds.has(receipt.id));
  const retainOutsideIds = new Set(outsideActive.slice(-keepCount).map((receipt) => receipt.id));
  const retained = current.receipts.filter(
    (receipt) => activeReceiptIds.has(receipt.id) || retainOutsideIds.has(receipt.id),
  );
  return { retained, prunedCount: current.receipts.length - retained.length };
}

function serializedJournal(receipts: AttemptReceipt[]): string {
  return receipts.map((receipt) => JSON.stringify(receipt)).join('\n') + (receipts.length > 0 ? '\n' : '');
}

/** Read the scope's Receipt Journal, parsing line-by-line with tolerance for single-line corruptions. */
export async function readReceiptJournal(
  scope: Scope,
  opts: JournalOptions = {},
): Promise<ObservedJournalReadResult> {
  return readReceiptJournalUnlocked(scope, opts);
}

/** Prune resolved receipts outside active chains while preserving ALL active recovery chains. */
export async function pruneReceiptJournal(
  scope: Scope,
  keepCount = 100,
  opts: JournalOptions = {},
): Promise<JournalPruneResult> {
  const journalPath = getReceiptsJournalPath(scope, opts);
  return withJournalLock(journalPath, opts, async () => {
    // Re-read only after acquiring the lock so every completed append participates
    // in this rewrite and cannot be overwritten by a stale snapshot.
    const current = readReceiptJournalUnlocked(scope, opts, journalPath);
    if (current.revision === 'read-error' || current.error) {
      throw new Error(`Receipt Journal cannot be read safely: ${current.error ?? 'read failed'}`);
    }
    const { retained, prunedCount } = retainedJournalReceipts(current, keepCount);
    const content = serializedJournal(retained);
    mkdirSync(dirname(journalPath), { recursive: true });
    await opts.testHooks?.beforePruneRewrite?.();
    const write = atomicWriteFile(journalPath, content);
    if (!write.success || !write.verified) {
      throw new Error(`Failed to atomically replace Receipt Journal: ${write.error ?? 'verification failed'}`);
    }

    return { prunedCount, retainedCount: retained.length };
  });
}

/**
 * Compare one exact Journal observation, optionally reconstruct degraded lines, and append the
 * bound Repair Receipt while holding one journal lock. A normal concurrent appender waits until
 * the Repair Receipt is durable, so neither side can overwrite the other.
 */
export async function commitJournalRepair(
  scope: Scope,
  receipt: AttemptReceipt,
  expectedRevision: JournalRevision,
  keepCount = 100,
  opts: JournalOptions = {},
): Promise<JournalRepairCommitResult> {
  const journalPath = getReceiptsJournalPath(scope, opts);
  return withJournalLock(journalPath, opts, async () => {
    const current = readReceiptJournalUnlocked(scope, opts, journalPath);
    if (current.revision !== expectedRevision) {
      return {
        status: 'stale',
        stage: 'before-prune',
        expectedRevision,
        observedRevision: current.revision,
        prunedCount: 0,
        retainedCount: current.receipts.length,
      };
    }
    if (current.error) throw new Error(`Receipt Journal cannot be read safely: ${current.error}`);

    let postPruneRevision = current.revision;
    let prunedCount = 0;
    let retainedCount = current.receipts.length;
    if (current.isDegraded) {
      const pruned = retainedJournalReceipts(current, keepCount);
      const content = serializedJournal(pruned.retained);
      mkdirSync(dirname(journalPath), { recursive: true });
      await opts.testHooks?.beforePruneRewrite?.();
      const observedBeforeRewrite = readJournalRevisionUnlocked(journalPath);
      if (observedBeforeRewrite !== current.revision) {
        return {
          status: 'stale',
          stage: 'before-prune',
          expectedRevision,
          observedRevision: observedBeforeRewrite,
          prunedCount: 0,
          retainedCount: current.receipts.length,
        };
      }
      const write = atomicWriteFile(journalPath, content);
      if (!write.success || !write.verified) {
        throw new Error(`Failed to atomically replace Receipt Journal: ${write.error ?? 'verification failed'}`);
      }
      postPruneRevision = revisionForBytes(Buffer.from(content, 'utf-8'));
      prunedCount = pruned.prunedCount;
      retainedCount = pruned.retained.length;
      await opts.testHooks?.afterPruneRewrite?.();
    }

    await opts.testHooks?.beforeRepairReceiptAppend?.();
    const observedBeforeAppend = readJournalRevisionUnlocked(journalPath);
    if (observedBeforeAppend !== postPruneRevision) {
      if (!current.isDegraded) {
        return {
          status: 'stale',
          stage: 'before-append',
          expectedRevision,
          observedRevision: observedBeforeAppend,
          postPruneRevision,
          prunedCount: 0,
          retainedCount,
        };
      }
      return {
        status: 'stale',
        stage: 'after-prune',
        expectedRevision,
        observedRevision: observedBeforeAppend,
        postPruneRevision,
        prunedCount,
        retainedCount,
      };
    }

    appendReceiptUnlocked(journalPath, receipt, opts);
    await opts.testHooks?.afterRepairReceiptAppend?.();
    const verified = readReceiptJournalUnlocked(scope, opts, journalPath);
    if (verified.error || verified.isDegraded || !verified.receipts.some((stored) => stored.id === receipt.id)) {
      throw new Error(`Bound Repair Receipt ${receipt.id} could not be verified in the readable Receipt Journal`);
    }
    return {
      status: 'committed',
      expectedRevision,
      postPruneRevision,
      revision: verified.revision,
      prunedCount,
      retainedCount,
    };
  });
}

/** Reconstruct or initialize the Receipt Journal from state. */
export async function reconstructJournalFromState(
  scope: Scope,
  opts: JournalOptions = {},
): Promise<JournalReadResult> {
  const journalPath = getReceiptsJournalPath(scope, opts);
  return withJournalLock(journalPath, opts, () => readReceiptJournalUnlocked(scope, opts, journalPath));
}
