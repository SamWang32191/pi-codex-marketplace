/**
 * TUI flows for Receipt Journal inspection and State Repair action (Issue #23).
 */

import type { ExtensionCommandContext, ExtensionUIContext } from '@earendil-works/pi-coding-agent';

import type { Scope } from '../../src/bridge-state/types.js';
import { readReceiptJournal } from '../../src/journal/journal.js';
import { repairBridgeState } from '../../src/bridge-state/repair.js';
import { formatThreeOrthogonalReport } from '../../src/registration/receipt.js';
import { reportOutcome } from './registration.js';

export async function runReceiptJournalView(ctx: ExtensionCommandContext): Promise<void> {
  const ui: ExtensionUIContext = ctx.ui;
  const scopeChoice = await ui.select('Receipt Journal — 選擇 Scope', [
    'Global Scope',
    'Project Scope',
  ]);
  if (!scopeChoice) return;
  const scope: Scope = scopeChoice.startsWith('Global') ? 'global' : 'project';

  const journal = await readReceiptJournal(scope, { cwd: ctx.cwd });
  const lines: string[] = [
    `=== ${scope === 'global' ? 'Global' : 'Project'} Receipt Journal ===`,
    `Total Receipts: ${journal.receipts.length}`,
    `Degraded: ${journal.isDegraded ? `Yes (${journal.corruptedLineCount} corrupted lines)` : 'No'}`,
    `Active Recovery Chains: ${journal.activeChains.length === 0 ? 'None' : ''}`,
  ];

  for (const chain of journal.activeChains) {
    lines.push(`  • Chain [${chain.rootReceiptId}] condition: ${chain.condition} (length: ${chain.receipts.length})`);
  }

  lines.push('');
  lines.push('--- Recent Receipts ---');
  const recent = journal.receipts.slice(-10).reverse();
  if (recent.length === 0) {
    lines.push('  (Journal is empty)');
  } else {
    for (const rc of recent) {
      lines.push(`[${rc.id}] ${rc.completedAt} · ${rc.operation} (${rc.scope})`);
      lines.push(`  Summary: ${rc.summary} | Durable: ${rc.durableOutcome} | Runtime: ${rc.runtimeOutcome}`);
      lines.push(`  Revision: ${rc.expectedStateRevision} → ${rc.observedStateRevision ?? rc.targetStateRevision ?? '?'}`);
      if (rc.recoversReceiptId) {
        lines.push(`  Recovers: ${rc.recoversReceiptId}`);
      }
      if (rc.findings.length > 0) {
        lines.push(`  Findings: ${rc.findings.map((f) => `${f.classification} ${f.code}`).join(', ')}`);
      }
      lines.push('');
    }
  }

  ui.notify(lines.join('\n'), journal.isDegraded ? 'warning' : 'info');
}

export async function runRepairStateFlow(ctx: ExtensionCommandContext): Promise<void> {
  const ui: ExtensionUIContext = ctx.ui;
  const scopeChoice = await ui.select('Repair State — 選擇 Scope', [
    'Global Scope',
    'Project Scope',
  ]);
  if (!scopeChoice) return;
  const scope: Scope = scopeChoice.startsWith('Global') ? 'global' : 'project';

  const confirmed = await ui.confirm(
    'Repair State Confirmation — 預設 No',
    `執行 ${scope === 'global' ? 'Global' : 'Project'} Scope 的 State Repair？\n將在 Attempt Fence 保護下驗證 Bridge State 結構與一致性，並解除相應的 Indeterminate/Degraded recovery chain。`,
  );
  if (!confirmed) {
    ui.notify('已取消 State Repair', 'info');
    return;
  }

  const res = await repairBridgeState(scope, {
    cwd: ctx.cwd,
  });

  reportOutcome(ctx, { receipt: res.receipt });
}
