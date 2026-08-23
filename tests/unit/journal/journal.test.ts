import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  appendReceipt,
  readReceiptJournal,
  pruneReceiptJournal,
  reconstructJournalFromState,
} from '../../../src/journal/journal.js';
import { createReceipt } from '../../../src/registration/receipt.js';
import { acquireLockSync, releaseLock } from '../../../src/bridge-state/atomic.js';
import { getReceiptsJournalPath } from '../../../src/bridge-state/paths.js';

describe('Receipt Journal — Storage & Bounded Retention', () => {
  const RECEIPT_1 = 'rcpt_11111111-1111-4111-8111-111111111111';
  const RECEIPT_2 = 'rcpt_22222222-2222-4222-8222-222222222222';
  const PENDING_RECEIPT = 'rcpt_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  let tmpRoot: string;
  let agentDir: string;
  let projectDir: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'rcpt-journal-'));
    agentDir = join(tmpRoot, 'agent');
    projectDir = join(tmpRoot, 'project');
  });

  afterEach(() => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  });

  it('appends and reads back immutable Attempt Receipts via receipts.jsonl', async () => {
    const rcpt1 = createReceipt({
      id: RECEIPT_1,
      operation: 'Marketplace Registration',
      scope: 'global',
      trigger: 'register local /path',
      expectedStateRevision: '0',
      targetStateRevision: '1',
      observedStateRevision: '1',
      durableOutcome: 'committed',
      runtimeOutcome: 'applied',
      summary: 'Completed',
    });

    const res = await appendReceipt('global', rcpt1, { agentDir, cwd: projectDir });
    expect(res.success).toBe(true);

    const journal = await readReceiptJournal('global', { agentDir, cwd: projectDir });
    expect(journal.receipts).toHaveLength(1);
    expect(journal.receipts[0].id).toBe(RECEIPT_1);
    expect(journal.receipts[0].summary).toBe('Completed');
    expect(journal.corruptedLineCount).toBe(0);
    expect(journal.isDegraded).toBe(false);
  });

  it('skips corrupted JSON lines and records RECEIPT_CORRUPT operational notices', async () => {
    const rcpt1 = createReceipt({
      id: RECEIPT_1,
      operation: 'Marketplace Registration',
      scope: 'global',
      trigger: 'register',
      expectedStateRevision: '0',
      durableOutcome: 'committed',
      summary: 'Completed',
    });
    await appendReceipt('global', rcpt1, { agentDir, cwd: projectDir });

    const journalPath = getReceiptsJournalPath('global', { agentDir, cwd: projectDir });
    mkdirSync(dirname(journalPath), { recursive: true });
    // Manually inject corrupted line
    writeFileSync(journalPath, readFileSync(journalPath, 'utf-8') + '{ invalid json\n', 'utf-8');

    const rcpt2 = createReceipt({
      id: RECEIPT_2,
      operation: 'Plugin Installation',
      scope: 'global',
      trigger: 'install',
      expectedStateRevision: '1',
      durableOutcome: 'committed',
      summary: 'Completed',
    });
    await appendReceipt('global', rcpt2, { agentDir, cwd: projectDir });

    const journal = await readReceiptJournal('global', { agentDir, cwd: projectDir });
    expect(journal.receipts).toHaveLength(2);
    expect(journal.receipts.map((r) => r.id)).toEqual([RECEIPT_1, RECEIPT_2]);
    expect(journal.corruptedLineCount).toBe(1);
    expect(journal.findings.some((f) => f.code === 'RECEIPT_CORRUPT')).toBe(true);
  });

  it('treats structurally incomplete Receipt JSON as a degraded line', async () => {
    const journalPath = getReceiptsJournalPath('global', { agentDir, cwd: projectDir });
    mkdirSync(dirname(journalPath), { recursive: true });
    writeFileSync(
      journalPath,
      `${JSON.stringify({ id: 'rcpt_33333333-3333-4333-8333-333333333333', summary: 'Blocked' })}\n`,
      'utf-8',
    );

    const journal = await readReceiptJournal('global', { agentDir, cwd: projectDir });

    expect(journal.receipts).toEqual([]);
    expect(journal.corruptedLineCount).toBe(1);
    expect(journal.isDegraded).toBe(true);
    expect(journal.findings).toEqual([
      expect.objectContaining({ code: 'RECEIPT_CORRUPT' }),
    ]);
  });

  it.each([
    ['an empty receipt id', { id: '' }],
    ['a non-canonical receipt id', { id: 'rcpt_44444444-4444-4444-8444-44444444444A' }],
    ['an empty recoversReceiptId', { recoversReceiptId: '' }],
    ['a non-canonical recoversReceiptId', { recoversReceiptId: 'rcpt_pending' }],
    ['an empty supersedesReceiptId', { supersedesReceiptId: '' }],
    ['a non-canonical supersedesReceiptId', { supersedesReceiptId: 'rcpt_pending' }],
  ])('rejects JSONL containing %s as JOURNAL-02', async (_case, override) => {
    const journalPath = getReceiptsJournalPath('global', { agentDir, cwd: projectDir });
    mkdirSync(dirname(journalPath), { recursive: true });
    const valid = createReceipt({
      id: RECEIPT_1,
      operation: 'Inspect',
      scope: 'global',
      trigger: 'inspect',
      expectedStateRevision: '0',
      summary: 'Completed',
    });
    writeFileSync(journalPath, `${JSON.stringify({ ...valid, ...override })}\n`, 'utf-8');

    const journal = await readReceiptJournal('global', { agentDir, cwd: projectDir });

    expect(journal.receipts).toEqual([]);
    expect(journal.corruptedLineCount).toBe(1);
    expect(journal.findings).toEqual([
      expect.objectContaining({ code: 'RECEIPT_CORRUPT', rule: 'JOURNAL-02' }),
    ]);
  });

  it('rejects a valid Project receipt found in the Global JSONL as JOURNAL-02', async () => {
    const journalPath = getReceiptsJournalPath('global', { agentDir, cwd: projectDir });
    mkdirSync(dirname(journalPath), { recursive: true });
    const projectReceipt = createReceipt({
      id: RECEIPT_1,
      operation: 'Inspect',
      scope: 'project',
      trigger: 'inspect',
      expectedStateRevision: '0',
      summary: 'Completed',
    });
    writeFileSync(journalPath, `${JSON.stringify(projectReceipt)}\n`, 'utf-8');

    const journal = await readReceiptJournal('global', { agentDir, cwd: projectDir });

    expect(journal.receipts).toEqual([]);
    expect(journal.corruptedLineCount).toBe(1);
    expect(journal.findings).toEqual([
      expect.objectContaining({ code: 'RECEIPT_CORRUPT', rule: 'JOURNAL-02' }),
    ]);
  });

  it('prunes resolved receipts outside active chains while keeping ALL active recovery chains intact', async () => {
    // 1. Create an active recovery root (Pending Application)
    const pendingRcpt = createReceipt({
      id: PENDING_RECEIPT,
      operation: 'Marketplace Registration',
      scope: 'global',
      trigger: 'register',
      expectedStateRevision: '0',
      targetStateRevision: '1',
      observedStateRevision: '1',
      durableOutcome: 'committed',
      runtimeOutcome: 'pending-application',
      summary: 'Pending Application',
    });
    await appendReceipt('global', pendingRcpt, { agentDir, cwd: projectDir });

    // 2. Create 15 resolved receipts
    for (let i = 1; i <= 15; i++) {
      const rcpt = createReceipt({
        id: `rcpt_00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        operation: 'Test Operation',
        scope: 'global',
        trigger: 'test',
        expectedStateRevision: '1',
        durableOutcome: 'unchanged',
        runtimeOutcome: 'none',
        summary: 'Completed',
      });
      await appendReceipt('global', rcpt, { agentDir, cwd: projectDir });
    }

    // Prune with keepCount = 5
    const pruneRes = await pruneReceiptJournal('global', 5, { agentDir, cwd: projectDir });
    expect(pruneRes.prunedCount).toBe(10); // 15 - 5 = 10 pruned

    const journal = await readReceiptJournal('global', { agentDir, cwd: projectDir });
    // Total receipts = 1 active root + 5 retained historical = 6
    expect(journal.receipts).toHaveLength(6);
    expect(journal.receipts.map((r) => r.id)).toContain(PENDING_RECEIPT);
    expect(journal.activeChains).toHaveLength(1);
    expect(journal.activeChains[0].rootReceiptId).toBe(PENDING_RECEIPT);
  });

  it('preserves a Pending receipt appended during the prune rewrite window', async () => {
    const opts = { agentDir, cwd: projectDir };
    const journalPath = getReceiptsJournalPath('global', opts);
    const historical = createReceipt({
      id: RECEIPT_1,
      operation: 'Inspect',
      scope: 'global',
      trigger: 'inspect',
      expectedStateRevision: '0',
      summary: 'Completed',
    });
    await appendReceipt('global', historical, opts);

    let signalRewriteWindow!: () => void;
    const rewriteWindow = new Promise<void>((resolve) => {
      signalRewriteWindow = resolve;
    });
    let resumeRewrite!: () => void;
    const rewriteMayContinue = new Promise<void>((resolve) => {
      resumeRewrite = resolve;
    });

    const pruning = pruneReceiptJournal('global', 1, {
      ...opts,
      testHooks: {
        beforePruneRewrite: async () => {
          expect(existsSync(`${journalPath}.lock`)).toBe(true);
          signalRewriteWindow();
          await rewriteMayContinue;
        },
      },
    });

    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        rewriteWindow,
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => reject(new Error('prune did not expose its rewrite window')), 100);
        }),
      ]);
    } finally {
      if (deadline) clearTimeout(deadline);
    }

    const pending = createReceipt({
      id: PENDING_RECEIPT,
      operation: 'Runtime Application',
      scope: 'global',
      trigger: 'reload',
      expectedStateRevision: '0',
      runtimeOutcome: 'pending-application',
      summary: 'Pending Application',
    });
    const appending = appendReceipt('global', pending, opts);
    resumeRewrite();

    const [pruneResult, appendResult] = await Promise.all([pruning, appending]);
    expect(pruneResult.retainedCount).toBe(1);
    expect(appendResult.success).toBe(true);

    const journal = await readReceiptJournal('global', opts);
    expect(journal.receipts.map((receipt) => receipt.id)).toEqual([RECEIPT_1, PENDING_RECEIPT]);
    expect(journal.activeChains[0]?.rootReceiptId).toBe(PENDING_RECEIPT);
  });

  it('fails closed without rewriting when the journal cannot be read during prune', async () => {
    const opts = { agentDir, cwd: projectDir };
    const journalPath = getReceiptsJournalPath('global', opts);
    const historical = createReceipt({
      id: RECEIPT_1,
      operation: 'Inspect',
      scope: 'global',
      trigger: 'inspect',
      expectedStateRevision: '0',
      summary: 'Completed',
    });
    await appendReceipt('global', historical, opts);
    const originalBytes = readFileSync(journalPath);

    await expect(pruneReceiptJournal('global', 0, {
      ...opts,
      testHooks: {
        beforeJournalRead: () => {
          throw new Error('injected journal read failure');
        },
      },
    })).rejects.toThrow('injected journal read failure');

    expect(readFileSync(journalPath)).toEqual(originalBytes);
  });

  it('rejects prune when the atomic journal replacement fails', async () => {
    const opts = { agentDir, cwd: projectDir };
    const journalPath = getReceiptsJournalPath('global', opts);
    const historical = createReceipt({
      id: RECEIPT_1,
      operation: 'Inspect',
      scope: 'global',
      trigger: 'inspect',
      expectedStateRevision: '0',
      summary: 'Completed',
    });
    await appendReceipt('global', historical, opts);

    await expect(pruneReceiptJournal('global', 0, {
      ...opts,
      testHooks: {
        beforePruneRewrite: () => {
          rmSync(journalPath);
          mkdirSync(journalPath);
        },
      },
    })).rejects.toThrow(
      'Failed to atomically replace Receipt Journal',
    );
    expect(existsSync(`${journalPath}.lock`)).toBe(false);
  });

  it('uses the journal lock while reconstructing', async () => {
    const opts = { agentDir, cwd: projectDir };
    const journalPath = getReceiptsJournalPath('global', opts);
    const lockPath = `${journalPath}.lock`;
    const lockFd = acquireLockSync(lockPath);

    try {
      await expect(reconstructJournalFromState('global', {
        ...opts,
        journalLockTimeoutMs: 1,
      })).rejects.toThrow(`Failed to acquire lock ${lockPath}`);
    } finally {
      releaseLock(lockFd, lockPath);
    }
  });

  it('reconstructs journal when missing from state', async () => {
    const journal = await reconstructJournalFromState('global', { agentDir, cwd: projectDir });
    expect(journal.receipts).toHaveLength(0);
    expect(journal.isDegraded).toBe(false);
  });
});
