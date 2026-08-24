import { describe, expect, it } from 'vitest';

import {
  attemptSummaryGloss,
  attemptSummaryText,
  closedValue,
  findingOutcomeText,
  recoveryActionGloss,
  recoveryActionText,
  transactionStepLabel,
  uiText,
  verdictText,
} from '../../../extensions/pi/ui-strings.js';

describe('centralized zh_TW presentation strings', () => {
  it('resolves message ids from the active locale dictionary', () => {
    expect(uiText('common.yes')).toBe('是');
    expect(uiText('common.no')).toBe('否');
  });

  it('interpolates {param} placeholders and keeps unknown placeholders loud', () => {
    expect(uiText('ledger.rail.registrations', { count: 3 })).toBe('Registration 3');
    expect(uiText('cmd.state.ok', {
      scope: 'Global Scope',
      revision: '12',
      registrations: 1,
      enabled: 2,
      disabled: 0,
    })).toBe('Global Scope：State Revision 12 · Registration 1 · 啟用 Installation 2 / 停用 0');
    expect(uiText('ledger.rail.registrations', { unrelated: 1 })).toContain('{count}');
  });

  it('pairs closed Attempt Summary values canonical-first with zh_TW glosses', () => {
    expect(attemptSummaryText('Blocked')).toBe('Blocked（受阻）');
    expect(attemptSummaryText('Pending Application')).toBe('Pending Application（待套用）');
    expect(attemptSummaryGloss('Declined')).toBe('已婉拒');
  });

  it('falls back to the canonical value when an unknown Attempt Summary arrives', () => {
    const forged = 'Blocked\nFORGED-RECEIPT' as never;
    expect(attemptSummaryText(forged)).toBe('Blocked\nFORGED-RECEIPT');
    expect(attemptSummaryGloss(forged)).toBe('');
  });

  it('pairs Recovery Action closed values canonical-first with zh_TW glosses', () => {
    expect(recoveryActionText('Retry Application')).toBe('Retry Application（重試運行時套用）');
    expect(recoveryActionGloss('Repair State')).toBe('修復 Bridge State');
  });

  it('renders validation verdicts canonical-first and stage labels in zh_TW', () => {
    expect(verdictText('Passed with diagnostics')).toBe('Passed with diagnostics（通過但有診斷）');
    expect(transactionStepLabel('Intent')).toBe('意圖');
    expect(transactionStepLabel('Receipt')).toBe('收據');
  });

  it('maps domain findings to zh_TW copy by stable rule code at the presentation boundary', () => {
    expect(findingOutcomeText({
      rule: 'BUDG-01',
      outcome: 'Validation Budget exceeded: catalog 999999 bytes > 200000',
    })).toBe('超出 Validation Budget 上限');
    expect(findingOutcomeText({ rule: 'CONT-01', outcome: 'path escapes root' }))
      .toBe('宣告路徑逸出其所屬根目錄（Contained Path 違規）');
  });

  it('falls back to the canonical outcome text for rules outside the dictionary', () => {
    expect(findingOutcomeText({ rule: 'TEST-99', outcome: 'unmapped diagnostic' }))
      .toBe('unmapped diagnostic');
  });

  it('composes canonical-first closed values through one helper', () => {
    expect(closedValue('Enabled', '已啟用')).toBe('Enabled（已啟用）');
  });
});
