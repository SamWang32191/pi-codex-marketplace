/**
 * Receipt Journal types.
 * See CONTEXT.md: Receipt Journal, Attempt Receipt, Receipt Resolution.
 */

import type { Scope } from '../bridge-state/types.js';
import type { ValidationFinding } from '../registration/findings.js';
import type { AttemptReceipt } from '../registration/receipt.js';

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
  receipts: AttemptReceipt[];
  activeChains: ActiveRecoveryChain[];
  allChains: ActiveRecoveryChain[];
  corruptedLineCount: number;
  isDegraded: boolean;
  findings: ValidationFinding[];
  error?: string;
}

export interface JournalAppendResult {
  success: boolean;
  error?: string;
  finding?: ValidationFinding;
}

export interface JournalPruneResult {
  prunedCount: number;
  retainedCount: number;
}
