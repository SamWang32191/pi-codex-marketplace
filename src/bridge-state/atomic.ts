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
 * Lock strategy: advisory lock file atomically published from a fully-fsynced same-directory temp file.
 * A lock is reclaimed only when its same-host owner can be proven dead; unknown ownership fails closed.
 */

import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { performance } from 'node:perf_hooks';
import { basename, dirname, join } from 'node:path';

export interface AtomicWriteResult {
  success: boolean;
  error?: string;
  /** Whether target was verified by read-after */
  verified?: boolean;
}

export interface FileLockMetadata {
  version: 1;
  pid: number;
  processStartIdentity: string;
  hostname: string;
  token: string;
  acquiredAt: string;
}

interface FileIdentity {
  dev: number;
  ino: number;
}

interface LockObservation {
  identity: FileIdentity;
  metadata?: FileLockMetadata;
}

interface OwnedLock extends LockObservation {
  lockPath: string;
  metadata: FileLockMetadata;
}

interface ReclaimOwnerMetadata extends FileLockMetadata {
  kind: 'file-lock-reclaimer-v1';
  observedLockToken: string;
  observedLockDev: string;
  observedLockIno: string;
}

const MAX_LOCK_METADATA_BYTES = 16 * 1024;
const LOCAL_HOSTNAME = hostname();

function readProcessStartIdentity(pid: number): string | undefined {
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
      const commandEnd = stat.lastIndexOf(')');
      if (commandEnd < 0) return undefined;
      // After the parenthesized command, index 0 is field 3 (state); starttime is field 22.
      const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
      const startTicks = fields[19];
      const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf-8').trim();
      if (!startTicks || !/^\d+$/.test(startTicks) || !bootId) return undefined;
      return `linux:${bootId}:${startTicks}`;
    } catch {
      return undefined;
    }
  }

  if (process.platform === 'darwin') {
    try {
      const started = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf-8',
        env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      return started ? `darwin:${started}` : undefined;
    } catch {
      return undefined;
    }
  }

  return undefined;
}

const PROCESS_START_IDENTITY = readProcessStartIdentity(process.pid) ??
  `node:${process.pid}:${performance.timeOrigin.toFixed(3)}`;
const ownedLocks = new Map<number, OwnedLock>();

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException)?.code === code;
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function parseLockMetadata(content: string): FileLockMetadata | undefined {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== 1 ||
    !Number.isSafeInteger(candidate.pid) ||
    (candidate.pid as number) <= 0 ||
    typeof candidate.processStartIdentity !== 'string' ||
    candidate.processStartIdentity.length === 0 ||
    typeof candidate.hostname !== 'string' ||
    candidate.hostname.length === 0 ||
    typeof candidate.token !== 'string' ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(candidate.token) ||
    typeof candidate.acquiredAt !== 'string' ||
    !Number.isFinite(Date.parse(candidate.acquiredAt))
  ) {
    return undefined;
  }
  return candidate as unknown as FileLockMetadata;
}

