import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { preflightLocalRegistration, confirmLocalRegistration } from '../../src/registration/flow.js';
import { checkGlobalPendingBarrier } from '../../src/barrier/global-barrier.js';
import { appendReceipt, readReceiptJournal, pruneReceiptJournal } from '../../src/journal/journal.js';
import { repairBridgeState } from '../../src/bridge-state/repair.js';
import { createReceipt } from '../../src/registration/receipt.js';
import { getReceiptsJournalPath, getStatePath } from '../../src/bridge-state/paths.js';

const PENDING_RECEIPT = 'rcpt_10000000-0000-4000-8000-000000000001';
const VALID_RECEIPT_1 = 'rcpt_10000000-0000-4000-8000-000000000002';
const VALID_RECEIPT_2 = 'rcpt_10000000-0000-4000-8000-000000000003';

function makeMarketplace(root: string, name = 'test-market') {
  mkdirSync(join(root, '.agents', 'plugins'), { recursive: true });
  mkdirSync(join(root, 'plugins', 'weather'), { recursive: true });
  writeFileSync(join(root, 'plugins', 'weather', 'plugin.json'), JSON.stringify({ name: 'weather' }));
  writeFileSync(join(root, 'plugins', 'weather', 'SKILL.md'), '# weather');
  writeFileSync(
    join(root, '.agents', 'plugins', 'marketplace.json'),
    JSON.stringify({
      name,
      plugins: [{ name: 'weather', path: './plugins/weather' }],
    }),
  );
}

