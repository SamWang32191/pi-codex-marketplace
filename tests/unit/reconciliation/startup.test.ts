import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runStartupReconciliation } from '../../../src/reconciliation/startup.js';
import { appendReceipt, readReceiptJournal } from '../../../src/journal/journal.js';
import { createReceipt } from '../../../src/registration/receipt.js';
import { getStatePath } from '../../../src/bridge-state/paths.js';

const PENDING_RECEIPT = 'rcpt_50000000-0000-4000-8000-000000000001';
const GLOBAL_PENDING_RECEIPT = 'rcpt_50000000-0000-4000-8000-000000000002';
const PROJECT_PENDING_RECEIPT = 'rcpt_50000000-0000-4000-8000-000000000003';

describe('Startup Reconciliation', () => {
  let tmpRoot: string;
  let agentDir: string;
  let projectDir: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'startup-recon-'));
    agentDir = join(tmpRoot, 'agent');
    projectDir = join(tmpRoot, 'project');
  });

  afterEach(() => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  });

  it('no-op on empty scopes produces NO empty receipts', async () => {
    const res = await runStartupReconciliation({ agentDir, cwd: projectDir, projectTrusted: true });
    expect(res.globalReconciled).toBe(false);
    expect(res.projectReconciled).toBe(false);

    const gj = await readReceiptJournal('global', { agentDir, cwd: projectDir });
    const pj = await readReceiptJournal('project', { agentDir, cwd: projectDir });
    expect(gj.receipts).toHaveLength(0);
    expect(pj.receipts).toHaveLength(0);
  });

  it('reconciles Global Pending Application on startup and produces a Reconciliation receipt', async () => {
    // 1. Setup pending application in global journal
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

    // 2. Setup state with 1 registration
    const statePath = getStatePath('global', { agentDir, cwd: projectDir });
    mkdirSync(join(agentDir, 'codex-marketplace'), { recursive: true });
    writeFileSync(
      statePath,
      JSON.stringify({
        schemaVersion: 1,
        stateRevision: '1',
        registrations: [{ id: 'reg1', alias: 'acme' }],
        installations: [],
        scopeOverrides: [],
      }),
      'utf-8',
    );

    // 3. Run reconciliation with a reload verification that succeeds
    const res = await runStartupReconciliation({
      agentDir,
      cwd: projectDir,
      projectTrusted: true,
      verifyReload: async () => true,
    });

    expect(res.globalReconciled).toBe(true);
    expect(res.globalReceipt?.summary).toBe('Completed');
    expect(res.globalReceipt?.kind).toBe('Reconciliation');
    expect(res.globalReceipt?.recoversReceiptId).toBe(PENDING_RECEIPT);

    const gj = await readReceiptJournal('global', { agentDir, cwd: projectDir });
    expect(gj.activeChains).toHaveLength(0);
  });

  it('reconciles Project independently while Global recovery stays pending (Barrier retired)', async () => {
    // 1. Setup pending application in global journal
    const globalPending = createReceipt({
      id: GLOBAL_PENDING_RECEIPT,
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
    await appendReceipt('global', globalPending, { agentDir, cwd: projectDir });

    // 2. Setup project state with pending work
    const projectPending = createReceipt({
      id: PROJECT_PENDING_RECEIPT,
      operation: 'Plugin Installation',
      scope: 'project',
      trigger: 'install',
      expectedStateRevision: '0',
      targetStateRevision: '1',
      observedStateRevision: '1',
      durableOutcome: 'committed',
      runtimeOutcome: 'pending-application',
      summary: 'Pending Application',
    });
    await appendReceipt('project', projectPending, { agentDir, cwd: projectDir });

    // 3. Run reconciliation where global reload fails (so global stays Pending)
    const res = await runStartupReconciliation({
      agentDir,
      cwd: projectDir,
      projectTrusted: true,
      verifyReload: async (scope) => scope === 'global' ? false : true,
    });

    expect(res.globalReconciled).toBe(true);
    expect(res.globalReceipt?.summary).toBe('Pending Application');
    // Global Pending Barrier retired: Project reconciliation proceeds on its own.
    expect(res.projectReconciled).toBe(true);
    expect(res.projectReceipt?.summary).toBe('Completed');
    expect(res.projectReceipt?.runtimeOutcome).toBe('applied');
    expect(res.projectReceipt?.findings ?? []).toHaveLength(0);
  });
});
