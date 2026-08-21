/**
 * Validation Snapshot — the immutable source state to which validation and confirmation apply.
 * See CONTEXT.md: Validation Snapshot.
 *
 * Covers the complete inspected tree: ordered paths, object types, modes, symlink targets, content
 * hashes. Binds the Source Key, Compatibility Profile, Validation Ruleset, and Validation Budget.
 * For Git, also binds Canonical Git Locator and Resolved Revision.
 * The fingerprint must still match before durable state mutation; a mismatch is a Blocking Finding.
 *
 * Deterministic: entries are always ordered by relative path; the fingerprint is a sha256 over the
 * canonical entry list plus binds.
 */

import { createHash } from 'node:crypto';
import {
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { join, sep } from 'node:path';

import { BUDGET, COMPATIBILITY_PROFILE, VALIDATION_BUDGET, VALIDATION_RULESET } from './budget.js';
import { CODE, RULE, blocking, type ValidationFinding } from './findings.js';
import type { SourceKey } from './source-key.js';
import type { Scope } from '../bridge-state/types.js';

export type SnapshotEntryType = 'file' | 'dir' | 'symlink';

export interface SnapshotEntry {
  /** Posix relative path from the Marketplace Root. */
  relPath: string;
  type: SnapshotEntryType;
  /** Permission bits (file mode). */
  mode: number;
  /** Byte size (files). */
  size: number;
  /** Symlink target text (symlinks), else undefined. */
  symlinkTarget?: string;
  /** sha256 content hash (files), else undefined. */
  contentHash?: string;
}

export interface ValidationSnapshot {
  /** sha256 hex over ordered entries + binds. */
  fingerprint: string;
  scope: Scope;
  /** Ordered (sorted) inspected tree entries. */
  entries: SnapshotEntry[];
  /** Bound Source Key (local canonical real path for #17, git canonicalUrl+selector for #18). */
  sourceKey: SourceKey;
  profile: string;
  ruleset: string;
  budget: string;
  /** Git-only: Canonical Git Locator bound at validation time */
  canonicalLocator?: string;
  /** Git-only: Resolved Revision (full commit) bound at validation time */
  resolvedRevision?: string;
  /** Git-only: canonical selector string */
  selectorCanonical?: string;
}

/**
 * Bind material captured while deriving a disclosure into the Validation Snapshot.
 * The base tree fingerprint remains available to registration-drift checks, while the
 * activation snapshot also proves the exact catalog/profile bytes observed by preflight.
 */
export function bindCapturedMaterial(snapshot: ValidationSnapshot, captureFingerprint: string): ValidationSnapshot {
  const fingerprint = createHash('sha256')
    .update(snapshot.fingerprint)
    .update('\u001f')
    .update(captureFingerprint)
    .digest('hex');
  return { ...snapshot, fingerprint };
}

export interface SnapshotResult {
  ok: boolean;
  snapshot?: ValidationSnapshot;
  findings: ValidationFinding[];
}

function hashEntry(e: SnapshotEntry): string {
  const parts = [e.relPath, e.type, String(e.mode), String(e.size)];
  if (e.type === 'symlink') parts.push(e.symlinkTarget ?? '');
  if (e.type === 'file') parts.push(e.contentHash ?? '');
  return parts.join('\u001f');
}

function fingerprintOf(entries: SnapshotEntry[], binds: string[]): string {
  const h = createHash('sha256');
  for (const e of entries) h.update(hashEntry(e));
  h.update('\u001e');
  for (const b of binds) h.update(b + '\u001f');
  return h.digest('hex');
}

const IGNORE_DIRS = new Set(['.git', 'node_modules']);
// Rationale: a local Marketplace Root that is a git clone must not let the Bridge's own VCS
// metadata (.git) or vendored dependency trees (node_modules) churn the fingerprint; the
// snapshot still records the directory entries themselves at their own depth. Full snapshot
// semantics over these dirs is revisited with Source Drift (#22).

function walkTree(
  canonicalRoot: string,
  scope: Scope,
  skip: Set<string>,
  findings: ValidationFinding[],
  entries: SnapshotEntry[],
): { fileCount: number; totalBytes: number; budgetBlocked: boolean } {
  let fileCount = 0;
  let totalBytes = 0;
  let budgetBlocked = false;

  const failBudget = (msg: string) => {
    budgetBlocked = true;
    findings.push(
      blocking({
        code: CODE.BUDGET_EXCEEDED,
        phase: 'validation',
        target: 'source',
        scope,
        pointer: '/',
        rule: RULE.BUDGET_EXCEEDED,
        outcome: msg,
      }),
    );
  };

  const walk = (dir: string, depth: number, stack: string[]): void => {
    if (budgetBlocked) return;
    if (depth > BUDGET.maxTreeDepth) {
      failBudget(`Validation Budget exceeded: tree depth ${depth} > ${BUDGET.maxTreeDepth}`);
      return;
    }
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') return;
      failBudget(`unable to read directory: ${err.message}`);
      return;
    }
    names.sort();
    for (const name of names) {
      if (budgetBlocked) return;
      const abs = join(dir, name);
      const rel = [...stack, name].join('/');
      let lst;
      try {
        lst = lstatSync(abs);
      } catch {
        continue; // vanished during walk (or broken entry)
      }
      if (lst.isSymbolicLink()) {
        let target = '';
        try {
          target = readlinkSync(abs);
        } catch (e) {
          const err = e as NodeJS.ErrnoException;
          findings.push(
            blocking({
              code: CODE.CONTAINED_SYMLINK_VIOLATION,
              phase: 'validation',
              target: 'source',
              scope,
              pointer: rel,
              rule: RULE.CONTAINED_SYMLINK_VIOLATION,
              outcome: `broken symlink: ${err.message}`,
            }),
          );
          continue;
        }
        entries.push({ relPath: rel, type: 'symlink', mode: lst.mode, size: lst.size, symlinkTarget: target });
        continue;
      }
      if (lst.isDirectory()) {
        entries.push({ relPath: rel, type: 'dir', mode: lst.mode, size: lst.size });
        if (!skip.has(name)) walk(abs, depth + 1, [...stack, name]);
        continue;
      }
      if (!lst.isFile()) {
        // special files are recorded but not hashed
        entries.push({ relPath: rel, type: 'file', mode: lst.mode, size: lst.size });
        continue;
      }
      fileCount += 1;
      if (fileCount > BUDGET.maxFiles) {
        failBudget(`Validation Budget exceeded: ${fileCount} files > ${BUDGET.maxFiles}`);
        return;
      }
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(abs);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === 'ENOENT') continue;
        failBudget(`stat error: ${err.message}`);
        return;
      }
      totalBytes += st.size;
      if (totalBytes > BUDGET.maxTotalBytes) {
        failBudget(`Validation Budget exceeded: ${totalBytes} bytes > ${BUDGET.maxTotalBytes}`);
        return;
      }
      let contentHash = '';
      try {
        contentHash = createHash('sha256').update(readFileSync(abs)).digest('hex');
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === 'ENOENT') continue;
        failBudget(`unable to hash content: ${err.message}`);
        return;
      }
      entries.push({ relPath: rel, type: 'file', mode: lst.mode, size: st.size, contentHash });
    }
  };

  walk(canonicalRoot, 1, []);
  return { fileCount, totalBytes, budgetBlocked };
}

