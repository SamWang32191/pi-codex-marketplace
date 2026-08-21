/**
 * Registration findings — machine-readable validation results identified by stable rule codes.
 * See CONTEXT.md: Validation Finding, Blocking Finding, Validation Warning, Operational Notice.
 *
 * Presentation is derived from the finding (not stored as authority); ordering follows
 * class → phase → target → pointer → rule (prototype Decision).
 */

import type { Scope } from '../bridge-state/types.js';

export type FindingClass = 'blocking' | 'warning' | 'notice';

export type FindingPhase =
  | 'admission' // Attempt Fence / barrier checks
  | 'identity' // Source Key / duplicate / Registration ID
  | 'validation' // catalog / path / symlink / budget / snapshot
  | 'persistence' // commit / revision verify
  | 'post-commit'; // receipt / runtime (not asserted here)

export type FindingTarget =
  | 'source'
  | 'catalog'
  | 'entry'
  | 'registration'
  | 'attempt';

export interface ValidationFinding {
  /** Stable rule code, e.g. "PATH_CONTAINMENT_VIOLATION". */
  code: string;
  classification: FindingClass;
  phase: FindingPhase;
  target: FindingTarget;
  scope: Scope;
  /** File or data pointer (e.g. "/plugins/2/path", a relative path, or "" when none). */
  pointer: string;
  /** Closed rule id, e.g. "CONT-01". */
  rule: string;
  /** Human-readable operational outcome. */
  outcome: string;
}

/** Closed rule ids (stable across versions, referenced by Validation Ruleset). */
export const RULE = {
  ATTEMPT_IN_PROGRESS: 'FENCE-01',
  REJECTED_AS_STALE: 'STALE-01',
  REJECTED_AS_STALE_SNAPSHOT: 'STALE-02',
  PROJECT_TRUST_DENIED: 'TRUST-01',
  DUPLICATE_SOURCE_KEY: 'DUP-01',
  SOURCE_NOT_EXISTS: 'SRC-01',
  SOURCE_NOT_DIRECTORY: 'SRC-02',
  CATALOG_MISSING: 'CAT-01',
  CATALOG_MALFORMED: 'CAT-02',
  CATALOG_NAME_INVALID: 'CAT-03',
  CATALOG_ENTRY_MALFORMED: 'CAT-04',
  PATH_CONTAINMENT_VIOLATION: 'CONT-01',
  CONTAINED_SYMLINK_VIOLATION: 'CONT-02',
  BUDGET_EXCEEDED: 'BUDG-01',
} as const;

export const CODE = {
  ATTEMPT_IN_PROGRESS: 'ATTEMPT_IN_PROGRESS',
  REJECTED_AS_STALE: 'REJECTED_AS_STALE',
  PROJECT_TRUST_DENIED: 'PROJECT_TRUST_DENIED',
  DUPLICATE_SOURCE_KEY: 'DUPLICATE_SOURCE_KEY',
  SOURCE_NOT_EXISTS: 'SOURCE_NOT_EXISTS',
  SOURCE_NOT_DIRECTORY: 'SOURCE_NOT_DIRECTORY',
  CATALOG_MISSING: 'CATALOG_MISSING',
  CATALOG_MALFORMED: 'CATALOG_MALFORMED',
  CATALOG_NAME_INVALID: 'CATALOG_NAME_INVALID',
  CATALOG_ENTRY_MALFORMED: 'CATALOG_ENTRY_MALFORMED',
  PATH_CONTAINMENT_VIOLATION: 'PATH_CONTAINMENT_VIOLATION',
  CONTAINED_SYMLINK_VIOLATION: 'CONTAINED_SYMLINK_VIOLATION',
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
  DECLINED: 'DECLINED',
  PERSISTENCE_FAILED: 'PERSISTENCE_FAILED',
  PERSISTENCE_INDETERMINATE: 'PERSISTENCE_INDETERMINATE',
} as const;

const CLASS_RANK: Record<FindingClass, number> = { blocking: 0, warning: 1, notice: 2 };
const PHASE_RANK: Record<FindingPhase, number> = {
  admission: 0,
  identity: 1,
  validation: 2,
  persistence: 3,
  'post-commit': 4,
};

/** Deterministic ordering: class → phase → target → pointer → rule. */
export function sortFindings(findings: ValidationFinding[]): ValidationFinding[] {
  return [...findings].sort((a, b) => {
    return (
      CLASS_RANK[a.classification] - CLASS_RANK[b.classification] ||
      PHASE_RANK[a.phase] - PHASE_RANK[b.phase] ||
      a.target.localeCompare(b.target) ||
      a.pointer.localeCompare(b.pointer) ||
      a.rule.localeCompare(b.rule)
    );
  });
}

export function blocking(p: Omit<ValidationFinding, 'classification'>): ValidationFinding {
  return { ...p, classification: 'blocking' };
}
export function warning(p: Omit<ValidationFinding, 'classification'>): ValidationFinding {
  return { ...p, classification: 'warning' };
}
export function notice(p: Omit<ValidationFinding, 'classification'>): ValidationFinding {
  return { ...p, classification: 'notice' };
}

/** True if any finding is blocking (denies the Registration target). */
export function hasBlocking(findings: ValidationFinding[]): boolean {
  return findings.some((f) => f.classification === 'blocking');
}
