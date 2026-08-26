import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runStartupReconciliation } from '../../../src/reconciliation/startup.js';
import { appendReceipt, readReceiptJournal } from '../../../src/journal/journal.js';
import { createReceipt } from '../../../src/registration/receipt.js';
import { getGlobalStatePath } from '../../../src/bridge-state/paths.js';
import { CURRENT_SCHEMA_VERSION } from '../../../src/bridge-state/types.js';

const PENDING_RECEIPT = 'rcpt_50000000-0000-4000-8000-000000000001';

describe('Startup Reconciliation — Global-only', () => {
  let tmpRoot: string;
  let agentDir: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'startup-recon-'));
    agentDir = join(tmpRoot, 'agent');
  });

  afterEach(() => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  });

  it('no-op on a clean state produces NO empty receipts', async () => {
    const res = await runStartupReconciliation({ agentDir });
    expect(res.reconciled).toBe(false);
    expect(res.receipt).toBeUndefined();

    const gj = await readReceiptJournal({ agentDir });
    expect(gj.receipts).toHaveLength(0);
  });

  it('reconciles a Pending Application chain on startup and produces a Reconciliation receipt', async () => {
    // 1. Setup pending application in the global journal
    const pendingRcpt = createReceipt({
      id: PENDING_RECEIPT,
      operation: 'Marketplace Registration',
      trigger: 'register',
      expectedStateRevision: '0',
      targetStateRevision: '1',
      observedStateRevision: '1',
      durableOutcome: 'committed',
      runtimeOutcome: 'pending-application',
      summary: 'Pending Application',
    });
    await appendReceipt(pendingRcpt, { agentDir });

    // 2. Setup state with 1 registration
    const statePath = getGlobalStatePath(agentDir);
    mkdirSync(join(agentDir, 'codex-marketplace'), { recursive: true });
    writeFileSync(
      statePath,
      JSON.stringify({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        stateRevision: '1',
        registrations: [{ id: 'reg1', alias: 'acme' }],
        installations: [],
      }),
      'utf-8',
    );

    // 3. Run reconciliation with a reload verification that succeeds
    const res = await runStartupReconciliation({
      agentDir,
      verifyReload: async () => true,
    });

    expect(res.reconciled).toBe(true);
    expect(res.receipt?.summary).toBe('Completed');
    expect(res.receipt?.kind).toBe('Reconciliation');
    expect(res.receipt?.recoversReceiptId).toBe(PENDING_RECEIPT);

    const gj = await readReceiptJournal({ agentDir });
    expect(gj.activeChains).toHaveLength(0);
  });

  it('reports Pending Application when reload verification fails', async () => {
    // Pending application chain in the journal
    const pendingRcpt = createReceipt({
      id: PENDING_RECEIPT,
      operation: 'Marketplace Registration',
      trigger: 'register',
      expectedStateRevision: '0',
      targetStateRevision: '1',
      observedStateRevision: '1',
      durableOutcome: 'committed',
      runtimeOutcome: 'pending-application',
      summary: 'Pending Application',
    });
    await appendReceipt(pendingRcpt, { agentDir });

    const res = await runStartupReconciliation({
      agentDir,
      verifyReload: async () => false,
    });

    expect(res.reconciled).toBe(true);
    expect(res.receipt?.summary).toBe('Pending Application');
    expect(res.receipt?.runtimeOutcome).toBe('pending-application');

    // The failed reconciliation leaves an active recovery chain behind.
    const gj = await readReceiptJournal({ agentDir });
    expect(gj.activeChains).toHaveLength(1);
    expect(gj.activeChains[0]?.condition).toBe('pending-application');
  });

  it('enabled installations with journal history reconcile even without a pending chain', async () => {
    mkdirSync(join(agentDir, 'codex-marketplace'), { recursive: true });
    writeFileSync(
      getGlobalStatePath(agentDir),
      JSON.stringify({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        stateRevision: '1',
        registrations: [{ id: 'reg1', alias: 'acme' }],
        installations: [{ id: 'acme/plugin', pluginId: 'acme/plugin', installationState: 'enabled' }],
      }),
      'utf-8',
    );

    const history = createReceipt({
      operation: 'Plugin Installation',
      trigger: 'install',
      expectedStateRevision: '0',
      targetStateRevision: '1',
      observedStateRevision: '1',
      durableOutcome: 'committed',
      runtimeOutcome: 'applied',
      summary: 'Completed',
    });
    await appendReceipt(history, { agentDir });

    const res = await runStartupReconciliation({
      agentDir,
      verifyReload: async () => true,
    });

    expect(res.reconciled).toBe(true);
    expect(res.receipt?.summary).toBe('Completed');
  });
});
