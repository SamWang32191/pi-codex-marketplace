import type { ExtensionCommandContext, Theme } from '@earendil-works/pi-coding-agent';
import {
  Key,
  matchesKey,
  stripTerminalSequences,
  wrapTextWithAnsi,
  type Component,
} from '@earendil-works/pi-tui';

import { sortFindings } from '../../src/registration/findings.js';
import type { AttemptReceipt, AttemptSummary, RecoveryAction } from '../../src/registration/receipt.js';
import {
  attemptSummaryGloss,
  closedValue,
  findingOutcomeText,
  recoveryActionGloss,
  transactionStepLabel,
  uiText,
} from './ui-strings.js';
import {
  padTerminalLine,
  quoteTerminalText,
  renderBadge,
  renderPanel,
  type BadgeTone,
  type PresentationTheme,
} from './terminal-presentation.js';

export const TRANSACTION_STEPS = ['Intent', 'Validation', 'Consent', 'Plan', 'Commit', 'Receipt'] as const;

export type TransactionStep = (typeof TRANSACTION_STEPS)[number];

export interface TransactionSheetModel {
  step: TransactionStep;
  actionLabel: string;
  /** Presentation-only authority tag ('global' since Global-only #61). */
  authority?: 'global';
  target?: string;
  stateRevision?: string;
  validationSnapshot?: string;
  details?: string[];
  receipt?: AttemptReceipt;
}

export type TransactionSheetTheme = PresentationTheme;

function field(theme: TransactionSheetTheme, label: string, value: unknown): string {
  return `${theme.fg('dim', `${label}:`)} ${theme.fg('text', quoteTerminalText(value))}`;
}

function authorityLabel(authority: string | undefined): string {
  return authority === 'global' ? '[G] Global Scope' : '[G] Global Scope';
}

function findingLine(theme: TransactionSheetTheme, finding: AttemptReceipt['findings'][number]): string {
  return (
    `${theme.fg('warning', `[${finding.classification}]`)} ${quoteTerminalText(finding.code)} ` +
    `${quoteTerminalText(finding.rule)}: ${quoteTerminalText(findingOutcomeText(finding))}` +
    `${finding.pointer ? ` @${quoteTerminalText(finding.pointer)}` : ''}`
  );
}

function receiptAxes(receipt: AttemptReceipt, theme: TransactionSheetTheme): [string[], string[], string[]] {
  const orderedFindings = sortFindings(receipt.findings);
  const classifications = {
    blocking: orderedFindings.filter((finding) => finding.classification === 'blocking').length,
    warning: orderedFindings.filter((finding) => finding.classification === 'warning').length,
    notice: orderedFindings.filter((finding) => finding.classification === 'notice').length,
  };
  const durable = [
    theme.fg('accent', theme.bold(uiText('sheet.axis.durable'))),
    field(theme, uiText('sheet.field.outcome'), receipt.durableOutcome),
    field(theme, uiText('sheet.field.expectedRevision'), receipt.expectedStateRevision),
    ...(receipt.targetStateRevision === undefined
      ? []
      : [field(theme, uiText('sheet.field.targetRevision'), receipt.targetStateRevision)]),
    ...(receipt.observedStateRevision === undefined
      ? []
      : [field(theme, uiText('sheet.field.observedRevision'), receipt.observedStateRevision)]),
    field(
      theme,
      uiText('sheet.field.stateChanged'),
      receipt.stateChanged ? uiText('common.yes') : uiText('common.no'),
    ),
  ];
  const findings = [
    theme.fg('accent', theme.bold(uiText('sheet.axis.findings'))),
    field(theme, uiText('sheet.field.count'), orderedFindings.length),
    field(theme, 'Blocking', classifications.blocking),
    field(theme, 'Warning', classifications.warning),
    field(theme, 'Notice', classifications.notice),
    ...orderedFindings.map((finding) => findingLine(theme, finding)),
  ];
  const runtime = [
    theme.fg('accent', theme.bold(uiText('sheet.axis.runtime'))),
    field(theme, uiText('sheet.field.outcome'), receipt.runtimeOutcome),
    field(theme, uiText('sheet.field.receipt'), receipt.id),
    field(theme, uiText('sheet.field.kind'), receipt.kind),
    field(theme, uiText('sheet.field.operation'), receipt.operation),
    field(theme, uiText('sheet.field.trigger'), receipt.trigger),
  ];
  return [durable, findings, runtime];
}

