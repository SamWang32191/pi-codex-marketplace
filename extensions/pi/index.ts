/**
 * Bridge Extension — Pi runtime entry for pi-codex-marketplace
 * Single extension "pi" package, Pi 0.84.2 compatible.
 *
 * Provides:
 * - /codex-marketplace command: persistent Bridge Ledger workspace
 * - Bridge State reading via dual-document store (global + project)
 * - Startup Reconciliation on session_start
 * - Receipt Journal inspection & State Repair flows
 *
 * Domain vocabulary follows CONTEXT.md (Bridge Package, Bridge Extension, Bridge State, State Revision, etc.)
 */

import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences } from '@earendil-works/pi-tui';

import { readBridgeStateSync } from '../../src/bridge-state/store.js';
import type { ReadResult } from '../../src/bridge-state/types.js';
import { runStartupReconciliation } from '../../src/reconciliation/startup.js';
import type { AttemptReceipt } from '../../src/registration/receipt.js';
import { checkGlobalPendingBarrier } from '../../src/barrier/global-barrier.js';
import { runLocalRegistrationFlow } from './registration.js';
import { runGitRegistrationFlow } from './git-registration.js';
import { runPluginInstallationFlow, runPluginStateFlow } from './installation.js';
import { runRefreshFlow, runRebindFlow, runRemovalFlow } from './lifecycle.js';
import {
  runEffectiveStateView,
  runRemoveScopeOverrideFlow,
  runScopeOverrideFlow,
} from './scope-overrides.js';
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

const STARTUP_RECEIPT_THEME = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

export function formatStartupReceipt(receipt: AttemptReceipt): string {
  return renderTransactionSheet({
    step: 'Receipt',
    actionLabel: receipt.operation,
    authority: receipt.scope,
    target: receipt.trigger,
    stateRevision: receipt.observedStateRevision ?? receipt.expectedStateRevision,
    validationSnapshot: receipt.validationSnapshot,
    receipt,
  }, STARTUP_RECEIPT_THEME, 80).map(stripTerminalSequences).join('\n');
}

function requiredScope(intent: LedgerActionIntent): 'global' | 'project' {
  if (intent.scope) return intent.scope;
  throw new Error(`Ledger action ${intent.actionId} requires an explicit scope`);
}

function requiredTarget(intent: LedgerActionIntent): string {
  if (intent.targetId) return intent.targetId;
  throw new Error(`Ledger action ${intent.actionId} requires a stable target identity`);
}

function requiredMarketplaceEntryTarget(intent: LedgerActionIntent): {
  registrationId: string;
  entryPointer: string;
} {
  if (
    intent.targetKind === 'marketplace-entry'
    && intent.registrationId
    && intent.entryPointer
    && intent.targetId
  ) {
    return {
      registrationId: intent.registrationId,
      entryPointer: intent.entryPointer,
    };
  }
  throw new Error(`Ledger action ${intent.actionId} requires a stable Marketplace Entry identity`);
}

function overrideTarget(intent: LedgerActionIntent): {
  targetKind: 'registration' | 'installation';
  targetId: string;
} {
  const target = requiredTarget(intent);
  if (intent.targetKind === 'registration' || intent.targetKind === 'installation') {
    return { targetKind: intent.targetKind, targetId: target };
  }
  const separator = target.indexOf('/');
  const kind = target.slice(0, separator);
  const targetId = target.slice(separator + 1);
  if ((kind !== 'registration' && kind !== 'installation') || separator < 1 || !targetId) {
    throw new Error(`Ledger action ${intent.actionId} has an invalid Scope Override target`);
  }
  return { targetKind: kind, targetId };
}

