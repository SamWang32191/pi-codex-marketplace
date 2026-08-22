/**
 * Active Recovery Chains in the Receipt Journal.
 * See CONTEXT.md: Receipt Resolution, Receipt Journal, Active Recovery Chain.
 *
 * Rules:
 * - A receipt enters an active condition if:
 *   - summary === 'Pending Application'
 *   - summary === 'Persistence Indeterminate' or durableOutcome === 'indeterminate'
 *   - summary === 'Persistence Failed' or durableOutcome === 'failed'
 *   - has RECEIPT_PERSISTENCE_FAILED finding
 * - Resolved: a later receipt explicitly recovers this receipt (recoversReceiptId === rootReceiptId)
 *   and achieves Completed / Completed with diagnostics for the same target state.
 * - Superseded: a later receipt commits a replacement State Revision (durableOutcome === 'committed'
 *   and new revision) or explicitly targets superseding.
 * - Failed retry: appends to the chain, but leaves the active condition UNRESOLVED.
 */

import { CODE } from '../registration/findings.js';
import type { AttemptReceipt } from '../registration/receipt.js';
import type { ActiveCondition, ActiveRecoveryChain } from './types.js';

function getActiveCondition(receipt: AttemptReceipt): ActiveCondition | null {
  if (receipt.findings.some((f) => f.code === CODE.RECEIPT_PERSISTENCE_FAILED)) {
    return 'journal-degradation';
  }
  if (receipt.summary === 'Persistence Indeterminate' || receipt.durableOutcome === 'indeterminate') {
    return 'persistence-indeterminate';
  }
  if (receipt.summary === 'Persistence Failed' || receipt.durableOutcome === 'failed') {
    return 'persistence-failed';
  }
  if (receipt.summary === 'Pending Application' || receipt.runtimeOutcome === 'pending-application') {
    return 'pending-application';
  }
  return null;
}

export function findActiveRecoveryChains(
  receipts: AttemptReceipt[],
): { activeChains: ActiveRecoveryChain[]; allChains: ActiveRecoveryChain[] } {
  const chains: ActiveRecoveryChain[] = [];

  for (let i = 0; i < receipts.length; i++) {
    const rcpt = receipts[i];
    const condition = getActiveCondition(rcpt);

    // If this receipt is a recovery attempt for an existing chain
    if (rcpt.recoversReceiptId) {
      const existingChain = chains.find((c) => c.rootReceiptId === rcpt.recoversReceiptId);
      if (existingChain) {
        existingChain.receipts.push(rcpt);
        if (rcpt.summary === 'Completed' || rcpt.summary === 'Completed with diagnostics') {
          existingChain.resolved = true;
          existingChain.resolvedByReceiptId = rcpt.id;
        }
        continue;
      }
    }

    // If this receipt opened an active condition and wasn't a recovery attempt
    if (condition) {
      const chain: ActiveRecoveryChain = {
        rootReceiptId: rcpt.id,
        scope: rcpt.scope,
        condition,
        stateRevision: rcpt.observedStateRevision ?? rcpt.targetStateRevision ?? rcpt.expectedStateRevision,
        receipts: [rcpt],
        resolved: false,
        superseded: false,
      };
      chains.push(chain);
    }

    // Check if this receipt supersedes any earlier un-resolved chains in the same scope
    // A replacement commit supersedes previous un-resolved chains
    if (rcpt.durableOutcome === 'committed' && rcpt.observedStateRevision) {
      for (const chain of chains) {
        if (!chain.resolved && !chain.superseded && chain.scope === rcpt.scope && chain.rootReceiptId !== rcpt.id) {
          // If the commit revision is different/newer than the chain's revision
          if (rcpt.observedStateRevision !== chain.stateRevision) {
            chain.superseded = true;
            chain.supersededByReceiptId = rcpt.id;
          }
        }
      }
    }

    if (rcpt.supersedesReceiptId) {
      const targetChain = chains.find((c) => c.rootReceiptId === rcpt.supersedesReceiptId);
      if (targetChain && !targetChain.resolved) {
        targetChain.superseded = true;
        targetChain.supersededByReceiptId = rcpt.id;
      }
    }
  }

  const activeChains = chains.filter((c) => !c.resolved && !c.superseded);
  return { activeChains, allChains: chains };
}
