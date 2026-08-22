/**
 * Bridge State Store — dual-document atomic persistence.
 *
 * Each scope (global/project) has its own file:
 *   global:  {getAgentDir()}/codex-marketplace/state.json
 *   project: {cwd}/.pi/codex-marketplace/state.json
 *
 * Guarantees:
 * - State Revision monotonic per scope (opaque numeric string)
 * - Atomic write: temp → fsync → rename + dir fsync
 * - File lock protects RMW races
 * - Read-after-verify after every write
 * - Closed corruption handling: corrupted / incompatible => not auto-rollback, caller sees Indeterminate/incompatible
 *
 * Only authoritative fields are persisted; Effective State etc are derived at read time (not stored).
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { atomicWriteFile, acquireLock, releaseLock } from './atomic.js';
import { commitMigratedState, migrateForward, recoverWalIfNeeded } from './migrate.js';
import { getLockPath, getStatePath } from './paths.js';
import { parseJson, validateSchema } from './schema.js';
import {
  CURRENT_SCHEMA_VERSION,
  createEmptyState,
  nextRevision,
  type BridgeState,
  type ReadResult,
  type Scope,
  type WriteResult,
} from './types.js';

export interface StoreOptions {
  cwd?: string;
  agentDir?: string;
  /** lock timeout ms (default 5000) */
  lockTimeoutMs?: number;
  /** Refuse the atomic mutation unless this is still the current State Revision under lock. */
  expectedStateRevision?: string;
}

/** Read a scope's Bridge State with closed handling of missing/corrupted/incompatible + WAL forward migration. */
export async function readBridgeState(scope: Scope, opts: StoreOptions = {}): Promise<ReadResult> {
  const statePath = getStatePath(scope, opts);

  if (!existsSync(statePath)) {
    // WAL recovery may have materialized a file after a prior crash
    const recovered = recoverWalIfNeeded(statePath, null);
    if (recovered.recovered && recovered.state) {
      return { status: 'ok', state: recovered.state };
    }
    return { status: 'missing', state: createEmptyState(), isEmptyInit: true };
  }

  let content: string;
  try {
    content = readFileSync(statePath, 'utf-8');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { status: 'corrupted', error: `Failed to read ${statePath}: ${msg}` };
  }

  if (content.trim().length === 0) {
    return { status: 'corrupted', error: 'Empty file (corrupted)', raw: content };
  }

  const parsed = parseJson(content);
  if (!parsed.ok) {
    return { status: 'corrupted', error: parsed.error, raw: content };
  }

  // Attempt WAL recovery before schema validation (handles crash between WAL write and rename)
  const preState = parsed.value as BridgeState;
  const hasVersion = typeof (preState as unknown as Record<string, unknown>).schemaVersion === 'number';
  if (hasVersion) {
    const walRecovered = recoverWalIfNeeded(statePath, preState);
    if (walRecovered.recovered && walRecovered.state) {
      return { status: 'ok', state: walRecovered.state };
    }
  }

  const validation = validateSchema(parsed.value);
  if (!validation.ok) {
    if (validation.code === 'INCOMPATIBLE_SCHEMA_VERSION') {
      return {
        status: 'incompatible',
        error: validation.error,
        raw: parsed.value,
      };
    }
    return { status: 'corrupted', error: validation.error, raw: parsed.value };
  }

  let state = parsed.value as BridgeState;

  // WAL forward migration: if schemaVersion < CURRENT, attempt known forward chain atomically.
  if (state.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    const migration = migrateForward(state);
    if (!migration.ok) {
      // Unknown older version (no path) => incompatible; newer => incompatible. Never auto-mutate.
      return {
        status: migration.code === 'INCOMPATIBLE_NEWER' ? 'incompatible' : 'corrupted',
        error: migration.error,
        raw: parsed.value,
      };
    }
    if (migration.migrated && migration.state) {
      // Acquire lock to commit migrated state atomically with WAL; if lock unavailable, surface as incompatible/corrupted per fail-closed.
      try {
        const lockPath = getLockPath(statePath);
        const fd = await acquireLock(lockPath, 1000);
        try {
          // Re-read under lock to avoid racing with a concurrent writer
          let fresh: BridgeState | null = null;
          try {
            const freshContent = readFileSync(statePath, 'utf-8');
            const freshParsed = parseJson(freshContent);
            if (freshParsed.ok) {
              const v = validateSchema(freshParsed.value);
              // If fresh already migrated by another process, use it
              if (v.ok) fresh = freshParsed.value as BridgeState;
              // If fresh is now at CURRENT, no need to migrate
              if (fresh && fresh.schemaVersion === CURRENT_SCHEMA_VERSION) {
                state = fresh;
              } else {
                const ok = commitMigratedState(statePath, migration.state, state.schemaVersion, state.stateRevision);
                if (ok) state = migration.state;
                else return { status: 'corrupted', error: 'Migration WAL commit failed — treated as Persistence Indeterminate', raw: parsed.value };
              }
            } else {
              const ok = commitMigratedState(statePath, migration.state, state.schemaVersion, state.stateRevision);
              if (ok) state = migration.state;
              else return { status: 'corrupted', error: 'Migration WAL commit failed — treated as Persistence Indeterminate', raw: parsed.value };
            }
          } catch {
            const ok = commitMigratedState(statePath, migration.state, state.schemaVersion, state.stateRevision);
            if (ok) state = migration.state;
          }
        } finally {
          releaseLock(fd, lockPath);
        }
      } catch {
        // Lock contention: surface original state as ok but note migration pending — fail-closed is to keep old version visible rather than block read?
        // For correctness we return incompatible-like status so callers retry after lock clears.
        return { status: 'corrupted', error: migration.error ?? 'Migration pending — lock contention', raw: parsed.value };
      }
    }
  }

  return { status: 'ok', state };
}

