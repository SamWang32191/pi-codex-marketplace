/**
 * Bridge Extension — Pi runtime entry for pi-codex-marketplace
 * Single extension "pi" package, Pi 0.84.2 compatible.
 *
 * Provides:
 * - /codex-marketplace command: persistent Bridge Ledger workspace
 * - Bridge State reading via the single-document store (Global)
 * - Startup Reconciliation on session_start
 * - Receipt Journal inspection & State Repair flows
 *
 * Domain vocabulary follows CONTEXT.md (Bridge Package, Bridge Extension, Bridge State, State Revision, etc.)
 */

import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences } from '@earendil-works/pi-tui';

import { readBridgeStateSync } from '../../src/bridge-state/store.js';
import type { ReadResult } from '../../src/bridge-state/types.js';
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
  BridgeLedgerComponent,
  buildBridgeLedgerModel,
  loadBridgeLedgerSnapshot,
  type LedgerActionIntent,
} from './bridge-ledger.js';
import { quoteTerminalText } from './terminal-presentation.js';
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

/** Localized state summary for TUI surfaces (the non-TUI list/inspect output stays canonical English). */
function formatLocalizedStateSummary(result: ReadResult): string {
  const scopeLabel = uiText('common.scope.global');
  if (result.status === 'missing') {
    const s = result.state!;
    return uiText('cmd.state.empty', {
      scope: scopeLabel,
      version: s.schemaVersion,
      revision: s.stateRevision,
    });
  }
  if (result.status === 'ok') {
    const s = result.state!;
    const regCount = s.registrations.length;
    const instEnabled = s.installations.filter((i) => i.installationState === 'enabled').length;
    const instDisabled = s.installations.filter((i) => i.installationState === 'disabled').length;
    const base = uiText('cmd.state.ok', {
      scope: scopeLabel,
      revision: s.stateRevision,
      registrations: regCount,
      enabled: instEnabled,
      disabled: instDisabled,
    });
    return base;
  }
  if (result.status === 'incompatible') {
    return uiText('cmd.state.incompatible', {
      scope: scopeLabel,
      error: quoteTerminalText(result.error ?? uiText('common.unknown')),
    });
  }
  return uiText('cmd.state.corrupted', {
    scope: scopeLabel,
    error: quoteTerminalText(result.error ?? uiText('common.unknown')),
  });
}

/** Dispatches only by stable semantic identity; display labels never select behavior. */
export async function dispatchLedgerAction(
  ctx: ExtensionCommandContext,
  intent: LedgerActionIntent,
): Promise<void> {
  switch (intent.actionId) {
    case 'observe-partitions': {
      const global = readBridgeStateSync();
      ctx.ui.notify(formatLocalizedStateSummary(global), 'info');
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

// Closed helper to format state summary for disclosure
function formatStateSummary(result: ReadResult, scopeLabel: string): string {
  if (result.status === 'missing') {
    const s = result.state!;
    return `${scopeLabel}: empty · schema v${s.schemaVersion} · revision ${s.stateRevision} · 0 registrations · 0 installations`;
  }
  if (result.status === 'ok') {
    const s = result.state!;
    const regCount = s.registrations.length;
    const instEnabled = s.installations.filter((i) => i.installationState === 'enabled').length;
    const instDisabled = s.installations.filter((i) => i.installationState === 'disabled').length;
    return `${scopeLabel}: revision ${s.stateRevision} · ${regCount} registrations · ${instEnabled} enabled / ${instDisabled} disabled`;
  }
  if (result.status === 'incompatible') {
    return `${scopeLabel}: incompatible — ${quoteTerminalText(result.error ?? 'unknown schema')} (requires newer Bridge Package)`;
  }
  return `${scopeLabel}: corrupted — ${quoteTerminalText(result.error ?? 'unreadable Bridge State')} (Persistence Indeterminate, no auto-rollback)`;
}

export default function (pi: ExtensionAPI) {
  pi.on('session_start', async (_event, ctx) => {
    // Startup reconciliation: Global pass
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
    handler: async (args, ctx) => {
      // Hybrid discovery/guided: support /codex-marketplace list|inspect <args> for non-TUI quick paths
      const rawArgs = (args ?? '').trim();
      if (rawArgs.length > 0 && (rawArgs.startsWith('list') || rawArgs.startsWith('inspect') || rawArgs === '--help' || rawArgs === '-h')) {
        const global = readBridgeStateSync();
        const g = formatStateSummary(global, 'Global Scope');
        ctx.ui.notify(`${g}\n(完整導向流請於 TUI 內執行 /codex-marketplace)`, 'info');
        return;
      }

      // Non-TUI fallback: notify with summary
      if (ctx.mode !== 'tui' || !ctx.hasUI) {
        const global = readBridgeStateSync();
        const g = formatStateSummary(global, 'Global Scope');
        ctx.ui.notify(`${g}\n互動流程需 TUI 模式（/codex-marketplace 於 TUI 內）`, 'info');
        return;
      }

      // The workspace is deliberately reopened from a fresh snapshot after every action.
      // Neither cached revisions nor presentation-derived eligibility become authority.
      while (true) {
        const snapshot = await loadBridgeLedgerSnapshot({});
        const model = buildBridgeLedgerModel(snapshot);
        const intent = await ctx.ui.custom<LedgerActionIntent | undefined>(
          (tui, theme, _keybindings, done) =>
            new BridgeLedgerComponent(model, theme, tui, done),
        );
        if (!intent) return;
        await dispatchLedgerAction(ctx, intent);
      }
    },
  });
}
