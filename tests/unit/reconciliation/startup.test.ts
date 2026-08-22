import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runStartupReconciliation } from '../../../src/reconciliation/startup.js';
import { appendReceipt, readReceiptJournal } from '../../../src/journal/journal.js';
import { createReceipt } from '../../../src/registration/receipt.js';
import { getStatePath } from '../../../src/bridge-state/paths.js';

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
      id: 'rcpt_pending_1',
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
    expect(res.globalReceipt?.recoversReceiptId).toBe('rcpt_pending_1');

    const gj = await readReceiptJournal('global', { agentDir, cwd: projectDir });
    expect(gj.activeChains).toHaveLength(0);
  });

  it('Global-first: blocks Project reconciliation when Global recovery cannot complete', async () => {
    // 1. Setup pending application in global journal
    const globalPending = createReceipt({
      id: 'rcpt_global_pending',
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
      id: 'rcpt_proj_pending',
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
    // Project is blocked by Global Pending Barrier
    expect(res.projectReconciled).toBe(true);
    expect(res.projectReceipt?.summary).toBe('Blocked');
    expect(res.projectReceipt?.findings[0].code).toBe('GLOBAL_PENDING_BARRIER');
  });
});