/** Dispatches only by stable semantic identity; display labels never select behavior. */
export async function dispatchLedgerAction(
  ctx: ExtensionCommandContext,
  intent: LedgerActionIntent,
): Promise<void> {
  switch (intent.actionId) {
    case 'observe-partitions': {
      const global = readBridgeStateSync('global', { cwd: ctx.cwd });
      const project = readBridgeStateSync('project', { cwd: ctx.cwd });
      ctx.ui.notify(
        `${formatStateSummary(global, 'Global Scope')}\n${formatStateSummary(project, 'Project Scope')}`,
        'info',
      );
      return;
    }
    case 'observe-effective-state':
      await runEffectiveStateView(ctx);
      return;
    case 'register-local':
      await runLocalRegistrationFlow(ctx, { scope: requiredScope(intent) });
      return;
    case 'register-git':
      await runGitRegistrationFlow(ctx, { scope: requiredScope(intent) });
      return;
    case 'refresh-registration':
      await runRefreshFlow(ctx, {
        scope: requiredScope(intent),
        registrationId: requiredTarget(intent),
      });
      return;
    case 'rebind-registration':
      await runRebindFlow(ctx, {
        scope: requiredScope(intent),
        registrationId: requiredTarget(intent),
      });
      return;
    case 'remove-registration':
      await runRemovalFlow(ctx, {
        scope: requiredScope(intent),
        targetKind: 'registration',
        targetId: requiredTarget(intent),
      });
      return;
    case 'install-disabled':
    case 'install-and-enable': {
      const entry = requiredMarketplaceEntryTarget(intent);
      await runPluginInstallationFlow(ctx, {
        scope: requiredScope(intent),
        registrationId: entry.registrationId,
        entryPointer: entry.entryPointer,
        targetState: intent.actionId === 'install-and-enable' ? 'enabled' : 'disabled',
      });
      return;
    }
    case 'enable-installation':
    case 'disable-installation':
      await runPluginStateFlow(ctx, {
        scope: requiredScope(intent),
        installationId: requiredTarget(intent),
        desiredState: intent.actionId === 'enable-installation' ? 'enabled' : 'disabled',
        expectedStateRevision: intent.stateRevision,
      });
      return;
    case 'remove-installation':
      await runRemovalFlow(ctx, {
        scope: requiredScope(intent),
        targetKind: 'installation',
        targetId: requiredTarget(intent),
      });
      return;
    case 'create-scope-override': {
      const target = overrideTarget(intent);
      await runScopeOverrideFlow(ctx, target);
      return;
    }
    case 'remove-scope-override': {
      const target = overrideTarget(intent);
      await runRemoveScopeOverrideFlow(ctx, target);
      return;
    }
    case 'view-receipt-journal':
      await runReceiptJournalView(ctx, { scope: requiredScope(intent) });
      return;
    case 'inspect-receipt':
      await runReceiptJournalView(ctx, {
        scope: requiredScope(intent),
        receiptId: requiredTarget(intent),
      });
      return;
    case 'repair-state':
      await runRepairStateFlow(ctx, { scope: requiredScope(intent) });
      return;
    case 'retry-application':
      await runRetryApplicationFlow(ctx, {
        scope: requiredScope(intent),
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
    const ov = s.scopeOverrides.length;
    const ovPart = scopeLabel === 'Project Scope' ? ` · ${ov} overrides` : '';
    return `${scopeLabel}: revision ${s.stateRevision} · ${regCount} registrations · ${instEnabled} enabled / ${instDisabled} disabled${ovPart}`;
  }
  if (result.status === 'incompatible') {
    return `${scopeLabel}: incompatible — ${quoteTerminalText(result.error ?? 'unknown schema')} (requires newer Bridge Package)`;
  }
  return `${scopeLabel}: corrupted — ${quoteTerminalText(result.error ?? 'unreadable Bridge State')} (Persistence Indeterminate, no auto-rollback)`;
}

export default function (pi: ExtensionAPI) {
  pi.on('session_start', async (_event, ctx) => {
    // Startup reconciliation: Global-first pass
    try {
      const recon = await runStartupReconciliation({
        cwd: ctx.cwd,
        projectTrusted: ctx.isProjectTrusted(),
      });
      if (recon.globalReconciled && recon.globalReceipt) {
        ctx.ui.notify(formatStartupReceipt(recon.globalReceipt), recon.globalReceipt.summary === 'Completed' ? 'info' : 'warning');
      }
      if (recon.projectReconciled && recon.projectReceipt) {
        ctx.ui.notify(formatStartupReceipt(recon.projectReceipt), recon.projectReceipt.summary === 'Completed' ? 'info' : 'warning');
      }
    } catch {
      // Non-blocking in extension bootstrap
    }
  });

  pi.registerCommand('codex-marketplace', {
    description: 'Manage Codex Marketplaces in the Global / Project Bridge Ledger workspace',
    handler: async (args, ctx) => {
      const cwd = ctx.cwd;

      // Hybrid discovery/guided: support /codex-marketplace list|inspect <args> for non-TUI quick paths
      const rawArgs = (args ?? '').trim();
      if (rawArgs.length > 0 && (rawArgs.startsWith('list') || rawArgs.startsWith('inspect') || rawArgs === '--help' || rawArgs === '-h')) {
        const global = readBridgeStateSync('global', { cwd });
        const project = readBridgeStateSync('project', { cwd });
        const g = formatStateSummary(global, 'Global Scope');
        const p = formatStateSummary(project, 'Project Scope');
        const barrier = await checkGlobalPendingBarrier({ cwd });
        const banner = barrier.active ? `\n⚠ Global Pending Barrier 活躍：${quoteTerminalText(barrier.reason ?? 'global recovery is required')}（專案變異已阻擋，僅檢查/Refresh 可用）` : '';
        ctx.ui.notify(`${g}\n${p}${banner}\n(完整導向流請於 TUI 內執行 /codex-marketplace)` , barrier.active ? 'warning' : 'info');
        return;
      }

      // Non-TUI fallback: notify with summary + barrier hint
      if (ctx.mode !== 'tui' || !ctx.hasUI) {
        const global = readBridgeStateSync('global', { cwd });
        const project = readBridgeStateSync('project', { cwd });
        const g = formatStateSummary(global, 'Global Scope');
        const p = formatStateSummary(project, 'Project Scope');
        const barrier = await checkGlobalPendingBarrier({ cwd });
        const banner = barrier.active ? `\n⚠ Global Pending Barrier：${quoteTerminalText(barrier.reason ?? 'global recovery is required')}` : '';
        ctx.ui.notify(`${g}\n${p}${banner}\n互動流程需 TUI 模式（/codex-marketplace 於 TUI 內）`, barrier.active ? 'warning' : 'info');
        return;
      }

      // The workspace is deliberately reopened from a fresh snapshot after every action.
      // Neither cached revisions nor presentation-derived eligibility become authority.
      while (true) {
        const snapshot = await loadBridgeLedgerSnapshot({
          cwd,
          projectTrusted: ctx.isProjectTrusted(),
        });
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
