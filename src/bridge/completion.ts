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
import {
  isInstallationEnabled,
  readMinimalBridgeStatePassive,
  type MinimalBridgeState,
  type MinimalInstallation,
} from './state.js';

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

/**
 * The owned Installation lifecycle second-level syntax (#123): `enable` / `disable` /
 * `remove` followed by whitespace and a single-token query. Like `install`, each command
 * without a trailing space stays at the root level; a second token is not Bridge-owned.
 */
const LIFECYCLE_SECOND_LEVEL_RE = /^(enable|disable|remove)\s+(\S*)$/;

export type LifecycleAction = 'enable' | 'disable' | 'remove';

/** Status vocabulary aligned with the `list` command surface (#90). */
function installStatusLabel(state: MarketplacePluginInstallationState): string {
  if (state === 'enabled') return '已裝啟用';
  if (state === 'disabled') return '已裝停用';
  return '可安裝';
}

/**
 * Positive canonical integer without leading zeros — the exact argument shape `install`
 * parses as an enumeration number (`String(Number(arg)) === arg && Number.isInteger && >= 1`),
 * so a unique plugin name with this shape can never be resolved by name.
 */
const CANONICAL_INTEGER_RE = /^[1-9]\d*$/;

/**
 * Whether a name-typed `install <name>` invocation would actually resolve this candidate
 * name: it must be unique in the full enumeration, contain no whitespace (the command splits
 * arguments on whitespace), and not look like a canonical integer (the command parses those
 * as enumeration numbers). Otherwise the insertion must be the enumeration number instead.
 */
function nameInsertionUsable(unique: boolean, name: string): boolean {
  return unique && !/\s/.test(name) && !CANONICAL_INTEGER_RE.test(name);
}

interface InstallCandidate {
  /** Plugin candidate name (entry name → path basename → ordinal fallback). */
  name: string;
  /** Marketplace provenance shown in the candidate description. */
  marketplaceName: string;
  /** 可安裝 / 已裝啟用 / 已裝停用 — install and reinstall are both selectable. */
  status: string;
  /** Case-insensitive fuzzy search target: plugin name + marketplace provenance. */
  searchText: string;
  /** Insertion token: the name when usable, else the enumeration number. */
  insertion: string;
}

/**
 * Compose install candidates from the shared Marketplace Plugin enumeration, restricted to
 * structurally installable entries. Unavailable Entries (unsupported source, unresolvable
 * source, invalid plugin, identity collision) never become candidates.
 *
 * Name insertion is allowed only when a name-typed `install <名稱>` would actually resolve
 * the plugin: the candidate name must be unique against the *full* enumeration (the same
 * domain `install <名稱>` resolves against — a same-named sibling, even an unavailable one,
 * forces the number insertion because the name would be rejected as ambiguous), contain no
 * whitespace, and not parse as a canonical enumeration number. The inserted number is the
 * plugin's number in that full enumeration, matching `list` and `install <編號>` exactly.
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
    candidates.push({
      name: plugin.candidateName,
      marketplaceName: plugin.marketplaceName,
      status: installStatusLabel(plugin.installationState),
      searchText: `${plugin.candidateName} ${plugin.marketplaceName}`,
      insertion: nameInsertionUsable((nameCounts.get(plugin.candidateName) ?? 0) === 1, plugin.candidateName)
        ? plugin.candidateName
        : String(plugin.number),
    });
  }
  return candidates;
}

/**
 * Compose the candidate label. A name insertion shows the name itself; a number insertion
 * keeps the enumeration number visible but labels the plugin so the user can tell which
 * same-named entry each candidate selects (the description carries provenance + status).
 */
function installLabel(candidate: InstallCandidate): string {
  return candidate.insertion === candidate.name
    ? candidate.name
    : `${candidate.name} (#${candidate.insertion})`;
}