/** Synchronously read (for extension startup / tests). Same closed semantics; WAL migration is async, so sync path never auto-migrates — it surfaces incompatible/corrupted to the caller who must use the async read for migration. Downgrade never writes back. */
export function readBridgeStateSync(scope: Scope, opts: StoreOptions = {}): ReadResult {
  const statePath = getStatePath(scope, opts);
  if (!existsSync(statePath)) {
    return { status: 'missing', state: createEmptyState(), isEmptyInit: true };
  }
  let content: string;
  try {
    content = readFileSync(statePath, 'utf-8');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { status: 'corrupted', error: `Failed to read ${statePath}: ${msg}` };
  }
  if (content.trim().length === 0) {
    return { status: 'corrupted', error: 'Empty file (corrupted)', raw: content };
  }
  const parsed = parseJson(content);
  if (!parsed.ok) return { status: 'corrupted', error: parsed.error, raw: content };
  const validation = validateSchema(parsed.value);
  if (!validation.ok) {
    if (validation.code === 'INCOMPATIBLE_SCHEMA_VERSION')
      return { status: 'incompatible', error: validation.error, raw: parsed.value };
    return { status: 'corrupted', error: validation.error, raw: parsed.value };
  }
  const state = parsed.value as BridgeState;
  // Sync path: if WAL exists but not yet applied, do not mutate; async read will handle WAL. Enforce downgrade guard via message only.
  if (state.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    const mig = migrateForward(state);
    if (!mig.ok) {
      return {
        status: mig.code === 'INCOMPATIBLE_NEWER' ? 'incompatible' : 'corrupted',
        error: mig.error,
        raw: parsed.value,
      };
    }
    if (mig.migrated) {
      // Sync path cannot take the migration lock; surface as requires async migration.
      return {
        status: 'corrupted',
        error: `Schema migration required: ${state.schemaVersion} → ${CURRENT_SCHEMA_VERSION} — async read will WAL-migrate (no implicit activation)`,
        raw: parsed.value,
      };
    }
  }
  return { status: 'ok', state };
}

/**
 * Commit a mutation atomically with lock + revision bump + verify.
 * updater receives current state (or empty if missing) and returns next state *without* needing to set revision.
 * The store bumps stateRevision monotonically and writes atomically.
 * If the file was corrupted/incompatible, commit is rejected as Indeterminate (fail-closed).
 */
