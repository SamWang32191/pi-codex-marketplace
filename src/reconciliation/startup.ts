/**
 * Startup Reconciliation — global-first verification and reconciliation pass on session start.
 * See CONTEXT.md: Startup reconciliation, Global Pending Barrier, Pending Application.
 *
 * Rules:
 * - At most one reconciliation pass per startup.
 * - Global-first: Global scope is reconciled first.
 * - Only scopes with enabled contributions, active recovery, or journal repair execute and produce a receipt.
 * - If no work needed (clean/empty), no-op and does NOT generate empty receipts.
 * - If Global recovery cannot reach a clean terminal state, Global Pending Barrier blocks Project reconciliation.
 * - Reconciles Pending Application without implicit activation or auto-rollback.
 */

import { readBridgeStateSync } from '../bridge-state/store.js';
import type { Scope } from '../bridge-state/types.js';
import { checkGlobalPendingBarrier, globalBarrierFinding } from '../barrier/global-barrier.js';
import { appendReceipt, readReceiptJournal } from '../journal/journal.js';
import { createReceipt, type AttemptReceipt } from '../registration/receipt.js';

export interface StartupReconciliationOptions {
  cwd?: string;
  agentDir?: string;
  projectTrusted?: boolean;
  verifyReload?: (scope: Scope) => Promise<boolean> | boolean;
}

export interface StartupReconciliationResult {
  globalReconciled: boolean;
  globalReceipt?: AttemptReceipt;
  projectReconciled: boolean;
  projectReceipt?: AttemptReceipt;
}

export async function runStartupReconciliation(
  opts: StartupReconciliationOptions = {},
): Promise<StartupReconciliationResult> {
  const result: StartupReconciliationResult = {
    globalReconciled: false,
    projectReconciled: false,
  };

  const defaultVerify = async (_s: Scope) => true;
  const verify = opts.verifyReload ?? defaultVerify;

  // 1. Global Scope Pass
  const globalState = readBridgeStateSync('global', opts);
  const globalJournal = await readReceiptJournal('global', opts);

  const globalPendingChain = globalJournal.activeChains.find(
    (c) => c.condition === 'pending-application',
  );

  const globalHasEnabledInstallations =
    globalState.status === 'ok' &&
    globalState.state!.installations.some((i) => i.installationState === 'enabled');

  if (globalPendingChain || (globalHasEnabledInstallations && globalJournal.receipts.length > 0)) {
    const rev = globalState.status === 'ok' ? globalState.state!.stateRevision : '0';
    const applied = await verify('global');
    const summary = applied ? 'Completed' : 'Pending Application';

    const receipt = createReceipt({
      kind: 'Reconciliation',
      operation: 'Startup Reconciliation',
      scope: 'global',
      trigger: 'startup reconciliation global',
      expectedStateRevision: rev,
      observedStateRevision: applied ? rev : undefined,
      durableOutcome: 'unchanged',
      runtimeOutcome: applied ? 'applied' : 'pending-application',
      summary,
      recoversReceiptId: globalPendingChain?.rootReceiptId,
    });

    await appendReceipt('global', receipt, opts);
    result.globalReconciled = true;
    result.globalReceipt = receipt;
  }

  // 2. Check Global Barrier before attempting Project Scope
  const barrier = await checkGlobalPendingBarrier(opts);

  // 3. Project Scope Pass
  const projectState = readBridgeStateSync('project', opts);
  const projectJournal = await readReceiptJournal('project', opts);

  const projectPendingChain = projectJournal.activeChains.find(
    (c) => c.condition === 'pending-application',
  );

  const projectHasEnabledInstallations =
    projectState.status === 'ok' &&
    projectState.state!.installations.some((i) => i.installationState === 'enabled');

  const projectNeedsWork =
    Boolean(projectPendingChain) ||
    (projectHasEnabledInstallations && projectJournal.receipts.length > 0);

  if (projectNeedsWork) {
    const rev = projectState.status === 'ok' ? projectState.state!.stateRevision : '0';

    if (barrier.active) {
      // Blocked by Global Pending Barrier
      const receipt = createReceipt({
        kind: 'Reconciliation',
        operation: 'Startup Reconciliation',
        scope: 'project',
        trigger: 'startup reconciliation project',
        expectedStateRevision: rev,
        durableOutcome: 'unchanged',
        runtimeOutcome: 'none',
        summary: 'Blocked',
        findings: [barrier.finding ?? globalBarrierFinding(barrier.reason ?? 'Global Barrier active')],
        recoversReceiptId: projectPendingChain?.rootReceiptId,
      });

      await appendReceipt('project', receipt, opts);
      result.projectReconciled = true;
      result.projectReceipt = receipt;
    } else if (opts.projectTrusted === true) {
      const applied = await verify('project');
      const summary = applied ? 'Completed' : 'Pending Application';

      const receipt = createReceipt({
        kind: 'Reconciliation',
        operation: 'Startup Reconciliation',
        scope: 'project',
        trigger: 'startup reconciliation project',
        expectedStateRevision: rev,
        observedStateRevision: applied ? rev : undefined,
        durableOutcome: 'unchanged',
        runtimeOutcome: applied ? 'applied' : 'pending-application',
        summary,
        recoversReceiptId: projectPendingChain?.rootReceiptId,
      });

      await appendReceipt('project', receipt, opts);
      result.projectReconciled = true;
      result.projectReceipt = receipt;
    }
  }

  return result;
}
