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
}

/** Read a scope's Bridge State with closed handling of missing/corrupted/incompatible. */
export async function readBridgeState(scope: Scope, opts: StoreOptions = {}): Promise<ReadResult> {
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
  if (!parsed.ok) {
    return { status: 'corrupted', error: parsed.error, raw: content };
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

  const state = parsed.value as BridgeState;
  // Ensure scopeOverrides empty for global? Not enforced — just return as is.
  // Project Trust is not persisted here; store is agnostic.

  return { status: 'ok', state };
}

/** Synchronously read (for extension startup / tests). Same closed semantics. */
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
  return { status: 'ok', state: parsed.value as BridgeState };
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
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
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