function checkSymlinkContainment(canonicalRoot: string, entries: SnapshotEntry[], scope: Scope, findings: ValidationFinding[]): void {
  for (const e of entries) {
    if (e.type !== 'symlink') continue;
    const abs = join(canonicalRoot, ...e.relPath.split('/'));
    let canonical = '';
    try {
      canonical = realpathSync.native(abs);
    } catch {
      findings.push(
        blocking({
          code: CODE.CONTAINED_SYMLINK_VIOLATION,
          phase: 'validation',
          target: 'source',
          scope,
          pointer: e.relPath,
          rule: RULE.CONTAINED_SYMLINK_VIOLATION,
          outcome: `broken or looping symlink: '${e.relPath}' has no resolvable canonical target`,
        }),
      );
      continue;
    }
    const prefix = canonicalRoot.endsWith(sep) ? canonicalRoot : canonicalRoot + sep;
    if (canonical !== canonicalRoot && !canonical.startsWith(prefix)) {
      findings.push(
        blocking({
          code: CODE.CONTAINED_SYMLINK_VIOLATION,
          phase: 'validation',
          target: 'source',
          scope,
          pointer: e.relPath,
          rule: RULE.CONTAINED_SYMLINK_VIOLATION,
          outcome: `symlink target '${canonical}' escapes owning root`,
        }),
      );
    }
  }
}

