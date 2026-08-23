import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

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
