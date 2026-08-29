/**
 * Registration findings — machine-readable validation results identified by stable rule codes.
 * See CONTEXT.md: Validation Finding, Blocking Finding.
 *
 * Presentation is derived from the finding (not stored as authority); ordering follows
 * class → phase → target → pointer → rule (prototype Decision).
 */

export type FindingClass = 'blocking' | 'warning' | 'notice';

export type FindingPhase =
  | 'identity' // Source Key / duplicate / Registration ID
  | 'validation'; // catalog / path / symlink / budget / snapshot

export type FindingTarget =
  | 'source'
  | 'catalog'
  | 'entry';

export interface ValidationFinding {
  /** Stable rule code, e.g. "PATH_CONTAINMENT_VIOLATION". */
  code: string;
  classification: FindingClass;
  phase: FindingPhase;
  target: FindingTarget;
  /** File or data pointer (e.g. "/plugins/2/path", a relative path, or "" when none). */
  pointer: string;
  /** Closed rule id, e.g. "CONT-01". */
  rule: string;
  /** Human-readable operational outcome. */
  outcome: string;
}

/** Closed rule ids (stable across versions). */
export const RULE = {
  CATALOG_MISSING: 'CAT-01',
  CATALOG_MALFORMED: 'CAT-02',
  CATALOG_NAME_INVALID: 'CAT-03',
  CATALOG_ENTRY_MALFORMED: 'CAT-04',
  CATALOG_OWNER_INVALID: 'CAT-06',
  PATH_CONTAINMENT_VIOLATION: 'CONT-01',
  CONTAINED_SYMLINK_VIOLATION: 'CONT-02',
  BUDGET_EXCEEDED: 'BUDG-01',
  GIT_LOCATOR_INVALID: 'GIT-01',
  GIT_LOCATOR_PLAINTEXT: 'GIT-02',
  GIT_LOCATOR_CREDENTIAL: 'GIT-03',
  GIT_LOCATOR_QUERY_FRAGMENT: 'GIT-04',
  GIT_LOCATOR_CONTROL_CHARS: 'GIT-05',
  GIT_LOCATOR_AMBIGUOUS_ENCODING: 'GIT-06',
  GIT_SELECTOR_INVALID: 'GIT-10',
  GIT_SELECTOR_BRANCH_INVALID: 'GIT-11',
  GIT_SELECTOR_TAG_INVALID: 'GIT-12',
  GIT_SELECTOR_COMMIT_INVALID: 'GIT-13',
  GIT_RESOLVED_REVISION_INVALID: 'GIT-20',
  GIT_ACQUISITION_FAILED: 'GIT-30',
  GIT_TRUST_HOST_KEY: 'GIT-31',
  GIT_TRUST_REDIRECT: 'GIT-32',
  GIT_TRUST_CREDENTIAL_HELPER: 'GIT-33',
} as const;

export const CODE = {
  CATALOG_MISSING: 'CATALOG_MISSING',
  CATALOG_MALFORMED: 'CATALOG_MALFORMED',
  CATALOG_NAME_INVALID: 'CATALOG_NAME_INVALID',
  CATALOG_ENTRY_MALFORMED: 'CATALOG_ENTRY_MALFORMED',
  CATALOG_OWNER_INVALID: 'CATALOG_OWNER_INVALID',
  PATH_CONTAINMENT_VIOLATION: 'PATH_CONTAINMENT_VIOLATION',
  CONTAINED_SYMLINK_VIOLATION: 'CONTAINED_SYMLINK_VIOLATION',
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
  GIT_LOCATOR_INVALID: 'GIT_LOCATOR_INVALID',
  GIT_LOCATOR_PLAINTEXT: 'GIT_LOCATOR_PLAINTEXT',
  GIT_LOCATOR_CREDENTIAL: 'GIT_LOCATOR_CREDENTIAL',
  GIT_LOCATOR_QUERY_FRAGMENT: 'GIT_LOCATOR_QUERY_FRAGMENT',
  GIT_LOCATOR_CONTROL_CHARS: 'GIT_LOCATOR_CONTROL_CHARS',
  GIT_LOCATOR_AMBIGUOUS_ENCODING: 'GIT_LOCATOR_AMBIGUOUS_ENCODING',
  GIT_SELECTOR_INVALID: 'GIT_SELECTOR_INVALID',
  GIT_SELECTOR_BRANCH_INVALID: 'GIT_SELECTOR_BRANCH_INVALID',
  GIT_SELECTOR_TAG_INVALID: 'GIT_SELECTOR_TAG_INVALID',
  GIT_SELECTOR_COMMIT_INVALID: 'GIT_SELECTOR_COMMIT_INVALID',
  GIT_RESOLVED_REVISION_INVALID: 'GIT_RESOLVED_REVISION_INVALID',
  GIT_ACQUISITION_FAILED: 'GIT_ACQUISITION_FAILED',
  GIT_TRUST_HOST_KEY_UNKNOWN: 'GIT_TRUST_HOST_KEY_UNKNOWN',
  GIT_TRUST_HOST_KEY_CHANGED: 'GIT_TRUST_HOST_KEY_CHANGED',
  GIT_TRUST_REDIRECT: 'GIT_TRUST_REDIRECT',
  GIT_TRUST_CREDENTIAL_HELPER: 'GIT_TRUST_CREDENTIAL_HELPER',
} as const;

const CLASS_RANK: Record<FindingClass, number> = { blocking: 0, warning: 1, notice: 2 };
const PHASE_RANK: Record<FindingPhase, number> = {
  identity: 0,
  validation: 1,
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