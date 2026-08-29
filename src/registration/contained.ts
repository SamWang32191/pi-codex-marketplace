/**
 * Contained Path / Contained Symlink — strict containment within an owning root.
 * See CONTEXT.md: Contained Path, Contained Symlink.
 *
 * Contained Path: a declared `./`-relative path with no absolute, backslash, NUL, dot, or parent
 * segment whose canonical target remains within its owning root. Existence without containment is
 * insufficient.
 *
 * Contained Symlink: a symlink whose canonical target is a regular file or directory within the same
 * owning root. Broken, looping, special-file, or root-external symlinks are Blocking Findings.
 */

import { realpathSync, readlinkSync, lstatSync, statSync } from 'node:fs';
import { isAbsolute, sep } from 'node:path';

export interface PathSyntax {
  ok: boolean;
  reason?: string;
}

/** Validate `./`-relative path syntax (no absolute, backslash, NUL, dot, or parent segments). */
export function containedPathSyntax(p: string): PathSyntax {
  if (typeof p !== 'string' || p.length === 0) return { ok: false, reason: 'empty path' };
  if (p.includes('\0')) return { ok: false, reason: 'NUL byte' };
  if (p.includes('\\')) return { ok: false, reason: 'backslash' };
  if (isAbsolute(p)) return { ok: false, reason: 'absolute path' };
  if (!p.startsWith('./')) return { ok: false, reason: 'not ./ relative' };
  if (p === './') return { ok: true };
  // The mandatory "./" prefix is not a path component; validate only the declared remainder.
  const segments = p.slice(2).split('/');
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') {
      return { ok: false, reason: `dot or parent segment '${seg}'` };
    }
  }
  return { ok: true };
}

export type ContainmentBlockClass = 'path' | 'symlink';

export type ContainmentOutcome =
  | { kind: 'ok'; canonicalPath: string }
  | { kind: 'blocking'; reason: string; blockClass: ContainmentBlockClass } // safety violation
  | { kind: 'missing' } // cannot resolve (Unavailable, not blocking)

export interface ContainmentResult {
  outcome: ContainmentOutcome;
  /** Symlink target when the resolved target is a symlink, else undefined. */
  symlinkTarget?: string;
  type: 'file' | 'directory' | 'symlink' | 'special';
}

function isWithin(root: string, target: string): boolean {
  if (target === root) return true;
  const prefix = root.endsWith(sep) ? root : root + sep;
  return target.startsWith(prefix);
}

/**
 * Resolve a `./`-relative declared path against a canonical owning root and verify strict
 * containment (including symlink targets) within the root.
 */
export function resolveContained(root: string, relPath: string, checkType: 'any' | 'file' | 'directory' = 'any'): ContainmentResult {
  const syntax = containedPathSyntax(relPath);
  if (!syntax.ok) {
    return {
      outcome: { kind: 'blocking', blockClass: 'path', reason: `path containment syntax violation: ${syntax.reason}` },
      type: 'special',
    };
  }

  let canonicalRoot = root;
  try {
    canonicalRoot = realpathSync.native(root);
  } catch {}

  const abs = canonicalRoot + sep + relPath.slice(2);
  let canonical: string;
  try {
    canonical = realpathSync.native(abs);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return { outcome: { kind: 'missing' }, type: 'special' };
    return { outcome: { kind: 'blocking', blockClass: 'symlink', reason: `unable to resolve: ${err.message}` }, type: 'special' };
  }

  // containment check
  if (!isWithin(canonicalRoot, canonical)) {
    return {
      outcome: { kind: 'blocking', blockClass: 'path', reason: `canonical target '${canonical}' escapes owning root '${root}'` },
      type: 'special',
    };
  }

  let type: ContainmentResult['type'];
  let symlinkTarget: string | undefined;
  try {
    const lst = lstatSync(abs);
    if (lst.isSymbolicLink()) {
      type = 'symlink';
      symlinkTarget = readlinkSync(abs);
      // canonical already resolved; for symlink, target file must be a regular file or directory
      try {
        const st = statSync(abs);
        if (!st.isFile() && !st.isDirectory()) {
          return {
            outcome: { kind: 'blocking', blockClass: 'symlink', reason: 'contained symlink resolves to a special file' },
            type: 'symlink',
            symlinkTarget,
          };
        }
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === 'ENOENT') {
          return {
            outcome: { kind: 'blocking', blockClass: 'symlink', reason: 'broken symlink (target does not exist)' },
            type: 'symlink',
            symlinkTarget,
          };
        }
        return {
          outcome: { kind: 'blocking', blockClass: 'symlink', reason: `symlink error: ${err.message}` },
          type: 'symlink',
          symlinkTarget,
        };
      }
    } else if (lst.isFile()) {
      type = 'file';
    } else if (lst.isDirectory()) {
      type = 'directory';
    } else {
      return { outcome: { kind: 'blocking', blockClass: 'path', reason: 'not a regular file or directory' }, type: 'special' };
    }
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return { outcome: { kind: 'missing' }, type: 'special' };
    return { outcome: { kind: 'blocking', blockClass: 'path', reason: `lstat error: ${err.message}` }, type: 'special' };
  }

  if (checkType !== 'any' && type !== checkType && type !== 'symlink') {
    return { outcome: { kind: 'blocking', blockClass: 'path', reason: `expected ${checkType} but got ${type}` }, type };
  }

  return { outcome: { kind: 'ok', canonicalPath: canonical }, type, symlinkTarget };
}
