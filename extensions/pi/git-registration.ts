/**
 * Git Marketplace Registration — interactive TUI flow (Issue #18).
 * Mirrors local registration contract: explicit scope → Git locator + Git Selector
 * → normalization (Canonical Locator + selector canonical) + Acquisition Trust Base + snapshot
 * → Validation Disclosure → Registration Confirmation (Snapshot+Revision bound, Default No) → atomic commit → Attempt Receipt.
 */

import type { ExtensionCommandContext, ExtensionUIContext } from '@earendil-works/pi-coding-agent';

import {
  preflightGitRegistration,
  confirmGitRegistration,
} from '../../src/registration/git-flow.js';
import type { GitSelectorInput } from '../../src/registration/git-selector.js';
import type { Scope } from '../../src/bridge-state/types.js';
import {
  fullValidationDisclosureLines,
  reportOutcome,
  reportTerminalPreflightOutcome,
} from './registration.js';
import { quoteTerminalText } from './terminal-presentation.js';
import { openTransactionSheet, type TransactionSheetModel } from './transaction-sheet.js';

async function transactionStep(
  ctx: ExtensionCommandContext,
  model: TransactionSheetModel,
  cancel?: () => void | Promise<void>,
): Promise<boolean> {
  if (await openTransactionSheet(ctx, model) === 'continue') return true;
  if (cancel) await cancel();
  else ctx.ui.notify('已取消 Transaction；Bridge State 未變更。', 'info');
  return false;
}

