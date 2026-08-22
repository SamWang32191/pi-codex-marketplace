/**
 * Source Cache — Git-only, fingerprint-addressed acquisition cache (#22).
 * See CONTEXT.md: Source Acquisition, Validation Snapshot, Stale Snapshot.
 *
 * Guarantees:
 * - Entries are addressed by Validation Snapshot fingerprint under
 *   `${getAgentDir()}/codex-marketplace/cache/entries/<fingerprint>`.
 * - Pinned set = Bridge State referenced fingerprints (registrations + installations)
 *   + pending Update Candidate fingerprints + in-flight pins. Pinned entries are never evicted.
 * - Total budget (default 2 GiB) applies LRU eviction over unpinned entries only,
 *   synchronously during store/prune. No background tasks, no TTL.
 * - Every entry mutation happens under a per-fingerprint lock (mutual exclusion).
 * - Offline reuse is allowed only on an exact fingerprint hit; a Stale Snapshot is never
 *   converted into success — verification is the caller's re-hashed snapshot comparison,
 *   and a mismatch is a Blocking Finding (Source Drift / Stale Snapshot), never reuse.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { cpSync } from 'node:fs';
import { join } from 'node:path';

import { acquireLock, acquireLockSync, releaseLock, atomicWriteFile } from '../bridge-state/atomic.js';
import { readBridgeState } from '../bridge-state/store.js';
import type { BridgeState } from '../bridge-state/types.js';
import type { Scope } from '../bridge-state/types.js';
import {
  getCacheDir,
  getCacheEntriesDir,
  getCacheIndexPath,
  getCacheLocksDir,
  getCachePendingPath,
} from './paths.js';

/** Total cache budget: 2 GiB across all entries (unpinned only are evictable). */
export const CACHE_TOTAL_BUDGET_BYTES = 2 * 1024 * 1024 * 1024;

export interface CacheEntryMeta {
  fingerprint: string;
  bytes: number;
  lastAccessMs: number;
  recordedAtMs: number;
}

export interface CacheIndexRecord {
  /** Last validated Validation Snapshot fingerprint for this locator+selector pair. */
  fingerprint: string;
  resolvedRevision: string;
  canonicalLocator: string;
  selectorCanonical: string;
  recordedAtMs: number;
}

export interface PendingUpdateRecord {
  scope: Scope;
  registrationId: string;
  fingerprint: string;
  recordedAtMs: number;
}

export interface SourceCacheOptions {
  /** Pi agent dir; defaults to getAgentDir(). */
  agentDir?: string;
  /** Explicit cache root override (test seam). */
  root?: string;
  /** Budget override for tests. */
  budgetBytes?: number;
  /** Injectable clock for deterministic lastAccess ordering in tests. */
  clock?: () => number;
}

export interface CacheHit {
  path: string;
  fingerprint: string;
}

function isSafeFingerprint(fp: string): boolean {
  return /^[0-9a-f]{64}$/.test(fp);
}

export class SourceCache {
  readonly root: string;
  private readonly budgetBytes: number;
  private readonly now: () => number;
  private readonly inFlight = new Map<string, number>();

  constructor(opts: SourceCacheOptions = {}) {
    this.root = opts.root ?? getCacheDir(opts.agentDir);
    this.budgetBytes = opts.budgetBytes ?? CACHE_TOTAL_BUDGET_BYTES;
    this.now = opts.clock ?? Date.now;
  }

  entryPath(fingerprint: string): string {
    return join(getCacheEntriesDir(this.root), fingerprint);
  }

  metaPath(fingerprint: string): string {
    return `${this.entryPath(fingerprint)}.meta`;
  }

  lockPath(fingerprint: string): string {
    return join(getCacheLocksDir(this.root), `${fingerprint}.lock`);
  }

  /**
   * Per-fingerprint mutual exclusion around store/prune/touch for that entry.
   * Concurrent operations on the same fingerprint serialize here.
   */
  async withFingerprintLock<T>(fingerprint: string, fn: () => Promise<T> | T, timeoutMs = 5000): Promise<T> {
    const lockPath = this.lockPath(fingerprint);
    const fd = await acquireLock(lockPath, timeoutMs);
    try {
      return await fn();
    } finally {
      releaseLock(fd, lockPath);
    }
  }

  /**
   * Synchronous per-fingerprint mutual exclusion around store/prune/touch for that entry.
   */
  withFingerprintLockSync<T>(fingerprint: string, fn: () => T, timeoutMs = 5000): T {
    const lockPath = this.lockPath(fingerprint);
    const fd = acquireLockSync(lockPath, timeoutMs);
    try {
      return fn();
    } finally {
      releaseLock(fd, lockPath);
    }
  }