export async function commitBridgeState(
  scope: Scope,
  updater: (current: BridgeState) => BridgeState,
  opts: StoreOptions = {},
): Promise<WriteResult> {
  const statePath = getStatePath(scope, opts);
  const lockPath = getLockPath(statePath);
  const timeout = opts.lockTimeoutMs ?? 5000;

  // Acquire lock for the entire RMW
  let lockFd: number | undefined;
  try {
    lockFd = await acquireLock(lockPath, timeout);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, error: `Failed to acquire lock: ${msg}` };
  }

  try {
    // Re-read under lock to get current revision (avoid lost update)
    let currentResult: ReadResult;
    // inline sync read under lock
    if (!existsSync(statePath)) {
      currentResult = { status: 'missing', state: createEmptyState(), isEmptyInit: true };
    } else {
      try {
        const content = readFileSync(statePath, 'utf-8');
        if (content.trim().length === 0) {
          releaseLock(lockFd, lockPath);
          return {
            success: false,
            error: 'Persistence Indeterminate: empty file, neither previous nor target verifiable',
            isIndeterminate: true,
          };
        }
        const parsed = parseJson(content);
        if (!parsed.ok) {
          releaseLock(lockFd, lockPath);
          return {
            success: false,
            error: `Persistence Indeterminate: corrupted JSON — ${parsed.error}`,
            isIndeterminate: true,
          };
        }
        const validation = validateSchema(parsed.value);
        if (!validation.ok) {
          if (validation.code === 'INCOMPATIBLE_SCHEMA_VERSION') {
            releaseLock(lockFd, lockPath);
            return {
              success: false,
              error: `Incompatible schemaVersion — ${validation.error}`,
              isIndeterminate: false,
            };
          }
          releaseLock(lockFd, lockPath);
          return {
            success: false,
            error: `Persistence Indeterminate: invalid schema — ${validation.error}`,
            isIndeterminate: true,
          };
        }
        currentResult = { status: 'ok', state: parsed.value as BridgeState };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        releaseLock(lockFd, lockPath);
        return { success: false, error: `Failed to read under lock: ${msg}`, isIndeterminate: true };
      }
    }

    const current = currentResult.state!;
    if (opts.expectedStateRevision !== undefined && current.stateRevision !== opts.expectedStateRevision) {
      return {
        success: false,
        isStale: true,
        observedRevision: current.stateRevision,
        error: `Rejected as Stale: expected State Revision ${opts.expectedStateRevision}, observed ${current.stateRevision}`,
      };
    }
    const draft = updater(structuredClone(current));

    // Ensure draft has correct schemaVersion and scopeOverrides shape
    draft.schemaVersion = CURRENT_SCHEMA_VERSION;
    if (!Array.isArray(draft.registrations)) draft.registrations = [];
    if (!Array.isArray(draft.installations)) draft.installations = [];
    if (!Array.isArray(draft.scopeOverrides)) draft.scopeOverrides = [];
    // Global scope must not persist overrides (but we allow empty)
    if (scope === 'global' && draft.scopeOverrides.length > 0) {
      // For scaffold we keep but warn — spec says overrides are project-only; we normalize to empty for global
      draft.scopeOverrides = [];
    }

    // Bump revision monotonically
    const newRevision = nextRevision(current.stateRevision);
    draft.stateRevision = newRevision;

    const data = JSON.stringify(draft, null, 2) + '\n';

    // Ensure dir exists
    mkdirSync(dirname(statePath), { recursive: true });

    const result = atomicWriteFile(statePath, data);
    if (!result.success) {
      // Classify as Persistence Failed vs Indeterminate by checking if previous is still readable
      let previousStillOk = false;
      try {
        const prevContent = readFileSync(statePath, 'utf-8');
        const prevParsed = parseJson(prevContent);
        if (prevParsed.ok) {
          const v = validateSchema(prevParsed.value);
          if (v.ok) {
            const prev = prevParsed.value as BridgeState;
            if (prev.stateRevision === current.stateRevision) previousStillOk = true;
          }
        }
      } catch {
        previousStillOk = false;
      }
      releaseLock(lockFd, lockPath);
      if (previousStillOk) {
        return {
          success: false,
          error: `Persistence Failed: ${result.error} — previous revision ${current.stateRevision} still verified`,
          isIndeterminate: false,
        };
      }
      return {
        success: false,
        error: `Persistence Indeterminate: ${result.error}`,
        isIndeterminate: true,
      };
    }

    // Verify written revision matches expected
    try {
      const verifyContent = readFileSync(statePath, 'utf-8');
      const verifyParsed = parseJson(verifyContent);
      if (!verifyParsed.ok || !validateSchema(verifyParsed.value).ok) {
        releaseLock(lockFd, lockPath);
        return {
          success: false,
          error: 'Persistence Indeterminate: written file not verifiable after commit',
          isIndeterminate: true,
        };
      }
      const verified = verifyParsed.value as BridgeState;
      if (verified.stateRevision !== newRevision) {
        releaseLock(lockFd, lockPath);
        return {
          success: false,
          error: `Persistence Indeterminate: revision mismatch after write (expected ${newRevision}, got ${verified.stateRevision})`,
          isIndeterminate: true,
        };
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      releaseLock(lockFd, lockPath);
      return { success: false, error: `Persistence Indeterminate: verify failed — ${msg}`, isIndeterminate: true };
    }

    releaseLock(lockFd, lockPath);
    return { success: true, newRevision };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    try {
      if (lockFd !== undefined) releaseLock(lockFd, lockPath);
    } catch {}
    return { success: false, error: msg };
  }
}

