/**
 * Bridge completion seam (#121).
 *
 * Pure root-level autocomplete for `/codex-marketplace` subcommands. This module owns no
 * terminal, TUI, rendering, or Pi host types: its input is the complete argument prefix plus
 * replaceable read-only options, and its output is only the insertion value, display label,
 * and optional description that Pi autocomplete needs — or `null` when the argument prefix is
 * not Bridge-owned syntax.
 *
 * Not owned (#121 scope): state-dependent second-level candidates, arbitrary text, file and
 * path completion. When the module does not own the syntax, callers fall through to Pi's
 * normal behavior unchanged.
 */

export interface CompletionItem {
  /** Insertion value. Argument-taking subcommands carry a trailing space (#121). */
  value: string;
  /** Display label shown in Pi's candidate list. */
  label: string;
  /** Optional short description, matching the command surface's HELP_TEXT vocabulary. */
  description?: string;
}

/**
 * Replaceable read-only options for composing candidates (Bridge State read seam).
 *
 * Root-level (#121) candidates never read Bridge State, so these options have no effect on
 * the current output — the seam exists so state-dependent second-level candidates can be
 * composed passively without ever writing or resetting a damaged document (#119 stories
 * 22–23). The adapter passes them through from registrable sources only.
 */
export interface CompletionReadOptions {
  statePath?: string;
  agentDir?: string;
}

interface RootCommandCandidate {
  label: string;
  description: string;
  /** Whether applying the subcommand expects an argument (inserts a trailing space). */
  takesArgument: boolean;
}

/** The nine root subcommands, descriptions aligned with the command surface's HELP_TEXT vocabulary. */
const ROOT_CANDIDATES: RootCommandCandidate[] = [
  { label: 'add', description: '註冊 marketplace', takesArgument: true },
  { label: 'list', description: '列出 plugins', takesArgument: true },
  { label: 'install', description: '安裝最新版本並立即啟用', takesArgument: true },
  { label: 'update', description: '全部更新', takesArgument: false },
  { label: 'disable', description: '停用 plugin（不再投影）', takesArgument: true },
  { label: 'enable', description: '啟用 plugin（恢復投影）', takesArgument: true },
  { label: 'remove', description: '移除 plugin', takesArgument: true },
  { label: 'forget', description: '移除 marketplace（含其全部安裝）', takesArgument: true },
  { label: 'help', description: '這份說明清單', takesArgument: false },
];

function toItem(candidate: RootCommandCandidate): CompletionItem {
  return {
    value: candidate.takesArgument ? `${candidate.label} ` : candidate.label,
    label: candidate.label,
    description: candidate.description,
  };
}

/** Scoring: earlier first-match wins, then a tighter char span within the label. */
const FIRST_MATCH_WEIGHT = 1000;

/**
 * Case-insensitive non-contiguous fuzzy match: every query character must appear in order
 * within the label. The score prefers earlier first-match position then a tighter span.
 */
function fuzzyScore(query: string, label: string): number | null {
  const q = query.toLowerCase();
  const target = label.toLowerCase();
  let queryIndex = 0;
  let firstMatch = -1;
  let lastMatch = -1;
  for (let i = 0; i < target.length && queryIndex < q.length; i += 1) {
    if (target[i] === q[queryIndex]) {
      if (firstMatch === -1) firstMatch = i;
      lastMatch = i;
      queryIndex += 1;
    }
  }
  if (queryIndex < q.length) return null;
  return firstMatch * FIRST_MATCH_WEIGHT + (lastMatch - firstMatch);
}

/**
 * Compose root-level completion candidates for `/codex-marketplace <argumentPrefix>`.
 *
 * - Empty prefix → all nine root candidates (Pi's exact-command interception surface).
 * - A single token → case-insensitive fuzzy-filtered subcommands; `[]` when nothing matches
 *   (the syntax is still Bridge-owned, there are simply no candidates).
 * - Whitespace-containing prefixes (second-level argument text) are not Bridge-owned in #121 → `null`,
 *   so callers fall through to Pi's own completion unchanged.
 *
 * The module never writes Bridge State; root candidates are derived without reading it at all.
 */
export function completeArguments(
  argumentPrefix: string,
  _options: CompletionReadOptions = {},
): CompletionItem[] | null {
  if (/\s/.test(argumentPrefix)) return null;

  const query = argumentPrefix.trim();
  if (query.length === 0) {
    return ROOT_CANDIDATES.map(toItem);
  }

  const scored: { item: CompletionItem; score: number }[] = [];
  for (const candidate of ROOT_CANDIDATES) {
    const score = fuzzyScore(query, candidate.label);
    if (score !== null) {
      scored.push({ item: toItem(candidate), score });
    }
  }
  scored.sort((a, b) => a.score - b.score || a.item.label.localeCompare(b.item.label));
  return scored.map((entry) => entry.item);
}
