import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { repairBridgeState } from '../../../src/bridge-state/repair.js';
import { checkGlobalPendingBarrier } from '../../../src/barrier/global-barrier.js';
import { getReceiptsJournalPath, getStatePath } from '../../../src/bridge-state/paths.js';
import { appendReceipt, readReceiptJournal } from '../../../src/journal/journal.js';
import { createReceipt } from '../../../src/registration/receipt.js';

describe('Repair State', () => {
  let tmpRoot: string;
  let agentDir: string;
  let projectDir: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'repair-test-'));
    agentDir = join(tmpRoot, 'agent');
    projectDir = join(tmpRoot, 'project');
  });

  afterEach(() => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  });

  it('fails with Persistence Indeterminate receipt when state file remains corrupted', async () => {
    const statePath = getStatePath('global', { agentDir, cwd: projectDir });
    mkdirSync(join(agentDir, 'codex-marketplace'), { recursive: true });
    writeFileSync(statePath, '{ corrupted json', 'utf-8');

    const res = await repairBridgeState('global', { agentDir, cwd: projectDir });
    expect(res.success).toBe(false);
    expect(res.receipt.summary).toBe('Persistence Indeterminate');
    expect(res.receipt.kind).toBe('State Repair');

    const journal = await readReceiptJournal('global', { agentDir, cwd: projectDir });
    expect(journal.receipts).toHaveLength(1);
    expect(journal.receipts[0].summary).toBe('Persistence Indeterminate');
  });

  it('succeeds and resolves active indeterminate recovery chain when state file is verified valid', async () => {
    // 1. Record an indeterminate receipt in journal
    const indetRcpt = createReceipt({
      id: 'rcpt_indet_1',
      operation: 'Marketplace Registration',
      scope: 'global',
      trigger: 'register',
      expectedStateRevision: '0',
      durableOutcome: 'indeterminate',
      summary: 'Persistence Indeterminate',
    });
    await appendReceipt('global', indetRcpt, { agentDir, cwd: projectDir });

    // 2. State file is valid
    const statePath = getStatePath('global', { agentDir, cwd: projectDir });
    mkdirSync(join(agentDir, 'codex-marketplace'), { recursive: true });
    writeFileSync(
      statePath,
      JSON.stringify({
        schemaVersion: 1,
        stateRevision: '1',
        registrations: [],
        installations: [],
        scopeOverrides: [],
      }),
      'utf-8',
    );

    // 3. Run Repair State
    const res = await repairBridgeState('global', { agentDir, cwd: projectDir });
    expect(res.success).toBe(true);
    expect(res.receipt.summary).toBe('Completed');
    expect(res.receipt.recoversReceiptId).toBe('rcpt_indet_1');

    const journal = await readReceiptJournal('global', { agentDir, cwd: projectDir });
    expect(journal.activeChains).toHaveLength(0);
  });

  it('atomically removes corrupted journal lines after state verification and clears the Global Pending Barrier', async () => {
    const opts = { agentDir, cwd: projectDir };
    const valid = createReceipt({
      id: 'rcpt_valid_before_journal_repair',
      operation: 'Inspect',
      scope: 'global',
      trigger: 'inspect',
      expectedStateRevision: '0',
      summary: 'Completed',
    });
    await appendReceipt('global', valid, opts);
    appendFileSync(getReceiptsJournalPath('global', opts), '{ malformed journal line\n', 'utf-8');

    expect((await checkGlobalPendingBarrier(opts)).active).toBe(true);

    const repaired = await repairBridgeState('global', opts);

    expect(repaired.success).toBe(true);
    const journal = await readReceiptJournal('global', opts);
    expect(journal.isDegraded).toBe(false);
    expect(journal.receipts.some((receipt) => receipt.id === valid.id)).toBe(true);
    expect(journal.receipts.at(-1)).toEqual(expect.objectContaining({
      kind: 'State Repair',
      summary: 'Completed with diagnostics',
    }));
    expect(journal.receipts.at(-1)?.findings).toEqual([
      expect.objectContaining({ code: 'RECEIPT_CORRUPT', rule: 'JOURNAL-02' }),
    ]);
    expect((await checkGlobalPendingBarrier(opts)).active).toBe(false);
  });

  it('preserves active recovery chains while repairing corrupted journal lines', async () => {
    const opts = { agentDir, cwd: projectDir };
    const pending = createReceipt({
      id: 'rcpt_pending_preserved_by_journal_repair',
      operation: 'Runtime Application',
      scope: 'global',
      trigger: 'reload',
      expectedStateRevision: '0',
      runtimeOutcome: 'pending-application',
      summary: 'Pending Application',
    });
    await appendReceipt('global', pending, opts);
    appendFileSync(getReceiptsJournalPath('global', opts), '{ malformed journal line\n', 'utf-8');

    const repaired = await repairBridgeState('global', opts);

    expect(repaired.success).toBe(true);
    const journal = await readReceiptJournal('global', opts);
    expect(journal.isDegraded).toBe(false);
    expect(journal.activeChains).toHaveLength(1);
    expect(journal.activeChains[0]?.rootReceiptId).toBe(pending.id);
    expect((await checkGlobalPendingBarrier(opts)).active).toBe(true);
  });
});
