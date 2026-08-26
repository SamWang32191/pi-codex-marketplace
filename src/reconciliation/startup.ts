/**
 * Startup Reconciliation — verification and reconciliation pass on session start.
 * See CONTEXT.md: Startup reconciliation, Pending Application.
 *
 * Rules:
 * - At most one reconciliation pass per startup.
 * - Only enabled contributions, active recovery, or journal repair execute and produce a receipt.
 * - If no work needed (clean/empty), no-op and does NOT generate empty receipts.
 * - Reconciles Pending Application without implicit activation or auto-rollback.
 */

import { readBridgeStateSync } from '../bridge-state/store.js';
import { appendReceipt, readReceiptJournal } from '../journal/journal.js';
import { createReceipt, type AttemptReceipt } from '../registration/receipt.js';

export interface StartupReconciliationOptions {
  agentDir?: string;
  verifyReload?: () => Promise<boolean> | boolean;
}

export interface StartupReconciliationResult {
  reconciled: boolean;
  receipt?: AttemptReceipt;
}

export async function runStartupReconciliation(
  opts: StartupReconciliationOptions = {},
): Promise<StartupReconciliationResult> {
  const verify = opts.verifyReload ?? (async () => true);

  const state = readBridgeStateSync({ agentDir: opts.agentDir });
  const journal = await readReceiptJournal({ agentDir: opts.agentDir });

  const pendingChain = journal.activeChains.find(
    (c) => c.condition === 'pending-application',
  );

  const hasEnabledInstallations =
    state.status === 'ok' &&
    state.state!.installations.some((i) => i.installationState === 'enabled');

  if (pendingChain || (hasEnabledInstallations && journal.receipts.length > 0)) {
    const rev = state.status === 'ok' ? state.state!.stateRevision : '0';
    const applied = await verify();
    const summary = applied ? 'Completed' : 'Pending Application';

    const receipt = createReceipt({
      kind: 'Reconciliation',
      operation: 'Startup Reconciliation',
      trigger: 'startup reconciliation global',
      expectedStateRevision: rev,
      observedStateRevision: applied ? rev : undefined,
      durableOutcome: 'unchanged',
      runtimeOutcome: applied ? 'applied' : 'pending-application',
      summary,
      recoversReceiptId: pendingChain?.rootReceiptId,
    });

    await appendReceipt(receipt, { agentDir: opts.agentDir });
    return { reconciled: true, receipt };
  }

  return { reconciled: false };
}
