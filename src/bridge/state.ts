/**
 * Minimal Bridge State — single Global document persistence (#88, #87).
 *
 * Persisted shape:
 * - schemaVersion: number (fixed, never migrated)
 * - registrations: MinimalRegistration[]
 * - installations: MinimalInstallation[]
 *
 * Fail-reset contract:
 * - Corrupted JSON, unreadable format, or incompatible shape is immediately reset to empty state.
 * - Atomic write: temp → fsync → rename + file lock (last-write-wins, no stale detection).
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { atomicWriteFile, atomicWriteWithLockSync } from '../bridge-state/atomic.js';
import { getGlobalStatePath, getLockPath } from '../bridge-state/paths.js';

export interface MinimalRegistration {
  id: string;
  marketplaceName: string;
  format: 'codex' | 'claude';
  sourceKind: 'local' | 'git';
  source: string;
  alias?: string;
  snapshot?: string;
}

export interface MinimalInstallation {
  id: string;
  pluginId: string;
  enabled: boolean;
  installationState?: 'enabled' | 'disabled';
  registrationId: string;
  manifestName: string;
  sourceKind: 'local' | 'git';
  source: string;
  snapshot?: string;
  skills?: string[];
}

export interface MinimalBridgeState {
  schemaVersion: number;
  registrations: MinimalRegistration[];
  installations: MinimalInstallation[];
}

export interface ReadMinimalStateOptions {
  statePath?: string;
  agentDir?: string;
}

export interface WriteMinimalStateOptions {
  statePath?: string;
  agentDir?: string;
  lockTimeoutMs?: number;
}

export interface ReadMinimalStateResult {
  state: MinimalBridgeState;
  wasReset: boolean;
  resetReason?: string;
}

export function createEmptyMinimalState(): MinimalBridgeState {
  return {
    schemaVersion: 1,
    registrations: [],
    installations: [],
  };
}

export function isMinimalBridgeState(value: unknown): value is MinimalBridgeState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  if (typeof o.schemaVersion !== 'number') return false;
  if (!Array.isArray(o.registrations) || !Array.isArray(o.installations)) return false;

  for (const reg of o.registrations) {
    if (typeof reg !== 'object' || reg === null || Array.isArray(reg)) return false;
  }
  for (const inst of o.installations) {
    if (typeof inst !== 'object' || inst === null || Array.isArray(inst)) return false;
  }
  return true;
}

export function writeMinimalBridgeState(
  state: MinimalBridgeState,
  opts: WriteMinimalStateOptions = {},
): void {
  const statePath = opts.statePath ?? getGlobalStatePath(opts.agentDir);
  const lockPath = getLockPath(statePath);
  const data = JSON.stringify(state, null, 2) + '\n';
  mkdirSync(dirname(statePath), { recursive: true });

  const timeoutMs = opts.lockTimeoutMs ?? 5000;
  const res = atomicWriteWithLockSync(statePath, data, lockPath, timeoutMs);
  if (!res.success) {
    // Fallback direct atomic write
    atomicWriteFile(statePath, data);
  }
}

export function resetMinimalBridgeState(opts: ReadMinimalStateOptions = {}): MinimalBridgeState {
  const state = createEmptyMinimalState();
  writeMinimalBridgeState(state, opts);
  return state;
}

export function readMinimalBridgeState(opts: ReadMinimalStateOptions = {}): ReadMinimalStateResult {
  const statePath = opts.statePath ?? getGlobalStatePath(opts.agentDir);

  if (!existsSync(statePath)) {
    return {
      state: createEmptyMinimalState(),
      wasReset: false,
    };
  }

  let content: string;
  try {
    content = readFileSync(statePath, 'utf-8');
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    const state = resetMinimalBridgeState(opts);
    return {
      state,
      wasReset: true,
      resetReason: `無法讀取檔案 (${errorMsg})`,
    };
  }

  if (content.trim().length === 0) {
    const state = resetMinimalBridgeState(opts);
    return {
      state,
      wasReset: true,
      resetReason: '檔案內容為空',
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    const state = resetMinimalBridgeState(opts);
    return {
      state,
      wasReset: true,
      resetReason: `JSON 解析失敗 (${errorMsg})`,
    };
  }

  if (!isMinimalBridgeState(parsed)) {
    const state = resetMinimalBridgeState(opts);
    return {
      state,
      wasReset: true,
      resetReason: 'Bridge State 格式不符',
    };
  }

  return {
    state: parsed,
    wasReset: false,
  };
}
