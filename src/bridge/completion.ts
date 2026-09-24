/**
 * Bridge completion seam (#121, #122, #123, #124).
 *
 * Pure autocomplete for `/codex-marketplace`: root-level subcommands (#121), state-aware
 * second-level `install` candidates (#122), Installation lifecycle `enable` / `disable` /
 * `remove` candidates (#123), and Marketplace Registration candidates for `list` / `forget`
 * (#124). This module owns no terminal, TUI, rendering, or Pi host types: its input is the
 * complete argument prefix plus replaceable read-only options, and its output is only the
 * insertion value, display label, and optional description that Pi autocomplete needs — or
 * `null` when the argument prefix is not Bridge-owned syntax.
 *
 * Not owned: the `add` argument (arbitrary path or Git locator — free-form by design #124),
 * arbitrary text, file and path completion. When the module does not own the syntax, callers
 * fall through to Pi's normal behavior unchanged.
 */

import { queryMarketplacePlugins, type MarketplacePluginInstallationState } from './plugin-query.js';
import { rereadConfirmableSkills } from './skill-discovery.js';
import { installationDisplayName, matchesInstallation, resolveInstallation } from './installation-identity.js';
import {
  isInstallationEnabled,
  readMinimalBridgeStatePassive,
  skillExclusionsOf,
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

/** The ten root subcommands, descriptions aligned with the command surface's HELP_TEXT vocabulary. */
const ROOT_CANDIDATES: RootCommandCandidate[] = [
  { label: 'add', description: '註冊 marketplace', takesArgument: true },
  { label: 'list', description: '列出 plugins', takesArgument: true },
  { label: 'install', description: '安裝最新版本並立即啟用', takesArgument: true },
  { label: 'update', description: '全部更新', takesArgument: false },
  { label: 'disable', description: '停用 plugin（不再投影）', takesArgument: true },
  { label: 'enable', description: '啟用 plugin（恢復投影）', takesArgument: true },
  { label: 'remove', description: '移除 plugin', takesArgument: true },
  { label: 'forget', description: '移除 marketplace（含其全部安裝）', takesArgument: true },
  { label: 'skills', description: '查看 skills 與排除狀態（不改變設定）', takesArgument: true },
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
 * Case-insensitive fuzzy filter over composed candidates, ordered by score then label. The
 * search text is read from the candidate (name plus provenance or status description) so a
 * query can match either, and only matching candidates are converted to completion items.
 */
function fuzzyFilter<T>(
  entries: T[],
  query: string,
  searchText: (entry: T) => string,
  toItem: (entry: T) => CompletionItem,
): CompletionItem[] {
  const scored: { item: CompletionItem; score: number }[] = [];
  for (const entry of entries) {
    const score = fuzzyScore(query, searchText(entry));
    if (score !== null) scored.push({ item: toItem(entry), score });
  }
  scored.sort((a, b) => a.score - b.score || a.item.label.localeCompare(b.item.label));
  return scored.map((entry) => entry.item);
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

/**
 * The owned Registration second-level syntax (#124): `list` / `forget` followed by
 * whitespace and a single-token query. Both commands resolve their argument against the same
 * Registration identity fields (marketplaceName OR alias OR id). Each command without a
 * trailing space stays at the root level; a second token is not Bridge-owned. `add` is
 * deliberately absent: its argument is free-form input (path or Git locator) and stays
 * Pi-native.
 */
const REGISTRATION_SECOND_LEVEL_RE = /^(list|forget)\s+(\S*)$/;

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
  return fuzzyFilter(candidates, query, (candidate) => candidate.searchText, toInstallItem);
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

/**
 * Whether a name-typed `enable|disable|remove <name>` invocation would resolve exactly this
 * Installation: the command matches `manifestName` OR `pluginId` OR `id` over every
 * Installation (#93), so the token must be unique across all records, and must survive the
 * command's whitespace token split.
 */
function lifecycleNameUsable(state: MinimalBridgeState, name: string): boolean {
  if (name.length === 0 || /\s/.test(name)) return false;
  const matches = state.installations.filter((other) => matchesInstallation(other, name));
  return matches.length === 1;
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
    const name = installationDisplayName(inst);
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

interface RegistrationCandidate {
  /** Registration display name — marketplaceName, else alias, else id (command surface display). */
  name: string;
  /** Unique resolvable token the command executes on: the name, else its alias, else its id. */
  insertion: string;
  /** Marketplace format ('codex' | 'claude') shown as provenance. */
  format: string;
  /** 本地 / git source-kind vocabulary matching the `list` overview surface (#90). */
  sourceKindLabel: string;
  /** Raw source (local path or Git URL) shown as provenance. */
  source: string;
  /** Case-insensitive fuzzy search target: name + alias + format + source provenance. */
  searchText: string;
}

/**
 * Whether a name-typed `list|forget <token>` invocation would resolve exactly this
 * Registration: the command matches marketplaceName OR alias OR id over every Registration
 * (the same predicate as `matchesRegistration` in the command surface), so the token must be
 * unique across all identity fields and survive the command's whitespace token split.
 */
function registrationTokenUsable(registrations: MinimalBridgeState['registrations'], token: string): boolean {
  if (token.length === 0 || /\s/.test(token)) return false;
  let matches = 0;
  for (const reg of registrations) {
    if (reg.marketplaceName === token || reg.alias === token || reg.id === token) matches += 1;
  }
  return matches === 1;
}

/**
 * Compose Registration candidates directly from Bridge State (#124). `list` and `forget`
 * both resolve their argument on Registration records, so a candidate is offered only when
 * some token uniquely names that record — the readable name first, then its alias, then its
 * Registration id — mirroring the exact predicate the commands execute with. Ambiguity uses
 * the full predicate over every Registration identity field; a Registration with no uniquely
 * resolvable token contributes no candidate, because the typed command could never select it.
 */
function composeRegistrationCandidates(state: MinimalBridgeState): RegistrationCandidate[] {
  const candidates: RegistrationCandidate[] = [];
  for (const reg of state.registrations) {
    const name = reg.marketplaceName || reg.alias || reg.id;
    const insertion =
      (registrationTokenUsable(state.registrations, name) && name) ||
      (reg.alias && reg.alias !== name && registrationTokenUsable(state.registrations, reg.alias) && reg.alias) ||
      (registrationTokenUsable(state.registrations, reg.id) && reg.id);
    if (!insertion) continue;
    const format = reg.format ?? 'codex';
    const sourceKindLabel = reg.sourceKind === 'local' ? '本地' : 'git';
    candidates.push({
      name,
      insertion,
      format,
      sourceKindLabel,
      source: reg.source,
      searchText: [name, reg.alias, format, sourceKindLabel, reg.source].filter(Boolean).join(' '),
    });
  }
  return candidates;
}

/**
 * Compose the candidate label: the readable Registration name; when the insertion is not the
 * name (ambiguous name, alias, or id), it stays visible so the user sees which token the
 * candidate inserts.
 */
function registrationLabel(candidate: RegistrationCandidate): string {
  return candidate.insertion === candidate.name
    ? candidate.name
    : `${candidate.name} (${candidate.insertion})`;
}

function toRegistrationItem(action: 'list' | 'forget', candidate: RegistrationCandidate): CompletionItem {
  return {
    value: `${action} ${candidate.insertion}`,
    label: registrationLabel(candidate),
    description: `[${candidate.format}] ${candidate.sourceKindLabel} ${candidate.source}`,
  };
}

/**
 * Second-level `list` / `forget` candidates for `/codex-marketplace <action> <query>` (#124).
 *
 * - Empty query → every Registration with a uniquely resolvable token, in state order.
 * - A query → case-insensitive fuzzy match over the name, alias, and source/format
 *   provenance; `[]` when nothing matches.
 *
 * The Bridge State read is passive: empty, damaged, unreadable, or incompatible state or
 * marketplace material contributes no candidates and is never written, reset, or repaired
 * (#119 stories 22–23). `add` is not owned here by design.
 */
function completeRegistrationArguments(
  action: 'list' | 'forget',
  query: string,
  options: CompletionReadOptions,
): CompletionItem[] {
  const state = readMinimalBridgeStatePassive({ statePath: options.statePath, agentDir: options.agentDir });
  const candidates = composeRegistrationCandidates(state);
  if (query.length === 0) {
    return candidates.map((candidate) => toRegistrationItem(action, candidate));
  }
  return fuzzyFilter(candidates, query, (candidate) => candidate.searchText, (candidate) =>
    toRegistrationItem(action, candidate));
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
  return fuzzyFilter(candidates, query, (candidate) => candidate.searchText, (candidate) =>
    toLifecycleItem(action, candidate));
}

/**
 * The owned Skill Exclusion second-level syntax (#158): `skills` followed by whitespace and a
 * single-token query. Like the lifecycle commands, `skills` without a trailing space stays at
 * the root level so the trailing-space root candidate can be applied first.
 */
const SKILLS_SECOND_LEVEL_RE = /^skills\s+(\S*)$/;

/** The owned `skills <名稱> <action>` third-level syntax (#158). */
const SKILLS_ACTION_LEVEL_RE = /^skills\s+(\S+)\s+(\S*)$/;

/**
 * The owned `skills <名稱> exclude|include|only <skill>` skill-argument syntax (#158). `reset`
 * takes no skill argument, so it never reaches this level and the prefix stays unowned for Pi.
 */
const SKILLS_SKILL_ARG_RE = /^skills\s+(\S+)\s+(exclude|include|only)\s+(\S*)$/;

interface SkillActionCandidate {
  label: 'exclude' | 'include' | 'only' | 'reset';
  description: string;
}

/**
 * The four Skill Exclusion operations, described with the semantics the command surface gives
 * them: each state-changing operation discloses that the Pi host is asked to reload afterwards,
 * and `only` discloses that a missing name cannot mean "exclude everything".
 */
const SKILL_ACTION_CANDIDATES: SkillActionCandidate[] = [
  { label: 'exclude', description: '排除單一 skill（不再投影；變更後 Pi 自動 reload）' },
  { label: 'include', description: '恢復已排除的 skill（逐項；變更後 Pi 自動 reload）' },
  { label: 'only', description: '只保留目前指定的 skills（未給名稱不會排除全部；變更後 Pi 自動 reload）' },
  { label: 'reset', description: '清除全部排除（含已消失名稱；變更後 Pi 自動 reload）' },
];

function toSkillActionItem(token: string, action: SkillActionCandidate): CompletionItem {
  return {
    value: `skills ${token} ${action.label}`,
    label: action.label,
    description: action.description,
  };
}

function toSkillInstallationItem(candidate: LifecycleCandidate): CompletionItem {
  return {
    value: `skills ${candidate.name}`,
    label: candidate.name,
    description: `[${candidate.marketplaceName}] ${candidate.status}`,
  };
}

/**
 * Second-level `skills <query>` candidates (#158): every uniquely resolvable Installed Plugin,
 * whatever its state — exclusions are adjustable while a Plugin is disabled, exactly as the
 * command allows. Provenance and status match the Installation lifecycle vocabulary (#123).
 */
function completeSkillsInstallationArguments(query: string, options: CompletionReadOptions): CompletionItem[] {
  const state = readMinimalBridgeStatePassive({ statePath: options.statePath, agentDir: options.agentDir });
  const candidates = composeLifecycleCandidates(state);
  if (query.length === 0) {
    return candidates.map(toSkillInstallationItem);
  }
  return fuzzyFilter(candidates, query, (candidate) => candidate.searchText, toSkillInstallationItem);
}

/**
 * Third-level `skills <名稱> <query>` candidates: the four operations. The syntax is owned as
 * soon as `skills <名稱>` names exactly one Installation; an unresolvable or ambiguous name
 * yields no candidates (never a silently picked target).
 */
function completeSkillsActionArguments(
  token: string,
  query: string,
  options: CompletionReadOptions,
): CompletionItem[] {
  const state = readMinimalBridgeStatePassive({ statePath: options.statePath, agentDir: options.agentDir });
  if (!resolveInstallation(state, token)) return [];
  if (query.length === 0) {
    return SKILL_ACTION_CANDIDATES.map((action) => toSkillActionItem(token, action));
  }
  return fuzzyFilter(SKILL_ACTION_CANDIDATES, query, (action) => action.label, (action) =>
    toSkillActionItem(token, action));
}

/**
 * Fourth-level `skills <名稱> exclude|include|only <query>` candidates: only the names the
 * command would actually accept. `exclude` and `only` read the currently confirmable source
 * (the same read the command validates against), so a stale record cannot offer a name the
 * command rejects and a newly added skill is offered immediately; an unreadable source offers
 * no candidate for them. `include` restores from the record and needs no source read.
 */
function completeSkillsSkillArguments(
  token: string,
  action: 'exclude' | 'include' | 'only',
  query: string,
  options: CompletionReadOptions,
): CompletionItem[] {
  const state = readMinimalBridgeStatePassive({ statePath: options.statePath, agentDir: options.agentDir });
  const installation = resolveInstallation(state, token);
  if (!installation) return [];
  const excluded = new Set(skillExclusionsOf(installation));
  let names: string[];
  if (action === 'include') {
    names = [...excluded];
  } else {
    const confirmable = rereadConfirmableSkills(state, installation, options);
    if (!confirmable) return [];
    names = action === 'only' ? confirmable : confirmable.filter((name) => !excluded.has(name));
  }
  names.sort((a, b) => a.localeCompare(b));
  const toItem = (name: string): CompletionItem => ({ value: `skills ${token} ${action} ${name}`, label: name });
  if (query.length === 0) {
    return names.map(toItem);
  }
  return fuzzyFilter(names, query, (name) => name, toItem);
}

/**
 * Compose completion candidates for `/codex-marketplace <argumentPrefix>`.
 *
 * - `install ` / `install <query>` → state-aware second-level install candidates (#122).
 * - `enable|disable|remove <query>` → Installation lifecycle candidates (#123).
 * - `list|forget <query>` → Registration candidates (#124); `add` is never owned.
 * - `skills <query>` / `skills <名稱> <query>` / `skills <名稱> exclude|include|only <query>`
 *   → Skill Exclusion candidates (#158).
 * - Empty prefix → all ten root candidates (Pi's exact-command interception surface).
 * - A single token → case-insensitive fuzzy-filtered subcommands; `[]` when nothing matches.
 * - Any other whitespace-containing prefix (unowned second-level syntax) → `null`, so callers
 *   fall through to Pi's own completion unchanged.
 *
 * The module never writes Bridge State; root candidates are derived without reading it at all,
 * and state-aware candidates read it passively.
 */
export function completeArguments(
  argumentPrefix: string,
  options: CompletionReadOptions = {},
): CompletionItem[] | null {
  const skillsSkillMatch = SKILLS_SKILL_ARG_RE.exec(argumentPrefix);
  if (skillsSkillMatch) {
    return completeSkillsSkillArguments(skillsSkillMatch[1]!, skillsSkillMatch[2] as 'exclude' | 'include' | 'only', skillsSkillMatch[3]!, options);
  }
  const skillsActionMatch = SKILLS_ACTION_LEVEL_RE.exec(argumentPrefix);
  if (skillsActionMatch) {
    return completeSkillsActionArguments(skillsActionMatch[1]!, skillsActionMatch[2]!, options);
  }
  const skillsMatch = SKILLS_SECOND_LEVEL_RE.exec(argumentPrefix);
  if (skillsMatch) {
    return completeSkillsInstallationArguments(skillsMatch[1]!, options);
  }
  const installMatch = INSTALL_SECOND_LEVEL_RE.exec(argumentPrefix);
  if (installMatch) {
    return completeInstallArguments(installMatch[1], options);
  }
  const lifecycleMatch = LIFECYCLE_SECOND_LEVEL_RE.exec(argumentPrefix);
  if (lifecycleMatch) {
    return completeLifecycleArguments(lifecycleMatch[1] as LifecycleAction, lifecycleMatch[2], options);
  }
  const registrationMatch = REGISTRATION_SECOND_LEVEL_RE.exec(argumentPrefix);
  if (registrationMatch) {
    return completeRegistrationArguments(
      registrationMatch[1] as 'list' | 'forget',
      registrationMatch[2],
      options,
    );
  }
  if (/\s/.test(argumentPrefix)) return null;

  const query = argumentPrefix.trim();
  if (query.length === 0) {
    return ROOT_CANDIDATES.map(toItem);
  }
  return fuzzyFilter(ROOT_CANDIDATES, query, (candidate) => candidate.label, toItem);
}