/** Read one stable inode. Missing is distinct from present-but-unverifiable metadata. */
function observeLock(lockPath: string): LockObservation | undefined {
  let fd: number | undefined;
  try {
    const pathStat = lstatSync(lockPath);
    const pathIdentity = { dev: pathStat.dev, ino: pathStat.ino };
    if (!pathStat.isFile()) return { identity: pathIdentity };

    // lstat avoids opening known special files; O_NONBLOCK also closes the replacement race
    // where a regular file becomes a FIFO/device between lstat and open.
    fd = openSync(
      lockPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = fstatSync(fd);
    const identity = { dev: stat.dev, ino: stat.ino };
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_LOCK_METADATA_BYTES) {
      return { identity };
    }
    const metadata = parseLockMetadata(readFileSync(fd, 'utf-8'));
    return metadata ? { identity, metadata } : { identity };
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    // Symlinks, permission failures, special files, and other uncertainty fail closed.
    return { identity: { dev: -1, ino: -1 } };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

function observationMatches(current: LockObservation | undefined, expected: LockObservation): boolean {
  return !!current &&
    sameIdentity(current.identity, expected.identity) &&
    !!current.metadata &&
    !!expected.metadata &&
    current.metadata.token === expected.metadata.token;
}

function ownerIsProvablyDead(metadata: FileLockMetadata): boolean {
  if (metadata.hostname !== LOCAL_HOSTNAME) return false;
  if (metadata.pid === process.pid) {
    // A mismatch with this process's stable start identity proves local PID reuse.
    return metadata.processStartIdentity !== PROCESS_START_IDENTITY;
  }

  const observedStartIdentity = readProcessStartIdentity(metadata.pid);
  const recordedScheme = metadata.processStartIdentity.split(':', 1)[0];
  const observedScheme = observedStartIdentity?.split(':', 1)[0];
  if (
    observedStartIdentity &&
    recordedScheme !== 'node' &&
    recordedScheme === observedScheme
  ) {
    // A process exists under the PID, but an exact start-identity mismatch proves it is a reuse.
    return observedStartIdentity !== metadata.processStartIdentity;
  }

  try {
    process.kill(metadata.pid, 0);
    return false;
  } catch (error) {
    // EPERM and every other uncertain result retain the lock. Age is never evidence of death.
    return isErrno(error, 'ESRCH');
  }
}

function unlinkMatchingObservation(lockPath: string, expected: LockObservation): boolean {
  const current = observeLock(lockPath);
  if (!observationMatches(current, expected)) return false;
  try {
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function reclaimSidecarPrefix(lockPath: string): string {
  return `${basename(lockPath)}.reclaim-owner.`;
}

function reclaimSidecarPath(lockPath: string, token: string): string {
  return join(dirname(lockPath), `${reclaimSidecarPrefix(lockPath)}${token}`);
}

function asReclaimOwnerMetadata(observation: LockObservation | undefined): ReclaimOwnerMetadata | undefined {
  if (!observation?.metadata) return undefined;
  const candidate = observation.metadata as unknown as Record<string, unknown>;
  if (
    candidate.kind !== 'file-lock-reclaimer-v1' ||
    typeof candidate.observedLockToken !== 'string' ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(candidate.observedLockToken) ||
    typeof candidate.observedLockDev !== 'string' ||
    !/^\d+$/.test(candidate.observedLockDev) ||
    typeof candidate.observedLockIno !== 'string' ||
    !/^\d+$/.test(candidate.observedLockIno)
  ) {
    return undefined;
  }
  return candidate as unknown as ReclaimOwnerMetadata;
}

function reclaimOwnerTargetsLock(metadata: ReclaimOwnerMetadata, lock: LockObservation): boolean {
  return !!lock.metadata &&
    metadata.observedLockToken === lock.metadata.token &&
    metadata.observedLockDev === String(lock.identity.dev) &&
    metadata.observedLockIno === String(lock.identity.ino);
}

/**
 * Move a verified path to a unique quarantine before unlinking it. If a replacement crossed the
 * observation, put that unexpected inode back instead of deleting it.
 */
function removeMatchingPathViaQuarantine(path: string, expected: LockObservation): boolean {
  const quarantinePath = `${path}.remove-${randomBytes(12).toString('hex')}`;
  try {
    renameSync(path, quarantinePath);
  } catch (error) {
    return isErrno(error, 'ENOENT');
  }

  const moved = observeLock(quarantinePath);
  if (!observationMatches(moved, expected)) {
    if (moved) {
      try {
        linkSync(quarantinePath, path);
        unlinkMatchingObservation(quarantinePath, moved);
      } catch {
        // Preserve the unexpected inode in quarantine if it cannot be safely restored.
      }
    }
    return false;
  }

  unlinkMatchingObservation(quarantinePath, expected);
  return true;
}

/**
 * Clear dead internal guards and report whether no live/unverifiable guard was observed.
 *
 * Guards are unique, metadata-identified siblings rather than a fixed public-looking suffix.
 * Acquisition checks them both before and after publishing the main lock, so a guard that races
 * the first scan is still observed before the new owner enters its critical section.
 */
function clearDeadReclaimGuards(lockPath: string): boolean {
  const dir = dirname(lockPath);
  const prefix = reclaimSidecarPrefix(lockPath);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return false;
  }

  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    const pathToken = entry.slice(prefix.length);
    // Temps and arbitrary caller-owned files in the same namespace are not internal guards.
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(pathToken)) continue;

    const sidecarPath = join(dir, entry);
    const sidecar = observeLock(sidecarPath);
    const owner = asReclaimOwnerMetadata(sidecar);
    if (!sidecar || !owner || owner.token !== pathToken) continue;
    if (!ownerIsProvablyDead(owner)) return false;
    if (!removeMatchingPathViaQuarantine(sidecarPath, sidecar)) return false;
  }
  return true;
}

function publishReclaimOwnerSidecar(
  lockPath: string,
  observed: LockObservation & { metadata: FileLockMetadata },
): { path: string; observation: LockObservation & { metadata: ReclaimOwnerMetadata } } | undefined {
  const owner = newLockMetadata();
  const metadata: ReclaimOwnerMetadata = {
    ...owner,
    kind: 'file-lock-reclaimer-v1',
    observedLockToken: observed.metadata.token,
    observedLockDev: String(observed.identity.dev),
    observedLockIno: String(observed.identity.ino),
  };
  const sidecarPath = reclaimSidecarPath(lockPath, metadata.token);
  const tempPath = `${sidecarPath}.lock-tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tempPath, 'wx', 0o600);
    writeFileSync(fd, `${JSON.stringify(metadata)}\n`, 'utf-8');
    fsyncSync(fd);
    const stat = fstatSync(fd);
    linkSync(tempPath, sidecarPath);
    return {
      path: sidecarPath,
      observation: {
        identity: { dev: stat.dev, ino: stat.ino },
        metadata,
      },
    };
  } catch {
    return undefined;
  } finally {
    try {
      unlinkSync(tempPath);
    } catch {}
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

function reclaimPublishedLock(lockPath: string, expected: LockObservation): boolean {
  const quarantinePath = `${lockPath}.reclaimed-${randomBytes(12).toString('hex')}`;
  try {
    renameSync(lockPath, quarantinePath);
  } catch (error) {
    return isErrno(error, 'ENOENT');
  }

  const moved = observeLock(quarantinePath);
  if (!observationMatches(moved, expected)) {
    if (moved) {
      try {
        linkSync(quarantinePath, lockPath);
        unlinkMatchingObservation(quarantinePath, moved);
      } catch {
        // Keep the unexpected replacement in quarantine rather than unlinking it.
      }
    }
    return false;
  }
  unlinkMatchingObservation(quarantinePath, expected);
  return true;
}

function removeObservedLockWithNewGuard(
  lockPath: string,
  observed: LockObservation & { metadata: FileLockMetadata },
  validateCurrent: (current: LockObservation & { metadata: FileLockMetadata }) => boolean,
): boolean {
  const sidecar = publishReclaimOwnerSidecar(
    lockPath,
    observed,
  );
  if (!sidecar) return false;

  try {
    const guard = observeLock(sidecar.path);
    const owner = asReclaimOwnerMetadata(guard);
    if (
      !observationMatches(guard, sidecar.observation) ||
      !owner ||
      !reclaimOwnerTargetsLock(owner, observed)
    ) {
      return false;
    }

    const current = observeLock(lockPath);
    if (
      !observationMatches(current, observed) ||
      !current?.metadata ||
      !validateCurrent(current as LockObservation & { metadata: FileLockMetadata }) ||
      !observationMatches(observeLock(sidecar.path), sidecar.observation)
    ) {
      return false;
    }

    return reclaimPublishedLock(lockPath, observed);
  } finally {
    const currentSidecar = observeLock(sidecar.path);
    if (observationMatches(currentSidecar, sidecar.observation)) {
      removeMatchingPathViaQuarantine(sidecar.path, currentSidecar!);
    }
  }
}

/** Reclaim a dead owner's lock under a crash-recoverable, owner-identified guard. */
function tryReclaimOrphanLock(lockPath: string): boolean {
  if (!clearDeadReclaimGuards(lockPath)) return false;

  const observed = observeLock(lockPath);
  if (!observed) return true;
  if (!observed.metadata || !ownerIsProvablyDead(observed.metadata)) return false;

  return removeObservedLockWithNewGuard(
    lockPath,
    observed as LockObservation & { metadata: FileLockMetadata },
    (current) => ownerIsProvablyDead(current.metadata),
  );
}

function newLockMetadata(): FileLockMetadata {
  return {
    version: 1,
    pid: process.pid,
    processStartIdentity: PROCESS_START_IDENTITY,
    hostname: LOCAL_HOSTNAME,
    token: randomBytes(24).toString('hex'),
    acquiredAt: new Date().toISOString(),
  };
}

/**
 * Fully write and fsync metadata before atomically publishing it with link(2). A crash before
 * publish cannot leave a malformed blocking lock; a crash after publish leaves valid metadata.
 */
function tryAcquireLockOnce(lockPath: string): number | undefined {
  // Avoid creating and fsyncing a temp file on the ordinary contention path. This check is only
  // an optimization; link(2) below remains the atomic no-clobber publication boundary.
  if (existsSync(lockPath)) return undefined;
  if (!clearDeadReclaimGuards(lockPath)) return undefined;

  const dir = dirname(lockPath);
  const metadata = newLockMetadata();
  const tempPath = join(dir, `.${basename(lockPath)}.${metadata.token}.lock-tmp`);
  let fd: number | undefined;
  let acquired = false;
  let published = false;
  try {
    fd = openSync(tempPath, 'wx', 0o600);
    writeFileSync(fd, `${JSON.stringify(metadata)}\n`, 'utf-8');
    fsyncSync(fd);
    const stat = fstatSync(fd);
    const owned: OwnedLock = {
      lockPath,
      identity: { dev: stat.dev, ino: stat.ino },
      metadata,
    };

    try {
      linkSync(tempPath, lockPath);
      published = true;
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) throw error;
      return undefined;
    }

    // A reclaimer that crossed our pre-publish scan owns the guard window. Withdraw our own
    // publication (verified by inode+token) and retry after every internal guard is gone.
    if (!clearDeadReclaimGuards(lockPath)) {
      published = !unlinkMatchingObservation(lockPath, owned);
      return undefined;
    }

    ownedLocks.set(fd, owned);
    acquired = true;
    return fd;
  } finally {
    try {
      unlinkSync(tempPath);
    } catch {}
    if (fd !== undefined && !acquired) {
      if (published) {
        const stat = fstatSync(fd);
        unlinkMatchingObservation(lockPath, {
          identity: { dev: stat.dev, ino: stat.ino },
          metadata,
        });
      }
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

/**
 * Acquire an advisory lock file with atomically published, verifiable owner metadata.
 * Retries until timeoutMs (default 5000). Caller must pass the returned fd to releaseLock.
 * Returns the open lock-file descriptor. Caller must release it exactly once with releaseLock.
 */
export async function acquireLock(lockPath: string, timeoutMs = 5000): Promise<number> {
  const start = Date.now();
  const dir = dirname(lockPath);
  mkdirSync(dir, { recursive: true });

  while (true) {
    const fd = tryAcquireLockOnce(lockPath);
    if (fd !== undefined) return fd;
    if (tryReclaimOrphanLock(lockPath)) continue;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Failed to acquire lock ${lockPath} after ${timeoutMs}ms`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

export function acquireLockSync(lockPath: string, timeoutMs = 5000): number {
  const start = Date.now();
  const dir = dirname(lockPath);
  mkdirSync(dir, { recursive: true });
  while (true) {
    const fd = tryAcquireLockOnce(lockPath);
    if (fd !== undefined) return fd;
    if (tryReclaimOrphanLock(lockPath)) continue;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Failed to acquire lock ${lockPath} after ${timeoutMs}ms`);
    }
    // brief spin for sync path (used rarely)
    const end = Date.now() + 10;
    while (Date.now() < end) {}
  }
}

export function releaseLock(fd: number, lockPath: string): void {
  const owned = ownedLocks.get(fd);
  if (!owned) return;
  ownedLocks.delete(fd);
  try {
    if (owned.lockPath === lockPath) {
      removeObservedLockWithNewGuard(lockPath, owned, () => true);
    }
  } catch {}
  try {
    closeSync(fd);
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
