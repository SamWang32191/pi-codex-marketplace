/**
 * Path helpers for the single Global Bridge State document.
 * - State:    {getAgentDir()}/codex-marketplace/state.json
 * - Journal:  {getAgentDir()}/codex-marketplace/receipts.jsonl
 *
 * getAgentDir() mirrors Pi's config.getAgentDir(): honors PI_CODING_AGENT_DIR,
 * otherwise ~/.pi/agent.
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

export function getReceiptsJournalPath(agentDir = getAgentDir()): string {
  return join(getGlobalStateDir(agentDir), RECEIPTS_FILENAME);
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
