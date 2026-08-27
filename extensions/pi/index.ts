/**
 * Bridge Extension — Pi runtime entry for pi-codex-marketplace
 * Single extension "pi" package, Pi 0.84.2 compatible.
 *
 * Provides:
 * - /codex-marketplace command: Thin Pi adapter delegating to pure runCommand
 * - resources_discover: Runtime Skill Exposure contributing Projected Skill paths
 *
 * Legacy flow exports retained for unit testing and backward compatibility.
 */

import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences } from '@earendil-works/pi-tui';

import { readBridgeStateSync } from '../../src/bridge-state/store.js';
import type { ReadResult } from '../../src/bridge-state/types.js';
import { runCommand } from '../../src/bridge/command.js';
import { discoverProjectedSkillPaths } from '../../src/projection/exposure.js';
import { runStartupReconciliation } from '../../src/reconciliation/startup.js';
import type { AttemptReceipt } from '../../src/registration/receipt.js';
import { runLocalRegistrationFlow } from './registration.js';
import { runGitRegistrationFlow } from './git-registration.js';
import { runPluginInstallationFlow, runPluginStateFlow } from './installation.js';
import { runRefreshFlow, runRebindFlow, runRemovalFlow } from './lifecycle.js';
import { runEffectiveStateView } from './effective-state-view.js';
import {
  runReceiptJournalView,
  runRepairStateFlow,
  runRetryApplicationFlow,
} from './journal.js';
import {
  type LedgerActionIntent,
} from './bridge-ledger.js';
import { renderTransactionSheet } from './transaction-sheet.js';
import { uiText } from './ui-strings.js';

const STARTUP_RECEIPT_THEME = {
  fg: (_color: string, text: string) => text,
  bg: (_token: string, text: string) => text,
  bold: (text: string) => text,
};

export function formatStartupReceipt(receipt: AttemptReceipt): string {
  return renderTransactionSheet({
    step: 'Receipt',
    actionLabel: receipt.operation,
    authority: 'global',
    target: receipt.trigger,
    stateRevision: receipt.observedStateRevision ?? receipt.expectedStateRevision,
    validationSnapshot: receipt.validationSnapshot,
    receipt,
  }, STARTUP_RECEIPT_THEME, 80).map(stripTerminalSequences).join('\n');
}

function requiredTarget(intent: LedgerActionIntent): string {
  if (intent.targetId) return intent.targetId;
  throw new Error(`Ledger action ${intent.actionId} requires a stable target identity`);
}

function requiredStateRevision(intent: LedgerActionIntent): string {
  if (intent.stateRevision) return intent.stateRevision;
  throw new Error(`Ledger action ${intent.actionId} requires a selected State Revision`);
}

function requiredMarketplaceEntryTarget(intent: LedgerActionIntent): {
  registrationId: string;
  entryPointer: string;
  marketplaceEntryId: string;
  validationSnapshot: string;
} {
  if (
    intent.targetKind === 'marketplace-entry'
    && intent.registrationId
    && intent.entryPointer
    && intent.targetId
  ) {
    if (!intent.validationSnapshot) {
      throw new Error(`Ledger action ${intent.actionId} requires a bound Validation Snapshot`);
    }
    return {
      registrationId: intent.registrationId,
      entryPointer: intent.entryPointer,
      marketplaceEntryId: intent.targetId,
      validationSnapshot: intent.validationSnapshot,
    };
  }
  throw new Error(`Ledger action ${intent.actionId} requires a stable Marketplace Entry identity`);
}

/** Dispatches only by stable semantic identity; display labels never select behavior. */
export async function dispatchLedgerAction(
  ctx: ExtensionCommandContext,
  intent: LedgerActionIntent,
): Promise<void> {
  switch (intent.actionId) {
    case 'observe-authority': {
      const global = readBridgeStateSync();
      ctx.ui.notify(global.status, 'info');
      return;
    }
    case 'observe-effective-state':
      await runEffectiveStateView(ctx);
      return;
    case 'register-local':
      await runLocalRegistrationFlow(ctx);
      return;
    case 'register-git':
      await runGitRegistrationFlow(ctx);
      return;
    case 'refresh-registration':
      await runRefreshFlow(ctx, {
        registrationId: requiredTarget(intent),
      });
      return;
    case 'rebind-registration':
      await runRebindFlow(ctx, {
        registrationId: requiredTarget(intent),
      });
      return;
    case 'remove-registration':
      await runRemovalFlow(ctx, {
        targetKind: 'registration',
        targetId: requiredTarget(intent),
      });
      return;
    case 'install-disabled':
    case 'install-and-enable': {
      const entry = requiredMarketplaceEntryTarget(intent);
      await runPluginInstallationFlow(ctx, {
        registrationId: entry.registrationId,
        entryPointer: entry.entryPointer,
        marketplaceEntryId: entry.marketplaceEntryId,
        targetState: intent.actionId === 'install-and-enable' ? 'enabled' : 'disabled',
        expectedStateRevision: requiredStateRevision(intent),
        expectedValidationSnapshot: entry.validationSnapshot,
      });
      return;
    }
    case 'enable-installation':
    case 'disable-installation':
      await runPluginStateFlow(ctx, {
        installationId: requiredTarget(intent),
        desiredState: intent.actionId === 'enable-installation' ? 'enabled' : 'disabled',
        expectedStateRevision: requiredStateRevision(intent),
      });
      return;
    case 'remove-installation':
      await runRemovalFlow(ctx, {
        targetKind: 'installation',
        targetId: requiredTarget(intent),
      });
      return;
    case 'view-receipt-journal':
      await runReceiptJournalView(ctx);
      return;
    case 'inspect-receipt':
      await runReceiptJournalView(ctx, {
        receiptId: requiredTarget(intent),
      });
      return;
    case 'repair-state':
      await runRepairStateFlow(ctx, {
        expectedStateRevision: intent.stateRevision,
      });
      return;
    case 'retry-application':
      await runRetryApplicationFlow(ctx, {
        receiptId: requiredTarget(intent),
      });
      return;
  }
}

export default function (pi: ExtensionAPI) {
  pi.on('session_start', async (_event, ctx) => {
    try {
      const recon = await runStartupReconciliation({});
      if (recon.reconciled && recon.receipt) {
        ctx.ui.notify(formatStartupReceipt(recon.receipt), recon.receipt.summary === 'Completed' ? 'info' : 'warning');
      }
    } catch {
      // Non-blocking in extension bootstrap
    }
  });

  // Runtime Skill Exposure (ADR 0001): contribute Projected Skills through Pi's
  // resource-discovery seam at every startup and reload. Passive existence inspection over the
  // current Effective State only — no fingerprint validation, no Bridge State mutation, and no
  // Attempt Receipt. Missing snapshot material is skipped individually; discovery never fails
  // the host's resource pass.
  pi.on('resources_discover', async (_event, _ctx) => {
    try {
      return {
        skillPaths: discoverProjectedSkillPaths({}).skillPaths,
      };
    } catch {
      return {};
    }
  });

  pi.registerCommand('codex-marketplace', {
    description: uiText('cmd.description'),
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const rawArgs = (args ?? '').trim();
      const argv = rawArgs.length > 0 ? rawArgs.split(/\s+/) : [];
      const result = await runCommand(argv);

      if (result.output) {
        ctx.ui.notify(result.output, 'info');
      }
      if (result.reload) {
        await ctx.reload();
      }
    },
  });
}
