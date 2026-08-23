/**
 * Attempt Receipt — redacted, immutable, non-authoritative record of one Bridge-managed attempt.
 * See CONTEXT.md: Attempt Receipt, Attempt Summary, Validation Finding, Recovery Action.
 *
 * Relates expected / target / observed State Revisions with the applicable Validation Snapshot,
 * outcomes, findings. Received object is frozen (immutable) and secret-bearing input is redacted.
 */

import { randomUUID } from 'node:crypto';

import type { Scope } from '../bridge-state/types.js';
import { CODE, hasBlocking, sortFindings, type ValidationFinding } from './findings.js';
import { redactSource } from './source-key.js';

/** Closed set of 8 Attempt Summary values (CONTEXT.md). */
export type AttemptSummary =
  | 'Completed'
  | 'Completed with diagnostics'
  | 'Declined'
  | 'Blocked'
  | 'Rejected as Stale'
  | 'Persistence Failed'
  | 'Persistence Indeterminate'
  | 'Pending Application';

/** Closed set of 9 Recovery Actions (CONTEXT.md & Issue #9). */
export type RecoveryAction =
  | 'Retry'
  | 'Revalidate'
  | 'Refresh'
  | 'Rebind'
  | 'Retry Application'
  | 'Disable'
  | 'Remove'
  | 'Repair State'
  | 'Inspect';

export type ReceiptKind =
  | 'Lifecycle Operation'
  | 'Marketplace Refresh'
  | 'Runtime Application'
  | 'Reconciliation'
  | 'State Repair';

export type DurableOutcome = 'committed' | 'unchanged' | 'failed' | 'indeterminate';
export type RuntimeOutcome = 'applied' | 'pending-application' | 'none';

export interface AttemptReceipt {
  /** Opaque receipt id (rcpt_<uuid>). */
  id: string;
  kind: ReceiptKind;
  /** Operation name (e.g. "Marketplace Registration", "Plugin Installation", etc.) */
  operation: string;
  scope: Scope;
  /** Redacted trigger description. */
  trigger: string;
  /** ISO timestamp when attempt started. */
  startedAt: string;
  /** ISO timestamp when attempt completed. */
  completedAt: string;
  /** State Revision expected before preflight. */
  expectedStateRevision: string;
  /** State Revision targeted to commit. */
  targetStateRevision?: string;
  /** State Revision observed after commit/verify. */
  observedStateRevision?: string;
  /** Bound Validation Snapshot fingerprint. */
  validationSnapshot?: string;
  /** Array of snapshot fingerprints involved. */
  snapshotFingerprints?: string[];
  /** Three-orthogonal axis 1: Durable persistence outcome. */
  durableOutcome: DurableOutcome;
  /** Three-orthogonal axis 2: Findings. Redacted and sorted. */
  findings: ValidationFinding[];
  /** Three-orthogonal axis 3: Runtime reload/participation outcome. */
  runtimeOutcome: RuntimeOutcome;
  /** User-visible closed Attempt Summary. */
  summary: AttemptSummary;
  /** Closed Recovery Actions eligible under current state. */
  recoveryActions: RecoveryAction[];
  /** Whether durable state was modified. */
  stateChanged: boolean;
  /** Active recovery chain link: receipt id this attempt seeks to recover. */
  recoversReceiptId?: string;
  /** Receipt id this attempt supersedes with a replacement commit. */
  supersedesReceiptId?: string;
  /** ISO timestamp of receipt creation. */
  createdAt: string;
}

