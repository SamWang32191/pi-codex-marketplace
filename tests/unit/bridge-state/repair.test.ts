import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRepairStateExpectation, repairBridgeState } from '../../../src/bridge-state/repair.js';
import { checkGlobalPendingBarrier } from '../../../src/barrier/global-barrier.js';
import { getReceiptsJournalPath, getStatePath } from '../../../src/bridge-state/paths.js';
import { commitBridgeState, readBridgeState } from '../../../src/bridge-state/store.js';
import { appendReceipt, pruneReceiptJournal, readReceiptJournal } from '../../../src/journal/journal.js';
import { acquireAttemptFence } from '../../../src/registration/fence.js';
import { createReceipt } from '../../../src/registration/receipt.js';

const INDETERMINATE_RECEIPT = 'rcpt_30000000-0000-4000-8000-000000000001';
const VALID_RECEIPT = 'rcpt_30000000-0000-4000-8000-000000000002';
const PENDING_RECEIPT = 'rcpt_30000000-0000-4000-8000-000000000003';

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

  it('keeps an unreadable-state Repair attempt in its existing recovery chain', async () => {
    const opts = { agentDir, cwd: projectDir };
    const indeterminate = createReceipt({
      id: INDETERMINATE_RECEIPT,
      operation: 'Marketplace Registration',
      scope: 'global',
      trigger: 'register',
      expectedStateRevision: '0',
      durableOutcome: 'indeterminate',
      summary: 'Persistence Indeterminate',
    });
    await appendReceipt('global', indeterminate, opts);
    const statePath = getStatePath('global', opts);
    mkdirSync(join(agentDir, 'codex-marketplace'), { recursive: true });
    writeFileSync(statePath, '{ corrupted json', 'utf-8');

    const repaired = await repairBridgeState('global', opts);

    expect(repaired.receipt).toEqual(expect.objectContaining({
      summary: 'Persistence Indeterminate',
      recoversReceiptId: indeterminate.id,
    }));
    const journal = await readReceiptJournal('global', opts);
    expect(journal.activeChains).toHaveLength(1);
    expect(journal.activeChains[0]?.rootReceiptId).toBe(indeterminate.id);
    expect(journal.activeChains[0]?.receipts.map((receipt) => receipt.id)).toEqual([
      indeterminate.id,
      repaired.receipt.id,
    ]);
  });

  it('succeeds and resolves active indeterminate recovery chain when state file is verified valid', async () => {
    // 1. Record an indeterminate receipt in journal
    const indetRcpt = createReceipt({
      id: INDETERMINATE_RECEIPT,
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
    expect(res.receipt.recoversReceiptId).toBe(INDETERMINATE_RECEIPT);

    const journal = await readReceiptJournal('global', { agentDir, cwd: projectDir });
    expect(journal.activeChains).toHaveLength(0);
  });

  it('atomically removes corrupted journal lines after state verification and clears the Global Pending Barrier', async () => {
    const opts = { agentDir, cwd: projectDir };
    const valid = createReceipt({
      id: VALID_RECEIPT,
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
      id: PENDING_RECEIPT,
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

  it('fingerprints exact raw Journal bytes even when parsed receipt counts stay equal', async () => {
    const opts = { agentDir, cwd: projectDir };
    expect((await readReceiptJournal('global', opts)).revision).toBe('missing');
    const first = createReceipt({
      id: VALID_RECEIPT,
      operation: 'First observation',
      scope: 'global',
      trigger: 'first',
      expectedStateRevision: '0',
      summary: 'Completed',
    });
    const second = createReceipt({
      ...first,
      operation: 'Second observation',
      trigger: 'second',
    });
    await appendReceipt('global', first, opts);
    const firstRead = await readReceiptJournal('global', opts);
    writeFileSync(getReceiptsJournalPath('global', opts), `${JSON.stringify(second)}\n`, 'utf-8');
    const secondRead = await readReceiptJournal('global', opts);

    expect(firstRead.receipts).toHaveLength(1);
    expect(secondRead.receipts).toHaveLength(1);
    expect(firstRead.revision).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(secondRead.revision).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(secondRead.revision).not.toBe(firstRead.revision);
  });

  it('treats the read-error Journal sentinel as unreadable even without a duplicated error field', async () => {
    const state = await readBridgeState('global', { agentDir, cwd: projectDir });
    const expectation = createRepairStateExpectation(state, {
      revision: 'read-error',
      receipts: [],
      activeChains: [],
      allChains: [],
      corruptedLineCount: 1,
      isDegraded: true,
      findings: [],
    });

    expect(expectation.journalEligibility).toBe('unreadable');
  });

  it('rejects a changed State observation without performing State Repair', async () => {
    const opts = { agentDir, cwd: projectDir };
    const initialState = await readBridgeState('global', opts);
    const initialJournal = await readReceiptJournal('global', opts);
    await commitBridgeState('global', (state) => ({ ...state }), opts);

    const repaired = await repairBridgeState('global', {
      ...opts,
      expected: {
        stateStatus: initialState.status,
        stateRevision: initialState.state?.stateRevision,
        journalRevision: initialJournal.revision,
        journalEligibility: 'healthy',
      },
    });

    expect(repaired.success).toBe(false);
    expect(repaired.receipt).toEqual(expect.objectContaining({
      expectedStateRevision: '0',
      observedStateRevision: '1',
      summary: 'Rejected as Stale',
    }));
    expect((await readBridgeState('global', opts)).state?.stateRevision).toBe('1');
  });

  it('checks the exact Journal revision under the Journal lock before pruning', async () => {
    const opts = { agentDir, cwd: projectDir };
    const valid = createReceipt({
      id: VALID_RECEIPT,
      operation: 'Inspect',
      scope: 'global',
      trigger: 'inspect',
      expectedStateRevision: '0',
      summary: 'Completed',
    });
    await appendReceipt('global', valid, opts);
    const journalPath = getReceiptsJournalPath('global', opts);
    appendFileSync(journalPath, '{ malformed journal line\n', 'utf-8');
    const initialState = await readBridgeState('global', opts);
    const initialJournal = await readReceiptJournal('global', opts);

    const drifted = readFileSync(journalPath, 'utf-8').replace(
      '{ malformed journal line',
      '{ different malformed line',
    );
    writeFileSync(journalPath, drifted, 'utf-8');

    const repaired = await repairBridgeState('global', {
      ...opts,
      expected: {
        stateStatus: initialState.status,
        stateRevision: initialState.state?.stateRevision,
        journalRevision: initialJournal.revision,
        journalEligibility: 'repairable',
      },
    });

    expect(repaired.success).toBe(false);
    expect(repaired.receipt.summary).toBe('Rejected as Stale');
    const journal = await readReceiptJournal('global', opts);
    expect(journal.isDegraded).toBe(true);
    expect(journal.corruptedLineCount).toBe(1);
    expect(journal.receipts.some((receipt) => receipt.id === valid.id)).toBe(true);
  });

  it('rechecks exact Journal bytes after the pre-rewrite hook and refuses to overwrite a bypassing writer', async () => {
    const opts = { agentDir, cwd: projectDir };
    const valid = createReceipt({
      id: VALID_RECEIPT,
      operation: 'Inspect',
      scope: 'global',
      trigger: 'inspect',
      expectedStateRevision: '0',
      summary: 'Completed',
    });
    const bypassingWriter = createReceipt({
      id: 'rcpt_30000000-0000-4000-8000-000000000006',
      operation: 'Pre-rewrite Bypass',
      scope: 'global',
      trigger: 'bypass journal lock before rewrite',
      expectedStateRevision: '0',
      summary: 'Completed',
    });
    const journalPath = getReceiptsJournalPath('global', opts);
    await appendReceipt('global', valid, opts);
    appendFileSync(journalPath, '{ malformed journal line\n', 'utf-8');
    const initialState = await readBridgeState('global', opts);
    const initialJournal = await readReceiptJournal('global', opts);

    const repaired = await repairBridgeState('global', {
      ...opts,
      expected: {
        stateStatus: initialState.status,
        stateRevision: initialState.state?.stateRevision,
        journalRevision: initialJournal.revision,
        journalEligibility: 'repairable',
      },
      testHooks: {
        beforePruneRewrite: () => {
          appendFileSync(journalPath, `${JSON.stringify(bypassingWriter)}\n`, 'utf-8');
        },
      },
    });

    expect(repaired.status).toBe('rejected-as-stale');
    expect(repaired.journalRepaired).not.toBe(true);
    const journal = await readReceiptJournal('global', opts);
    expect(journal.isDegraded).toBe(true);
    expect(journal.receipts.map((receipt) => receipt.id)).toEqual([
      valid.id,
      bypassingWriter.id,
      repaired.receipt.id,
    ]);
  });

  it('classifies healthy Journal drift before Repair Receipt append without claiming a prune', async () => {
    const opts = { agentDir, cwd: projectDir };
    const valid = createReceipt({
      id: VALID_RECEIPT,
      operation: 'Inspect',
      scope: 'global',
      trigger: 'inspect',
      expectedStateRevision: '0',
      summary: 'Completed',
    });
    const bypassingWriter = createReceipt({
      id: 'rcpt_30000000-0000-4000-8000-000000000007',
      operation: 'Pre-append Bypass',
      scope: 'global',
      trigger: 'bypass journal lock before append',
      expectedStateRevision: '0',
      summary: 'Completed',
    });
    const journalPath = getReceiptsJournalPath('global', opts);
    await appendReceipt('global', valid, opts);
    const initialState = await readBridgeState('global', opts);
    const initialJournal = await readReceiptJournal('global', opts);

    const repaired = await repairBridgeState('global', {
      ...opts,
      expected: {
        stateStatus: initialState.status,
        stateRevision: initialState.state?.stateRevision,
        journalRevision: initialJournal.revision,
        journalEligibility: 'healthy',
      },
      testHooks: {
        beforeRepairReceiptAppend: () => {
          appendFileSync(journalPath, `${JSON.stringify(bypassingWriter)}\n`, 'utf-8');
        },
      },
    });

    expect(repaired.status).toBe('rejected-as-stale');
    expect(repaired.journalRepaired).not.toBe(true);
    expect((await readReceiptJournal('global', opts)).receipts.map((receipt) => receipt.id)).toEqual([
      valid.id,
      bypassingWriter.id,
      repaired.receipt.id,
    ]);
  });

  it('preserves a concurrent append started after prune and before the bound success Receipt', async () => {
    const opts = { agentDir, cwd: projectDir };
    const valid = createReceipt({
      id: VALID_RECEIPT,
      operation: 'Inspect',
      scope: 'global',
      trigger: 'inspect',
      expectedStateRevision: '0',
      summary: 'Completed',
    });
    const concurrent = createReceipt({
      id: 'rcpt_30000000-0000-4000-8000-000000000004',
      operation: 'Concurrent Inspection',
      scope: 'global',
      trigger: 'concurrent inspect',
      expectedStateRevision: '0',
      summary: 'Completed',
    });
    await appendReceipt('global', valid, opts);
    appendFileSync(getReceiptsJournalPath('global', opts), '{ malformed journal line\n', 'utf-8');
    const initialState = await readBridgeState('global', opts);
    const initialJournal = await readReceiptJournal('global', opts);
    let concurrentAppend: ReturnType<typeof appendReceipt> | undefined;

    const repaired = await repairBridgeState('global', {
      ...opts,
      expected: {
        stateStatus: initialState.status,
        stateRevision: initialState.state?.stateRevision,
        journalRevision: initialJournal.revision,
        journalEligibility: 'repairable',
      },
      testHooks: {
        afterPruneRewrite: () => {
          // This append must wait for Repair's journal lock instead of slipping between
          // reconstruction and its revision-bound success Receipt.
          concurrentAppend = appendReceipt('global', concurrent, opts);
        },
      },
    });
    await concurrentAppend;

    expect(repaired.success).toBe(true);
    expect(repaired.receipt.summary).toBe('Completed with diagnostics');
    const journal = await readReceiptJournal('global', opts);
    expect(journal.isDegraded).toBe(false);
    expect(journal.receipts.map((receipt) => receipt.id)).toEqual([
      valid.id,
      repaired.receipt.id,
      concurrent.id,
    ]);
  });

  it('keeps the observed State Revision locked until the bound Repair Receipt is durable', async () => {
    const opts = { agentDir, cwd: projectDir };
    let directCommit: ReturnType<typeof commitBridgeState> | undefined;
    let writerSettled = false;

    const repaired = await repairBridgeState('global', {
      ...opts,
      testHooks: {
        beforeRepairReceiptAppend: async () => {
          directCommit = commitBridgeState('global', (current) => ({ ...current }), opts);
          void directCommit.then(
            () => { writerSettled = true; },
            () => { writerSettled = true; },
          );
          await Promise.resolve();
          await Promise.resolve();
          expect(writerSettled).toBe(false);
        },
        afterRepairReceiptAppend: () => {
          expect(writerSettled).toBe(false);
        },
      },
    });

    expect(repaired).toEqual(expect.objectContaining({ success: true, status: 'completed' }));
    expect(repaired.receipt).toEqual(expect.objectContaining({
      expectedStateRevision: '0',
      observedStateRevision: '0',
    }));
    expect(await directCommit).toEqual(expect.objectContaining({ success: true, newRevision: '1' }));
    expect((await readBridgeState('global', opts)).state?.stateRevision).toBe('1');

    const journal = await readReceiptJournal('global', opts);
    expect(journal.receipts.map((receipt) => receipt.id)).toContain(repaired.receipt.id);
  });

  it('reports when an indeterminate Repair Receipt could not be persisted', async () => {
    const opts = { agentDir, cwd: projectDir };
    const statePath = getStatePath('global', opts);
    mkdirSync(join(agentDir, 'codex-marketplace'), { recursive: true });
    writeFileSync(statePath, '{ corrupted json', 'utf-8');
    let releaseRewrite!: () => void;
    let signalLocked!: () => void;
    const locked = new Promise<void>((resolve) => { signalLocked = resolve; });
    const pruning = pruneReceiptJournal('global', 100, {
      ...opts,
      testHooks: {
        beforePruneRewrite: () => {
          signalLocked();
          return new Promise<void>((resolve) => { releaseRewrite = resolve; });
        },
      },
    });
    await locked;

    let repaired: Awaited<ReturnType<typeof repairBridgeState>>;
    try {
      repaired = await repairBridgeState('global', {
        ...opts,
        journalLockTimeoutMs: 20,
      });
    } finally {
      releaseRewrite();
      await pruning;
    }

    expect(repaired.status).toBe('journal-persistence-failed');
    expect(repaired.receiptPersisted).toBe(false);
    expect(repaired.receipt.summary).toBe('Persistence Indeterminate');
    expect(repaired.receipt.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'RECEIPT_PERSISTENCE_FAILED' }),
    ]));
    expect(Object.isFrozen(repaired.receipt)).toBe(true);
    expect((await readReceiptJournal('global', opts)).receipts).toEqual([]);
  });

  it('propagates a Receipt fsync failure instead of reporting append success', async () => {
    const opts = { agentDir, cwd: projectDir };
    const receipt = createReceipt({
      id: VALID_RECEIPT,
      operation: 'Injected fsync failure',
      scope: 'global',
      trigger: 'fsync injection',
      expectedStateRevision: '0',
      summary: 'Completed',
    });

    const appended = await appendReceipt('global', receipt, {
      ...opts,
      testHooks: {
        beforeReceiptFsync: () => { throw new Error('injected receipt fsync failure'); },
      },
    });

    expect(appended).toEqual(expect.objectContaining({
      success: false,
      error: expect.stringContaining('injected receipt fsync failure'),
    }));
  });

  it('requires a readable post-append Journal containing the bound Repair Receipt', async () => {
    const opts = { agentDir, cwd: projectDir };
    const journalPath = getReceiptsJournalPath('global', opts);

    const repaired = await repairBridgeState('global', {
      ...opts,
      testHooks: {
        afterRepairReceiptAppend: () => {
          writeFileSync(journalPath, '', 'utf-8');
        },
      },
    });

    expect(repaired).toEqual(expect.objectContaining({
      success: false,
      status: 'persistence-indeterminate',
      receiptPersisted: true,
      error: expect.stringContaining('could not be verified'),
    }));
    const journal = await readReceiptJournal('global', opts);
    expect(journal.receipts.map((receipt) => receipt.id)).toEqual([repaired.receipt.id]);
    expect(repaired.receipt.summary).toBe('Persistence Indeterminate');
  });

  it('reports post-prune drift as a partial Journal repair rather than a no-mutation stale rejection', async () => {
    const opts = { agentDir, cwd: projectDir };
    const valid = createReceipt({
      id: VALID_RECEIPT,
      operation: 'Inspect',
      scope: 'global',
      trigger: 'inspect',
      expectedStateRevision: '0',
      summary: 'Completed',
    });
    const bypassingWriter = createReceipt({
      id: 'rcpt_30000000-0000-4000-8000-000000000005',
      operation: 'Bypassing Writer',
      scope: 'global',
      trigger: 'bypass journal lock',
      expectedStateRevision: '0',
      summary: 'Completed',
    });
    const journalPath = getReceiptsJournalPath('global', opts);
    await appendReceipt('global', valid, opts);
    appendFileSync(journalPath, '{ malformed journal line\n', 'utf-8');
    const initialState = await readBridgeState('global', opts);
    const initialJournal = await readReceiptJournal('global', opts);

    const repaired = await repairBridgeState('global', {
      ...opts,
      expected: {
        stateStatus: initialState.status,
        stateRevision: initialState.state?.stateRevision,
        journalRevision: initialJournal.revision,
        journalEligibility: 'repairable',
      },
      testHooks: {
        afterPruneRewrite: () => {
          appendFileSync(journalPath, `${JSON.stringify(bypassingWriter)}\n`, 'utf-8');
        },
      },
    });

    expect(repaired).toEqual(expect.objectContaining({
      success: false,
      status: 'persistence-indeterminate',
      journalRepaired: true,
      receiptPersisted: true,
    }));
    expect(repaired.error).toContain('reconstruction completed');
    expect(repaired.receipt.summary).toBe('Persistence Indeterminate');
    expect(repaired.receipt.findings[0]?.classification).toBe('blocking');
    expect(repaired.receipt.findings[0]?.outcome).toContain('reconstruction completed');
    const journal = await readReceiptJournal('global', opts);
    expect(journal.isDegraded).toBe(false);
    expect(journal.receipts.map((receipt) => receipt.id)).toEqual([
      valid.id,
      bypassingWriter.id,
      repaired.receipt.id,
    ]);
  });

  it('reports a non-durable fence-blocked Receipt as Journal persistence failure', async () => {
    const opts = { agentDir, cwd: projectDir };
    const heldFence = await acquireAttemptFence('global', opts);
    expect(heldFence.ok).toBe(true);
    let releaseRewrite!: () => void;
    let signalLocked!: () => void;
    const locked = new Promise<void>((resolve) => { signalLocked = resolve; });
    const pruning = pruneReceiptJournal('global', 100, {
      ...opts,
      testHooks: {
        beforePruneRewrite: () => {
          signalLocked();
          return new Promise<void>((resolve) => { releaseRewrite = resolve; });
        },
      },
    });
    await locked;

    let repaired: Awaited<ReturnType<typeof repairBridgeState>>;
    try {
      repaired = await repairBridgeState('global', {
        ...opts,
        fenceTimeoutMs: 20,
        journalLockTimeoutMs: 20,
      });
    } finally {
      releaseRewrite();
      await pruning;
      heldFence.handle?.release();
    }

    expect(repaired).toEqual(expect.objectContaining({
      success: false,
      status: 'journal-persistence-failed',
      receiptPersisted: false,
    }));
    expect(repaired.receipt.summary).toBe('Blocked');
    expect(repaired.receipt.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'ATTEMPT_IN_PROGRESS' }),
      expect.objectContaining({ code: 'RECEIPT_PERSISTENCE_FAILED' }),
    ]));
  });

  it('reports a non-durable catch fallback Receipt as Journal persistence failure', async () => {
    const opts = { agentDir, cwd: projectDir };
    let releaseRewrite!: () => void;
    let signalLocked!: () => void;
    const locked = new Promise<void>((resolve) => { signalLocked = resolve; });
    const pruning = pruneReceiptJournal('global', 100, {
      ...opts,
      testHooks: {
        beforePruneRewrite: () => {
          signalLocked();
          return new Promise<void>((resolve) => { releaseRewrite = resolve; });
        },
      },
    });
    await locked;

    let repaired: Awaited<ReturnType<typeof repairBridgeState>>;
    try {
      repaired = await repairBridgeState('global', {
        ...opts,
        journalLockTimeoutMs: 20,
      });
    } finally {
      releaseRewrite();
      await pruning;
    }

    expect(repaired).toEqual(expect.objectContaining({
      success: false,
      status: 'journal-persistence-failed',
      receiptPersisted: false,
    }));
    expect(repaired.receipt.summary).toBe('Persistence Indeterminate');
    expect(repaired.receipt.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'RECEIPT_PERSISTENCE_FAILED' }),
    ]));
  });
});
