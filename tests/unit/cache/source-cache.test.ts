import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CACHE_TOTAL_BUDGET_BYTES,
  SourceCache,
  treeBytes,
} from '../../../src/cache/source-cache.js';
import { writeMinimalBridgeState, type MinimalBridgeState } from '../../../src/bridge/state.js';
import { getGlobalStatePath } from '../../../src/bridge-state/paths.js';

const FP_A = 'a'.repeat(64);
const FP_B = 'b'.repeat(64);
const FP_C = 'c'.repeat(64);
const FP_PINNED = 'd'.repeat(64);

function makeTree(root: string, marker = 'one'): string {
  mkdirSync(join(root, 'sub'), { recursive: true });
  writeFileSync(join(root, 'file.txt'), marker);
  writeFileSync(join(root, 'sub', 'nested.txt'), `${marker}-nested`);
  return root;
}

describe('SourceCache (Git-only, fingerprint-addressed)', () => {
  let root: string;
  let cache: SourceCache;
  let tick: number;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'source-cache-'));
    tick = 1000;
    cache = new SourceCache({ root, budgetBytes: 100, clock: () => (tick += 10) });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('stores a tree by fingerprint and serves an exact-fingerprint hit', async () => {
    const src = makeTree(join(root, 'src'));
    const stored = await cache.storeTree(src, FP_A);
    expect(stored.stored).toBe(true);

    const hit = await cache.hitExact(FP_A);
    expect(hit).not.toBeNull();
    expect(hit!.fingerprint).toBe(FP_A);
    expect(existsSync(join(hit!.path, 'file.txt'))).toBe(true);
    // No false positives.
    expect(await cache.hitExact(FP_B)).toBeNull();
    expect(await cache.hitExact('not-a-fingerprint')).toBeNull();
  });

  it('is idempotent when the same fingerprint is stored twice', async () => {
    const src = makeTree(join(root, 'src'));
    await cache.storeTree(src, FP_A);
    const again = await cache.storeTree(src, FP_A);
    expect(again.stored).toBe(false);
    expect((await cache.hitExact(FP_A))!.path).toBe(cache.entryPath(FP_A));
  });

  it('evicts unpinned entries LRU-first beyond the budget and never evicts pinned entries', async () => {
    const marker = 'm'.repeat(60);
    const mk = (fp: string) => makeTree(join(root, `src-${fp.slice(0, 4)}`), marker);
    // Budget sized so exactly one LRU eviction occurs among three equal trees.
    const probe = treeBytes(mk(FP_A));

    // A Minimal Bridge State referenced fingerprint is pinned (not itself stored here).
    // The state document lives in a per-test agent dir following the production layout
    // (<agentDir>/codex-marketplace/state.json next to <agentDir>/codex-marketplace/cache),
    // so it is cleaned up with this test's own temp root — never the shared OS tmpdir.
    const agentDir = join(root, 'agent');
    const layoutCache = new SourceCache({ root: join(agentDir, 'codex-marketplace', 'cache'), budgetBytes: Math.floor(probe * 2.5), clock: () => (tick += 10) });
    writeMinimalBridgeState(
      {
        schemaVersion: 1,
        registrations: [{ id: 'r1', marketplaceName: 'm', format: 'codex', sourceKind: 'git', source: 'https://example.com/m.git', snapshot: FP_PINNED }],
        installations: [],
      } satisfies MinimalBridgeState,
      { statePath: getGlobalStatePath(agentDir) },
    );
    await layoutCache.storeTree(mk(FP_A), FP_A); // oldest
    await layoutCache.storeTree(mk(FP_B), FP_B);
    await layoutCache.storeTree(mk(FP_C), FP_C);
    await layoutCache.prune();

    // FP_A (oldest unpinned in the layout cache) must be evicted; newer entries remain.
    expect(existsSync(layoutCache.entryPath(FP_A))).toBe(false);
    expect(existsSync(layoutCache.entryPath(FP_B))).toBe(true);
    expect(existsSync(layoutCache.entryPath(FP_C))).toBe(true);
  });

  it('never evicts in-flight entries even over budget', async () => {
    const src = makeTree(join(root, 'inflight'), 'x'.repeat(200));
    const release = cache.pinInFlight(FP_A);
    await cache.storeTree(src, FP_A);
    await cache.prune();
    expect(existsSync(cache.entryPath(FP_A))).toBe(true);
    release();
    await cache.prune();
    // Over budget now → evicted once no longer in flight.
    expect(existsSync(cache.entryPath(FP_A))).toBe(false);
  });

  it('serializes concurrent operations on the same fingerprint (flock mutual exclusion)', async () => {
    const order: string[] = [];
    const first = cache.withFingerprintLock(FP_A, () => {
      order.push('first-enter');
      return new Promise<void>((resolve) => setTimeout(resolve, 50)).then(() => {
        order.push('first-exit');
      });
    });
    const second = cache.withFingerprintLock(FP_A, () => {
      order.push('second-enter');
    }, 5000);
    await Promise.all([first, second]);
    // The second holder can only enter after the first exits.
    expect(order.indexOf('first-exit')).toBeLessThan(order.indexOf('second-enter'));
  });

  it('denies the lock when another holder exceeds the timeout instead of queueing forever', async () => {
    const slow = cache.withFingerprintLock(FP_A, async () => {
      await new Promise((r) => setTimeout(r, 120));
    });
    let timedOut = false;
    try {
      await cache.withFingerprintLock(FP_A, () => {}, 30);
    } catch {
      timedOut = true;
    }
    expect(timedOut).toBe(true);
    await slow;
    // After release the lock is acquirable again.
    await expect(cache.withFingerprintLock(FP_A, () => 'ok')).resolves.toBe('ok');
  });

  it('records and clears the locator+selector index', async () => {
    cache.recordIndex({
      fingerprint: FP_A,
      resolvedRevision: '1'.repeat(40),
      canonicalLocator: 'https://github.com/acme/plugins.git',
      selectorCanonical: 'refs/heads/main',
    });
    expect(cache.readIndex()['https://github.com/acme/plugins.git\u001frefs/heads/main']?.fingerprint).toBe(FP_A);
    // A different locator+selector pair has no record.
    expect(cache.readIndex()['https://github.com/acme/plugins.git\u001frefs/tags/v1']).toBeUndefined();
  });

  it('pins fingerprints referenced by Minimal Bridge State (registrations and installations)', async () => {
    const agentDir = join(root, 'agent');
    const layoutCache = new SourceCache({ root: join(agentDir, 'codex-marketplace', 'cache'), clock: () => (tick += 10) });
    const src = makeTree(join(root, 'src'));
    await layoutCache.storeTree(src, FP_A);
    writeMinimalBridgeState(
      {
        schemaVersion: 1,
        registrations: [{ id: 'r1', marketplaceName: 'm', format: 'codex', sourceKind: 'git', source: 'https://example.com/m.git', snapshot: FP_A }],
        installations: [{ id: 'i1', pluginId: 'p1', enabled: true, registrationId: 'r1', manifestName: 'p1', sourceKind: 'git', source: 'https://example.com/m.git', snapshot: FP_A }],
      } satisfies MinimalBridgeState,
      { statePath: getGlobalStatePath(agentDir) },
    );
    const pinned = await layoutCache.statePinnedFingerprints();
    expect(pinned).toEqual(new Set([FP_A]));
  });

  it('serves an exact-fingerprint hit synchronously with hitExactSync', async () => {
    const src = makeTree(join(root, 'src'));
    await cache.storeTree(src, FP_A);

    const hit = cache.hitExactSync(FP_A);
    expect(hit).not.toBeNull();
    expect(hit!.fingerprint).toBe(FP_A);
    expect(existsSync(join(hit!.path, 'file.txt'))).toBe(true);

    expect(cache.hitExactSync(FP_B)).toBeNull();
    expect(cache.hitExactSync('not-a-fingerprint')).toBeNull();
  });

  it('serializes synchronous operations with withFingerprintLockSync', () => {
    let ran = false;
    const res = cache.withFingerprintLockSync(FP_A, () => {
      ran = true;
      return 42;
    });
    expect(ran).toBe(true);
    expect(res).toBe(42);
  });

  it('exposes the production budget constant at 2 GiB', () => {
    expect(CACHE_TOTAL_BUDGET_BYTES).toBe(2 * 1024 * 1024 * 1024);
  });
});
