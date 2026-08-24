import { describe, expect, it } from 'vitest';

import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';

import {
  fitTerminalLine,
  padTerminalLine,
  quoteTerminalText,
} from '../../../extensions/pi/terminal-presentation.js';
import {
  TRANSACTION_STEPS,
  TransactionSheetComponent,
  openTransactionSheet,
  renderTransactionSheet,
  type TransactionSheetModel,
} from '../../../extensions/pi/transaction-sheet.js';
import { transactionStepLabel, uiText, verdictText } from '../../../extensions/pi/ui-strings.js';
import type { AttemptReceipt, AttemptSummary } from '../../../src/registration/receipt.js';

const identityTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_token: string, text: string) => text,
  bold: (text: string) => text,
};

function receipt(summary: AttemptSummary = 'Pending Application'): AttemptReceipt {
  return {
    id: 'rcpt_123',
    kind: 'Lifecycle Operation',
    operation: 'Plugin Installation',
    scope: 'project',
    trigger: 'user request',
    startedAt: '2026-08-23T00:00:00.000Z',
    completedAt: '2026-08-23T00:00:01.000Z',
    expectedStateRevision: '4',
    targetStateRevision: '5',
    observedStateRevision: '5',
    validationSnapshot: 'snapshot-5',
    durableOutcome: 'committed',
    findings: [{
      code: 'COLLISION-01',
      classification: 'notice',
      phase: 'post-commit',
      target: 'skill',
      scope: 'project',
      pointer: '/skills/build',
      rule: 'COLLISION-01',
      outcome: 'skill availability needs inspection',
    }],
    runtimeOutcome: 'pending-application',
    summary,
    recoveryActions: ['Retry Application', 'Inspect'],
    stateChanged: true,
    createdAt: '2026-08-23T00:00:01.000Z',
  };
}

