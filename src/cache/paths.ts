/**
 * Source Cache path helpers (#22).
 * The Git-only Source Cache lives at `${getAgentDir()}/codex-marketplace/cache`.
 *
 * Layout:
 *   cache/
 *     entries/<fingerprint>/        — fingerprint-addressed acquired source trees
 *     entries/<fingerprint>.meta    — { fingerprint, bytes, lastAccessMs, recordedAtMs }
 *     index.json                    — (canonicalLocator ⊕ selector) → last validated fingerprint
 *     pending-updates.json          — fingerprints of produced-but-unapplied Update Candidates
 *     locks/<fingerprint>.lock      — per-fingerprint mutual exclusion
 */

import { join } from 'node:path';

import { getGlobalStateDir } from '../bridge-state/paths.js';

export const CACHE_ENTRIES_DIR = 'entries';
export const CACHE_INDEX_FILENAME = 'index.json';
export const CACHE_PENDING_FILENAME = 'pending-updates.json';
export const CACHE_LOCKS_DIR = 'locks';
export const CACHE_META_SUFFIX = '.meta';

export function getCacheDir(agentDir?: string): string {
  return join(getGlobalStateDir(agentDir), 'cache');
}

export function getCacheEntriesDir(cacheDir: string): string {
  return join(cacheDir, CACHE_ENTRIES_DIR);
}

export function getCacheIndexPath(cacheDir: string): string {
  return join(cacheDir, CACHE_INDEX_FILENAME);
}

export function getCachePendingPath(cacheDir: string): string {
  return join(cacheDir, CACHE_PENDING_FILENAME);
}

export function getCacheLocksDir(cacheDir: string): string {
  return join(cacheDir, CACHE_LOCKS_DIR);
}
