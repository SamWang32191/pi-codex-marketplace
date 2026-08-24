import type { ExtensionCommandContext, Theme } from '@earendil-works/pi-coding-agent';
import {
  Key,
  matchesKey,
  stripTerminalSequences,
  wrapTextWithAnsi,
  type Component,
} from '@earendil-works/pi-tui';

import type { Scope } from '../../src/bridge-state/types.js';
import { sortFindings } from '../../src/registration/findings.js';
import type { AttemptReceipt, AttemptSummary } from '../../src/registration/receipt.js';
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
  authority?: Scope;
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

function authorityLabel(scope: Scope): string {
  return scope === 'global' ? '[G] GLOBAL' : '[P] PROJECT';
}

function receiptAxes(receipt: AttemptReceipt, theme: TransactionSheetTheme): [string[], string[], string[]] {
  const orderedFindings = sortFindings(receipt.findings);
  const classifications = {
    blocking: orderedFindings.filter((finding) => finding.classification === 'blocking').length,
    warning: orderedFindings.filter((finding) => finding.classification === 'warning').length,
    notice: orderedFindings.filter((finding) => finding.classification === 'notice').length,
  };
  const durable = [
    theme.fg('accent', theme.bold('Durable')),
    field(theme, 'Outcome', receipt.durableOutcome),
    field(theme, 'Expected revision', receipt.expectedStateRevision),
    ...(receipt.targetStateRevision === undefined ? [] : [field(theme, 'Target revision', receipt.targetStateRevision)]),
    ...(receipt.observedStateRevision === undefined ? [] : [field(theme, 'Observed revision', receipt.observedStateRevision)]),
    field(theme, 'State changed', receipt.stateChanged ? 'yes' : 'no'),
  ];
  const findings = [
    theme.fg('accent', theme.bold('Findings')),
    field(theme, 'Count', orderedFindings.length),
    field(theme, 'Blocking', classifications.blocking),
    field(theme, 'Warning', classifications.warning),
    field(theme, 'Notice', classifications.notice),
    ...orderedFindings.map((finding) =>
      `${theme.fg('warning', `[${finding.classification}]`)} ${quoteTerminalText(finding.code)} ${quoteTerminalText(finding.rule)}: ${quoteTerminalText(finding.outcome)}${finding.pointer ? ` @${quoteTerminalText(finding.pointer)}` : ''}`,
    ),
  ];
  const runtime = [
    theme.fg('accent', theme.bold('Runtime')),
    field(theme, 'Outcome', receipt.runtimeOutcome),
    field(theme, 'Receipt', receipt.id),
    field(theme, 'Kind', receipt.kind),
    field(theme, 'Operation', receipt.operation),
    field(theme, 'Trigger', receipt.trigger),
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

/** Stage indicator cells: done ✓, active ▸ … ACTIVE, pending numbered. */
function stageSegments(theme: TransactionSheetTheme, step: TransactionStep): string[] {
  const activeIndex = TRANSACTION_STEPS.indexOf(step);
  return TRANSACTION_STEPS.map((name, index) => {
    if (index < activeIndex) return theme.fg('success', `✓ ${index + 1} ${name}`);
    if (index === activeIndex) {
      return theme.fg('accent', theme.bold(`▸ ${index + 1} ${name} ACTIVE`));
    }
    return theme.fg('muted', `${index + 1} ${name}`);
  });
}

function stageRows(theme: TransactionSheetTheme, step: TransactionStep, width: number): string[] {
  const segments = stageSegments(theme, step);
  const connector = theme.fg('borderMuted', ' ─ ');
  return [segments.slice(0, 3), segments.slice(3)].flatMap((row) =>
    wrapTextWithAnsi(row.join(connector), Math.max(1, width)));
}

const SUMMARY_TONES: Record<AttemptSummary, { tone: BadgeTone; label: string }> = {
  'Completed': { tone: 'success', label: 'COMPLETED' },
  'Completed with diagnostics': { tone: 'warning', label: 'DIAGNOSTICS' },
  'Declined': { tone: 'warning', label: 'DECLINED' },
  'Blocked': { tone: 'error', label: 'BLOCKED' },
  'Rejected as Stale': { tone: 'warning', label: 'STALE' },
  'Persistence Failed': { tone: 'error', label: 'PERSISTENCE FAILED' },
  'Persistence Indeterminate': { tone: 'error', label: 'INDETERMINATE' },
  'Pending Application': { tone: 'warning', label: 'PENDING' },
};

export function renderTransactionSheet(
  model: TransactionSheetModel,
  theme: TransactionSheetTheme,
  width: number,
): string[] {
  const totalWidth = Math.max(4, Math.floor(width));
  const innerWidth = Math.max(1, totalWidth - 3);
  const receipt = model.receipt;
  const authority = model.authority ?? receipt?.scope;
  const stateRevision = model.stateRevision ?? receipt?.observedStateRevision ?? receipt?.expectedStateRevision;
  const validationSnapshot = model.validationSnapshot ?? receipt?.validationSnapshot;
  const body: string[] = [
    ...stageRows(theme, model.step, innerWidth),
    '',
    field(theme, 'Action', model.actionLabel),
    ...(authority === undefined ? [] : [field(theme, 'Authority', authorityLabel(authority))]),
    ...(model.target === undefined ? [] : [field(theme, 'Target', model.target)]),
    ...(stateRevision === undefined ? [] : [field(theme, 'State Revision', stateRevision)]),
    ...(validationSnapshot === undefined ? [] : [field(theme, 'Validation Snapshot', validationSnapshot)]),
    ...(model.details ?? []).map((detail) => field(theme, 'Detail', detail)),
  ];

  if (receipt) {
    body.push('');
    const axes = receiptAxes(receipt, theme);
    body.push(...(innerWidth >= 64 ? renderWideAxes(axes, theme, innerWidth) : renderStackedAxes(axes, innerWidth)));
    body.push('');
    const summaryTone = SUMMARY_TONES[receipt.summary];
    body.push(
      `${theme.fg('accent', theme.bold('Attempt Summary:'))} ${quoteTerminalText(receipt.summary)} ` +
        renderBadge(theme, summaryTone.tone, summaryTone.label),
    );
    body.push(
      `${theme.fg('accent', theme.bold('Recovery Actions:'))} ${
        receipt.recoveryActions.length > 0
          ? receipt.recoveryActions.map((action) => quoteTerminalText(action)).join(', ')
          : 'none'
      }`,
    );
  }

  body.push('');
  body.push(theme.fg('dim', 'Enter: continue | Esc/q/Ctrl-C: cancel'));
  // Wrap every content line to the panel interior so no tail is lost inside the frame.
  const wrappedBody = body.flatMap((line) => wrapTextWithAnsi(line, Math.max(1, totalWidth - 3)));
  return renderPanel(theme, { title: 'Transaction Sheet', lines: wrappedBody, width: totalWidth });
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
      /^Verdict(?:\s|:)/.test(detail) || /^Findings(?:\s|:)/.test(detail));
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
        ? [...details, 'Full Validation Disclosure expanded (press d to collapse)']
        : [
            ...this.validationPreview(),
            `Full Validation Disclosure collapsed (${details.length} lines; press d to expand)`,
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
