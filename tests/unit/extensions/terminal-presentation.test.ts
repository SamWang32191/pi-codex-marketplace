import { describe, expect, it } from 'vitest';

import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';

import {
  fitTerminalLine,
  padTerminalLine,
  quoteTerminalText,
  renderBadge,
  renderPanel,
  renderSelectableRow,
  type PresentationTheme,
} from '../../../extensions/pi/terminal-presentation.js';

const identityTheme: PresentationTheme = {
  fg: (_token: string, text: string) => text,
  bg: (_token: string, text: string) => text,
  bold: (text: string) => text,
};

/** Records which semantic token each helper applies; returns text unchanged so width math stays honest. */
function tokenRecorder() {
  const used: string[] = [];
  const theme: PresentationTheme = {
    fg: (token: string, text: string) => {
      used.push(`fg:${token}`);
      return text;
    },
    bg: (token: string, text: string) => {
      used.push(`bg:${token}`);
      return text;
    },
    bold: (text: string) => {
      used.push('bold');
      return text;
    },
  };
  return { theme, used };
}

describe('panel presentation', () => {
  it('draws an exact-width box-drawing panel around content lines', () => {
    const lines = renderPanel(identityTheme, {
      title: 'Global Scope',
      lines: ['rev "12"', 'registrations 2'],
      width: 30,
    });

    // Spec geometry: two border columns; one-cell content inset; title consumes
    // its own cells plus exactly one leading rule on the top border.
    expect(lines[0]).toBe('┌─ Global Scope ' + '─'.repeat(30 - 16 - 1) + '┐');
    expect(lines[1]).toBe('│ rev "12"' + ' '.repeat(28 - 1 - 8) + '│');
    expect(lines[2]).toBe('│ registrations 2' + ' '.repeat(28 - 1 - 15) + '│');
    expect(lines[3]).toBe('└' + '─'.repeat(28) + '┘');
    expect(lines.every((line) => visibleWidth(line) === 30)).toBe(true);
  });

  it('styles borders and titles through theme tokens only', () => {
    const { theme, used } = tokenRecorder();
    renderPanel(theme, { title: 'Project Scope', lines: ['rev "7"'], width: 20 });

    expect(used).toContain('fg:border');
    expect(used).toContain('fg:accent');
    expect(used).toContain('bold');
  });

  it('truncates oversized content and titles to stay inside the frame', () => {
    const lines = renderPanel(identityTheme, {
      title: 'an unreasonably long panel title that cannot fit',
      lines: ['漢字漢字漢字漢字漢字漢字漢字漢字'],
      width: 12,
    });

    expect(lines.every((line) => visibleWidth(line) === 12)).toBe(true);
    expect(stripTerminalSequences(lines.join('\n'))).toContain('an u');
    expect(stripTerminalSequences(lines[1]!)).not.toBe('│ 漢字漢字漢字漢字漢字漢字漢字漢字 │');
  });

  it('keeps ANSI-styled content lines inside the frame width', () => {
    const styled = identityTheme.fg('success', '● Ready');
    const lines = renderPanel(identityTheme, { lines: [styled], width: 16 });
    expect(lines.every((line) => visibleWidth(line) === 16)).toBe(true);
    expect(stripTerminalSequences(lines[1]!)).toBe('│ ● Ready' + ' '.repeat(14 - 1 - 7) + '│');
  });

  it('degrades safely at zero and minimal widths', () => {
    expect(renderPanel(identityTheme, { lines: ['content'], width: 0 })).toEqual(['']);
    const minimal = renderPanel(identityTheme, { title: 'T', lines: ['a'], width: 5 });
    expect(minimal.every((line) => visibleWidth(line) === 5)).toBe(true);
  });
});

describe('badge presentation', () => {
  it.each([
    ['success', 'bg:toolSuccessBg', 'fg:success'],
    ['warning', 'bg:toolPendingBg', 'fg:warning'],
    ['error', 'bg:toolErrorBg', 'fg:error'],
    ['neutral', 'bg:userMessageBg', 'fg:text'],
  ] as const)('renders %s badges with a background token and its text label', (tone, bgToken, fgToken) => {
    const { theme, used } = tokenRecorder();
    renderBadge(theme, tone, 'HEALTHY');

    expect(used).toContain(bgToken);
    expect(used).toContain(fgToken);
  });

  it('keeps badges readable without color through the text label', () => {
    const badge = renderBadge(identityTheme, 'error', 'MAINTENANCE');
    expect(badge).toBe(' MAINTENANCE ');
    expect(visibleWidth(badge)).toBe(13);
  });
});

describe('selection presentation', () => {
  it('marks the selected row with a background wash and a text cursor across the full width', () => {
    const row = renderSelectableRow(identityTheme, {
      selected: true,
      text: 'Register local Marketplace',
      width: 40,
    });

    expect(row.startsWith('> ')).toBe(true);
    expect(visibleWidth(row)).toBe(40);
    expect(row.endsWith(' '.repeat(40 - '> Register local Marketplace'.length))).toBe(true);
  });

  it('applies the selection background token to the padded row', () => {
    const { theme, used } = tokenRecorder();
    renderSelectableRow(theme, { selected: true, text: 'row', width: 10 });

    expect(used).toContain('bg:selectedBg');
  });

  it('leaves unselected rows unhighlighted with a blank cursor column', () => {
    const { theme, used } = tokenRecorder();
    const row = renderSelectableRow(theme, { selected: false, text: 'row', width: 10 });

    expect(used).not.toContain('bg:selectedBg');
    expect(stripTerminalSequences(row).startsWith('  row')).toBe(true);
  });

  it('supports a custom cursor glyph while keeping a textual marker', () => {
    const row = renderSelectableRow(identityTheme, {
      selected: true,
      text: 'Sources',
      width: 12,
      cursor: '▸',
    });
    expect(stripTerminalSequences(row).startsWith('▸ Sources')).toBe(true);
    expect(visibleWidth(row)).toBe(12);
  });

  it('fits hostile oversized row text into the given width', () => {
    const row = renderSelectableRow(identityTheme, {
      selected: true,
      text: quoteTerminalText('x'.repeat(200)),
      width: 20,
    });
    expect(visibleWidth(row)).toBe(20);
  });
});

describe('existing width-safe helpers (regression)', () => {
  it('still quotes, fits, and pads by terminal cell width', () => {
    expect(quoteTerminalText('evil\nrow')).toBe('"evil\\nrow"');
    expect(visibleWidth(fitTerminalLine('漢字abc', 5))).toBe(5);
    expect(padTerminalLine('漢', 5)).toBe('漢   ');
  });
});
