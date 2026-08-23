import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  appendReceipt,
  readReceiptJournal,
  pruneReceiptJournal,
  reconstructJournalFromState,
} from '../../../src/journal/journal.js';
import { createReceipt } from '../../../src/registration/receipt.js';
import { getReceiptsJournalPath } from '../../../src/bridge-state/paths.js';

describe('Receipt Journal — Storage & Bounded Retention', () => {
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
      id: 'rcpt_1',
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
    expect(journal.receipts[0].id).toBe('rcpt_1');
    expect(journal.receipts[0].summary).toBe('Completed');
    expect(journal.corruptedLineCount).toBe(0);
    expect(journal.isDegraded).toBe(false);
  });

  it('skips corrupted JSON lines and records RECEIPT_CORRUPT operational notices', async () => {
    const rcpt1 = createReceipt({
      id: 'rcpt_1',
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
      id: 'rcpt_2',
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
    expect(journal.receipts.map((r) => r.id)).toEqual(['rcpt_1', 'rcpt_2']);
    expect(journal.corruptedLineCount).toBe(1);
    expect(journal.findings.some((f) => f.code === 'RECEIPT_CORRUPT')).toBe(true);
  });

  it('treats structurally incomplete Receipt JSON as a degraded line', async () => {
    const journalPath = getReceiptsJournalPath('global', { agentDir, cwd: projectDir });
    mkdirSync(dirname(journalPath), { recursive: true });
    writeFileSync(
      journalPath,
      `${JSON.stringify({ id: 'rcpt_incomplete', summary: 'Blocked' })}\n`,
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

  it('prunes resolved receipts outside active chains while keeping ALL active recovery chains intact', async () => {
    // 1. Create an active recovery root (Pending Application)
    const pendingRcpt = createReceipt({
      id: 'rcpt_pending',
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
        id: `rcpt_resolved_${i}`,
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
    expect(journal.receipts.map((r) => r.id)).toContain('rcpt_pending');
    expect(journal.activeChains).toHaveLength(1);
    expect(journal.activeChains[0].rootReceiptId).toBe('rcpt_pending');
  });

  it('reconstructs journal when missing from state', async () => {
    const journal = await reconstructJournalFromState('global', { agentDir, cwd: projectDir });
    expect(journal.receipts).toHaveLength(0);
    expect(journal.isDegraded).toBe(false);
  });
});
