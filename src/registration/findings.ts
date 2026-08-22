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
  | 'plugin'
  | 'skill'
  | 'registration'
  | 'installation'
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
  PLUGIN_MANIFEST_INVALID: 'COMP-01',
  SKILL_DESCRIPTOR_INVALID: 'COMP-02',
  UNSUPPORTED_ACTIVE_COMPONENT: 'COMP-03',
  PLUGIN_ID_COLLISION: 'COMP-04',
  REGISTRATION_NOT_FOUND: 'REG-01',
  UPDATE_PLAN_INCOMPLETE: 'UPD-01',
  INSTALLATION_NOT_FOUND: 'INSTALL-01',
  INSTALLATION_ALREADY_EXISTS: 'INSTALL-02',
  ACTIVATION_CONFIRMATION_REQUIRED: 'INSTALL-03',
  SOURCE_REACQUISITION_REQUIRED: 'INSTALL-04',
  RUNTIME_SKILL_COLLISION: 'COLLISION-01',
  SOURCE_DRIFT: 'DRIFT-01',
  SCOPE_OVERRIDE_TARGET_NOT_FOUND: 'OVR-01',
  SCOPE_OVERRIDE_ALREADY_PRESENT: 'OVR-02',
  GLOBAL_PENDING_BARRIER: 'BARRIER-01',
  RECEIPT_PERSISTENCE_FAILED: 'JOURNAL-01',
  RECEIPT_CORRUPT: 'JOURNAL-02',
  STATE_CORRUPT: 'PERSIST-01',
  STATE_SCHEMA_UNKNOWN: 'SCHEMA-01',
  RECONCILIATION_REQUIRED: 'RECON-01',
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
  PLUGIN_MANIFEST_INVALID: 'PLUGIN_MANIFEST_INVALID',
  SKILL_DESCRIPTOR_INVALID: 'SKILL_DESCRIPTOR_INVALID',
  UNSUPPORTED_ACTIVE_COMPONENT: 'UNSUPPORTED_ACTIVE_COMPONENT',
  INERT_METADATA_IGNORED: 'INERT_METADATA_IGNORED',
  PLUGIN_ID_COLLISION: 'PLUGIN_ID_COLLISION',
  REGISTRATION_NOT_FOUND: 'REGISTRATION_NOT_FOUND',
  UPDATE_PLAN_INCOMPLETE: 'UPDATE_PLAN_INCOMPLETE',
  INSTALLATION_NOT_FOUND: 'INSTALLATION_NOT_FOUND',
  INSTALLATION_ALREADY_EXISTS: 'INSTALLATION_ALREADY_EXISTS',
  ACTIVATION_CONFIRMATION_REQUIRED: 'ACTIVATION_CONFIRMATION_REQUIRED',
  SOURCE_REACQUISITION_REQUIRED: 'SOURCE_REACQUISITION_REQUIRED',
  RUNTIME_SKILL_COLLISION: 'RUNTIME_SKILL_COLLISION',
  SOURCE_DRIFT: 'SOURCE_DRIFT',
  SCOPE_OVERRIDE_TARGET_NOT_FOUND: 'SCOPE_OVERRIDE_TARGET_NOT_FOUND',
  SCOPE_OVERRIDE_ALREADY_PRESENT: 'SCOPE_OVERRIDE_ALREADY_PRESENT',
  GLOBAL_PENDING_BARRIER: 'GLOBAL_PENDING_BARRIER',
  RECEIPT_PERSISTENCE_FAILED: 'RECEIPT_PERSISTENCE_FAILED',
  RECEIPT_CORRUPT: 'RECEIPT_CORRUPT',
  STATE_CORRUPT: 'STATE_CORRUPT',
  STATE_SCHEMA_UNKNOWN: 'STATE_SCHEMA_UNKNOWN',
  RECONCILIATION_REQUIRED: 'RECONCILIATION_REQUIRED',
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
