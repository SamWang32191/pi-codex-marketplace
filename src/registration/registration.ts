/**
 * Registration identity and duplicate detection.
 * See CONTEXT.md: Registration ID, Registration Alias, Source Key, Marketplace ID.
 *
 * Registration ID: opaque immutable lowercase UUIDv4, generated locally, allocated BEFORE preflight
 * so findings have stable derived identities; persisted only after Registration Confirmation; never
 * reused after a failed or declined attempt.
 *
 * Registration Alias: optional scope-local human-readable handle, initially derived from a
 * compatible declared Marketplace name; unique within its scope.
 */

import { randomUUID } from 'node:crypto';

import { CODE, RULE, blocking } from './findings.js';
import type { ValidationFinding } from './findings.js';
import type { Scope } from '../bridge-state/types.js';
import type { Registration } from '../bridge-state/types.js';
import { localSourceKey, sourceKeyEquals, type SourceKey } from './source-key.js';

/** Allocate an immutable lowercase UUIDv4 before preflight. Never reused. */
export function allocateRegistrationId(): string {
  return randomUUID();
}

/** Sanitize a declared marketplace name into an initial Registration Alias (scope-local unique). */
export function deriveInitialAlias(marketplaceName: string | undefined, existingAliases: string[]): string | undefined {
  if (!marketplaceName || marketplaceName.trim().length === 0) return undefined;
  let alias = marketplaceName.trim();
  const taken = new Set(existingAliases);
  if (!taken.has(alias)) return alias;
  // scope-local uniqueness: append a numeric suffix
  let n = 2;
  while (taken.has(`${alias}-${n}`)) n += 1;
  return `${alias}-${n}`;
}

export interface DuplicateCheckResult {
  duplicate: boolean;
  /** The existing registration matched by identical Source Key (same kind). */
  existing?: Registration;
  finding?: ValidationFinding;
}

/**
 * Detect repeated registration within one scope by identical Source Key (same kind).
 * Local and Git kinds remain distinct; equal keys across scopes do not merge registrations.
 */
export function findDuplicateRegistration(
  scope: Scope,
  sourceKey: SourceKey,
  registrations: Registration[],
): DuplicateCheckResult {
  for (const reg of registrations) {
    if (!reg.sourceKey) continue;
    if (sourceKeyEquals(reg.sourceKey, sourceKey)) {
      return {
        duplicate: true,
        existing: reg,
        finding: blocking({
          code: CODE.DUPLICATE_SOURCE_KEY,
          phase: 'identity',
          target: 'registration',
          scope,
          pointer: `${sourceKey.kind}:${sourceKey.key}`,
          rule: RULE.DUPLICATE_SOURCE_KEY,
          outcome:
            sourceKey.kind === 'local'
              ? `a local Registration for canonical path '${sourceKey.canonicalPath ?? sourceKey.key}' already exists (${reg.id.slice(0, 8)}…)`
              : `a Registration with an identical Source Key already exists (${reg.id.slice(0, 8)}…)`,
        }),
      };
    }
  }
  return { duplicate: false };
}

/** Compute the local Source Key; returns Blocking findings on invalid input. */
export function sourceKeyForLocalRoot(
  rootPath: string,
  scope: Scope,
): { ok: true; sourceKey: SourceKey } | { ok: false; findings: ValidationFinding[] } {
  const res = localSourceKey(rootPath);
  if (!res.ok) {
    const missing = res.errno === 'ENOENT';
    return {
      ok: false,
      findings: [
        blocking({
          code: missing ? CODE.SOURCE_NOT_EXISTS : CODE.SOURCE_NOT_DIRECTORY,
          phase: 'identity',
          target: 'source',
          scope,
          pointer: rootPath,
          rule: missing ? RULE.SOURCE_NOT_EXISTS : RULE.SOURCE_NOT_DIRECTORY,
          outcome: res.error ?? 'unable to resolve local Marketplace Root',
        }),
      ],
    };
  }
  return { ok: true, sourceKey: res.sourceKey! };
}