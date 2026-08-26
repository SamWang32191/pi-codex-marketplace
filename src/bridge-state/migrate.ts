/**
 * Bridge State WAL Migration — schemaVersion binding.
 *
 * Closed rules (per CONTEXT.md / Issue #24):
 * - Versioned JSON schema with `schemaVersion` bound to Bridge Package version.
 * - Supported forward migrations are applied atomically via WAL (write-ahead log).
 * - Unknown / newer `schemaVersion` (> CURRENT) is `incompatible` — fail-closed, no auto-migrate, no rollback.
 * - Downgrade (attempting to persist an older schemaVersion over a newer durable file) never writes back.
 * - No implicit activation or automatic rollback on migration.
 * - WAL is per-document (`state.json.wal` sibling), fsynced before commit, replayed on read, cleaned after success.
 * - Corruption during migration leaves the previous durable revision verifiable or the file treated as Indeterminate.
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

import { scopeOverridesStrippedFinding, type ValidationFinding } from '../registration/findings.js';
import { atomicWriteFile } from './atomic.js';
import { getWalPath } from './paths.js';
import { parseJson } from './schema.js';
import { CURRENT_SCHEMA_VERSION, type BridgeState, createEmptyState } from './types.js';

/** Known forward migrations: fromVersion -> migrator. Only migrations listed here are supported. */
type MigratorResult = { state: BridgeState; findings?: ValidationFinding[] } | BridgeState;
type Migrator = (state: any) => MigratorResult;

const MIGRATIONS: Record<number, Migrator> = {
  1: (state: any) => {
    const findings: ValidationFinding[] = [];
    const hadOverrides = Array.isArray(state.scopeOverrides) && state.scopeOverrides.length > 0;
    if (hadOverrides) {
      findings.push(scopeOverridesStrippedFinding(state.scopeOverrides.length));
    }
    const cloned = structuredClone(state);
    delete cloned.scopeOverrides;
    cloned.schemaVersion = 2;
    // Normalize Installation IDs: strip retired 'global/' scope prefix if present
    if (Array.isArray(cloned.installations)) {
      cloned.installations = cloned.installations.map((inst: any) => {
        if (typeof inst === 'object' && inst !== null && typeof inst.id === 'string' && inst.id.startsWith('global/')) {
          return {
            ...inst,
            id: inst.pluginId ?? inst.id.slice('global/'.length),
          };
        }
        return inst;
      });
    }
    return { state: cloned, findings };
  },
};

export interface MigrationResult {
  ok: boolean;
  state?: BridgeState;
  migrated?: boolean;
  /** From version before migration, when migrated. */
  fromVersion?: number;
  toVersion?: number;
  error?: string;
  code?: 'INCOMPATIBLE_NEWER' | 'UNKNOWN_OLD_VERSION' | 'MIGRATION_FAILED' | 'CORRUPTED' | 'DOWNGRADE_BLOCKED';
  findings?: ValidationFinding[];
}

/**
 * Attempt to migrate a parsed BridgeState forward to CURRENT_SCHEMA_VERSION.
 * Returns:
 * - ok:true + migrated:false when already current
 * - ok:true + migrated:true when migrated via known chain
 * - ok:false with INCOMPATIBLE_NEWER when file is newer than current (do not auto-migrate)
 * - ok:false with UNKNOWN_OLD_VERSION when no migration path exists for an older version
 */
export function migrateForward(state: BridgeState): MigrationResult {
  const from = state.schemaVersion;

  if (from === CURRENT_SCHEMA_VERSION) {
    return { ok: true, state, migrated: false, fromVersion: from, toVersion: CURRENT_SCHEMA_VERSION, findings: [] };
  }

  if (!Number.isInteger(from) || from < 1) {
    return {
      ok: false,
      code: 'CORRUPTED',
      error: `Invalid schemaVersion ${from} — treated as corrupted`,
    };
  }

  if (from > CURRENT_SCHEMA_VERSION) {
    return {
      ok: false,
      code: 'INCOMPATIBLE_NEWER',
      error: `Incompatible schemaVersion ${from} > supported ${CURRENT_SCHEMA_VERSION} — requires newer Bridge Package (no downgrade write-back)`,
    };
  }

  // from < CURRENT: need forward chain
  let cur: any = structuredClone(state);
  let version = from;
  const allFindings: ValidationFinding[] = [];
  while (version < CURRENT_SCHEMA_VERSION) {
    const migrator = MIGRATIONS[version];
    if (!migrator) {
      return {
        ok: false,
        code: 'UNKNOWN_OLD_VERSION',
        error: `No supported migration path from schemaVersion ${from} to ${CURRENT_SCHEMA_VERSION} (missing ${version}→${version + 1}) — fail-closed`,
      };
    }
    try {
      const res = migrator(cur);
      if (typeof res === 'object' && res !== null && 'state' in res) {
        cur = res.state;
        if (res.findings && res.findings.length > 0) {
          allFindings.push(...res.findings);
        }
      } else {
        cur = res;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        code: 'MIGRATION_FAILED',
        error: `Migration ${version}→${version + 1} failed: ${msg}`,
      };
    }
    // Migrator must bump schemaVersion exactly by one; enforce closed invariant
    if (cur.schemaVersion !== version + 1) {
      return {
        ok: false,
        code: 'MIGRATION_FAILED',
        error: `Migration ${version}→${version + 1} did not set schemaVersion to ${version + 1} (got ${cur.schemaVersion})`,
      };
    }
    version = cur.schemaVersion;
  }

  return { ok: true, state: cur as BridgeState, migrated: true, fromVersion: from, toVersion: CURRENT_SCHEMA_VERSION, findings: allFindings };
}

