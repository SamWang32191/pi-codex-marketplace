import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { commitBridgeState, readBridgeState } from '../../src/bridge-state/store.js';
import { getGlobalStatePath } from '../../src/bridge-state/paths.js';
import { atomicWriteFile, withFileLock } from '../../src/bridge-state/atomic.js';

describe('Atomic store — cross-process concurrency and durability', () => {
  let tmpRoot: string;
  let agentDir: string;
  let projectDir: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bridge-atomic-'));
    agentDir = join(tmpRoot, 'agent');
    projectDir = join(tmpRoot, 'project');
  });

  afterEach(() => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  });

  it('concurrent commits do not corrupt file (file lock protects RMW)', async () => {
    // Fire 10 concurrent commits to same scope
    const promises = Array.from({ length: 10 }, (_, i) =>
      commitBridgeState(
        'global',
        (cur) => ({
          ...cur,
          registrations: [
            ...cur.registrations,
            { id: `id-${i}-${Date.now()}`, alias: `mp-${i}` },
          ],
        }),
        { agentDir, cwd: projectDir },
      ),
    );

    const results = await Promise.all(promises);
    // All should succeed (lock serializes), or at least none corrupt
    // With lock, revisions should be monotonic and all succeed
    const successes = results.filter((r) => r.success);
    // At least some succeed; due to RMW under lock, all 10 should succeed sequentially
    expect(successes.length).toBe(10);

    const final = await readBridgeState('global', { agentDir, cwd: projectDir });
    expect(final.status).toBe('ok');
    expect(final.state!.stateRevision).toBe('10');
    // All registrations should be present (no lost writes beyond last)
    // Because each updater clones current, and lock re-reads, no lost update
    expect(final.state!.registrations.length).toBe(10);
  });

  it('atomicWriteFile leaves valid JSON even under rapid writes', async () => {
    const target = join(tmpRoot, 'test.json');
    // Rapid atomic writes without lock (just atomic rename) should not leave torn JSON
    const writes = Array.from({ length: 20 }, (_, i) =>
      atomicWriteFile(target, JSON.stringify({ n: i, pad: 'x'.repeat(1000) })),
    );
    // All writes synchronously; check file is still valid JSON with one of the values
    expect(existsSync(target)).toBe(true);
    const content = readFileSync(target, 'utf-8');
    const parsed = JSON.parse(content);
    expect(typeof parsed.n).toBe('number');
    expect(parsed.n).toBeGreaterThanOrEqual(0);
    expect(parsed.n).toBeLessThan(20);
  });

  it('withFileLock serializes access', async () => {
    const lockPath = join(tmpRoot, 'test.lock');
    const order: number[] = [];
    const tasks = Array.from({ length: 5 }, (_, i) =>
      withFileLock(lockPath, async () => {
        order.push(i);
        // Simulate work
        await new Promise((r) => setTimeout(r, 10));
        return i;
      }),
    );
    const results = await Promise.all(tasks);
    expect(results).toHaveLength(5);
    // Order should be 0..4 (serialized)
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  it('corrupted file after concurrent writer still classified as Indeterminate, not silently fixed', async () => {
    // First, create a valid file
    await commitBridgeState('global', (c) => ({ ...c }), { agentDir, cwd: projectDir });
    const path = getGlobalStatePath(agentDir);
    expect(existsSync(path)).toBe(true);

    // Corrupt it externally
    const { writeFileSync } = await import('node:fs');
    const { mkdirSync } = await import('node:fs');
    // ensure dir
    writeFileSync(path, '<<<corrupted>>>', 'utf-8');

    const after = await readBridgeState('global', { agentDir, cwd: projectDir });
    expect(after.status).toBe('corrupted');

    // Another concurrent commit attempt should not overwrite corrupted file silently
    const attempt = await commitBridgeState('global', (c) => ({ ...c }), { agentDir, cwd: projectDir });
    expect(attempt.success).toBe(false);
    const stillCorrupted = readFileSync(path, 'utf-8');
    expect(stillCorrupted).toBe('<<<corrupted>>>');
  });
});