const RECEIPT_KINDS = new Set<ReceiptKind>([
  'Lifecycle Operation',
  'Marketplace Refresh',
  'Runtime Application',
  'Reconciliation',
  'State Repair',
]);
const DURABLE_OUTCOMES = new Set<DurableOutcome>([
  'committed',
  'unchanged',
  'failed',
  'indeterminate',
]);
const RUNTIME_OUTCOMES = new Set<RuntimeOutcome>([
  'applied',
  'pending-application',
  'none',
]);
const ATTEMPT_SUMMARIES = new Set<AttemptSummary>([
  'Completed',
  'Completed with diagnostics',
  'Declined',
  'Blocked',
  'Rejected as Stale',
  'Persistence Failed',
  'Persistence Indeterminate',
  'Pending Application',
]);
const RECOVERY_ACTIONS = new Set<RecoveryAction>([
  'Retry',
  'Revalidate',
  'Refresh',
  'Rebind',
  'Retry Application',
  'Disable',
  'Remove',
  'Repair State',
  'Inspect',
]);
const FINDING_CLASSES = new Set(['blocking', 'warning', 'notice']);
const FINDING_PHASES = new Set([
  'admission',
  'identity',
  'validation',
  'persistence',
  'post-commit',
]);
const FINDING_TARGETS = new Set([
  'source',
  'catalog',
  'entry',
  'plugin',
  'skill',
  'registration',
  'installation',
  'attempt',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

const CANONICAL_RECEIPT_ID = /^rcpt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function isReceiptId(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_RECEIPT_ID.test(value);
}

function isOptionalReceiptId(value: unknown): value is string | undefined {
  return value === undefined || isReceiptId(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isValidationFinding(value: unknown): value is ValidationFinding {
  if (!isRecord(value)) return false;

  return (
    typeof value.code === 'string' &&
    typeof value.classification === 'string' &&
    FINDING_CLASSES.has(value.classification) &&
    typeof value.phase === 'string' &&
    FINDING_PHASES.has(value.phase) &&
    typeof value.target === 'string' &&
    FINDING_TARGETS.has(value.target) &&
    (value.scope === 'global' || value.scope === 'project') &&
    typeof value.pointer === 'string' &&
    typeof value.rule === 'string' &&
    typeof value.outcome === 'string'
  );
}

/** Runtime boundary guard for untrusted JSONL entries in the Receipt Journal. */
export function isAttemptReceipt(value: unknown): value is AttemptReceipt {
  if (!isRecord(value)) return false;

  return (
    isReceiptId(value.id) &&
    typeof value.kind === 'string' &&
    RECEIPT_KINDS.has(value.kind as ReceiptKind) &&
    typeof value.operation === 'string' &&
    (value.scope === 'global' || value.scope === 'project') &&
    typeof value.trigger === 'string' &&
    typeof value.startedAt === 'string' &&
    typeof value.completedAt === 'string' &&
    typeof value.expectedStateRevision === 'string' &&
    isOptionalString(value.targetStateRevision) &&
    isOptionalString(value.observedStateRevision) &&
    isOptionalString(value.validationSnapshot) &&
    (value.snapshotFingerprints === undefined || isStringArray(value.snapshotFingerprints)) &&
    typeof value.durableOutcome === 'string' &&
    DURABLE_OUTCOMES.has(value.durableOutcome as DurableOutcome) &&
    Array.isArray(value.findings) &&
    value.findings.every(isValidationFinding) &&
    typeof value.runtimeOutcome === 'string' &&
    RUNTIME_OUTCOMES.has(value.runtimeOutcome as RuntimeOutcome) &&
    typeof value.summary === 'string' &&
    ATTEMPT_SUMMARIES.has(value.summary as AttemptSummary) &&
    Array.isArray(value.recoveryActions) &&
    value.recoveryActions.every(
      (action) => typeof action === 'string' && RECOVERY_ACTIONS.has(action as RecoveryAction),
    ) &&
    typeof value.stateChanged === 'boolean' &&
    isOptionalReceiptId(value.recoversReceiptId) &&
    isOptionalReceiptId(value.supersedesReceiptId) &&
    typeof value.createdAt === 'string'
  );
}

export interface ReceiptOptions {
  id?: string;
  kind?: ReceiptKind;
  operation: string;
  scope: Scope;
  trigger: string;
  startedAt?: string;
  completedAt?: string;
  expectedStateRevision: string;
  targetStateRevision?: string;
  observedStateRevision?: string;
  validationSnapshot?: string;
  snapshotFingerprints?: string[];
  durableOutcome?: DurableOutcome;
  runtimeOutcome?: RuntimeOutcome;
  findings?: ValidationFinding[];
  summary?: AttemptSummary;
  recoveryActions?: RecoveryAction[];
  stateChanged?: boolean;
  declined?: boolean;
  recoversReceiptId?: string;
  supersedesReceiptId?: string;
}

/** Derive closed Attempt Summary from the three orthogonal outcomes. */
export function deriveAttemptSummary(
  durable: DurableOutcome,
  findings: ValidationFinding[],
  runtime: RuntimeOutcome,
  opts: { declined?: boolean } = {},
): AttemptSummary {
  if (durable === 'indeterminate') return 'Persistence Indeterminate';
  if (durable === 'failed') return 'Persistence Failed';
  if (opts.declined) return 'Declined';

  const hasStale = findings.some(
    (f) => f.code === CODE.REJECTED_AS_STALE || f.rule === 'STALE-01' || f.rule === 'STALE-02',
  );
  if (hasStale && durable !== 'committed') return 'Rejected as Stale';

  if (durable !== 'committed' && hasBlocking(findings)) return 'Blocked';

  if (durable === 'committed') {
    if (runtime === 'pending-application') return 'Pending Application';
    const hasDiagnostics = findings.some((f) => f.classification === 'warning' || f.classification === 'notice');
    return hasDiagnostics ? 'Completed with diagnostics' : 'Completed';
  }

  // If durable is unchanged and no blocking findings
  if (runtime === 'applied') return 'Completed';
  if (runtime === 'pending-application') return 'Pending Application';
  return 'Blocked';
}

/** Derive closed Recovery Actions from the Attempt Summary and findings. */
export function deriveRecoveryActions(
  summary: AttemptSummary,
  findings: ValidationFinding[],
  _context: { canRebind?: boolean; isInstalled?: boolean } = {},
): RecoveryAction[] {
  switch (summary) {
    case 'Persistence Indeterminate':
      return ['Repair State', 'Inspect'];
    case 'Persistence Failed':
      return ['Retry'];
    case 'Rejected as Stale':
      return ['Revalidate'];
    case 'Pending Application':
      return ['Retry Application'];
    case 'Declined':
      return [];
    case 'Completed':
      return [];
    case 'Completed with diagnostics': {
      const actions: RecoveryAction[] = [];
      if (findings.some((f) => f.code === CODE.RUNTIME_SKILL_COLLISION)) {
        actions.push('Inspect', 'Disable', 'Remove');
      } else {
        actions.push('Inspect');
      }
      return actions;
    }
    case 'Blocked': {
      // Check finding types
      if (findings.some((f) => f.code === CODE.SOURCE_DRIFT)) {
        return ['Refresh'];
      }
      if (findings.some((f) => f.code.startsWith('GIT_LOCATOR_') || f.code.startsWith('GIT_SELECTOR_'))) {
        return ['Rebind', 'Inspect'];
      }
      if (findings.some((f) => f.code === CODE.ATTEMPT_IN_PROGRESS || f.code === CODE.GLOBAL_PENDING_BARRIER)) {
        return ['Inspect'];
      }
      if (findings.some((f) => f.code === CODE.PROJECT_TRUST_DENIED)) {
        return ['Inspect'];
      }
      if (findings.some((f) => f.code === CODE.CATALOG_MISSING || f.code === CODE.CATALOG_MALFORMED)) {
        return ['Inspect'];
      }
      if (findings.some((f) => f.code === CODE.BUDGET_EXCEEDED || f.code === CODE.PATH_CONTAINMENT_VIOLATION)) {
        return ['Inspect'];
      }
      return ['Inspect'];
    }
  }
}

/** Format a Three-Orthogonal Diagnostic Report string. */
export function formatThreeOrthogonalReport(receipt: AttemptReceipt): string {
  const lines: string[] = [];

  // Persistence Partition
  let persistenceStr = '';
  if (receipt.durableOutcome === 'committed') {
    persistenceStr = `已提交 (State Revision: ${receipt.observedStateRevision ?? receipt.targetStateRevision ?? '?'})`;
  } else if (receipt.durableOutcome === 'failed') {
    persistenceStr = `Persistence Failed (維持先前 State Revision ${receipt.expectedStateRevision})`;
  } else if (receipt.durableOutcome === 'indeterminate') {
    persistenceStr = `Persistence Indeterminate (狀態損毀或無法驗證，fail-closed)`;
  } else {
    persistenceStr = `未變更 (維持 State Revision ${receipt.expectedStateRevision})`;
  }
  lines.push(`【持久化 / Persistence】: ${persistenceStr}`);

  // Findings Partition
  const blockingCount = receipt.findings.filter((f) => f.classification === 'blocking').length;
  const warningCount = receipt.findings.filter((f) => f.classification === 'warning').length;
  const noticeCount = receipt.findings.filter((f) => f.classification === 'notice').length;
  lines.push(`【診斷 / Findings】: ${blockingCount} Blocking · ${warningCount} Warning · ${noticeCount} Notice`);
  for (const f of receipt.findings) {
    const ptr = f.pointer ? ` @${f.pointer}` : '';
    lines.push(`  - [${f.classification.toUpperCase()}] ${f.code} (${f.rule}): ${f.outcome}${ptr}`);
  }

  // Runtime Partition
  let runtimeStr = '';
  if (receipt.runtimeOutcome === 'applied') {
    runtimeStr = 'Applied (宿主驗證生效)';
  } else if (receipt.runtimeOutcome === 'pending-application') {
    runtimeStr = 'Pending Application (待重載/套用)';
  } else {
    runtimeStr = 'None (無運行時變更)';
  }
  lines.push(`【運行時 / Runtime】: ${runtimeStr}`);

  // Summary & Recovery Actions
  lines.push(`\nAttempt Summary: ${receipt.summary}`);
  if (receipt.recoveryActions.length > 0) {
    lines.push(`Recovery Actions: ${receipt.recoveryActions.join(', ')}`);
  } else {
    lines.push(`Recovery Actions: none required`);
  }

  return lines.join('\n');
}

/** Create an immutable, redacted Attempt Receipt. */
export function createReceipt(opts: ReceiptOptions): AttemptReceipt {
  const startedAt = opts.startedAt ?? new Date().toISOString();
  const completedAt = opts.completedAt ?? new Date().toISOString();
  const sortedFindings = sortFindings([...(opts.findings ?? [])]);

  let durable: DurableOutcome;
  if (opts.durableOutcome) {
    durable = opts.durableOutcome;
  } else if (opts.summary === 'Persistence Indeterminate') {
    durable = 'indeterminate';
  } else if (opts.summary === 'Persistence Failed') {
    durable = 'failed';
  } else if (opts.summary === 'Completed' || opts.summary === 'Completed with diagnostics' || opts.stateChanged) {
    durable = 'committed';
  } else {
    durable = 'unchanged';
  }

  let runtime: RuntimeOutcome;
  if (opts.runtimeOutcome) {
    runtime = opts.runtimeOutcome;
  } else if (opts.summary === 'Pending Application') {
    runtime = 'pending-application';
  } else if (durable === 'committed') {
    runtime = 'applied';
  } else {
    runtime = 'none';
  }

  const summary = opts.summary ?? deriveAttemptSummary(durable, sortedFindings, runtime, { declined: opts.declined });
  const recoveryActions = opts.recoveryActions ?? deriveRecoveryActions(summary, sortedFindings);

  const receipt: AttemptReceipt = {
    id: opts.id ?? `rcpt_${randomUUID()}`,
    kind: opts.kind ?? 'Lifecycle Operation',
    operation: opts.operation,
    scope: opts.scope,
    trigger: redactSource(opts.trigger),
    startedAt,
    completedAt,
    expectedStateRevision: opts.expectedStateRevision,
    targetStateRevision: opts.targetStateRevision,
    observedStateRevision: opts.observedStateRevision,
    validationSnapshot: opts.validationSnapshot,
    snapshotFingerprints: opts.snapshotFingerprints,
    durableOutcome: durable,
    findings: sortedFindings,
    runtimeOutcome: runtime,
    summary,
    recoveryActions,
    stateChanged: opts.stateChanged ?? (durable === 'committed'),
    recoversReceiptId: opts.recoversReceiptId,
    supersedesReceiptId: opts.supersedesReceiptId,
    createdAt: completedAt,
  };

  return Object.freeze(receipt);
}
