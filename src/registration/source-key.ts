/**
 * Source Key — deterministic typed value for duplicate detection / repeated registration.
 * See CONTEXT.md: Source Key. Not the identity of a registration.
 *
 * local Source Key = canonical real path of the Marketplace Root.
 * git Source Key   = canonical (credential-free) remote URL + exact selector (implemented in #18).
 * Local and Git keys remain distinct; a duplicate key detects a repeated registration.
 */

import { realpathSync, statSync } from 'node:fs';

import type { CanonicalGitLocator } from './git-locator.js';
import type { NormalizedGitSelector } from './git-selector.js';

export type SourceKind = 'local' | 'git';

export interface SourceKey {
  kind: SourceKind;
  /** Deterministic, typed key value used only for comparison. */
  key: string;
  /** Canonical real path for local; resolved via fs.realpathSync. */
  canonicalPath?: string;
  /** Canonical Git URL for git */
  canonicalUrl?: string;
  /** Canonical Git selector (for git) */
  selector?: string;
  /** Resolved Revision (git, not part of identity but stored for provenance) */
  resolvedRevision?: string;
}

export interface SourceKeyResult {
  ok: boolean;
  sourceKey?: SourceKey;
  error?: string;
  /** Node errno code (ENOENT / ENOTDIR / …) when resolution failed. */
  errno?: string;
}

/** Build a local Source Key from the Marketplace Root. Fails (Blocking) if path missing/not a dir. */
export function localSourceKey(rootPath: string): SourceKeyResult {
  let canonical: string;
  try {
    canonical = realpathSync.native(rootPath);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Unable to resolve Marketplace Root real path: ${msg}`, errno: err.code };
  }

  let isDir = false;
  let errno: string | undefined;
  try {
    isDir = statSync(canonical).isDirectory();
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    errno = err.code;
    isDir = false;
  }
  if (!isDir) {
    return {
      ok: false,
      error: `Marketplace Root is not a directory: ${canonical}`,
      errno,
    };
  }

  return {
    ok: true,
    sourceKey: {
      kind: 'local',
      key: `local:${canonical}`,
      canonicalPath: canonical,
    },
  };
}

/** Build a Git Source Key from its canonical locator + exact selector (type-distinct from local). */
export function gitSourceKey(
  locator: CanonicalGitLocator,
  selector: NormalizedGitSelector,
): SourceKey {
  const canonicalUrl = locator.canonicalUrl;
  const sel = selector.canonical;
  // Key is deterministic: git:<canonicalUrl>#<canonicalSelector>
  // Preserve host lowercasing and path case via canonicalUrl; selector already canonical.
  const key = `git:${canonicalUrl}#${sel}`;
  return {
    kind: 'git',
    key,
    canonicalUrl,
    selector: sel,
  };
}

/**
 * Equality across source keys: same kind AND same key value.
 * Local and Git kinds are intrinsically distinct even when a local dir is a clone of the git repo.
 */
export function sourceKeyEquals(a: SourceKey, b: SourceKey): boolean {
  return a.kind === b.kind && a.key === b.key;
}

/** Redact secret-bearing content out of a locator string (local real paths carry no credentials). */
export function redactSource(source: string): string {
  // Local real paths carry no credentials; guard against accidental '://user:pass@' for future git.
  return source.replace(/\/\/[^/?#]+@/, (m) => {
    // if it looks like user:pass@host, strip credentials
    if (/\/\/[^:/\s]+:[^@\s]+@/.test(m)) return m.replace(/:[^@]*@/, ':***@');
    return m;
  });
}
