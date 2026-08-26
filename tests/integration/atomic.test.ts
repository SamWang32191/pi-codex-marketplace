import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

import { commitBridgeState, readBridgeState } from '../../src/bridge-state/store.js';
import { getGlobalStatePath } from '../../src/bridge-state/paths.js';
import {
  acquireLock,
  atomicWriteFile,
  releaseLock,
  withFileLock,
} from '../../src/bridge-state/atomic.js';

const EXITING_LOCK_OWNER = String.raw`
  const { closeSync, fsyncSync, openSync, writeFileSync } = require('node:fs');
  const { randomUUID } = require('node:crypto');
  const { hostname } = require('node:os');
  const lockPath = process.argv[1];
  const fd = openSync(lockPath, 'wx', 0o600);
  writeFileSync(fd, JSON.stringify({
    version: 1,
    pid: process.pid,
    processStartIdentity: 'child:' + process.pid + ':' + Date.now(),
    hostname: hostname(),
    token: randomUUID(),
    acquiredAt: new Date().toISOString(),
  }) + '\n');
  fsyncSync(fd);
  closeSync(fd);
`;

const PROCESS_START_IDENTITY_SOURCE = String.raw`
  function processStartIdentity() {
    if (process.platform === 'linux') {
      const stat = readFileSync('/proc/' + process.pid + '/stat', 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
      const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      return 'linux:' + bootId + ':' + fields[19];
    }
    if (process.platform === 'darwin') {
      const started = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(process.pid)], {
        encoding: 'utf8',
        env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
      }).trim();
      return 'darwin:' + started;
    }
    return 'node:' + process.pid + ':' + require('node:perf_hooks').performance.timeOrigin.toFixed(3);
  }
`;

const HOLDING_LOCK_OWNER = String.raw`
  const { fsyncSync, openSync, readFileSync, writeFileSync } = require('node:fs');
  const { execFileSync } = require('node:child_process');
  const { randomUUID } = require('node:crypto');
  const { hostname } = require('node:os');
  ${PROCESS_START_IDENTITY_SOURCE}
  const lockPath = process.argv[1];
  const fd = openSync(lockPath, 'wx', 0o600);
  writeFileSync(fd, JSON.stringify({
    version: 1,
    pid: process.pid,
    processStartIdentity: processStartIdentity(),
    hostname: hostname(),
    token: randomUUID(),
    acquiredAt: new Date().toISOString(),
  }) + '\n');
  fsyncSync(fd);
  process.stdout.write('ready\n');
  setInterval(() => {}, 1000);
`;

const CRASHED_RECLAIMER = String.raw`
  const { closeSync, fstatSync, fsyncSync, openSync, readFileSync, writeFileSync } = require('node:fs');
  const { execFileSync } = require('node:child_process');
  const { randomUUID } = require('node:crypto');
  const { hostname } = require('node:os');
  ${PROCESS_START_IDENTITY_SOURCE}
  const lockPath = process.argv[1];
  const ownerStartIdentity = processStartIdentity();
  const ownerToken = randomUUID();
  const lockFd = openSync(lockPath, 'wx', 0o600);
  writeFileSync(lockFd, JSON.stringify({
    version: 1,
    pid: process.pid,
    processStartIdentity: ownerStartIdentity,
    hostname: hostname(),
    token: ownerToken,
    acquiredAt: new Date().toISOString(),
  }) + '\n');
  fsyncSync(lockFd);
  const lockStat = fstatSync(lockFd);

  const reclaimerToken = randomUUID();
  const sidecarPath = lockPath + '.reclaim-owner.' + reclaimerToken;
  const sidecarFd = openSync(sidecarPath, 'wx', 0o600);
  writeFileSync(sidecarFd, JSON.stringify({
    version: 1,
    kind: 'file-lock-reclaimer-v1',
    pid: process.pid,
    processStartIdentity: ownerStartIdentity,
    hostname: hostname(),
    token: reclaimerToken,
    acquiredAt: new Date().toISOString(),
    observedLockToken: ownerToken,
    observedLockDev: String(lockStat.dev),
    observedLockIno: String(lockStat.ino),
  }) + '\n');
  fsyncSync(sidecarFd);
  closeSync(sidecarFd);
  process.stdout.write('ready\n');
  setInterval(() => {}, 1000);
`;

const DELAYED_FIFO_WRITER = String.raw`
  const { openSync } = require('node:fs');
  const fifoPath = process.argv[1];
  setTimeout(() => {
    openSync(fifoPath, 'w');
    setInterval(() => {}, 1000);
  }, 1000);
`;

const MKFIFO_PATH = process.platform === 'win32'
  ? undefined
  : ['/usr/bin/mkfifo', '/bin/mkfifo'].find((path) => existsSync(path));

