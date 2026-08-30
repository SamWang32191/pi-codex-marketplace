import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { completeArguments } from '../../../src/bridge/completion.js';
import { HELP_TEXT } from '../../../src/bridge/command.js';

const ROOT_LABELS = ['add', 'list', 'install', 'update', 'disable', 'enable', 'remove', 'forget', 'help'];

/** Parse the command surface's canonical description per subcommand out of HELP_TEXT. */
function helpDescriptions(): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of HELP_TEXT.split('\n')) {
    const match = line.match(/^ {2}([a-z-]+)(?: .*?)?\s{2,}(.+)$/);
    if (match) map.set(match[1], match[2].trim());
  }
  return map;
}

describe('Bridge completion seam (#121)', () => {
  it('returns all nine root candidates with descriptions for an empty argument prefix', () => {
    const result = completeArguments('');

    expect(result).not.toBeNull();
    expect(result!.map((item) => item.label)).toEqual(ROOT_LABELS);
    expect(result!.every((item) => typeof item.description === 'string' && item.description.length > 0)).toBe(true);
  });

  it('narrows the list with case-insensitive fuzzy matching', () => {
    const mixedCase = completeArguments('INSTL');
    expect(mixedCase!.map((item) => item.label)).toEqual(['install']);

    const lower = completeArguments('dis');
    expect(lower!.map((item) => item.label)).toEqual(['disable']);
  });

  it('narrows the list with non-contiguous fuzzy matching', () => {
    const result = completeArguments('istl');
    expect(result!.map((item) => item.label)).toEqual(['install']);
  });

  it('keeps a trailing space in the insertion value of argument-taking subcommands', () => {
    const result = completeArguments('add');
    expect(result![0].value).toBe('add ');

    const all = completeArguments('');
    const argTaking = all!.filter((item) => ['add', 'list', 'install', 'disable', 'enable', 'remove', 'forget'].includes(item.label));
    for (const item of argTaking) {
      expect(item.value.endsWith(' ')).toBe(true);
      expect(item.value).toBe(item.label + ' ');
    }
  });

  it('inserts no trailing space for update and help', () => {
    const update = completeArguments('upd');
    expect(update![0].value).toBe('update');

    const help = completeArguments('he');
    expect(help![0].value).toBe('help');
  });

  it('returns an empty list when no subcommand fuzzy-matches', () => {
    expect(completeArguments('zzz')).toEqual([]);
  });

  it('returns null when the argument prefix is not Bridge-owned syntax', () => {
    // Second-level argument text is out of scope for #121 — Bridge must not own it.
    expect(completeArguments('install my-plugin')).toBeNull();
    expect(completeArguments('list ')).toBeNull();
  });

  it('mirrors the command surface description vocabulary without drift', () => {
    const canonical = helpDescriptions();
    expect([...canonical.keys()].sort()).toEqual([...ROOT_LABELS].sort());

    for (const item of completeArguments('')!) {
      expect(canonical.get(item.label)).toBe(item.description);
    }
  });

  it('is passive: composing candidates never writes or resets a damaged Bridge State document', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'bridge-completion-passive-'));
    try {
      const statePath = join(tmpDir, 'state.json');
      const damaged = 'INVALID JSON CONTENT';
      writeFileSync(statePath, damaged, 'utf-8');

      const result = completeArguments('', { statePath });

      expect(result).not.toBeNull();
      // The damaged document must survive untouched — autocomplete is read-only (#119 22–23).
      expect(readFileSync(statePath, 'utf-8')).toBe(damaged);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
