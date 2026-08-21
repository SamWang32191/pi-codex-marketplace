/**
 * Attempt Receipt — redacted, immutable, non-authoritative record of one Bridge-managed attempt.
 * See CONTEXT.md: Attempt Receipt, Attempt Summary, Validation Finding.
 *
 * Relates expected / target / observed State Revisions with the applicable Validation Snapshot,
 * outcomes, findings. Received object is frozen (immutable) and secret-bearing input is redacted.
 * The durable Receipt Journal is a later ticket (#23); #17 produces the receipt itself.
 */

import { randomUUID } from 'node:crypto';

import type { Scope } from '../bridge-state/types.js';
import type { ValidationFinding } from './findings.js';
import { redactSource } from './source-key.js';

/** Closed set of Attempt Summary values (CONTEXT.md). */
export type AttemptSummary =
  | 'Completed'
  | 'Completed with diagnostics'
  | 'Declined'
  | 'Blocked'
  | 'Rejected as Stale'
  | 'Persistence Failed'
  | 'Persistence Indeterminate'
  | 'Pending Application';

export interface AttemptReceipt {
  /** Opaque receipt id (journal entries will key chains on this in #23). */
  id: string;
  kind: 'Lifecycle Operation';
  /** e.g. "Marketplace Registration" for #17. */
  operation: string;
  scope: Scope;
  /** Human-readable trigger (redacted). */
  trigger: string;
  /** State Revision expected (preflight). */
  expectedStateRevision: string;
  /** State Revision the attempt aimed to commit (preflight expected on success). */
  targetStateRevision?: string;
  /** State Revision observed after commit (present when verification succeeded). */
  observedStateRevision?: string;
  /** Validation Snapshot fingerprint the attempt was bound to. */
  validationSnapshot?: string;
  summary: AttemptSummary;
  /** Redacted immutable findings (safe by construction). */
  findings: ValidationFinding[];
  /** Whether any durable state was changed by this attempt. */
  stateChanged: boolean;
  /** ISO timestamp of receipt creation. */
  createdAt: string;
}

export interface ReceiptOptions {
  operation: string;
  scope: Scope;
  trigger: string;
  expectedStateRevision: string;
  validationSnapshot?: string;
  summary: AttemptSummary;
  findings?: ValidationFinding[];
  stateChanged?: boolean;
  targetStateRevision?: string;
  observedStateRevision?: string;
}

/** Create an immutable, redacted Attempt Receipt. */
export function createReceipt(opts: ReceiptOptions): AttemptReceipt {
  const receipt: AttemptReceipt = {
    id: `rcpt_${randomUUID()}`,
    kind: 'Lifecycle Operation',
    operation: opts.operation,
    scope: opts.scope,
    trigger: redactSource(opts.trigger),
    expectedStateRevision: opts.expectedStateRevision,
    targetStateRevision: opts.targetStateRevision,
    observedStateRevision: opts.observedStateRevision,
    validationSnapshot: opts.validationSnapshot,
    summary: opts.summary,
    findings: [...(opts.findings ?? [])].map((f) => ({ ...f })),
    stateChanged: opts.stateChanged ?? false,
    createdAt: new Date().toISOString(),
  };
  return Object.freeze(receipt);
}