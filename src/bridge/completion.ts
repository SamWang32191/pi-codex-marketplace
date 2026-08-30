/**
 * Bridge completion seam (#121, #122).
 *
 * Pure autocomplete for `/codex-marketplace`: root-level subcommands (#121) plus
 * state-aware second-level `install` candidates (#122). This module owns no terminal, TUI,
 * rendering, or Pi host types: its input is the complete argument prefix plus replaceable
 * read-only options, and its output is only the insertion value, display label, and optional
 * description that Pi autocomplete needs — or `null` when the argument prefix is not
 * Bridge-owned syntax.
 *
 * Not owned: second-level candidates for subcommands other than `install`, arbitrary text,
 * file and path completion. When the module does not own the syntax, callers fall through to
 * Pi's normal behavior unchanged.
 */

import { queryMarketplacePlugins, type MarketplacePluginInstallationState } from './plugin-query.js';
import { readMinimalBridgeStatePassive, type MinimalBridgeState } from './state.js';

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
 * Root-level (#121) candidates never read Bridge State; state-aware `install` candidates
 * (#122) read it passively through `readMinimalBridgeStatePassive`, so a damaged document is
 * never written, reset, or repaired (#119 stories 22–23). The adapter passes them through
 * from registrable sources only.
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
 * The owned second-level syntax: `install` followed by whitespace and a single-token query
 * (plugin names are lowercase kebab-case; a second token is not Bridge-owned and falls
 * through). `install` without a trailing space stays at the root level so the trailing-space
 * root candidate can be applied first.
 */
const INSTALL_SECOND_LEVEL_RE = /^install\s+(\S*)$/;

/** Status vocabulary aligned with the `list` command surface (#90). */
function installStatusLabel(state: MarketplacePluginInstallationState): string {
  if (state === 'enabled') return '已裝啟用';
  if (state === 'disabled') return '已裝停用';
  return '可安裝';
}

interface InstallCandidate {
  /** Marketplace provenance shown in the candidate description. */
  marketplaceName: string;
  /** 可安裝 / 已裝啟用 / 已裝停用 — install and reinstall are both selectable. */
  status: string;
  /** Case-insensitive fuzzy search target: plugin name + marketplace provenance. */
  searchText: string;
  /** Insertion token: the name when unique in the full enumeration, else the enumeration number. */
  insertion: string;
}

/**
 * Compose install candidates from the shared Marketplace Plugin enumeration, restricted to
 * structurally installable entries. Unavailable Entries (unsupported source, unresolvable
 * source, invalid plugin, identity collision) never become candidates.
 *
 * Name uniqueness is judged against the *full* enumeration — the same domain `install <名稱>`
 * resolves against, so a same-named sibling that is unavailable still forces the number
 * insertion (the name would otherwise be rejected as ambiguous). The number is the plugin's
 * number in that full enumeration, matching `list` and `install <編號>` exactly.
 */
function composeInstallCandidates(state: MinimalBridgeState, options: CompletionReadOptions): InstallCandidate[] {
  const { plugins } = queryMarketplacePlugins(state, { agentDir: options.agentDir });
  const nameCounts = new Map<string, number>();
  for (const plugin of plugins) {
    nameCounts.set(plugin.candidateName, (nameCounts.get(plugin.candidateName) ?? 0) + 1);
  }

  const candidates: InstallCandidate[] = [];
  for (const plugin of plugins) {
    if (!plugin.structurallyInstallable) continue;
    const unique = (nameCounts.get(plugin.candidateName) ?? 0) === 1;
    candidates.push({
      marketplaceName: plugin.marketplaceName,
      status: installStatusLabel(plugin.installationState),
      searchText: `${plugin.candidateName} ${plugin.marketplaceName}`,
      insertion: unique ? plugin.candidateName : String(plugin.number),
    });
  }
  return candidates;
}

function toInstallItem(candidate: InstallCandidate): CompletionItem {
  return {
    value: `install ${candidate.insertion}`,
    label: candidate.insertion,
    description: `[${candidate.marketplaceName}] ${candidate.status}`,
  };
}

/**
 * Second-level `install` candidates for `/codex-marketplace install <query>`.
 *
 * - Empty query → every currently installable or reinstallable plugin in enumeration order.
 * - A query → case-insensitive fuzzy match over the plugin name and Marketplace provenance;
 *   `[]` when nothing matches (the syntax is still Bridge-owned, there are simply no
 *   candidates).
 *
 * The Bridge State read is passive: empty, damaged, unreadable, or incompatible state or
 * marketplace material contributes no candidates and is never written, reset, or repaired.
 */
function completeInstallArguments(query: string, options: CompletionReadOptions): CompletionItem[] {
  const state = readMinimalBridgeStatePassive({ statePath: options.statePath, agentDir: options.agentDir });
  const candidates = composeInstallCandidates(state, options);
  if (query.length === 0) {
    return candidates.map(toInstallItem);
  }
  const scored: { item: CompletionItem; score: number }[] = [];
  for (const candidate of candidates) {
    const score = fuzzyScore(query, candidate.searchText);
    if (score !== null) {
      scored.push({ item: toInstallItem(candidate), score });
    }
  }
  scored.sort((a, b) => a.score - b.score || a.item.label.localeCompare(b.item.label));
  return scored.map((entry) => entry.item);
}

/**
 * Compose completion candidates for `/codex-marketplace <argumentPrefix>`.
 *
 * - `install ` / `install <query>` → state-aware second-level install candidates (#122).
 * - Empty prefix → all nine root candidates (Pi's exact-command interception surface).
 * - A single token → case-insensitive fuzzy-filtered subcommands; `[]` when nothing matches.
 * - Any other whitespace-containing prefix (unowned second-level syntax) → `null`, so callers
 *   fall through to Pi's own completion unchanged.
 *
 * The module never writes Bridge State; root candidates are derived without reading it at all,
 * and install candidates read it passively.
 */
export function completeArguments(
  argumentPrefix: string,
  options: CompletionReadOptions = {},
): CompletionItem[] | null {
  const installMatch = INSTALL_SECOND_LEVEL_RE.exec(argumentPrefix);
  if (installMatch) {
    return completeInstallArguments(installMatch[1], options);
  }
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