/**
 * Build a Validation Snapshot for a local Marketplace Root (canonical real path).
 * Walks the complete tree without following symlinks; symlink targets are recorded, not descended.
 * Budget limits produce Blocking Findings at the source boundary.
 */
export function buildLocalSnapshot(
  canonicalRoot: string,
  sourceKey: SourceKey,
  scope: Scope,
  opts: { skipDirs?: Set<string> } = {},
): SnapshotResult {
  const findings: ValidationFinding[] = [];
  const entries: SnapshotEntry[] = [];
  const skip = opts.skipDirs ?? IGNORE_DIRS;

  const { budgetBlocked } = walkTree(canonicalRoot, scope, skip, findings, entries);

  // Sort deterministically by posix relative path.
  entries.sort((a, b) => a.relPath.localeCompare(b.relPath));

  if (budgetBlocked) {
    return { ok: false, findings };
  }

  // Symlink containment: any symlink in the tree whose canonical target escapes the root — or
  // cannot be resolved at all (broken / looping) — is a Blocking Finding (CONTEXT: Contained
  // Symlink).
  checkSymlinkContainment(canonicalRoot, entries, scope, findings);

  const binds = [sourceKey.key, COMPATIBILITY_PROFILE, VALIDATION_RULESET, VALIDATION_BUDGET];

  if (findings.some((f) => f.classification === 'blocking')) {
    return {
      ok: false,
      findings,
      snapshot: {
        fingerprint: fingerprintOf(entries, binds),
        scope,
        entries,
        sourceKey,
        profile: COMPATIBILITY_PROFILE,
        ruleset: VALIDATION_RULESET,
        budget: VALIDATION_BUDGET,
      },
    };
  }

  return {
    ok: true,
    findings,
    snapshot: {
      fingerprint: fingerprintOf(entries, binds),
      scope,
      entries,
      sourceKey,
      profile: COMPATIBILITY_PROFILE,
      ruleset: VALIDATION_RULESET,
      budget: VALIDATION_BUDGET,
    },
  };
}

/**
 * Build a Validation Snapshot for a Git-acquired Marketplace Root.
 * Same tree walk as local, but binds also include Canonical Locator and Resolved Revision
 * (Source Key already contains canonicalUrl+selector; we bind them additionally for explicitness).
 */
export function buildGitSnapshot(
  acquiredRoot: string,
  sourceKey: SourceKey,
  scope: Scope,
  extra: { canonicalLocator: string; resolvedRevision: string; selectorCanonical: string },
  opts: { skipDirs?: Set<string> } = {},
): SnapshotResult {
  const findings: ValidationFinding[] = [];
  const entries: SnapshotEntry[] = [];
  const skip = opts.skipDirs ?? IGNORE_DIRS;

  const { budgetBlocked } = walkTree(acquiredRoot, scope, skip, findings, entries);

  entries.sort((a, b) => a.relPath.localeCompare(b.relPath));

  if (budgetBlocked) {
    return { ok: false, findings };
  }

  checkSymlinkContainment(acquiredRoot, entries, scope, findings);

  const binds = [
    sourceKey.key,
    extra.canonicalLocator,
    extra.resolvedRevision,
    extra.selectorCanonical,
    COMPATIBILITY_PROFILE,
    VALIDATION_RULESET,
    VALIDATION_BUDGET,
  ];

  const fingerprint = fingerprintOf(entries, binds);

  const snapshot: ValidationSnapshot = {
    fingerprint,
    scope,
    entries,
    sourceKey,
    profile: COMPATIBILITY_PROFILE,
    ruleset: VALIDATION_RULESET,
    budget: VALIDATION_BUDGET,
    canonicalLocator: extra.canonicalLocator,
    resolvedRevision: extra.resolvedRevision,
    selectorCanonical: extra.selectorCanonical,
  };

  if (findings.some((f) => f.classification === 'blocking')) {
    return { ok: false, findings, snapshot };
  }

  return { ok: true, findings, snapshot };
}
