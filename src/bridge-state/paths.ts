/**
 * Dual-path helpers for Bridge State documents.
 * - Global:  {getAgentDir()}/codex-marketplace/state.json
 * - Project: {cwd}/.pi/codex-marketplace/state.json
 *
 * getAgentDir() mirrors Pi's config.getAgentDir(): honors PI_CODING_AGENT_DIR,
 * otherwise ~/.pi/agent. Project path uses CONFIG_DIR_NAME ".pi".
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

export const CONFIG_DIR_NAME = '.pi';
export const BRIDGE_SUBDIR = 'codex-marketplace';
export const STATE_FILENAME = 'state.json';
export const RECEIPTS_FILENAME = 'receipts.jsonl';
export const LOCK_SUFFIX = '.lock';
export const WAL_SUFFIX = '.wal';
export const FENCE_SUFFIX = '.fence';

/** Mirrors pi's getAgentDir() — env PI_CODING_AGENT_DIR wins, else ~/.pi/agent */
export function getAgentDir(): string {
  const env = process.env.PI_CODING_AGENT_DIR ?? process.env.PI_AGENT_DIR;
  if (env && env.trim().length > 0) {
    // Pi does tilde + normalize; we do minimal
    if (env.startsWith('~/')) return join(homedir(), env.slice(2));
    return env;
  }
  return join(homedir(), CONFIG_DIR_NAME, 'agent');
}

export function getGlobalStateDir(agentDir = getAgentDir()): string {
  return join(agentDir, BRIDGE_SUBDIR);
}

export function getGlobalStatePath(agentDir = getAgentDir()): string {
  return join(getGlobalStateDir(agentDir), STATE_FILENAME);
}

export function getProjectStateDir(cwd: string = process.cwd()): string {
  return join(cwd, CONFIG_DIR_NAME, BRIDGE_SUBDIR);
}

export function getProjectStatePath(cwd: string = process.cwd()): string {
  return join(getProjectStateDir(cwd), STATE_FILENAME);
}

export function getStatePath(
  scope: 'global' | 'project',
  opts: { cwd?: string; agentDir?: string } = {},
): string {
  if (scope === 'global') return getGlobalStatePath(opts.agentDir);
  return getProjectStatePath(opts.cwd);
}

export function getReceiptsJournalPath(
  scope: 'global' | 'project',
  opts: { cwd?: string; agentDir?: string } = {},
): string {
  const stateDir = scope === 'global' ? getGlobalStateDir(opts.agentDir) : getProjectStateDir(opts.cwd);
  return join(stateDir, RECEIPTS_FILENAME);
}

export function getLockPath(statePath: string): string {
  return `${statePath}${LOCK_SUFFIX}`;
}

export function getWalPath(statePath: string): string {
  return `${statePath}${WAL_SUFFIX}`;
}

export function getFencePath(statePath: string): string {
  return `${statePath}${FENCE_SUFFIX}`;
}