  /** Register an in-flight pin (reference-counted); returns its release function. In-flight entries are never evicted. */
  pinInFlight(fingerprint: string): () => void {
    this.inFlight.set(fingerprint, (this.inFlight.get(fingerprint) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = (this.inFlight.get(fingerprint) ?? 1) - 1;
      if (n <= 0) this.inFlight.delete(fingerprint);
      else this.inFlight.set(fingerprint, n);
    };
  }

  /** Exact fingerprint hit: entry directory + matching meta must exist. Touches lastAccess. */
  async hitExact(fingerprint: string): Promise<CacheHit | null> {
    if (!isSafeFingerprint(fingerprint)) return null;
    const dir = this.entryPath(fingerprint);
    const meta = this.readMeta(fingerprint);
    if (!existsSync(dir) || !meta || meta.fingerprint !== fingerprint) return null;
    await this.withFingerprintLock(fingerprint, () => {
      this.touchMeta(fingerprint);
    });
    return { path: dir, fingerprint };
  }

  /** Synchronous exact fingerprint hit: entry directory + matching meta must exist. Touches lastAccess. */
  hitExactSync(fingerprint: string): CacheHit | null {
    if (!isSafeFingerprint(fingerprint)) return null;
    const dir = this.entryPath(fingerprint);
    const meta = this.readMeta(fingerprint);
    if (!existsSync(dir) || !meta || meta.fingerprint !== fingerprint) return null;
    this.withFingerprintLockSync(fingerprint, () => {
      this.touchMeta(fingerprint);
    });
    return { path: dir, fingerprint };
  }

  /**
   * Store an acquired source tree under its fingerprint. The stored fingerprint is pinned
   * for the duration of the store ("in flight"), so its own prune can never evict it.
   */
  async storeTree(root: string, fingerprint: string): Promise<{ stored: boolean; path: string }> {
    const releasePin = this.pinInFlight(fingerprint);
    try {
      return await this.withFingerprintLock(fingerprint, async () => {
        mkdirSync(getCacheEntriesDir(this.root), { recursive: true });
        const dest = this.entryPath(fingerprint);
        if (existsSync(dest)) {
          this.touchMeta(fingerprint);
          return { stored: false, path: dest };
        }
        const bytes = treeBytes(root);
        // Copy to a temp name first so readers never observe a partial tree.
        const tmp = `${dest}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
        cpSync(root, tmp, { recursive: true, verbatimSymlinks: true });
        // Replace any pre-existing (possibly tampered) entry wholesale so a stored
        // fingerprint always hashes true.
        rmSync(dest, { recursive: true, force: true });
        copyTree(tmp, dest);
        this.writeMeta(fingerprint, bytes);
        await this.prune();
        return { stored: true, path: dest };
      });
    } finally {
      releasePin();
    }
  }

  /**
   * Synchronous LRU prune over unpinned entries only. Pinned set =
   * Bridge State references + pending Update Candidates + in-flight pins + extraPinned.
   * No background tasks; called inline after stores.
   */
  async prune(extraPinned: Iterable<string> = []): Promise<void> {
    const pinned = new Set<string>(extraPinned);
    for (const fp of this.inFlight.keys()) pinned.add(fp);
    for (const rec of this.pendingUpdates()) pinned.add(rec.fingerprint);
    for (const fp of await this.statePinnedFingerprints()) pinned.add(fp);

    type Cand = { fingerprint: string; bytes: number; lastAccessMs: number };
    const cands: Cand[] = [];
    const entriesDir = getCacheEntriesDir(this.root);
    if (!existsSync(entriesDir)) return;
    let total = 0;
    for (const name of readdirSync(entriesDir)) {
      // Skip in-progress temp copies.
      if (name.includes('.tmp-')) continue;
      const meta = this.readMeta(name);
      if (!meta || !isSafeFingerprint(name)) continue;
      total += meta.bytes;
      if (!pinned.has(name)) cands.push({ fingerprint: name, bytes: meta.bytes, lastAccessMs: meta.lastAccessMs });
    }
    // LRU over unpinned only, ascending lastAccess.
    cands.sort((a, b) => a.lastAccessMs - b.lastAccessMs);
    for (const cand of cands) {
      if (total <= this.budgetBytes) break;
      rmSync(this.entryPath(cand.fingerprint), { recursive: true, force: true });
      rmSync(this.metaPath(cand.fingerprint), { force: true });
      total -= cand.bytes;
    }
  }

  /** Fingerprints referenced by authoritative Bridge State (both scopes). Never evicted. */
  async statePinnedFingerprints(): Promise<Set<string>> {
    const pinned = new Set<string>();
    for (const scope of ['global', 'project'] as const) {
      const read = await readBridgeState(scope, {});
      collectPinned(read.state, pinned);
    }
    return pinned;
  }

  /** Collect pinned fingerprints from already-read state documents (test seam, no I/O). */
  static pinnedFromStates(states: (BridgeState | undefined)[]): Set<string> {
    const pinned = new Set<string>();
    for (const s of states) collectPinned(s, pinned);
    return pinned;
  }

  // ---- Pending Update Candidate registry ---------------------------------

  recordPendingUpdate(rec: Omit<PendingUpdateRecord, 'recordedAtMs'>): void {
    const records = this.pendingUpdates().filter((r) => !(r.scope === rec.scope && r.registrationId === rec.registrationId));
    records.push({ ...rec, recordedAtMs: this.now() });
    atomicWriteFile(getCachePendingPath(this.root), JSON.stringify(records));
  }

  clearPendingUpdate(scope: Scope, registrationId: string): void {
    const records = this.pendingUpdates().filter((r) => !(r.scope === scope && r.registrationId === registrationId));
    atomicWriteFile(getCachePendingPath(this.root), JSON.stringify(records));
  }

  pendingUpdates(): PendingUpdateRecord[] {
    const p = getCachePendingPath(this.root);
    if (!existsSync(p)) return [];
    try {
      const parsed: unknown = JSON.parse(readFileSync(p, 'utf-8'));
      return Array.isArray(parsed) ? (parsed as PendingUpdateRecord[]) : [];
    } catch {
      return [];
    }
  }

  // ---- Locator+selector → fingerprint index ------------------------------

  recordIndex(rec: Omit<CacheIndexRecord, 'recordedAtMs'>): void {
    const index = this.readIndex();
    index[indexKey(rec.canonicalLocator, rec.selectorCanonical)] = { ...rec, recordedAtMs: this.now() };
    atomicWriteFile(getCacheIndexPath(this.root), JSON.stringify(index));
  }

  readIndex(): Record<string, CacheIndexRecord> {
    const p = getCacheIndexPath(this.root);
    if (!existsSync(p)) return {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(p, 'utf-8'));
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, CacheIndexRecord>) : {};
    } catch {
      return {};
    }
  }

  /**
   * Offline reuse seam: only an exact fingerprint hit counts. Returns the cached tree only when
   * the index records exactly `expectedFingerprint` for this locator+selector AND that exact
   * entry is present in the cache. The hit refreshes LRU recency. Callers must still verify by
   * re-hashing the tree; any mismatch is a Blocking Finding and never success.
   */
  async offlineHit(canonicalLocator: string, selectorCanonical: string, expectedFingerprint: string): Promise<CacheHit | null> {
    if (!expectedFingerprint) return null;
    const rec = this.readIndex()[indexKey(canonicalLocator, selectorCanonical)];
    if (!rec || rec.fingerprint !== expectedFingerprint) return null;
    const dir = this.entryPath(expectedFingerprint);
    const meta = this.readMeta(expectedFingerprint);
    if (!existsSync(dir) || !meta || meta.fingerprint !== expectedFingerprint) return null;
    await this.withFingerprintLock(expectedFingerprint, () => {
      this.touchMeta(expectedFingerprint);
    });
    return { path: dir, fingerprint: expectedFingerprint };
  }

  // ---- internals ----------------------------------------------------------

  private readMeta(fingerprint: string): CacheEntryMeta | null {
    const p = this.metaPath(fingerprint);
    if (!existsSync(p)) return null;
    try {
      const parsed: unknown = JSON.parse(readFileSync(p, 'utf-8'));
      if (parsed && typeof parsed === 'object' && typeof (parsed as CacheEntryMeta).fingerprint === 'string') {
        return parsed as CacheEntryMeta;
      }
      return null;
    } catch {
      return null;
    }
  }

  private touchMeta(fingerprint: string): void {
    const meta = this.readMeta(fingerprint);
    if (!meta) return;
    meta.lastAccessMs = this.now();
    this.writeMeta(fingerprint, meta.bytes, meta.recordedAtMs);
  }

  private writeMeta(fingerprint: string, bytes: number, recordedAtMs?: number): void {
    const at = this.now();
    atomicWriteFile(
      this.metaPath(fingerprint),
      JSON.stringify({ fingerprint, bytes, lastAccessMs: at, recordedAtMs: recordedAtMs ?? at } satisfies CacheEntryMeta),
    );
  }
}

/** Canonical index key for a locator+selector pair. */
function indexKey(canonicalLocator: string, selectorCanonical: string): string {
  return `${canonicalLocator}\u001f${selectorCanonical}`;
}

/** Move a fully-written temp copy into place; a vanished source is a no-op. */
function copyTree(from: string, to: string): void {
  try {
    statSync(from);
    cpSync(from, to, { recursive: true, verbatimSymlinks: true });
    rmSync(from, { recursive: true, force: true });
  } catch {}
}

function collectPinned(state: BridgeState | undefined, pinned: Set<string>): void {
  if (!state) return;
  for (const r of state.registrations ?? []) if (r.validationSnapshot) pinned.add(r.validationSnapshot);
  for (const i of state.installations ?? []) if (i.validationSnapshot) pinned.add(i.validationSnapshot);
}

/** Recursive byte size of a tree (files only). */
export function treeBytes(root: string): number {
  let total = 0;
  const walk = (dir: string): void => {
    let stats;
    try {
      stats = statSync(dir);
    } catch {
      return;
    }
    if (!stats.isDirectory()) {
      total += stats.size;
      return;
    }
    for (const name of readdirSync(dir)) walk(join(dir, name));
  };
  walk(root);
  return total;
}