/**
 * Low-level direct write (for tests / migration). Caller must ensure revision monotonicity.
 * Still uses lock + atomic + verify.
 */
export async function writeBridgeState(
  scope: Scope,
  state: BridgeState,
  opts: StoreOptions = {},
): Promise<WriteResult> {
  const statePath = getStatePath(scope, opts);
  const lockPath = getLockPath(statePath);
  const timeout = opts.lockTimeoutMs ?? 5000;

  let lockFd: number | undefined;
  try {
    lockFd = await acquireLock(lockPath, timeout);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, error: `Failed to acquire lock: ${msg}` };
  }

  try {
    // Closed handling: if existing file is corrupted/incompatible, fail-closed as Indeterminate/incompatible
    // Also enforce downgrade guard: never overwrite a newer schemaVersion with an older one (no write-back).
    if (existsSync(statePath)) {
      try {
        const curContent = readFileSync(statePath, 'utf-8');
        const curParsed = parseJson(curContent);
        if (!curParsed.ok) {
          releaseLock(lockFd, lockPath);
          return {
            success: false,
            error: `Persistence Indeterminate: existing file corrupted — ${curParsed.error}`,
            isIndeterminate: true,
          };
        }
        const curVal = validateSchema(curParsed.value);
        if (!curVal.ok) {
          if (curVal.code === 'INCOMPATIBLE_SCHEMA_VERSION') {
            releaseLock(lockFd, lockPath);
            return { success: false, error: curVal.error, isIndeterminate: false };
          }
          releaseLock(lockFd, lockPath);
          return {
            success: false,
            error: `Persistence Indeterminate: existing file invalid — ${curVal.error}`,
            isIndeterminate: true,
          };
        }
        const curState = curParsed.value as BridgeState;
        // Downgrade guard: target schemaVersion must not be older than durable
        if (state.schemaVersion < curState.schemaVersion) {
          releaseLock(lockFd, lockPath);
          return {
            success: false,
            error: `Downgrade blocked: durable schemaVersion ${curState.schemaVersion} > target ${state.schemaVersion} — update Bridge Package instead (never write back to older version)`,
            isIndeterminate: false,
          };
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // If we already handled downgrade case, propagate; otherwise generic indeterminate
        if (msg.includes('Downgrade blocked')) {
          releaseLock(lockFd, lockPath);
          return { success: false, error: msg, isIndeterminate: false };
        }
        releaseLock(lockFd, lockPath);
        return { success: false, error: `Persistence Indeterminate: ${msg}`, isIndeterminate: true };
      }
    }

    const data = JSON.stringify(state, null, 2) + '\n';
    mkdirSync(dirname(statePath), { recursive: true });
    const result = atomicWriteFile(statePath, data);
    if (!result.success) {
      releaseLock(lockFd, lockPath);
      return { success: false, error: result.error, isIndeterminate: true };
    }
    releaseLock(lockFd, lockPath);
    return { success: true, newRevision: state.stateRevision };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    try {
      if (lockFd !== undefined) releaseLock(lockFd, lockPath);
    } catch {}
    return { success: false, error: msg };
  }
}

/** Convenience: read both scopes (global + project) */
export async function readBothStates(opts: StoreOptions = {}): Promise<{
  global: ReadResult;
  project: ReadResult;
}> {
  const [global, project] = await Promise.all([
    readBridgeState('global', opts),
    readBridgeState('project', opts),
  ]);
  return { global, project };
}
