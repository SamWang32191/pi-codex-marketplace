import type { Theme, ThemeColor } from '@earendil-works/pi-coding-agent';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

/** Structural theme surface used by the presentation contracts; host Pi Theme satisfies it. */
export type PresentationTheme = Pick<Theme, 'fg' | 'bg' | 'bold'>;

/** Background token vocabulary accepted by Theme.bg. */
type ThemeBgToken = Parameters<Theme['bg']>[0];

export function quoteTerminalText(value: unknown): string {
  return JSON.stringify(String(value)).replace(
    /[\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

export function fitTerminalLine(text: string, width: number): string {
  return truncateToWidth(text, Math.max(0, Math.floor(width)));
}

export function padTerminalLine(text: string, width: number): string {
  const terminalWidth = Math.max(0, Math.floor(width));
  const fitted = fitTerminalLine(text, terminalWidth);
  return fitted + ' '.repeat(Math.max(0, terminalWidth - visibleWidth(fitted)));
}

export interface PanelOptions {
  /** Optional panel title rendered into the top border. */
  title?: string;
  /** Pre-styled content lines; each is width-safe padded inside the frame. */
  lines: string[];
  /** Total terminal columns including the two border columns. */
  width: number;
  /** Frame token; defaults to border so panels read as primary containers. */
  borderToken?: Extract<ThemeColor, 'border' | 'borderAccent' | 'borderMuted'>;
}

/**
 * Draws a box-drawing panel (`┌─ Title ─┐ … └──────┘`) exactly `width` columns wide.
 * Borders and the title are styled with theme tokens only; content lines keep their own styling.
 */
export function renderPanel(theme: PresentationTheme, options: PanelOptions): string[] {
  const width = Math.max(0, Math.floor(options.width));
  const border = options.borderToken ?? 'border';
  const frame = (text: string): string => theme.fg(border, text);
  if (width < 3) {
    return [padTerminalLine(options.lines.join(''), width)];
  }
  const innerWidth = width - 2;
  let topFill = innerWidth;
  let titleCell = '';
  if (options.title !== undefined && innerWidth >= 4) {
    titleCell = fitTerminalLine(` ${String(options.title)} `, innerWidth - 2);
    topFill = innerWidth - visibleWidth(titleCell) - 1;
  }
  const lines = [
    frame('┌') + frame('─') + theme.fg('accent', theme.bold(titleCell)) + frame('─'.repeat(Math.max(0, topFill))) + frame('┐'),
    ...options.lines.map((line) => frame('│') + ' ' + padTerminalLine(line, innerWidth - 1) + frame('│')),
    frame('└') + frame('─'.repeat(innerWidth)) + frame('┘'),
  ];
  return lines.map((line) => truncateToWidth(line, width));
}

/** Semantic badge tones mapped onto existing host background tokens. */
export type BadgeTone = 'success' | 'warning' | 'error' | 'neutral';

const BADGE_BG_TOKENS: Record<BadgeTone, ThemeBgToken> = {
  success: 'toolSuccessBg',
  warning: 'toolPendingBg',
  error: 'toolErrorBg',
  neutral: 'userMessageBg',
};

const BADGE_FG_TOKENS: Record<BadgeTone, ThemeColor> = {
  success: 'success',
  warning: 'warning',
  error: 'error',
  neutral: 'text',
};

/**
 * Renders a text-labelled background badge. The label is load-bearing: meaning must
 * survive without color, so badges always carry their canonical word.
 */
export function renderBadge(theme: PresentationTheme, tone: BadgeTone, label: string): string {
  return theme.bg(
    BADGE_BG_TOKENS[tone],
    theme.fg(BADGE_FG_TOKENS[tone], ` ${label} `),
  );
}

/**
 * Renders two framed panels side by side inside `totalWidth`, equalizing their
 * heights by padding the shorter content so both frames bottom-align.
 */
export function renderSideBySidePanels(
  theme: PresentationTheme,
  options: { left: PanelOptions; right: PanelOptions; totalWidth: number; gutter?: string },
): string[] {
  const gutter = options.gutter ?? '  ';
  const leftWidth = Math.max(3, Math.floor(options.left.width));
  const rightWidth = Math.max(3, options.totalWidth - gutter.length - leftWidth);
  const height = Math.max(options.left.lines.length, options.right.lines.length);
  const padToHeight = (lines: string[]): string[] => [
    ...lines,
    ...Array.from({ length: height - lines.length }, () => ''),
  ];
  const leftFrame = renderPanel(theme, { ...options.left, lines: padToHeight(options.left.lines), width: leftWidth });
  const rightFrame = renderPanel(theme, { ...options.right, lines: padToHeight(options.right.lines), width: rightWidth });
  return Array.from({ length: Math.max(leftFrame.length, rightFrame.length) }, (_, index) =>
    padTerminalLine(leftFrame[index] ?? '', leftWidth) +
    gutter +
    padTerminalLine(rightFrame[index] ?? '', rightWidth));
}

export interface SelectableRowOptions {
  selected: boolean;
  /** Pre-styled row text (may already contain theme sequences). */
  text: string;
  width: number;
  /** Textual cursor glyph; defaults to '>' so selection survives without color. */
  cursor?: string;
}

/**
 * Renders one selectable row. Selected rows combine a full-width selected background
 * wash with a leading text cursor glyph; unselected rows stay unhighlighted but keep
 * the cursor column for scanning. The result is exactly `width` columns wide.
 */
export function renderSelectableRow(theme: PresentationTheme, options: SelectableRowOptions): string {
  const cursor = options.cursor ?? '>';
  const marker = options.selected ? cursor : ' ';
  const content = `${marker} ${options.text}`;
  return options.selected
    ? theme.bg('selectedBg', padTerminalLine(content, Math.max(0, Math.floor(options.width))))
    : padTerminalLine(content, Math.max(0, Math.floor(options.width)));
}