function renderWideAxes(axes: [string[], string[], string[]], theme: TransactionSheetTheme, width: number): string[] {
  const separator = theme.fg('borderMuted', ' │ ');
  const available = Math.max(0, width - 5);
  const firstWidth = Math.floor(available / 3);
  const secondWidth = Math.floor(available / 3);
  const widths = [firstWidth, secondWidth, available - firstWidth - secondWidth];
  const wrappedAxes = axes.map((axis, column) =>
    axis.flatMap((line) => wrapTextWithAnsi(line, Math.max(1, widths[column]!))),
  );
  const height = Math.max(...wrappedAxes.map((axis) => axis.length));
  return Array.from({ length: height }, (_, row) =>
    wrappedAxes
      .map((axis, column) => padTerminalLine(axis[row] ?? '', widths[column]!))
      .join(separator),
  );
}

function renderStackedAxes(axes: [string[], string[], string[]], width: number): string[] {
  const lines: string[] = [];
  axes.forEach((axis, index) => {
    if (index > 0) lines.push('');
    lines.push(...wrapTextWithAnsi(axis[0]!, Math.max(1, width)));
    lines.push(...axis.slice(1).flatMap((line) =>
      wrapTextWithAnsi(line, Math.max(1, width - 2)).map((part) => `  ${part}`),
    ));
  });
  return lines;
}

/** Stage indicator cells: done ✓, active ▸ …（進行中）, pending numbered. Labels are zh_TW. */
function stageSegments(theme: TransactionSheetTheme, step: TransactionStep): string[] {
  const activeIndex = TRANSACTION_STEPS.indexOf(step);
  return TRANSACTION_STEPS.map((name, index) => {
    const label = transactionStepLabel(name);
    if (index < activeIndex) return theme.fg('success', `✓ ${index + 1} ${label}`);
    if (index === activeIndex) {
      return theme.fg('accent', theme.bold(`▸ ${index + 1} ${label}（${uiText('step.activeSuffix')}）`));
    }
    return theme.fg('muted', `${index + 1} ${label}`);
  });
}

function stageRows(theme: TransactionSheetTheme, step: TransactionStep, width: number): string[] {
  const segments = stageSegments(theme, step);
  const connector = theme.fg('borderMuted', ' ─ ');
  return [segments.slice(0, 3), segments.slice(3)].flatMap((row) =>
    wrapTextWithAnsi(row.join(connector), Math.max(1, width)));
}

const SUMMARY_TONES: Record<AttemptSummary, { tone: BadgeTone; labelId: Parameters<typeof uiText>[0] }> = {
  'Completed': { tone: 'success', labelId: 'ledger.badge.healthy' },
  'Completed with diagnostics': { tone: 'warning', labelId: 'summary.badge.diagnostics' },
  'Declined': { tone: 'warning', labelId: 'summary.badge.declined' },
  'Blocked': { tone: 'error', labelId: 'summary.badge.blocked' },
  'Rejected as Stale': { tone: 'warning', labelId: 'summary.badge.stale' },
  'Persistence Failed': { tone: 'error', labelId: 'summary.badge.persistenceFailed' },
  'Persistence Indeterminate': { tone: 'error', labelId: 'ledger.badge.indeterminate' },
  'Pending Application': { tone: 'warning', labelId: 'summary.badge.pending' },
};

/** Recovery Action closed values rendered quoted-canonical + zh_TW gloss outside the quotes. */
function recoveryActionsText(actions: RecoveryAction[]): string {
  return actions
    .map((action) => closedValue(quoteTerminalText(action), recoveryActionGloss(action)))
    .join(', ');
}