describe('Atomic store — cross-process concurrency and durability', () => {
  let tmpRoot: string;
  let agentDir: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bridge-atomic-'));
    agentDir = join(tmpRoot, 'agent');
  });

  afterEach(() => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  });

  it('concurrent commits do not corrupt file (file lock protects RMW)', async () => {
    // Fire 10 concurrent commits to the single Global document
    const promises = Array.from({ length: 10 }, (_, i) =>
      commitBridgeState((cur) => ({
          ...cur,
          registrations: [
            ...cur.registrations,
            { id: `id-${i}-${Date.now()}`, alias: `mp-${i}` },
          ],
        }),
        { agentDir },
      ),
    );

    const results = await Promise.all(promises);
    // All should succeed (lock serializes), or at least none corrupt
    // With lock, revisions should be monotonic and all succeed
    const successes = results.filter((r) => r.success);
    // At least some succeed; due to RMW under lock, all 10 should succeed sequentially
    expect(successes.length).toBe(10);

    const final = await readBridgeState({ agentDir });
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

  it.skipIf(!MKFIFO_PATH)('fails closed on a FIFO lock without blocking past its timeout', async () => {
    const lockPath = join(tmpRoot, 'fifo.lock');
    execFileSync(MKFIFO_PATH!, [lockPath]);
    const delayedWriter = spawn(process.execPath, ['-e', DELAYED_FIFO_WRITER, lockPath], {
      stdio: 'ignore',
    });
    const startedAt = Date.now();

    try {
      await expect(withFileLock(lockPath, () => undefined, 50)).rejects.toThrow(
        `Failed to acquire lock ${lockPath}`,
      );
      expect(Date.now() - startedAt).toBeLessThan(500);
      expect(lstatSync(lockPath).isFIFO()).toBe(true);
    } finally {
      if (delayedWriter.exitCode === null && delayedWriter.signalCode === null) {
        const exited = new Promise<void>((resolve) => delayedWriter.once('exit', () => resolve()));
        delayedWriter.kill('SIGKILL');
        await exited;
      }
    }
  });

  it('withFileLock reclaims an orphan left by an exited process', async () => {
    const lockPath = join(tmpRoot, 'orphan.lock');
    execFileSync(process.execPath, ['-e', EXITING_LOCK_OWNER, lockPath]);
    expect(existsSync(lockPath)).toBe(true);

    let entered = false;
    await withFileLock(lockPath, () => {
      entered = true;
    }, 250);

    expect(entered).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('serializes concurrent contenders racing to reclaim the same orphan', async () => {
    const lockPath = join(tmpRoot, 'orphan-race.lock');
    execFileSync(process.execPath, ['-e', EXITING_LOCK_OWNER, lockPath]);
    let active = 0;
    let maxActive = 0;

    await Promise.all(Array.from({ length: 4 }, () => withFileLock(lockPath, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
    }, 500)));

    expect(maxActive).toBe(1);
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(`${lockPath}.reclaim`)).toBe(false);
  });

  it('recovers when a reclaimer is killed after publishing its guard', async () => {
    const lockPath = join(tmpRoot, 'crashed-reclaimer.lock');
    const child = spawn(process.execPath, ['-e', CRASHED_RECLAIMER, lockPath], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('reclaimer child did not become ready')), 1000);
        child.once('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        child.stdout.once('data', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGKILL');
      await exited;
      expect(readdirSync(tmpRoot).filter((entry) => entry.startsWith('crashed-reclaimer.lock.reclaim-owner.'))).toHaveLength(1);

      let entered = false;
      await withFileLock(lockPath, () => {
        entered = true;
      }, 250);

      expect(entered).toBe(true);
      expect(existsSync(lockPath)).toBe(false);
      expect(readdirSync(tmpRoot).filter((entry) => entry.startsWith('crashed-reclaimer.lock.reclaim-owner.'))).toEqual([]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });

  it('retains a live owner when contender and owner timezones differ', async () => {
    const lockPath = join(tmpRoot, 'cross-timezone-live.lock');
    const child = spawn(process.execPath, ['-e', HOLDING_LOCK_OWNER, lockPath], {
      env: { ...process.env, TZ: 'UTC' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const originalTimezone = process.env.TZ;
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('live owner child did not become ready')), 1000);
        child.once('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        child.stdout.once('data', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
      process.env.TZ = 'Asia/Taipei';

      await expect(withFileLock(lockPath, () => undefined, 60)).rejects.toThrow(
        `Failed to acquire lock ${lockPath}`,
      );
      expect(existsSync(lockPath)).toBe(true);

      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGKILL');
      await exited;
      await withFileLock(lockPath, () => undefined, 250);
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      if (originalTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = originalTimezone;
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });

  it('publishes complete owner metadata before entering the critical section', async () => {
    const lockPath = join(tmpRoot, 'metadata.lock');

    const metadata = await withFileLock(lockPath, () => JSON.parse(readFileSync(lockPath, 'utf-8')));

    expect(metadata).toEqual(expect.objectContaining({
      version: 1,
      pid: process.pid,
      processStartIdentity: expect.any(String),
      hostname: expect.any(String),
      token: expect.stringMatching(/^[a-f0-9]{48}$/),
      acquiredAt: expect.any(String),
    }));
    expect(Number.isFinite(Date.parse(metadata.acquiredAt))).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('retains live and malformed locks when ownership cannot be proven dead', async () => {
    const livePath = join(tmpRoot, 'live.lock');
    const liveFd = await acquireLock(livePath);
    try {
      expect(fstatSync(liveFd).isFile()).toBe(true);
      await expect(withFileLock(livePath, () => undefined, 40)).rejects.toThrow(
        `Failed to acquire lock ${livePath}`,
      );
      expect(existsSync(livePath)).toBe(true);
    } finally {
      releaseLock(liveFd, livePath);
    }

    const malformedPath = join(tmpRoot, 'malformed.lock');
    writeFileSync(malformedPath, '{ not verifiable lock metadata', 'utf-8');
    await expect(withFileLock(malformedPath, () => undefined, 40)).rejects.toThrow(
      `Failed to acquire lock ${malformedPath}`,
    );
    expect(readFileSync(malformedPath, 'utf-8')).toBe('{ not verifiable lock metadata');

    const legacyPath = join(tmpRoot, 'legacy-pid-only.lock');
    writeFileSync(legacyPath, '2147483647', 'utf-8');
    await expect(withFileLock(legacyPath, () => undefined, 40)).rejects.toThrow(
      `Failed to acquire lock ${legacyPath}`,
    );
    expect(readFileSync(legacyPath, 'utf-8')).toBe('2147483647');
  });

  it('reclaims proven PID reuse but retains an unverifiable foreign-host lock', async () => {
    const reusedPidPath = join(tmpRoot, 'reused-pid.lock');
    writeFileSync(reusedPidPath, JSON.stringify({
      version: 1,
      pid: process.pid,
      processStartIdentity: 'darwin:an older process start',
      hostname: hostname(),
      token: 'old-owner-token',
      acquiredAt: '2020-01-01T00:00:00.000Z',
    }), 'utf-8');
    let entered = false;
    await withFileLock(reusedPidPath, () => {
      entered = true;
    }, 100);
    expect(entered).toBe(true);

    const foreignPath = join(tmpRoot, 'foreign-host.lock');
    const foreignMetadata = JSON.stringify({
      version: 1,
      pid: process.pid,
      processStartIdentity: 'foreign:start-identity',
      hostname: `${hostname()}.unverifiable.invalid`,
      token: 'foreign-owner-token',
      acquiredAt: '2020-01-01T00:00:00.000Z',
    });
    writeFileSync(foreignPath, foreignMetadata, 'utf-8');
    await expect(withFileLock(foreignPath, () => undefined, 40)).rejects.toThrow(
      `Failed to acquire lock ${foreignPath}`,
    );
    expect(readFileSync(foreignPath, 'utf-8')).toBe(foreignMetadata);
  });

  it('does not let a caller-owned .reclaim lock block or get deleted by base lock release', async () => {
    const lockPath = join(tmpRoot, 'guard-namespace.lock');
    const callerOwnedGuardPath = `${lockPath}.reclaim`;
    const baseFd = await acquireLock(lockPath);
    const callerFd = await acquireLock(callerOwnedGuardPath);
    try {
      releaseLock(baseFd, lockPath);
      expect(existsSync(lockPath)).toBe(false);
      expect(existsSync(callerOwnedGuardPath)).toBe(true);

      await withFileLock(lockPath, () => undefined, 100);
      expect(existsSync(callerOwnedGuardPath)).toBe(true);
    } finally {
      releaseLock(baseFd, lockPath);
      releaseLock(callerFd, callerOwnedGuardPath);
    }
  });

  it('does not let an old owner release a replacement lock', async () => {
    const lockPath = join(tmpRoot, 'replacement.lock');
    const oldFd = await acquireLock(lockPath);
    unlinkSync(lockPath);
    const replacementFd = await acquireLock(lockPath);

    try {
      releaseLock(oldFd, lockPath);
      expect(existsSync(lockPath)).toBe(true);
      await expect(withFileLock(lockPath, () => undefined, 40)).rejects.toThrow(
        `Failed to acquire lock ${lockPath}`,
      );
    } finally {
      releaseLock(replacementFd, lockPath);
    }
    expect(existsSync(lockPath)).toBe(false);
  });

  it('corrupted file after concurrent writer still classified as Indeterminate, not silently fixed', async () => {
    // First, create a valid file
    await commitBridgeState((c) => ({ ...c }), { agentDir });
    const path = getGlobalStatePath(agentDir);
    expect(existsSync(path)).toBe(true);

    // Corrupt it externally
    const { writeFileSync } = await import('node:fs');
    const { mkdirSync } = await import('node:fs');
    // ensure dir
    writeFileSync(path, '<<<corrupted>>>', 'utf-8');

    const after = await readBridgeState({ agentDir });
    expect(after.status).toBe('corrupted');

    // Another concurrent commit attempt should not overwrite corrupted file silently
    const attempt = await commitBridgeState((c) => ({ ...c }), { agentDir });
    expect(attempt.success).toBe(false);
    const stillCorrupted = readFileSync(path, 'utf-8');
    expect(stillCorrupted).toBe('<<<corrupted>>>');
  });
});
