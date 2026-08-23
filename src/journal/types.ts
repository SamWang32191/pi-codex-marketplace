/**
 * Receipt Journal types.
 * See CONTEXT.md: Receipt Journal, Attempt Receipt, Receipt Resolution.
 */

import type { Scope } from '../bridge-state/types.js';
import type { ValidationFinding } from '../registration/findings.js';
import type { AttemptReceipt } from '../registration/receipt.js';

/** Exact Receipt Journal observation: raw-byte SHA-256, or a closed file-state sentinel. */
export type JournalRevision = `sha256:${string}` | 'missing' | 'read-error';

export type ActiveCondition =
  | 'pending-application'
  | 'persistence-indeterminate'
  | 'persistence-failed'
  | 'journal-degradation';

export interface ActiveRecoveryChain {
  /** Root receipt that entered the active condition. */
  rootReceiptId: string;
  scope: Scope;
  condition: ActiveCondition;
  stateRevision: string;
  /** All receipts in this chain (root + follow-up attempts). */
  receipts: AttemptReceipt[];
  resolved: boolean;
  resolvedByReceiptId?: string;
  superseded: boolean;
  supersededByReceiptId?: string;
}

export interface JournalReadResult {
  /** Present on filesystem-backed reads; optional only for legacy in-memory adapters. */
  revision?: JournalRevision;
  receipts: AttemptReceipt[];
  activeChains: ActiveRecoveryChain[];
  allChains: ActiveRecoveryChain[];
  corruptedLineCount: number;
  isDegraded: boolean;
  findings: ValidationFinding[];
  error?: string;
}

/** Filesystem-backed observation; unlike legacy in-memory adapters, revision is always exact. */
export interface ObservedJournalReadResult extends JournalReadResult {
  revision: JournalRevision;
}

export interface JournalAppendResult {
  success: boolean;
  /** Conditional append refusal; no journal bytes were written. */
  isStale?: boolean;
  expectedRevision?: JournalRevision;
  observedRevision?: JournalRevision;
  error?: string;
  finding?: ValidationFinding;
}

export interface JournalPruneResult {
  prunedCount: number;
  retainedCount: number;
}

export type JournalRepairCommitResult =
  | {
      status: 'committed';
      expectedRevision: JournalRevision;
      postPruneRevision: JournalRevision;
      revision: JournalRevision;
      prunedCount: number;
      retainedCount: number;
    }
  | {
      status: 'stale';
      stage: 'before-prune';
      expectedRevision: JournalRevision;
      observedRevision: JournalRevision;
      prunedCount: 0;
      retainedCount: number;
    }
  | {
      status: 'stale';
      stage: 'before-append';
      expectedRevision: JournalRevision;
      observedRevision: JournalRevision;
      postPruneRevision: JournalRevision;
      prunedCount: 0;
      retainedCount: number;
    }
  | {
      status: 'stale';
      stage: 'after-prune';
      expectedRevision: JournalRevision;
      observedRevision: JournalRevision;
      postPruneRevision: JournalRevision;
      prunedCount: number;
      retainedCount: number;
    };
