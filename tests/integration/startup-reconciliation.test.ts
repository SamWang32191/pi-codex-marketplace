import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runStartupReconciliation } from '../../src/reconciliation/startup.js';
import { appendReceipt, readReceiptJournal } from '../../src/journal/journal.js';
import { createReceipt } from '../../src/registration/receipt.js';
import { getGlobalStatePath } from '../../src/bridge-state/paths.js';
import { CURRENT_SCHEMA_VERSION } from '../../src/bridge-state/types.js';

const GLOBAL_PENDING_RECEIPT = 'rcpt_40000000-0000-4000-8000-000000000001';

describe('Integration — Startup Reconciliation (Global-only)', () => {
  let tmpRoot: string;
  let agentDir: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'startup-recon-int-'));
    agentDir = join(tmpRoot, 'agent');
  });

  afterEach(() => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  });

  it('performs clean no-op when session starts with empty state and creates no journal records', async () => {
    const res = await runStartupReconciliation({ agentDir });
    expect(res.reconciled).toBe(false);
    expect(res.receipt).toBeUndefined();

    const gj = await readReceiptJournal({ agentDir });
    expect(gj.receipts).toHaveLength(0);
  });

  it('reconciles the Global pending-application chain and resolves it with a Completed receipt', async () => {
    // Setup Global Pending Application
    const globalStatePath = getGlobalStatePath(agentDir);
    mkdirSync(join(agentDir, 'codex-marketplace'), { recursive: true });
    writeFileSync(
      globalStatePath,
      JSON.stringify({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        stateRevision: '2',
        registrations: [{ id: 'reg1', alias: 'market-1' }],
        installations: [{ id: 'weather', pluginId: 'weather', installationState: 'enabled' }],
      }),
      'utf-8',
    );
    const globalPending = createReceipt({
      id: GLOBAL_PENDING_RECEIPT,
      operation: 'Plugin Installation',
      trigger: 'install weather',
      expectedStateRevision: '1',
      targetStateRevision: '2',
      observedStateRevision: '2',
      durableOutcome: 'committed',
      runtimeOutcome: 'pending-application',
      summary: 'Pending Application',
    });
    await appendReceipt(globalPending, { agentDir });

    const res = await runStartupReconciliation({
      agentDir,
      verifyReload: async () => true,
    });

    expect(res.reconciled).toBe(true);
    expect(res.receipt?.summary).toBe('Completed');
    expect(res.receipt?.recoversReceiptId).toBe(GLOBAL_PENDING_RECEIPT);

    const gj = await readReceiptJournal({ agentDir });
    expect(gj.activeChains).toHaveLength(0);
  });

  it('leaves a Pending Application receipt when the host reload cannot verify re-entry', async () => {
    const globalStatePath = getGlobalStatePath(agentDir);
    mkdirSync(join(agentDir, 'codex-marketplace'), { recursive: true });
    writeFileSync(
      globalStatePath,
      JSON.stringify({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        stateRevision: '1',
        registrations: [],
        installations: [{ id: 'tools', pluginId: 'tools', installationState: 'enabled' }],
      }),
      'utf-8',
    );

    // Enabled contributions plus journal history trigger the pass; an unverifiable reload
    // keeps the chain active as Pending Application.
    await appendReceipt(createReceipt({
      operation: 'Plugin Installation',
      trigger: 'install tools',
      expectedStateRevision: '1',
      targetStateRevision: '1',
      observedStateRevision: '1',
      durableOutcome: 'committed',
      runtimeOutcome: 'pending-application',
      summary: 'Pending Application',
    }), { agentDir });

    const res = await runStartupReconciliation({
      agentDir,
      verifyReload: async () => false,
    });

    expect(res.reconciled).toBe(true);
    expect(res.receipt?.summary).toBe('Pending Application');
    expect(res.receipt?.durableOutcome).toBe('unchanged');

    const gj = await readReceiptJournal({ agentDir });
    expect(gj.activeChains.map((chain) => chain.condition)).toContain('pending-application');
  });

  it('never touches the retired Project state document — zero reads even when one exists', async () => {
    // A leftover project document from the dual-scope era must be completely ignored (D2).
    const projectDir = join(tmpRoot, 'project');
    mkdirSync(join(projectDir, '.pi', 'codex-marketplace'), { recursive: true });
    writeFileSync(
      join(projectDir, '.pi', 'codex-marketplace', 'state.json'),
      '{ this file must never be read or removed }',
      'utf-8',
    );
    const before = await import('node:fs').then(({ readFileSync }) => readFileSync(join(projectDir, '.pi', 'codex-marketplace', 'state.json'), 'utf-8'));

    const res = await runStartupReconciliation({ agentDir, verifyReload: async () => true });
    expect(res.reconciled).toBe(false);

    // The project document is untouched: not read into any result, not deleted.
    const after = await import('node:fs').then(({ existsSync }) => existsSync(join(projectDir, '.pi', 'codex-marketplace', 'state.json')));
    expect(after).toBe(true);
    expect(before).toBe('{ this file must never be read or removed }');
  });
});
