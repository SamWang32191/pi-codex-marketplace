import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CACHE_TOTAL_BUDGET_BYTES,
  SourceCache,
  treeBytes,
} from '../../../src/cache/source-cache.js';
import type { BridgeState, Registration } from '../../../src/bridge-state/types.js';

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
    cache = new SourceCache({ root, budgetBytes: Math.floor(probe * 2.5), clock: () => (tick += 10) });

    await cache.storeTree(mk(FP_A), FP_A); // oldest
    await cache.storeTree(mk(FP_B), FP_B);
    // A pending Update Candidate fingerprint is pinned (not itself stored here).
    cache.recordPendingUpdate({ scope: 'global', registrationId: 'r1', fingerprint: FP_PINNED });
    await cache.storeTree(mk(FP_C), FP_C);
    await cache.prune();

    // FP_A (oldest unpinned) must be evicted; newer entries remain.
    expect(existsSync(cache.entryPath(FP_A))).toBe(false);
    expect(existsSync(cache.entryPath(FP_B))).toBe(true);
    expect(existsSync(cache.entryPath(FP_C))).toBe(true);
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

  it('records and clears pending Update Candidate fingerprints', () => {
    cache.recordPendingUpdate({ scope: 'global', registrationId: 'reg-1', fingerprint: FP_A });
    cache.recordPendingUpdate({ scope: 'global', registrationId: 'reg-1', fingerprint: FP_B }); // replaces
    cache.recordPendingUpdate({ scope: 'project', registrationId: 'reg-2', fingerprint: FP_C });
    expect(cache.pendingUpdates().map((r) => r.fingerprint).sort()).toEqual([FP_B, FP_C].sort());
    cache.clearPendingUpdate('global', 'reg-1');
    expect(cache.pendingUpdates().map((r) => r.fingerprint)).toEqual([FP_C]);
  });

  it('offline reuse requires an exact index fingerprint match AND a present entry', async () => {
    const src = makeTree(join(root, 'src'));
    await cache.storeTree(src, FP_A);
    cache.recordIndex({
      fingerprint: FP_A,
      resolvedRevision: '1'.repeat(40),
      canonicalLocator: 'https://github.com/acme/plugins.git',
      selectorCanonical: 'refs/heads/main',
    });
    const hit = await cache.offlineHit('https://github.com/acme/plugins.git', 'refs/heads/main', FP_A);
    expect(hit?.fingerprint).toBe(FP_A);
    // Different expected fingerprint → no hit (Stale Snapshot never becomes success).
    expect(await cache.offlineHit('https://github.com/acme/plugins.git', 'refs/heads/main', FP_B)).toBeNull();
    // Unknown selector → no hit.
    expect(await cache.offlineHit('https://github.com/acme/plugins.git', 'refs/tags/v1', FP_A)).toBeNull();
    // Missing entry → no hit even with matching index.
    rmSync(cache.entryPath(FP_A), { recursive: true, force: true });
    expect(await cache.offlineHit('https://github.com/acme/plugins.git', 'refs/heads/main', FP_A)).toBeNull();
  });

  it('collects pinned fingerprints from Bridge State documents without I/O', () => {
    const globalState = {
      registrations: [{ validationSnapshot: FP_A }],
      installations: [{ validationSnapshot: FP_B }],
    } as unknown as BridgeState;
    const projectState = {
      registrations: [],
      installations: [{ validationSnapshot: FP_C }],
    } as unknown as BridgeState;
    const pinned = SourceCache.pinnedFromStates([globalState, projectState]);
    expect(pinned).toEqual(new Set([FP_A, FP_B, FP_C]));
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