describe('Integration — Journal, Fence, and Global Barrier', () => {
  let tmpRoot: string;
  let agentDir: string;
  let projectDir: string;
  let marketplaceRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'journal-barrier-int-'));
    agentDir = join(tmpRoot, 'agent');
    projectDir = join(tmpRoot, 'project');
    marketplaceRoot = join(tmpRoot, 'marketplace');

    makeMarketplace(marketplaceRoot);
  });

  afterEach(() => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  });

  it('appends AttemptReceipts to receipt journal on successful registration and preserves active chains across pruning', async () => {
    const opts = { cwd: projectDir, agentDir, projectTrusted: true };

    // 1. Preflight & confirm local registration
    const pfRes = await preflightLocalRegistration('global', marketplaceRoot, opts);
    expect(pfRes.ok).toBe(true);
    if (!pfRes.ok) return;

    const confRes = await confirmLocalRegistration(pfRes.preflight, true, opts);
    expect(confRes.status).toBe('completed');

    // Check receipt journal
    let journal = await readReceiptJournal('global', opts);
    expect(journal.receipts).toHaveLength(1);
    expect(journal.receipts[0].summary).toBe('Completed');
    expect(journal.receipts[0].durableOutcome).toBe('committed');
    expect(journal.activeChains).toHaveLength(0);

    // 2. Append a Pending Application receipt into the journal
    const pendingRcpt = createReceipt({
      id: PENDING_RECEIPT,
      operation: 'Plugin Installation',
      scope: 'global',
      trigger: 'install weather',
      expectedStateRevision: '1',
      targetStateRevision: '2',
      observedStateRevision: '2',
      durableOutcome: 'committed',
      runtimeOutcome: 'pending-application',
      summary: 'Pending Application',
    });
    await appendReceipt('global', pendingRcpt, opts);

    // 3. Append 15 resolved receipts to trigger pruning threshold
    for (let i = 0; i < 15; i++) {
      const resolvedRcpt = createReceipt({
        id: `rcpt_20000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        operation: 'Inspect Marketplace',
        scope: 'global',
        trigger: 'inspect',
        expectedStateRevision: '2',
        summary: 'Completed',
      });
      await appendReceipt('global', resolvedRcpt, opts);
    }

    journal = await readReceiptJournal('global', opts);
    expect(journal.activeChains).toHaveLength(1);
    expect(journal.activeChains[0].rootReceiptId).toBe(PENDING_RECEIPT);

    // Prune with maxReceipts = 5
    await pruneReceiptJournal('global', 5, opts);

    journal = await readReceiptJournal('global', opts);
    // Active chain MUST be retained!
    expect(journal.activeChains).toHaveLength(1);
    expect(journal.activeChains[0].rootReceiptId).toBe(PENDING_RECEIPT);
    const hasPending = journal.receipts.some((r) => r.id === PENDING_RECEIPT);
    expect(hasPending).toBe(true);
  });

  it('tolerates corrupted lines in receipt journal without failing the whole journal (RECEIPT_CORRUPT notice)', async () => {
    const opts = { cwd: projectDir, agentDir, projectTrusted: true };

    const validRcpt = createReceipt({
      id: VALID_RECEIPT_1,
      operation: 'Marketplace Registration',
      scope: 'global',
      trigger: 'register',
      expectedStateRevision: '0',
      summary: 'Completed',
    });
    await appendReceipt('global', validRcpt, opts);

    // Manually inject a corrupted line into receipts.jsonl
    const journalPath = getReceiptsJournalPath('global', opts);
    appendFileSync(journalPath, '\n{ invalid corrupted json line\n', 'utf-8');

    // Append another valid receipt
    const validRcpt2 = createReceipt({
      id: VALID_RECEIPT_2,
      operation: 'Inspect',
      scope: 'global',
      trigger: 'inspect',
      expectedStateRevision: '1',
      summary: 'Completed',
    });
    await appendReceipt('global', validRcpt2, opts);

    const journal = await readReceiptJournal('global', opts);
    expect(journal.receipts).toHaveLength(2);
    expect(journal.isDegraded).toBe(true);
    expect(journal.corruptedLineCount).toBe(1);
    expect(journal.findings).toHaveLength(1);
    expect(journal.findings[0].code).toBe('RECEIPT_CORRUPT');
    expect(journal.findings[0].classification).toBe('notice');
  });

  it('Global Pending Barrier blocks Project mutation when Global has active recovery, and clears upon repair', async () => {
    const opts = { cwd: projectDir, agentDir, projectTrusted: true };

    // 1. Initially barrier is inactive
    let barrier = await checkGlobalPendingBarrier(opts);
    expect(barrier.active).toBe(false);

    // 2. Put global scope in Persistence Indeterminate condition
    const globalStatePath = getStatePath('global', opts);
    mkdirSync(join(agentDir, 'codex-marketplace'), { recursive: true });
    writeFileSync(globalStatePath, '{ corrupted global state json', 'utf-8');

    barrier = await checkGlobalPendingBarrier(opts);
    expect(barrier.active).toBe(true);

    // 3. Project scope mutation attempt must be blocked with GLOBAL_PENDING_BARRIER
    const projPreflight = await preflightLocalRegistration('project', marketplaceRoot, opts);
    expect(projPreflight.ok).toBe(false);
    if (!projPreflight.ok) {
      expect(projPreflight.outcome.receipt.summary).toBe('Blocked');
      expect(projPreflight.outcome.receipt.findings[0].code).toBe('GLOBAL_PENDING_BARRIER');
      expect(projPreflight.outcome.receipt.findings[0].rule).toBe('BARRIER-01');
    }

    // 4. Fix global state and run Repair State
    writeFileSync(
      globalStatePath,
      JSON.stringify({
        schemaVersion: 1,
        stateRevision: '1',
        registrations: [],
        installations: [],
        scopeOverrides: [],
      }),
      'utf-8',
    );
    const repairRes = await repairBridgeState('global', opts);
    expect(repairRes.success).toBe(true);

    // 5. Barrier is now automatically cleared
    barrier = await checkGlobalPendingBarrier(opts);
    expect(barrier.active).toBe(false);

    // 6. Project Scope attempt can now succeed
    const projPreflight2 = await preflightLocalRegistration('project', marketplaceRoot, opts);
    expect(projPreflight2.ok).toBe(true);
    if (projPreflight2.ok) {
      const conf = await confirmLocalRegistration(projPreflight2.preflight, true, opts);
      expect(conf.status).toBe('completed');
    }
  });
});
