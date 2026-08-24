/**
 * Local Marketplace Registration — interactive TUI flow (Issue #17).
 * Prototype contract (tui-management-flow): explicit scope selection → Validation Disclosure →
 * Registration Confirmation (Validation Snapshot + State Revision bound, Default No) → atomic
 * commit → Attempt Summary + closed Recovery Action reporting.
 *
 * The flow logic itself lives in src/registration/flow.ts (the tested seam); this file renders it.
 * All user-visible strings come from the centralized ui-strings module (Issue #41).
 */

import type { ExtensionCommandContext, ExtensionUIContext } from '@earendil-works/pi-coding-agent';

import {
  preflightLocalRegistration,
  confirmLocalRegistration,
} from '../../src/registration/flow.js';
import type { Scope } from '../../src/bridge-state/types.js';
import { sortFindings, type ValidationFinding } from '../../src/registration/findings.js';
import type { AttemptReceipt } from '../../src/registration/receipt.js';
import { attemptSummaryText, findingOutcomeText, uiText, verdictText } from './ui-strings.js';
import { quoteTerminalText } from './terminal-presentation.js';
import { openTransactionSheet, type TransactionSheetModel } from './transaction-sheet.js';

export function formatFindings(findings: ValidationFinding[]): string[] {
  return sortFindings(findings).map((f) =>
    uiText('finding.line', {
      classification: f.classification,
      scope: f.scope,
      phase: f.phase,
      target: f.target,
      pointer: quoteTerminalText(f.pointer || `(${uiText('common.none')})`),
      code: quoteTerminalText(f.code),
      rule: quoteTerminalText(f.rule),
      outcome: quoteTerminalText(findingOutcomeText(f)),
    }),
  );
}

export function validationDisclosureLines(findings: ValidationFinding[]): string[] {
  const counts = {
    blocking: findings.filter((finding) => finding.classification === 'blocking').length,
    warning: findings.filter((finding) => finding.classification === 'warning').length,
    notice: findings.filter((finding) => finding.classification === 'notice').length,
  };
  const verdict = counts.blocking > 0 ? 'Blocked'
    : counts.warning > 0 || counts.notice > 0 ? 'Passed with diagnostics' : 'Passed';
  return [
    `${uiText('verdict.label')}：${verdictText(verdict)}`,
    `${uiText('findings.count.label')}：${uiText('findings.count.line', counts)}`,
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
  else ctx.ui.notify(uiText('common.cancelled.transaction'), 'info');
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
      [uiText('common.scope.global'), 'global'],
      [uiText('common.scope.project'), 'project'],
    ]);
    const scopeChoice = await ui.select(uiText('reg.select.scope'), [...scopeLabels.keys()]);
    if (!scopeChoice) {
      ui.notify(uiText('reg.cancelled'), 'info');
      return;
    }
    scope = scopeLabels.get(scopeChoice);
    if (!scope) return;
  }

  const rootPath = await ui.input(uiText('reg.input.localRoot'), '.');
  if (!rootPath) {
    ui.notify(uiText('reg.cancelled'), 'info');
    return;
  }

  const actionLabel = 'Local Marketplace Registration';
  if (!await transactionStep(ctx, {
    step: 'Intent',
    actionLabel,
    authority: scope,
    target: rootPath,
    details: [uiText('reg.detail.source', { source: quoteTerminalText(rootPath) })],
  })) return;

  const opts = { cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() };
  const res = await preflightLocalRegistration(scope, rootPath, opts);
  if (!res.ok) {
    await reportTerminalPreflightOutcome(ctx, res.outcome);
    return;
  }

  const pf = res.preflight;
  const validationDetails = [
    uiText('reg.detail.registrationId', { id: quoteTerminalText(pf.registrationId) }),
    uiText('reg.detail.source', { source: quoteTerminalText(pf.canonicalPath) }),
    uiText('reg.detail.marketplace', { name: quoteTerminalText(pf.marketplaceName) }),
    uiText('reg.detail.entries', {
      total: pf.catalog.entries.length,
      locatable: pf.catalog.entries.filter((entry) => entry.available).length,
      unavailable: pf.catalog.entries.filter((entry) => !entry.available).length,
    }),
    uiText('reg.detail.profile', { profile: quoteTerminalText(pf.snapshot.profile) }),
    uiText('reg.detail.ruleset', { ruleset: quoteTerminalText(pf.snapshot.ruleset) }),
    uiText('reg.detail.budget', { budget: quoteTerminalText(pf.snapshot.budget) }),
    ...fullValidationDisclosureLines(pf.findings),
    ...pf.catalog.entries.map((entry) =>
      uiText('reg.detail.entry', {
        entryId: quoteTerminalText(entry.entryId),
        name: quoteTerminalText(entry.name ?? `(${uiText('common.none')})`),
        status: entry.available
          ? uiText('reg.entry.locatable')
          : uiText('reg.entry.unavailable', { reason: quoteTerminalText(entry.unavailableReason ?? uiText('common.unavailable')) }),
      }),
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
    details: [uiText('reg.consent.details')],
  }, cancel)) return;

  const yes = await ui.confirm(
    uiText('reg.consent.title'),
    uiText('reg.local.consent.body', {
      registrationId: quoteTerminalText(pf.registrationId),
      source: quoteTerminalText(pf.canonicalPath),
      scope,
      disclosure: validationDetails.join('\n'),
    }),
  );

  if (yes) {
    if (!await transactionStep(ctx, {
      ...boundModel,
      step: 'Plan',
      details: [uiText('reg.plan.details')],
    }, cancel)) return;
    if (!await transactionStep(ctx, {
      ...boundModel,
      step: 'Commit',
      details: [
        uiText('reg.commit.persist', { id: quoteTerminalText(pf.registrationId) }),
        uiText('reg.commit.authority', { scope, revision: quoteTerminalText(pf.stateRevision) }),
      ],
    }, cancel)) return;
  }

  const outcome = await confirmLocalRegistration(pf, yes, opts);
  await reportOutcome(ctx, outcome);
}

/** Show a terminal preflight's bound Validation Disclosure before presenting its existing Receipt. */
export async function reportTerminalPreflightOutcome(
  ctx: Pick<ExtensionCommandContext, 'mode' | 'hasUI' | 'ui'>,
  outcome: { receipt: AttemptReceipt },
): Promise<void> {
  const receipt = outcome.receipt;
  await openTransactionSheet(ctx, {
    step: 'Validation',
    actionLabel: receipt.operation,
    authority: receipt.scope,
    target: receipt.trigger,
    stateRevision: receipt.expectedStateRevision,
    validationSnapshot: receipt.validationSnapshot,
    details: fullValidationDisclosureLines(receipt.findings),
  });
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
  ctx.ui.notify(
    uiText('reg.outcome.notify', { summary: attemptSummaryText(rc.summary), receiptId: quoteTerminalText(rc.id) }),
    notifyType,
  );
}
