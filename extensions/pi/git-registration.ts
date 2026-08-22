/**
 * Git Marketplace Registration — interactive TUI flow (Issue #18).
 * Mirrors local registration contract: explicit scope → Git locator + Git Selector
 * → normalization (Canonical Locator + selector canonical) + Acquisition Trust Base + snapshot
 * → Validation Disclosure → Registration Confirmation (Snapshot+Revision bound, Default No) → atomic commit → Attempt Receipt.
 */

import type { Theme } from '@earendil-works/pi-coding-agent';
import type { ExtensionCommandContext, ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import { truncateToWidth } from '@earendil-works/pi-tui';

import {
  preflightGitRegistration,
  confirmGitRegistration,
  disclosureSummaryGit,
} from '../../src/registration/git-flow.js';
import type { GitSelectorInput } from '../../src/registration/git-selector.js';
import type { GitRegistrationOutcome as RegistrationOutcome } from '../../src/registration/git-flow.js';
import { formatFindings, reportOutcome } from './registration.js';

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
    out.push(truncateToWidth(th.fg('accent', th.bold(' Validation Disclosure (Git) ')) + th.fg('borderMuted', '─'.repeat(Math.max(0, width - 26))), width));
    for (const ln of this.lines) {
      out.push(truncateToWidth(`  ${ln}`, width));
    }
    out.push('');
    out.push(truncateToWidth(`  ${th.fg('dim', 'Any key: continue to Registration Confirmation (Default No) · Confirm is snapshot + State Revision bound')}`, width));
    out.push(truncateToWidth(`  ${th.fg('dim', 'Canonical Locator 與 Git Selector 正規化結果已於上方披露；Acquisition 採 clone --no-checkout 且未執行 hooks/filters/submodules')}`, width));
    out.push('');
    return out;
  }

  invalidate(): void {}
}

export async function runGitRegistrationFlow(ctx: ExtensionCommandContext): Promise<void> {
  const ui: ExtensionUIContext = ctx.ui;
  const scopeChoice = await ui.select('Marketplace Registration (Git) — 選擇 Scope', [
    'Global Scope',
    'Project Scope',
  ]);
  if (!scopeChoice) {
    ui.notify('已取消 Git Registration', 'info');
    return;
  }
  const scope: 'global' | 'project' = scopeChoice.startsWith('Global') ? 'global' : 'project';

  const locator = await ui.input('Git Marketplace Locator（https:// 或 ssh:// 或 scp-like user@host:path，無憑證、無 query/fragment）', 'https://github.com/owner/repo.git');
  if (!locator) {
    ui.notify('已取消 Git Registration', 'info');
    return;
  }

  const selectorKindChoice = await ui.select('Git Selector — 選擇型別', [
    'default (跟隨遠端預設分支 HEAD)',
    'branch (→ refs/heads/*)',
    'tag (→ refs/tags/*)',
    'commit (小寫完整 40/64 hex)',
  ]);
  if (!selectorKindChoice) {
    ui.notify('已取消 Git Registration', 'info');
    return;
  }
  let selectorInput: GitSelectorInput;
  if (selectorKindChoice.startsWith('default')) {
    selectorInput = { kind: 'default' };
  } else if (selectorKindChoice.startsWith('branch')) {
    const branch = await ui.input('Branch 名稱（例：main / feature/foo，將正規化為 refs/heads/<name>）', 'main');
    if (!branch) {
      ui.notify('已取消 Git Registration', 'info');
      return;
    }
    selectorInput = { kind: 'branch', value: branch };
  } else if (selectorKindChoice.startsWith('tag')) {
    const tag = await ui.input('Tag 名稱（例：v1.2.3，將正規化為 refs/tags/<name>）', 'v1.0.0');
    if (!tag) {
      ui.notify('已取消 Git Registration', 'info');
      return;
    }
    selectorInput = { kind: 'tag', value: tag };
  } else {
    const commit = await ui.input('Commit（完整 40 或 64 hex，將轉為小寫）', 'abc123def456abc123def456abc123def456abcd12');
    if (!commit) {
      ui.notify('已取消 Git Registration', 'info');
      return;
    }
    selectorInput = { kind: 'commit', value: commit };
  }

  const opts = { cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() };
  const res = await preflightGitRegistration(scope, locator, selectorInput, opts);
  if (!res.ok) {
    reportOutcome(ctx, res.outcome);
    return;
  }

  const pf = res.preflight;
  const lines = [
    ...disclosureSummaryGit(pf).split('\n'),
    '',
    ...formatFindings(pf.findings),
  ];

  if (ctx.mode !== 'tui') {
    ui.notify('Git Registration 需要 TUI 模式; disclosure:\n' + lines.join('\n'), 'info');
  } else {
    await ui.custom<void>(
      (_tui, theme, _kb, done) =>
        new DisclosureComponent(lines, theme, () => done(undefined)),
    );
  }

  const yes = await ui.confirm(
    'Registration Confirmation — 預設 No（綁定 State Revision + Validation Snapshot，不可記憶、不可批次）',
    `確認註冊 ${pf.locator.canonicalUrl}#${pf.selector.canonical} (${pf.resolvedRevision.slice(0, 8)}…) 至 ${scope}？\n${lines.slice(0, 10).join('\n')}`,
  );

  const outcome = await confirmGitRegistration(pf, yes, opts);
  reportOutcome(ctx, outcome);
}
