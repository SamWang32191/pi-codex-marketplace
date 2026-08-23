import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runStartupReconciliation } from '../../src/reconciliation/startup.js';
import { appendReceipt, readReceiptJournal } from '../../src/journal/journal.js';
import { createReceipt } from '../../src/registration/receipt.js';
import { getStatePath } from '../../src/bridge-state/paths.js';

const GLOBAL_PENDING_RECEIPT = 'rcpt_40000000-0000-4000-8000-000000000001';
const PROJECT_PENDING_RECEIPT = 'rcpt_40000000-0000-4000-8000-000000000002';

describe('Integration — Startup Reconciliation & Multi-scope Lifecycle', () => {
  let tmpRoot: string;
  let agentDir: string;
  let projectDir: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'startup-recon-int-'));
    agentDir = join(tmpRoot, 'agent');
    projectDir = join(tmpRoot, 'project');
  });

  afterEach(() => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  });

  it('performs clean no-op when session starts with empty state and creates no journal records', async () => {
    const res = await runStartupReconciliation({
      cwd: projectDir,
      agentDir,
      projectTrusted: true,
    });
    expect(res.globalReconciled).toBe(false);
    expect(res.projectReconciled).toBe(false);

    const gj = await readReceiptJournal('global', { cwd: projectDir, agentDir });
    const pj = await readReceiptJournal('project', { cwd: projectDir, agentDir });
    expect(gj.receipts).toHaveLength(0);
    expect(pj.receipts).toHaveLength(0);
  });

  it('runs global-first reconciliation, clears global active chain, and reconciles project cleanly', async () => {
    const opts = { cwd: projectDir, agentDir, projectTrusted: true };

    // 1. Setup Global Pending Application
    const globalStatePath = getStatePath('global', opts);
    mkdirSync(join(agentDir, 'codex-marketplace'), { recursive: true });
    writeFileSync(
      globalStatePath,
      JSON.stringify({
        schemaVersion: 1,
        stateRevision: '2',
        registrations: [{ id: 'reg1', alias: 'market-1' }],
        installations: [{ id: 'global/weather', pluginId: 'weather', installationState: 'enabled' }],
        scopeOverrides: [],
      }),
      'utf-8',
    );
    const globalPending = createReceipt({
      id: GLOBAL_PENDING_RECEIPT,
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
    await appendReceipt('global', globalPending, opts);

    // 2. Setup Project Pending Application
    const projectStatePath = getStatePath('project', opts);
    mkdirSync(join(projectDir, '.pi', 'codex-marketplace'), { recursive: true });
    writeFileSync(
      projectStatePath,
      JSON.stringify({
        schemaVersion: 1,
        stateRevision: '1',
        registrations: [],
        installations: [{ id: 'project/tools', pluginId: 'tools', installationState: 'enabled' }],
        scopeOverrides: [],
      }),
      'utf-8',
    );
    const projPending = createReceipt({
      id: PROJECT_PENDING_RECEIPT,
      operation: 'Plugin Installation',
      scope: 'project',
      trigger: 'install tools',
      expectedStateRevision: '0',
      targetStateRevision: '1',
      observedStateRevision: '1',
      durableOutcome: 'committed',
      runtimeOutcome: 'pending-application',
      summary: 'Pending Application',
    });
    await appendReceipt('project', projPending, opts);

    // 3. Run startup reconciliation where both reload cleanly
    const res = await runStartupReconciliation({
      ...opts,
      verifyReload: async () => true,
    });

    expect(res.globalReconciled).toBe(true);
    expect(res.globalReceipt?.summary).toBe('Completed');
    expect(res.globalReceipt?.recoversReceiptId).toBe(GLOBAL_PENDING_RECEIPT);

    expect(res.projectReconciled).toBe(true);
    expect(res.projectReceipt?.summary).toBe('Completed');
    expect(res.projectReceipt?.recoversReceiptId).toBe(PROJECT_PENDING_RECEIPT);

    const gj = await readReceiptJournal('global', opts);
    const pj = await readReceiptJournal('project', opts);
    expect(gj.activeChains).toHaveLength(0);
    expect(pj.activeChains).toHaveLength(0);
  });
});
