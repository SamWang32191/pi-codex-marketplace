import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkGlobalPendingBarrier } from '../../../src/barrier/global-barrier.js';
import { appendReceipt } from '../../../src/journal/journal.js';
import { createReceipt } from '../../../src/registration/receipt.js';
import { acquireAttemptFence } from '../../../src/registration/fence.js';
import { getStatePath } from '../../../src/bridge-state/paths.js';

describe('Global Pending Barrier', () => {
  let tmpRoot: string;
  let agentDir: string;
  let projectDir: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'barrier-test-'));
    agentDir = join(tmpRoot, 'agent');
    projectDir = join(tmpRoot, 'project');
  });

  afterEach(() => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  });

  it('reports barrier inactive when Global Scope is clean', async () => {
    const barrier = await checkGlobalPendingBarrier({ agentDir, cwd: projectDir });
    expect(barrier.active).toBe(false);
  });

  it('activates barrier when Global Attempt Fence is held', async () => {
    const fence = await acquireAttemptFence('global', { agentDir, cwd: projectDir });
    expect(fence.ok).toBe(true);

    try {
      const barrier = await checkGlobalPendingBarrier({ agentDir, cwd: projectDir });
      expect(barrier.active).toBe(true);
      expect(barrier.reason).toContain('Global Attempt Fence is held');
      expect(barrier.finding?.code).toBe('GLOBAL_PENDING_BARRIER');
      expect(barrier.finding?.rule).toBe('BARRIER-01');
    } finally {
      fence.handle?.release();
    }

    // Barrier clears after fence release
    const after = await checkGlobalPendingBarrier({ agentDir, cwd: projectDir });
    expect(after.active).toBe(false);
  });

  it('activates barrier when Global Scope has Pending Application in journal', async () => {
    const pendingRcpt = createReceipt({
      id: 'rcpt_pending_global',
      operation: 'Marketplace Registration',
      scope: 'global',
      trigger: 'register global',
      expectedStateRevision: '0',
      targetStateRevision: '1',
      observedStateRevision: '1',
      durableOutcome: 'committed',
      runtimeOutcome: 'pending-application',
      summary: 'Pending Application',
    });
    await appendReceipt('global', pendingRcpt, { agentDir, cwd: projectDir });

    const barrier = await checkGlobalPendingBarrier({ agentDir, cwd: projectDir });
    expect(barrier.active).toBe(true);
    expect(barrier.reason).toContain('Pending Application');

    // Resolve by appending Completed recovery receipt
    const resolvedRcpt = createReceipt({
      id: 'rcpt_resolved_global',
      operation: 'Runtime Application',
      scope: 'global',
      trigger: 'reapply',
      expectedStateRevision: '1',
      observedStateRevision: '1',
      durableOutcome: 'unchanged',
      runtimeOutcome: 'applied',
      summary: 'Completed',
      recoversReceiptId: 'rcpt_pending_global',
    });
    await appendReceipt('global', resolvedRcpt, { agentDir, cwd: projectDir });

    const after = await checkGlobalPendingBarrier({ agentDir, cwd: projectDir });
    expect(after.active).toBe(false);
  });

  it('activates barrier when Global Scope has corrupted state (Persistence Indeterminate)', async () => {
    const globalStatePath = getStatePath('global', { agentDir, cwd: projectDir });
    const { mkdirSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    mkdirSync(dirname(globalStatePath), { recursive: true });
    writeFileSync(globalStatePath, '{ corrupted state json', 'utf-8');

    const barrier = await checkGlobalPendingBarrier({ agentDir, cwd: projectDir });
    expect(barrier.active).toBe(true);
    expect(barrier.reason).toContain('corrupted');
  });

  it('acquiring Project Attempt Fence fails with GLOBAL_PENDING_BARRIER when barrier is active', async () => {
    // Hold global fence
    const globalFence = await acquireAttemptFence('global', { agentDir, cwd: projectDir });
    expect(globalFence.ok).toBe(true);

    try {
      // Project fence acquisition must fail with GLOBAL_PENDING_BARRIER
      const projectFence = await acquireAttemptFence('project', { agentDir, cwd: projectDir, projectTrusted: true });
      expect(projectFence.ok).toBe(false);
      expect(projectFence.finding?.code).toBe('GLOBAL_PENDING_BARRIER');
      expect(projectFence.finding?.rule).toBe('BARRIER-01');
    } finally {
      globalFence.handle?.release();
    }
  });
});