describe('Transaction Sheet presentation', () => {
  it('renders the fixed six-step sequence in order with a textual active marker', () => {
    const model: TransactionSheetModel = {
      step: 'Validation',
      actionLabel: 'Register marketplace',
      authority: 'global',
      stateRevision: '18',
      validationSnapshot: 'snapshot-18',
    };

    const output = renderTransactionSheet(model, identityTheme, 80).join('\n');
    expect(TRANSACTION_STEPS).toEqual(['Intent', 'Validation', 'Consent', 'Plan', 'Commit', 'Receipt']);

    // Canonical step ids stay stable internally; presentation labels are zh_TW.
    const positions = TRANSACTION_STEPS.map((step, index) => output.indexOf(`${index + 1} ${transactionStepLabel(step)}`));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(output).toContain(`▸ 2 ${transactionStepLabel('Validation')}（${uiText('step.activeSuffix')}）`);
    expect(output).toContain(`✓ 1 ${transactionStepLabel('Intent')}`);
    expect(output).not.toContain('[1 意圖] ->');
    expect(output).toContain('授權範圍: "[G] Global Scope"');
    expect(output).toContain('State Revision: "18"');
    expect(output).toContain('Validation Snapshot: "snapshot-18"');
    expect(renderTransactionSheet(model, identityTheme, 80).every((line) => visibleWidth(line) <= 80)).toBe(true);
  });

  it('frames the sheet in a box-drawing panel at every width without overflow', () => {
    const model: TransactionSheetModel = {
      step: 'Commit',
      actionLabel: 'Enable plugin',
      authority: 'project',
    };

    for (const width of [120, 80, 60]) {
      const lines = renderTransactionSheet(model, identityTheme, width);
      expect(lines[0]).toContain('┌─ Transaction Sheet');
      expect(lines.at(-1)).toContain('┘');
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      expect(lines.join('\n')).toContain(`5 ${transactionStepLabel('Commit')}（${uiText('step.activeSuffix')}）`);
    }
  });

  it.each<[AttemptSummary, 'success' | 'error' | 'warning']>([
    ['Completed', 'success'],
    ['Blocked', 'error'],
    ['Pending Application', 'warning'],
  ])("pairs Attempt Summary %s with a %s tone badge", (summary, tone) => {
    const tokens: string[] = [];
    const spyingTheme = {
      ...identityTheme,
      bg: (token: string, text: string) => {
        tokens.push(token);
        return text;
      },
    };
    const output = renderTransactionSheet({
      step: 'Receipt',
      actionLabel: 'Lifecycle operation',
      receipt: { ...receipt(summary), recoveryActions: [] },
    }, spyingTheme, 60).join('\n');
    expect(output).toContain(`Attempt Summary: "${summary}"（`);
    expect(tokens).toContain(`tool${tone === 'success' ? 'Success' : tone === 'error' ? 'Error' : 'Pending'}Bg`);
    expect(renderTransactionSheet({
      step: 'Receipt',
      actionLabel: 'Lifecycle operation',
      receipt: { ...receipt(summary), recoveryActions: [] },
    }, identityTheme, 60).join('\n')).toContain(summary);
  });

  it('quotes terminal-controlled text and fits or pads by terminal cell width', () => {
    const quoted = quoteTerminalText('evil\nrow\t\x1b[31m\u202eright-to-left"');
    expect(quoted).toBe('"evil\\nrow\\t\\u001b[31m\\u202eright-to-left\\\""');
    expect(quoted).not.toMatch(/[\n\r\t\x1b\u202e]/);

    const fitted = fitTerminalLine('漢字abc', 5);
    expect(stripTerminalSequences(fitted)).toBe('漢...');
    expect(visibleWidth(fitted)).toBe(5);
    const padded = padTerminalLine('漢', 5);
    expect(padded).toBe('漢   ');
    expect(visibleWidth(padded)).toBe(5);
  });

  it.each([120, 80])('presents Receipt durable, findings, and runtime axes side by side at width %i', (width) => {
    const lines = renderTransactionSheet({
      step: 'Receipt',
      actionLabel: 'Install and Enable',
      authority: 'project',
      target: 'acme/build-tools',
      stateRevision: '5',
      validationSnapshot: 'snapshot-5',
      details: ['Activation Confirmation accepted'],
      receipt: receipt(),
    }, identityTheme, width);

    const axisHeader = lines.find((line) => line.includes(uiText('sheet.axis.durable')) && line.includes(uiText('sheet.axis.findings')) && line.includes(uiText('sheet.axis.runtime')));
    expect(axisHeader).toBeDefined();
    expect(axisHeader!.indexOf(uiText('sheet.axis.durable'))).toBeLessThan(axisHeader!.indexOf(uiText('sheet.axis.findings')));
    expect(axisHeader!.indexOf(uiText('sheet.axis.findings'))).toBeLessThan(axisHeader!.indexOf(uiText('sheet.axis.runtime')));
    expect(lines.join('\n')).toContain('Attempt Summary: "Pending Application"');
    expect(lines.join('\n')).toContain('"Retry Application"（重試運行時套用）');
    expect(lines.join('\n')).toContain('"Inspect"（檢視）');
    expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
  });

  it('stacks Receipt durable, findings, and runtime axes in order at width 60', () => {
    const lines = renderTransactionSheet({
      step: 'Receipt',
      actionLabel: 'Install and Enable',
      authority: 'project',
      stateRevision: '5',
      validationSnapshot: 'snapshot-5',
      receipt: receipt(),
    }, identityTheme, 60);
    const axisLines = lines.map((line) => stripTerminalSequences(line));
    const headers = [uiText('sheet.axis.durable'), uiText('sheet.axis.findings'), uiText('sheet.axis.runtime')];
    const positions = headers.map((header) =>
      axisLines.findIndex((line) => line.includes(header)));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(lines.every((line) => visibleWidth(line) <= 60)).toBe(true);
  });

  it('renders Receipt Findings in the canonical class-phase-target-pointer-rule order', () => {
    const unordered = receipt();
    unordered.findings = [
      unordered.findings[0]!,
      {
        code: 'ADMISSION-01',
        classification: 'blocking',
        phase: 'admission',
        target: 'attempt',
        scope: 'project',
        pointer: '',
        rule: 'ADMISSION-01',
        outcome: 'denied',
      },
    ];

    const output = renderTransactionSheet({
      step: 'Receipt',
      actionLabel: 'Lifecycle operation',
      receipt: unordered,
    }, identityTheme, 60).join('\n');

    expect(output.indexOf('[blocking]')).toBeLessThan(output.indexOf('[notice]'));
  });

  it.each<AttemptSummary>([
    'Completed',
    'Completed with diagnostics',
    'Declined',
    'Blocked',
    'Rejected as Stale',
    'Persistence Failed',
    'Persistence Indeterminate',
    'Pending Application',
  ])('preserves the closed Attempt Summary value %s', (summary) => {
    const output = renderTransactionSheet({
      step: 'Receipt',
      actionLabel: 'Lifecycle operation',
      receipt: { ...receipt(summary), recoveryActions: [] },
    }, identityTheme, 60).join('\n');
    expect(output).toContain(`Attempt Summary: "${summary}"`);
    expect(output).toContain(`${uiText('sheet.recoveryActions')}: ${uiText('common.none')}`);
  });

  it.each([120, 80, 60])('prevents malicious terminal text from forging rows or exceeding width %i', (width) => {
    const malicious = `safe\nForged Row\t\x1b[31m${'漢'.repeat(100)}`;
    const hostileReceipt = receipt();
    hostileReceipt.operation = malicious;
    hostileReceipt.findings = [{ ...hostileReceipt.findings[0]!, outcome: malicious }];
    const lines = renderTransactionSheet({
      step: 'Receipt',
      actionLabel: malicious,
      target: malicious,
      details: [malicious],
      receipt: hostileReceipt,
    }, identityTheme, width);
    const output = lines.join('\n');

    expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    expect(lines.some((line) => line.trimStart().startsWith('Forged Row'))).toBe(false);
    expect(output).not.toContain('\x1b[31m');
    expect(output).not.toContain('\t');
    expect(output).toContain('\\n');
    expect(output).toContain('\\t');
    expect(output).toContain('\\u001b');
  });

  it.each([120, 80, 60])('wraps long disclosure details without losing their tail at width %i', (width) => {
    const lines = renderTransactionSheet({
      step: 'Validation',
      actionLabel: 'Inspect candidate',
      details: [`${'validation-detail-'.repeat(20)}DETAIL-END`],
    }, identityTheme, width);

    expect(lines.join('\n')).toContain('DETAIL-END');
    expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
  });

  it.each([
    ['Enter', '\r', 'continue'],
    ['Escape', '\x1b', 'cancel'],
    ['q', 'q', 'cancel'],
    ['Ctrl-C', '\x03', 'cancel'],
  ] as const)('%s closes the component with %s', (_label, input, expected) => {
    const results: string[] = [];
    const component = new TransactionSheetComponent(
      { step: 'Intent', actionLabel: 'Register marketplace' },
      identityTheme,
      () => results.push('continue'),
      () => results.push('cancel'),
    );

    component.handleInput(input);
    component.handleInput(input);
    expect(results).toEqual([expected]);
    expect(component.render(60).some((line) => line.includes(`1 ${transactionStepLabel('Intent')}`))).toBe(true);
  });

  it('starts Validation with verdict/counts and toggles the full disclosure with d', () => {
    const results: string[] = [];
    let renderRequests = 0;
    const component = new TransactionSheetComponent(
      {
        step: 'Validation',
        actionLabel: 'Inspect candidate',
        details: [
          'Source /marketplace',
          `${uiText('verdict.label')}：${verdictText('Blocked')}`,
          `${uiText('findings.count.label')}：${uiText('findings.count.line', { blocking: 0, warning: 1, notice: 0 })}`,
          'FULL-DISCLOSURE-TAIL',
        ],
      },
      identityTheme,
      () => results.push('continue'),
      () => results.push('cancel'),
      () => { renderRequests += 1; },
    );

    const collapsed = component.render(60).join('\n');
    expect(collapsed).toContain(`${uiText('verdict.label')}：${verdictText('Blocked')}`);
    expect(collapsed).toContain(uiText('findings.count.line', { blocking: 0, warning: 1, notice: 0 }));
    expect(collapsed).toContain(uiText('sheet.disclosure.collapsed', { count: 4 }).split('；')[0]!);
    expect(collapsed).not.toContain('FULL-DISCLOSURE-TAIL');

    component.handleInput('d');
    const expanded = component.render(60).join('\n');
    expect(expanded).toContain('FULL-DISCLOSURE-TAIL');
    // At 60 columns the hint may wrap inside the panel frame; both fragments must survive.
    expect(expanded).toContain(uiText('sheet.disclosure.expanded'));
    expect(results).toEqual([]);
    expect(renderRequests).toBe(1);
  });

  it.each([
    ['\r', 'continue'],
    ['\x1b', 'cancel'],
  ] as const)('opens a TUI custom sheet and resolves %s from its keyboard result', async (input, expected) => {
    let rendered: string[] = [];
    const ui = {
      custom: async (factory: (...args: any[]) => any) => new Promise((resolve) => {
        Promise.resolve(factory({}, identityTheme, {}, resolve)).then((component) => {
          rendered = component.render(60);
          component.handleInput(input);
        });
      }),
      notify: () => undefined,
    };
    const result = await openTransactionSheet(
      { mode: 'tui', hasUI: true, ui } as unknown as Parameters<typeof openTransactionSheet>[0],
      { step: 'Consent', actionLabel: 'Enable plugin' },
    );

    expect(result).toBe(expected);
    expect(rendered.some((line) => line.includes(transactionStepLabel('Consent')))).toBe(true);
  });

  it('uses escaped notification text and continues when custom TUI is unavailable', async () => {
    let notification = '';
    const result = await openTransactionSheet({
      mode: 'print',
      hasUI: false,
      ui: {
        custom: () => { throw new Error('custom should not be called'); },
        notify: (message: string) => { notification = message; },
      },
    } as unknown as Parameters<typeof openTransactionSheet>[0], {
      step: 'Intent',
      actionLabel: `safe\nForged Row\t\x1b[31m${'漢'.repeat(100)}`,
    });

    expect(result).toBe('continue');
    expect(notification.split('\n').some((line) => line.startsWith('Forged Row'))).toBe(false);
    expect(notification).toContain('\\n');
    expect(notification).toContain('\\t');
    expect(notification).toContain('\\u001b');
    expect(notification).not.toContain('\x1b');
  });
});