export async function runGitRegistrationFlow(
  ctx: ExtensionCommandContext,
  target: { scope?: Scope } = {},
): Promise<void> {
  const ui: ExtensionUIContext = ctx.ui;
  let scope = target.scope;
  if (!scope) {
    const scopeLabels = new Map<string, Scope>([
      ['Global Scope', 'global'],
      ['Project Scope', 'project'],
    ]);
    const scopeChoice = await ui.select('Marketplace Registration (Git) — 選擇 Scope', [...scopeLabels.keys()]);
    if (!scopeChoice) {
      ui.notify('已取消 Git Registration', 'info');
      return;
    }
    scope = scopeLabels.get(scopeChoice);
    if (!scope) return;
  }

  const locator = await ui.input('Git Marketplace Locator（https:// 或 ssh:// 或 scp-like user@host:path，無憑證、無 query/fragment）', 'https://github.com/owner/repo.git');
  if (!locator) {
    ui.notify('已取消 Git Registration', 'info');
    return;
  }

  const selectorKinds = new Map<string, GitSelectorInput['kind']>([
    ['default (跟隨遠端預設分支 HEAD)', 'default'],
    ['branch (→ refs/heads/*)', 'branch'],
    ['tag (→ refs/tags/*)', 'tag'],
    ['commit (小寫完整 40/64 hex)', 'commit'],
  ]);
  const selectorKindChoice = await ui.select('Git Selector — 選擇型別', [...selectorKinds.keys()]);
  if (!selectorKindChoice) {
    ui.notify('已取消 Git Registration', 'info');
    return;
  }
  const selectorKind = selectorKinds.get(selectorKindChoice);
  if (!selectorKind) return;
  let selectorInput: GitSelectorInput;
  if (selectorKind === 'default') {
    selectorInput = { kind: 'default' };
  } else if (selectorKind === 'branch') {
    const branch = await ui.input('Branch 名稱（例：main / feature/foo，將正規化為 refs/heads/<name>）', 'main');
    if (!branch) {
      ui.notify('已取消 Git Registration', 'info');
      return;
    }
    selectorInput = { kind: 'branch', value: branch };
  } else if (selectorKind === 'tag') {
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

  const actionLabel = 'Git Marketplace Registration';
  const intentTarget = `${locator}#${selectorInput.kind === 'default' ? 'default' : selectorInput.value}`;
  if (!await transactionStep(ctx, {
    step: 'Intent',
    actionLabel,
    authority: scope,
    target: intentTarget,
    details: [
      `Locator ${quoteTerminalText(locator)}`,
      `Selector ${quoteTerminalText(selectorInput.kind === 'default' ? 'default' : selectorInput.value)}`,
    ],
  })) return;

  const opts = { cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() };
  const res = await preflightGitRegistration(scope, locator, selectorInput, opts);
  if (!res.ok) {
    await reportTerminalPreflightOutcome(ctx, res.outcome);
    return;
  }

  const pf = res.preflight;
  const validationDetails = [
    `Registration ID ${quoteTerminalText(pf.registrationId)}`,
    `Canonical Locator ${quoteTerminalText(pf.locator.canonicalUrl)}`,
    `Locator transport ${quoteTerminalText(pf.locator.transport)}`,
    `Locator host ${quoteTerminalText(pf.locator.host)}`,
    `Locator port ${quoteTerminalText(pf.locator.port ?? '(default)')}`,
    `Locator path ${quoteTerminalText(pf.locator.path)}`,
    `Locator user ${quoteTerminalText(pf.locator.user ?? '(none)')}`,
    `Git Selector ${quoteTerminalText(pf.selector.kind)} → ${quoteTerminalText(pf.selector.canonical)}`,
    `Resolved Revision ${quoteTerminalText(pf.resolvedRevision)}`,
    `Marketplace ${quoteTerminalText(pf.marketplaceName)}`,
    `Entries ${pf.catalog.entries.length} (` +
      `${pf.catalog.entries.filter((entry) => entry.available).length} locatable / ` +
      `${pf.catalog.entries.filter((entry) => !entry.available).length} unavailable)`,
    `Compatibility Profile ${quoteTerminalText(pf.snapshot.profile)}`,
    `Ruleset ${quoteTerminalText(pf.snapshot.ruleset)}`,
    `Validation Budget ${quoteTerminalText(pf.snapshot.budget)}`,
    'Acquisition safety: isolated credential-free Git acquisition; remote-controlled hooks and submodules are not executed.',
    ...fullValidationDisclosureLines(pf.findings),
    ...pf.catalog.entries.map((entry) =>
      `Entry ${quoteTerminalText(entry.entryId)} ${quoteTerminalText(entry.name ?? '(unnamed)')} ${quoteTerminalText(entry.available ? 'locatable' : entry.unavailableReason ?? 'unavailable')}`,
    ),
  ];
  const boundModel = {
    actionLabel,
    authority: scope,
    target: pf.registrationId,
    stateRevision: pf.stateRevision,
    validationSnapshot: pf.snapshot.fingerprint,
  };
  const cancel = async () => {
    await reportOutcome(ctx, await confirmGitRegistration(pf, false, opts));
  };
  if (!await transactionStep(ctx, {
    ...boundModel,
    step: 'Validation',
    details: validationDetails,
  }, cancel)) return;
  if (!await transactionStep(ctx, {
    ...boundModel,
    step: 'Consent',
    details: ['Registration Confirmation: separate Default No host gate'],
  }, cancel)) return;

  const yes = await ui.confirm(
    'Registration Confirmation — 預設 No（綁定 State Revision + Validation Snapshot，不可記憶、不可批次）',
    `確認 Registration ID ${quoteTerminalText(pf.registrationId)}：` +
      `${quoteTerminalText(pf.locator.canonicalUrl)}#${quoteTerminalText(pf.selector.canonical)} ` +
      `(${pf.resolvedRevision.slice(0, 8)}…) 至 ${scope}？\nValidation Disclosure:\n` +
      validationDetails.join('\n'),
  );

  if (yes) {
    if (!await transactionStep(ctx, {
      ...boundModel,
      step: 'Plan',
      details: ['Update Plan: N/A — new Registration has no replacement plan'],
    }, cancel)) return;
    if (!await transactionStep(ctx, {
      ...boundModel,
      step: 'Commit',
      details: [
        `Persist Registration ID ${quoteTerminalText(pf.registrationId)}`,
        `Write authority ${scope} at State Revision ${quoteTerminalText(pf.stateRevision)}`,
      ],
    }, cancel)) return;
  }

  const outcome = await confirmGitRegistration(pf, yes, opts);
  await reportOutcome(ctx, outcome);
}
