/**
 * Local Marketplace Registration — interactive TUI flow (Issue #17).
 * Prototype contract (tui-management-flow): explicit scope selection → Validation Disclosure →
 * Registration Confirmation (Validation Snapshot + State Revision bound, Default No) → atomic
 * commit → Attempt Summary + closed Recovery Action reporting.
 *
 * The flow logic itself lives in src/registration/flow.ts (the tested seam); this file renders it.
 */

import type { Theme } from '@earendil-works/pi-coding-agent';
import type { ExtensionCommandContext, ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import { truncateToWidth } from '@earendil-works/pi-tui';

import {
  preflightLocalRegistration,
  confirmLocalRegistration,
  disclosureSummary,
  type LocalRegistrationPreflight,
} from '../../src/registration/flow.js';
import type { ValidationFinding } from '../../src/registration/findings.js';
import type { RegistrationOutcome } from '../../src/registration/flow.js';
import { formatThreeOrthogonalReport, type AttemptReceipt } from '../../src/registration/receipt.js';

export function formatFindings(findings: ValidationFinding[]): string[] {
  const sorted = [...findings].sort((a, b) => {
    const rank: Record<string, number> = { blocking: 0, warning: 1, notice: 2 };
    const phaseRank: Record<string, number> = { admission: 0, identity: 1, validation: 2, persistence: 3, 'post-commit': 4 };
    return (
      (rank[a.classification] ?? 9) - (rank[b.classification] ?? 9) ||
      (phaseRank[a.phase] ?? 9) - (phaseRank[b.phase] ?? 9) ||
      a.target.localeCompare(b.target) ||
      a.pointer.localeCompare(b.pointer) ||
      a.rule.localeCompare(b.rule)
    );
  });
  return sorted.map((f) => {
    const cls = f.classification === 'blocking' ? 'BLOCKING' : f.classification === 'warning' ? 'WARNING' : 'NOTICE';
    const ptr = f.pointer ? ` @${f.pointer}` : '';
    return `  [${cls}] ${f.code} (${f.rule}) · ${f.target}${ptr} — ${f.outcome}`;
  });
}

/** Static disclosure view (mirrors the scaffold component pattern). */
class DisclosureComponent {
  private lines: string[];
  private theme: Theme;
  private onClose: () => void;

  constructor(lines: string[], theme: Theme, onClose: () => void) {
    this.lines = lines;
    this.theme = theme;
    this.onClose = onClose;
  }

  handleInput(data: string): void {
    if (data) this.onClose();
  }

  render(width: number): string[] {
    const th = this.theme;
    const out: string[] = [];
    out.push('');
    out.push(truncateToWidth(th.fg('accent', th.bold(' Validation Disclosure ')) + th.fg('borderMuted', '─'.repeat(Math.max(0, width - 22))), width));
    for (const ln of this.lines) {
      out.push(truncateToWidth(`  ${ln}`, width));
    }
    out.push('');
    out.push(truncateToWidth(`  ${th.fg('dim', 'Any key: continue to Registration Confirmation (Default No) · Confirm is snapshot + State Revision bound')}`, width));
    out.push('');
    return out;
  }

  invalidate(): void {}
}

/** One interactive registration flow invocation. */
export async function runLocalRegistrationFlow(ctx: ExtensionCommandContext): Promise<void> {
  const ui: ExtensionUIContext = ctx.ui;
  const scopeChoice = await ui.select('Marketplace Registration — 選擇 Scope', [
    'Global Scope',
    'Project Scope',
  ]);
  if (!scopeChoice) {
    ui.notify('已取消 Registration', 'info');
    return;
  }
  const scope: 'global' | 'project' = scopeChoice.startsWith('Global') ? 'global' : 'project';

  const rootPath = await ui.input('本地 Marketplace Root（需含 .agents/plugins/marketplace.json）', '.');
  if (!rootPath) {
    ui.notify('已取消 Registration', 'info');
    return;
  }

  const opts = { cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() };
  const res = await preflightLocalRegistration(scope, rootPath, opts);
  if (!res.ok) {
    reportOutcome(ctx, res.outcome);
    return;
  }

  const pf = res.preflight;
  // Validation Disclosure → confirmation
  const lines = [
    ...disclosureSummary(pf).split('\n'),
    '',
    ...formatFindings(pf.findings),
  ];
  const disclosure: string[] = lines;

  if (ctx.mode !== 'tui') {
    ui.notify('Registration 需要 TUI 模式; disclosure:\n' + lines.join('\n'), 'info');
  } else {
    await ui.custom<void>(
      (_tui, theme, _kb, done) =>
        new DisclosureComponent(disclosure, theme, () => done(undefined)),
    );
  }

  const yes = await ui.confirm(
    'Registration Confirmation — 預設 No（綁定 State Revision + Validation Snapshot，不可記憶、不可批次）',
    `確認註冊 ${pf.canonicalPath} 至 ${scope}？\n${disclosure.slice(0, 8).join('\n')}`,
  );

  const outcome = await confirmLocalRegistration(pf, yes, opts);
  reportOutcome(ctx, outcome);
}

/** Render the three-orthogonal outcome (persistence / findings / runtime) as an Attempt Summary + Recovery Action. */
export function reportOutcome(
  ctx: { ui: { notify(message: string, type?: 'info' | 'warning' | 'error'): void } },
  outcome: { receipt: AttemptReceipt },
): void {
  const rc = outcome.receipt;
  const report = formatThreeOrthogonalReport(rc);
  const notifyType =
    rc.summary === 'Completed' || rc.summary === 'Completed with diagnostics'
      ? 'info'
      : rc.summary === 'Declined' || rc.summary === 'Rejected as Stale'
        ? 'warning'
        : 'error';
  ctx.ui.notify(report, notifyType);
}