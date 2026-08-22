/**
 * Global Pending Barrier — Compatibility Profile v1 policy.
 * See CONTEXT.md: Global Pending Barrier.
 *
 * Active when:
 * - Global Scope Attempt Fence is currently held, OR
 * - Global Scope has Pending Application, Persistence Indeterminate, or Receipt Journal degradation.
 *
 * Blocks all Project Scope mutations and Runtime Applications (Lifecycle Operations,
 * Repair State, project startup reconciliation). Inspection and Marketplace Refresh remain available.
 */

import { existsSync, openSync, closeSync, unlinkSync } from 'node:fs';

import { readBridgeStateSync } from '../bridge-state/store.js';
import { getFencePath, getGlobalStatePath, getStatePath } from '../bridge-state/paths.js';
import { readReceiptJournal } from '../journal/journal.js';
import { blocking, CODE, RULE, type ValidationFinding } from '../registration/findings.js';

export interface GlobalBarrierStatus {
  active: boolean;
  reason?: string;
  finding?: ValidationFinding;
}

export function globalBarrierFinding(reason: string): ValidationFinding {
  return blocking({
    code: CODE.GLOBAL_PENDING_BARRIER,
    phase: 'admission',
    target: 'attempt',
    scope: 'project',
    pointer: '',
    rule: RULE.GLOBAL_PENDING_BARRIER,
    outcome: `Global Pending Barrier is active: ${reason}; project state mutations and runtime applications are blocked until global recovery completes (Inspection and Marketplace Refresh remain available)`,
  });
}

/** Check if the Global Attempt Fence lock is currently held. */
function isGlobalFenceHeld(opts: { agentDir?: string; cwd?: string }): boolean {
  const globalStatePath = getGlobalStatePath(opts.agentDir);
  const fencePath = getFencePath(globalStatePath);
  if (!existsSync(fencePath)) return false;

  // Try opening with 'wx' flag to see if file exists / is held
  // In our fence implementation, the lock file exists while the fence is held and is unlinked on release.
  // If fencePath exists, check if we can acquire it or if it exists.
  return existsSync(fencePath);
}

/** Check if the Global Pending Barrier is active. */
export async function checkGlobalPendingBarrier(
  opts: { agentDir?: string; cwd?: string } = {},
): Promise<GlobalBarrierStatus> {
  // 1. Check if Global Attempt Fence is held
  if (isGlobalFenceHeld(opts)) {
    const reason = 'Global Attempt Fence is held by an in-flight operation';
    return {
      active: true,
      reason,
      finding: globalBarrierFinding(reason),
    };
  }

  // 2. Check Global State readability / integrity
  const globalState = readBridgeStateSync('global', opts);
  if (globalState.status === 'corrupted' || globalState.status === 'incompatible') {
    const reason = `Global Bridge State is ${globalState.status} (${globalState.error ?? 'Persistence Indeterminate'})`;
    return {
      active: true,
      reason,
      finding: globalBarrierFinding(reason),
    };
  }

  // 3. Check Global Receipt Journal for active recovery chains or degradation
  const journal = await readReceiptJournal('global', opts);
  if (journal.activeChains.length > 0) {
    const root = journal.activeChains[0];
    const conditionLabel =
      root.condition === 'pending-application'
        ? 'Pending Application'
        : root.condition === 'persistence-indeterminate'
          ? 'Persistence Indeterminate'
          : root.condition === 'persistence-failed'
            ? 'Persistence Failed'
            : 'Receipt Journal degradation';
    const reason = `Global Scope has active recovery condition '${conditionLabel}' (root receipt: ${root.rootReceiptId})`;
    return {
      active: true,
      reason,
      finding: globalBarrierFinding(reason),
    };
  }

  if (journal.isDegraded) {
    const reason = `Global Receipt Journal is degraded (${journal.corruptedLineCount} corrupted lines)`;
    return {
      active: true,
      reason,
      finding: globalBarrierFinding(reason),
    };
  }

  return { active: false };
}