export function renderTransactionSheet(
  model: TransactionSheetModel,
  theme: TransactionSheetTheme,
  width: number,
): string[] {
  const totalWidth = Math.max(4, Math.floor(width));
  const innerWidth = Math.max(1, totalWidth - 3);
  const receipt = model.receipt;
  const authority = model.authority ?? 'global';
  const stateRevision = model.stateRevision ?? receipt?.observedStateRevision ?? receipt?.expectedStateRevision;
  const validationSnapshot = model.validationSnapshot ?? receipt?.validationSnapshot;
  const body: string[] = [
    ...stageRows(theme, model.step, innerWidth),
    '',
    field(theme, uiText('sheet.field.action'), model.actionLabel),
    ...(authority === undefined ? [] : [field(theme, uiText('sheet.field.authority'), authorityLabel(authority))]),
    ...(model.target === undefined ? [] : [field(theme, uiText('sheet.field.target'), model.target)]),
    ...(stateRevision === undefined ? [] : [field(theme, 'State Revision', stateRevision)]),
    ...(validationSnapshot === undefined ? [] : [field(theme, 'Validation Snapshot', validationSnapshot)]),
    ...(model.details ?? []).map((detail) => field(theme, uiText('sheet.field.detail'), detail)),
  ];

  if (receipt) {
    body.push('');
    const axes = receiptAxes(receipt, theme);
    body.push(...(innerWidth >= 64 ? renderWideAxes(axes, theme, innerWidth) : renderStackedAxes(axes, innerWidth)));
    body.push('');
    const summaryTone = SUMMARY_TONES[receipt.summary];
    body.push(
      `${theme.fg('accent', theme.bold(`${uiText('sheet.attemptSummary')}:`))} ` +
        `${closedValue(quoteTerminalText(receipt.summary), attemptSummaryGloss(receipt.summary))} ` +
        renderBadge(theme, summaryTone.tone, uiText(summaryTone.labelId)),
    );
    body.push(
      `${theme.fg('accent', theme.bold(`${uiText('sheet.recoveryActions')}:`))} ${
        receipt.recoveryActions.length > 0 ? recoveryActionsText(receipt.recoveryActions) : uiText('common.none')
      }`,
    );
  }

  body.push('');
  body.push(theme.fg('dim', uiText('sheet.keys')));
  // Wrap every content line to the panel interior so no tail is lost inside the frame.
  const wrappedBody = body.flatMap((line) => wrapTextWithAnsi(line, Math.max(1, totalWidth - 3)));
  return renderPanel(theme, { title: uiText('sheet.title'), lines: wrappedBody, width: totalWidth });
}

export class TransactionSheetComponent implements Component {
  private closed = false;
  private validationDetailsExpanded = false;

  constructor(
    private readonly model: TransactionSheetModel,
    private readonly theme: TransactionSheetTheme,
    private readonly onContinue: () => void,
    private readonly onCancel: () => void,
    private readonly requestRender: () => void = () => {},
  ) {}

  handleInput(data: string): void {
    if (this.closed) return;
    if (matchesKey(data, 'd') && this.hasCollapsibleValidationDetails()) {
      this.validationDetailsExpanded = !this.validationDetailsExpanded;
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.closed = true;
      this.onContinue();
      return;
    }
    if (
      matchesKey(data, Key.escape)
      || matchesKey(data, 'q')
      || matchesKey(data, Key.ctrl('c'))
    ) {
      this.closed = true;
      this.onCancel();
    }
  }

  render(width: number): string[] {
    return renderTransactionSheet(this.renderModel(), this.theme, width);
  }

  invalidate(): void {}

  private validationPreview(): string[] {
    const details = this.model.details ?? [];
    const verdictAndCounts = details.filter((detail) =>
      detail.startsWith(uiText('verdict.label')) || detail.startsWith(uiText('findings.count.label')));
    return verdictAndCounts.length > 0 ? verdictAndCounts : details.slice(0, 2);
  }

  private hasCollapsibleValidationDetails(): boolean {
    return this.model.step === 'Validation'
      && (this.model.details?.length ?? 0) > this.validationPreview().length;
  }

  private renderModel(): TransactionSheetModel {
    if (!this.hasCollapsibleValidationDetails()) return this.model;
    const details = this.model.details ?? [];
    return {
      ...this.model,
      details: this.validationDetailsExpanded
        ? [...details, uiText('sheet.disclosure.expanded')]
        : [
            ...this.validationPreview(),
            uiText('sheet.disclosure.collapsed', { count: details.length }),
          ],
    };
  }
}

const PLAIN_THEME: TransactionSheetTheme = {
  fg: (_color, text) => text,
  bg: (_token, text) => text,
  bold: (text) => text,
};

export async function openTransactionSheet(
  ctx: Pick<ExtensionCommandContext, 'mode' | 'hasUI' | 'ui'>,
  model: TransactionSheetModel,
): Promise<'continue' | 'cancel'> {
  if (ctx.mode !== 'tui' || !ctx.hasUI) {
    ctx.ui.notify(
      renderTransactionSheet(model, PLAIN_THEME, 80).map(stripTerminalSequences).join('\n'),
      'info',
    );
    return 'continue';
  }

  return ctx.ui.custom<'continue' | 'cancel'>((tui, theme, _keybindings, done) =>
    new TransactionSheetComponent(
      model,
      theme,
      () => done('continue'),
      () => done('cancel'),
      () => tui.requestRender(),
    ),
  );
}
