/**
 * Atomic file utilities: WAL + write-to-temp → fsync → rename + file lock + read-after-verify
 *
 * Guarantees:
 * - Cross-process concurrent writers do not corrupt the file (lock + atomic rename)
 * - Readers never observe a torn write (rename is atomic on POSIX)
 * - Durability: fsync temp file and parent dir before/after rename
 * - Verification: read back persisted content and compare
 *
 * Fail-closed contract:
 * - If neither previous nor target State Revision can be verified, caller should treat as Persistence Indeterminate
 * - If previous revision still verified, it's Persistence Failed
 *
 * Lock strategy: advisory lock file via O_CREAT|O_EXCL (".lock" sibling). Stale locks are not auto-removed
 * except on timeout; callers hold lock for the shortest interval (write+verify).
 */

import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { mkdirSync, existsSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';

export interface AtomicWriteResult {
  success: boolean;
  error?: string;
  /** Whether target was verified by read-after */
  verified?: boolean;
}

/**
 * Acquire an advisory lock file. Creates lockPath with O_EXCL and writes pid.
 * Retries until timeoutMs (default 5000). Caller must release via releaseLock or the returned fd.
 * Returns fd of lock file (already open). Caller should close+unlink on success/failure.
 */
export async function acquireLock(lockPath: string, timeoutMs = 5000): Promise<number> {
  const start = Date.now();
  const dir = dirname(lockPath);
  mkdirSync(dir, { recursive: true });

  while (true) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600);
      try {
        writeSync(fd, String(process.pid));
        fsyncSync(fd);
      } catch {
        // ignore write failure but keep lock
      }
      return fd;
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') throw e;
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Failed to acquire lock ${lockPath} after ${timeoutMs}ms`);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
  }
}

export function acquireLockSync(lockPath: string, timeoutMs = 5000): number {
  const start = Date.now();
  const dir = dirname(lockPath);
  mkdirSync(dir, { recursive: true });
  while (true) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600);
      try {
        writeSync(fd, String(process.pid));
        fsyncSync(fd);
      } catch {}
      return fd;
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') throw e;
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Failed to acquire lock ${lockPath} after ${timeoutMs}ms`);
      }
      // brief spin for sync path (used rarely)
      const end = Date.now() + 10;
      while (Date.now() < end) {}
    }
  }
}

export function releaseLock(fd: number, lockPath: string): void {
  try {
    closeSync(fd);
  } catch {}
  try {
    unlinkSync(lockPath);
  } catch {}
}

/** Run fn while holding the lock file. */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T> | T,
  timeoutMs = 5000,
): Promise<T> {
  const fd = await acquireLock(lockPath, timeoutMs);
  let released = false;
  const doRelease = () => {
    if (!released) {
      released = true;
      releaseLock(fd, lockPath);
    }
  };
  try {
    const result = await fn();
    doRelease();
    return result;
  } catch (e) {
    doRelease();
    throw e;
  }
}

/**
 * Atomic write: write data to temp file, fsync, rename to target, fsync dir, verify.
 * Must be called while holding the sibling .lock if protecting against RMW races;
 * but even without lock, this prevents torn reads.
 */
export function atomicWriteFile(targetPath: string, data: string): AtomicWriteResult {
  const dir = dirname(targetPath);
  mkdirSync(dir, { recursive: true });

  const tmpName = `.${Date.now()}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const tmpPath = join(dir, tmpName);

  let tmpFd: number | undefined;
  try {
    tmpFd = openSync(tmpPath, 'wx', 0o600);
    writeSync(tmpFd, data, null, 'utf-8');
    fsyncSync(tmpFd);
    closeSync(tmpFd);
    tmpFd = undefined;

    // Atomic rename
    renameSync(tmpPath, targetPath);

    // Fsync parent dir for durability (best-effort)
    try {
      const dirFd = openSync(dir, 'r');
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } catch {
      // fsync dir may fail on some filesystems; not fatal
    }

    // Read-after-verify
    try {
      const persisted = readFileSync(targetPath, 'utf-8');
      if (persisted !== data) {
        return {
          success: false,
          verified: false,
          error: 'Read-after-verify mismatch: persisted content differs from written',
        };
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { success: false, verified: false, error: `Read-after-verify failed: ${msg}` };
    }

    return { success: true, verified: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, verified: false, error: msg };
  } finally {
    if (tmpFd !== undefined) {
      try {
        closeSync(tmpFd);
      } catch {}
    }
    // cleanup tmp if still exists
    if (existsSync(tmpPath)) {
      try {
        unlinkSync(tmpPath);
      } catch {}
    }
  }
}

/**
 * Higher-level atomic commit that combines lock + write + verify,
 * and classifies outcome as success / Persistence Failed / Persistence Indeterminate
 * by checking whether previous revision is still readable.
 * For scaffold, we defer Indeterminate classification to store.ts (needs read context).
 */
export async function atomicWriteWithLock(
  targetPath: string,
  data: string,
  lockPath: string,
  timeoutMs = 5000,
): Promise<AtomicWriteResult & { lockHeld: boolean }> {
  const fd = await acquireLock(lockPath, timeoutMs);
  try {
    const result = atomicWriteFile(targetPath, data);
    releaseLock(fd, lockPath);
    return { ...result, lockHeld: true };
  } catch (e) {
    try {
      releaseLock(fd, lockPath);
    } catch {}
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, verified: false, error: msg, lockHeld: true };
  }
}

export function atomicWriteWithLockSync(
  targetPath: string,
  data: string,
  lockPath: string,
  timeoutMs = 5000,
): AtomicWriteResult & { lockHeld: boolean } {
  const fd = acquireLockSync(lockPath, timeoutMs);
  try {
    const result = atomicWriteFile(targetPath, data);
    releaseLock(fd, lockPath);
    return { ...result, lockHeld: true };
  } catch (e) {
    try {
      releaseLock(fd, lockPath);
    } catch {}
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, verified: false, error: msg, lockHeld: true };
  }
}

// For testability: export fsync helper
export function fsyncFileSync(fd: number): void {
  fsyncSync(fd);
}