function toInstallItem(candidate: InstallCandidate): CompletionItem {
  return {
    value: `install ${candidate.insertion}`,
    label: installLabel(candidate),
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

interface LifecycleCandidate {
  /** The Installation name the command surface resolves on (manifestName → pluginId → id). */
  name: string;
  /** Marketplace provenance shown in the candidate description. */
  marketplaceName: string;
  /** 已裝啟用 / 已裝停用 — the Installation lifecycle status (#123). */
  status: string;
  /** Case-insensitive fuzzy search target: plugin name + marketplace provenance. */
  searchText: string;
  /** Durable Installation state — consumed by the action filter, not rendered. */
  enabled: boolean;
}

function lifecycleStatusLabel(enabled: boolean): string {
  return enabled ? '已裝啟用' : '已裝停用';
}

function installationName(inst: MinimalInstallation): string {
  return inst.manifestName || inst.pluginId || inst.id;
}

/**
 * Whether a name-typed `enable|disable|remove <name>` invocation would resolve exactly this
 * Installation: the command matches `manifestName` OR `pluginId` OR `id` over every
 * Installation (#93), so the token must be unique across all records, and must survive the
 * command's whitespace token split.
 */
function lifecycleNameUsable(state: MinimalBridgeState, name: string): boolean {
  if (name.length === 0 || /\s/.test(name)) return false;
  let matches = 0;
  for (const other of state.installations) {
    if (other.manifestName === name || other.pluginId === name || other.id === name) matches += 1;
  }
  return matches === 1;
}

/**
 * Compose Installation lifecycle candidates directly from Bridge State (#123). Lifecycle
 * commands resolve on Installation records — not on catalog entries — so a record stays
 * selectable even when its registration or marketplace material has become unreadable; only
 * the provenance display degrades to the registration id.
 *
 * Ambiguity uses the full command resolution predicate over every Installation: a token that
 * could resolve more than one record (cross-Marketplace same name, or a pluginId/id
 * collision) is never offered, because the typed command would be rejected as ambiguous.
 */
function composeLifecycleCandidates(state: MinimalBridgeState): LifecycleCandidate[] {
  const regNames = new Map(state.registrations.map((reg) => [reg.id, reg.marketplaceName || reg.alias || reg.id]));
  const candidates: LifecycleCandidate[] = [];
  for (const inst of state.installations) {
    const name = installationName(inst);
    if (!lifecycleNameUsable(state, name)) continue;
    const marketplaceName = regNames.get(inst.registrationId) ?? inst.registrationId;
    const enabled = isInstallationEnabled(inst);
    candidates.push({
      name,
      marketplaceName,
      status: lifecycleStatusLabel(enabled),
      searchText: `${name} ${marketplaceName}`,
      enabled,
    });
  }
  return candidates;
}

function lifecycleCandidateIncluded(action: LifecycleAction, enabled: boolean): boolean {
  if (action === 'enable') return !enabled;
  if (action === 'disable') return enabled;
  return true; // remove: every Installed Plugin, regardless of state
}

function toLifecycleItem(action: LifecycleAction, candidate: LifecycleCandidate): CompletionItem {
  return {
    value: `${action} ${candidate.name}`,
    label: candidate.name,
    description: `[${candidate.marketplaceName}] ${candidate.status}`,
  };
}

/**
 * Second-level `enable` / `disable` / `remove` candidates for `/codex-marketplace <action> <query>`.
 *
 * - `enable <query>` → disabled Installations only.
 * - `disable <query>` → enabled Installations only.
 * - `remove <query>` → every Installed Plugin, whatever its state.
 * - Empty query → every actionable Installation in state order; a query → case-insensitive
 *   fuzzy match over the name and Marketplace provenance; `[]` when nothing matches.
 *
 * The Bridge State read is passive: empty, damaged, unreadable, or incompatible state
 * contributes no candidates and is never written, reset, or repaired (#119 stories 22–23).
 */
function completeLifecycleArguments(
  action: LifecycleAction,
  query: string,
  options: CompletionReadOptions,
): CompletionItem[] {
  const state = readMinimalBridgeStatePassive({ statePath: options.statePath, agentDir: options.agentDir });
  const candidates = composeLifecycleCandidates(state).filter((candidate) =>
    lifecycleCandidateIncluded(action, candidate.enabled),
  );
  if (query.length === 0) {
    return candidates.map((candidate) => toLifecycleItem(action, candidate));
  }
  const scored: { item: CompletionItem; score: number }[] = [];
  for (const candidate of candidates) {
    const score = fuzzyScore(query, candidate.searchText);
    if (score !== null) {
      scored.push({ item: toLifecycleItem(action, candidate), score });
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
  const lifecycleMatch = LIFECYCLE_SECOND_LEVEL_RE.exec(argumentPrefix);
  if (lifecycleMatch) {
    return completeLifecycleArguments(lifecycleMatch[1] as LifecycleAction, lifecycleMatch[2], options);
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
