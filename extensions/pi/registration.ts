/**
 * Local Marketplace Registration — interactive TUI flow (Issue #17).
 * Prototype contract (tui-management-flow): explicit scope selection → Validation Disclosure →
 * Registration Confirmation (Validation Snapshot + State Revision bound, Default No) → atomic
 * commit → Attempt Summary + closed Recovery Action reporting.
 *
 * The flow logic itself lives in src/registration/flow.ts (the tested seam); this file renders it.
 */

import type { ExtensionCommandContext, ExtensionUIContext } from '@earendil-works/pi-coding-agent';

import {
  preflightLocalRegistration,
  confirmLocalRegistration,
} from '../../src/registration/flow.js';
import type { Scope } from '../../src/bridge-state/types.js';
import { sortFindings, type ValidationFinding } from '../../src/registration/findings.js';
import type { AttemptReceipt } from '../../src/registration/receipt.js';
import { quoteTerminalText } from './terminal-presentation.js';
import { openTransactionSheet, type TransactionSheetModel } from './transaction-sheet.js';

export function formatFindings(findings: ValidationFinding[]): string[] {
  return sortFindings(findings).map((f) => {
    return `Finding classification ${f.classification} | scope ${f.scope} | phase ${f.phase} | ` +
      `target ${f.target} | pointer ${quoteTerminalText(f.pointer || '(none)')} | ` +
      `code ${quoteTerminalText(f.code)} | rule ${quoteTerminalText(f.rule)} | ` +
      `outcome ${quoteTerminalText(f.outcome)}`;
  });
}

export function validationDisclosureLines(findings: ValidationFinding[]): string[] {
  const counts = {
    blocking: findings.filter((finding) => finding.classification === 'blocking').length,
    warning: findings.filter((finding) => finding.classification === 'warning').length,
    notice: findings.filter((finding) => finding.classification === 'notice').length,
  };
  const verdict = counts.blocking > 0
    ? 'Blocked'
    : counts.warning > 0 || counts.notice > 0
      ? 'Passed with diagnostics'
      : 'Passed';
  return [
    `Verdict ${verdict}`,
    `Findings ${counts.blocking} blocking · ${counts.warning} warning · ${counts.notice} notice`,
  ];
}

/** Verdict/count preview followed by the complete, canonically sorted disclosure. */
export function fullValidationDisclosureLines(findings: ValidationFinding[]): string[] {
  return [
    ...validationDisclosureLines(findings),
    ...formatFindings(findings),
  ];
}

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

/** One interactive registration flow invocation. */
export async function runLocalRegistrationFlow(
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
    const scopeChoice = await ui.select('Marketplace Registration — 選擇 Scope', [...scopeLabels.keys()]);
    if (!scopeChoice) {
      ui.notify('已取消 Registration', 'info');
      return;
    }
    scope = scopeLabels.get(scopeChoice);
    if (!scope) return;
  }

  const rootPath = await ui.input('本地 Marketplace Root（需含 .agents/plugins/marketplace.json）', '.');
  if (!rootPath) {
    ui.notify('已取消 Registration', 'info');
    return;
  }

  const actionLabel = 'Local Marketplace Registration';
  if (!await transactionStep(ctx, {
    step: 'Intent',
    actionLabel,
    authority: scope,
    target: rootPath,
    details: [`Source ${quoteTerminalText(rootPath)}`],
  })) return;

  const opts = { cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() };
  const res = await preflightLocalRegistration(scope, rootPath, opts);
  if (!res.ok) {
    await reportOutcome(ctx, res.outcome);
    return;
  }

  const pf = res.preflight;
  const validationDetails = [
    `Registration ID ${quoteTerminalText(pf.registrationId)}`,
    `Source ${quoteTerminalText(pf.canonicalPath)}`,
    `Marketplace ${quoteTerminalText(pf.marketplaceName)}`,
    `Entries ${pf.catalog.entries.length} (` +
      `${pf.catalog.entries.filter((entry) => entry.available).length} locatable / ` +
      `${pf.catalog.entries.filter((entry) => !entry.available).length} unavailable)`,
    `Compatibility Profile ${quoteTerminalText(pf.snapshot.profile)}`,
    `Ruleset ${quoteTerminalText(pf.snapshot.ruleset)}`,
    `Validation Budget ${quoteTerminalText(pf.snapshot.budget)}`,
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
    await reportOutcome(ctx, await confirmLocalRegistration(pf, false, opts));
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
      `${quoteTerminalText(pf.canonicalPath)} 至 ${scope}？\n` +
      `Validation Disclosure:\n${validationDetails.join('\n')}`,
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

  const outcome = await confirmLocalRegistration(pf, yes, opts);
  await reportOutcome(ctx, outcome);
}

/** Render the three-orthogonal outcome (persistence / findings / runtime) as an Attempt Summary + Recovery Action. */
export async function reportOutcome(
  ctx: Pick<ExtensionCommandContext, 'mode' | 'hasUI' | 'ui'>,
  outcome: { receipt: AttemptReceipt },
): Promise<void> {
  const rc = outcome.receipt;
  const notifyType =
    rc.summary === 'Completed' || rc.summary === 'Completed with diagnostics'
      ? 'info'
      : rc.summary === 'Declined' || rc.summary === 'Rejected as Stale'
        ? 'warning'
        : 'error';
  await openTransactionSheet(ctx, {
    step: 'Receipt',
    actionLabel: rc.operation,
    authority: rc.scope,
    target: rc.trigger,
    stateRevision: rc.observedStateRevision ?? rc.targetStateRevision ?? rc.expectedStateRevision,
    validationSnapshot: rc.validationSnapshot,
    receipt: rc,
  });
  ctx.ui.notify(`Attempt Summary: ${rc.summary} · Receipt ${quoteTerminalText(rc.id)}`, notifyType);
}
