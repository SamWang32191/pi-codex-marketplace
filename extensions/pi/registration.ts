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

export function formatFindings(findings: ValidationFinding[]): string[] {
  return findings.map((f) => {
    const cls = f.classification === 'blocking' ? 'BLOCKING' : f.classification === 'warning' ? 'warning' : 'notice';
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
  outcome: RegistrationOutcome,
): void {
  if (outcome.status === 'completed') {
    const rc = outcome.receipt;
    ctx.ui.notify(
      `Attempt Summary: ${rc.summary} · new State Revision ${outcome.newRevision} · Registration ${outcome.registration.alias ?? outcome.registration.id.slice(0, 8)}…\nReceipt ${rc.id} — immutable, non-authoritative. Recovery: none required.`,
      'info',
    );
    return;
  }
  if (outcome.status === 'declined') {
    ctx.ui.notify(
      `Attempt Summary: Declined — state unchanged. Receipt ${outcome.receipt.id}（redacted, immutable）`,
      'info',
    );
    return;
  }
  if (outcome.status === 'rejected-as-stale') {
    ctx.ui.notify(
      `Attempt Summary: Rejected as Stale — State Revision or Validation Snapshot changed since disclosure. Recovery: 重新 preflight + confirmation（不會自動合併）`,
      'warning',
    );
    return;
  }
  if (outcome.status === 'persistence-failed') {
    ctx.ui.notify(
      `Attempt Summary: ${outcome.isIndeterminate ? 'Persistence Indeterminate' : 'Persistence Failed'} — ${outcome.receipt.findings[0]?.outcome ?? ''}. Recovery: Persistence Indeterminate 需先 Repair State 使 state 可讀且精確（fail-closed，不自動回滾）`,
      'error',
    );
    return;
  }
  // blocked
  const blocked = outcome.findings[0];
  const existing = outcome.existing ? ` 已存在 Registration: ${outcome.existing.alias ?? outcome.existing.id.slice(0, 8)}… — 導向既有 Registration` : '';
  ctx.ui.notify(
    `Attempt Summary: Blocked — ${blocked?.code ?? '?'} (${blocked?.rule ?? '?'}): ${blocked?.outcome ?? ''}${existing}\nRecovery: 修復來源後重新 preflight（Blocking Findings 不可 waive）`,
    'error',
  );
}