/**
 * Downgrade guard: refuse to persist a state whose schemaVersion is older than the durable file.
 * Returns true if write should be blocked (never write back to an older version).
 */
export function isDowngradeAttempt(durableVersion: number, targetVersion: number): boolean {
  return targetVersion < durableVersion;
}

/**
 * WAL helpers — per-document write-ahead log at `state.json.wal`.
 * The WAL holds the *target* state JSON before the atomic rename, plus a header with from/to versions.
 * On read, if WAL exists but state.json still holds the old revision, the WAL can be replayed or cleaned.
 */

interface WalRecord {
  fromVersion: number;
  toVersion: number;
  fromRevision: string;
  targetState: BridgeState;
  createdAt: string;
}

function writeWalSync(statePath: string, record: WalRecord): void {
  const walPath = getWalPath(statePath);
  const dir = dirname(statePath);
  mkdirSync(dir, { recursive: true });
  const data = JSON.stringify(record, null, 2) + '\n';
  const fd = openSync(walPath, 'w', 0o600);
  try {
    writeSync(fd, data, null, 'utf-8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    const dirFd = openSync(dir, 'r');
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {}
}

function readWalSync(statePath: string): WalRecord | undefined {
  const walPath = getWalPath(statePath);
  if (!existsSync(walPath)) return undefined;
  try {
    const raw = readFileSync(walPath, 'utf-8');
    const parsed = JSON.parse(raw) as WalRecord;
    if (typeof parsed.fromVersion !== 'number' || typeof parsed.toVersion !== 'number' || !parsed.targetState) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function removeWalSync(statePath: string): void {
  const walPath = getWalPath(statePath);
  if (!existsSync(walPath)) return;
  try {
    unlinkSync(walPath);
  } catch {}
}

/**
 * Perform a WAL-guarded migration commit: write WAL, then atomic rename.
 * Caller must already hold the file lock.
 * Returns true when the migrated state was durable, false otherwise.
 */
export function commitMigratedState(statePath: string, migrated: BridgeState, fromVersion: number, fromRevision: string): boolean {
  const record: WalRecord = {
    fromVersion,
    toVersion: migrated.schemaVersion,
    fromRevision,
    targetState: migrated,
    createdAt: new Date().toISOString(),
  };
  try {
    writeWalSync(statePath, record);
  } catch {
    return false;
  }

  const data = JSON.stringify(migrated, null, 2) + '\n';
  const result = atomicWriteFile(statePath, data);
  if (!result.success) {
    // WAL remains for replay on next read; caller treats as Persistence Failed/Indeterminate
    return false;
  }

  // Success: remove WAL
  try {
    removeWalSync(statePath);
  } catch {}
  return true;
}

/**
 * Attempt to replay or clean a stale WAL on read.
 * If WAL's target matches the current file's revision/version, WAL is just cleaned.
 * If WAL's source matches the current file but target is newer, WAL target is re-applied (recovery without new confirmation).
 * In all other cases WAL is removed as orphaned.
 */
export function recoverWalIfNeeded(statePath: string, currentState: BridgeState | null): { recovered: boolean; state?: BridgeState } {
  const wal = readWalSync(statePath);
  if (!wal) return { recovered: false };

  if (!currentState) {
    // No durable file — apply WAL target if it looks valid
    const ok = wal.targetState && wal.targetState.schemaVersion === CURRENT_SCHEMA_VERSION;
    if (!ok) {
      removeWalSync(statePath);
      return { recovered: false };
    }
    const data = JSON.stringify(wal.targetState, null, 2) + '\n';
    const res = atomicWriteFile(statePath, data);
    if (res.success) {
      removeWalSync(statePath);
      return { recovered: true, state: wal.targetState };
    }
    return { recovered: false };
  }

  // File exists; compare
  if (currentState.schemaVersion === wal.toVersion && currentState.stateRevision === wal.targetState.stateRevision) {
    // Already applied
    removeWalSync(statePath);
    return { recovered: false };
  }
  if (currentState.schemaVersion === wal.fromVersion && currentState.stateRevision === wal.fromRevision) {
    // Replay WAL: durable still holds old revision, WAL holds migrated target
    const data = JSON.stringify(wal.targetState, null, 2) + '\n';
    const res = atomicWriteFile(statePath, data);
    if (res.success) {
      removeWalSync(statePath);
      return { recovered: true, state: wal.targetState };
    }
    return { recovered: false };
  }

  // Orphan / mismatch — clean
  removeWalSync(statePath);
  return { recovered: false };
}

/** For tests: expose internals */
export const _internal = {
  MIGRATIONS,
  writeWalSync,
  readWalSync,
  removeWalSync,
  CURRENT_SCHEMA_VERSION,
};
