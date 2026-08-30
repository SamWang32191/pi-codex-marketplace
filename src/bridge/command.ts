/**
 * Pure runCommand dispatch seam (#88, #89, #87, #90).
 *
 * Single pure entry point: runCommand(argv) -> { messages, lines, output, reload, stateReset }
 * Does not touch Pi host APIs; safe for direct assertion in pure Node environments.
 */

import { randomUUID } from 'node:crypto';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';

import { parseFrontmatter } from '@earendil-works/pi-coding-agent';

import {
  isInstallationEnabled,
  readMinimalBridgeState,
  writeMinimalBridgeState,
  type MinimalBridgeState,
} from './state.js';
import { localSourceKey } from '../registration/source-key.js';
import {
  detectMarketplaceFormat,
  CODEX_MARKETPLACE_CATALOG_RELPATH,
  CLAUDE_MARKETPLACE_CATALOG_RELPATH,
} from '../registration/format.js';
import { resolveContained } from '../registration/contained.js';
import { findEntryByManifestName } from '../registration/catalog.js';
import {
  queryMarketplacePlugins,
  readMarketplaceCatalog,
  resolveMarketplaceRoot,
  type MarketplaceCatalogReadResult,
  type MarketplacePluginCandidate,
} from './plugin-query.js';
import { normalizeGitLocator } from '../registration/git-locator.js';
import { acquireGitSource, cleanupAcquisition, type GitExecutor } from '../registration/git-acquisition.js';
import {
  CREDENTIAL_HELPERS_ENV,
  resolveApprovedHelpers,
  type CredentialHelperDetector,
} from '../registration/credential-helpers.js';
import { gitSourceKey } from '../registration/source-key.js';
import { buildGitSnapshot } from '../registration/snapshot.js';
import { SourceCache } from '../cache/source-cache.js';

export interface CommandOptions {
  statePath?: string;
  agentDir?: string;
  cwd?: string;
  /** Git executor seam for tests — mocks `git` invocations (ls-remote/clone/checkout). */
  gitExecutor?: GitExecutor;
  /** 自動偵測 seam for tests — mocks gh/keychain/store detection (#117). */
  credentialHelperDetector?: CredentialHelperDetector;
}

export interface CommandResult {
  messages: string[];
  lines: string[];
  output: string;
  reload: boolean;
  stateReset?: boolean;
}

const USAGE_LINE = '用法：/codex-marketplace <add|list|install|update|disable|enable|remove|forget|help>';

const HELP_TEXT = [
  '用法：/codex-marketplace <子命令> [參數]',
  '',
  '子命令：',
  '  add <路徑|網址>      註冊 marketplace',
  '  list [名稱]          列出 plugins',
  '  install <編號|名稱>  安裝最新版本並立即啟用',
  '  update               全部更新',
  '  disable <名稱>       停用 plugin（不再投影）',
  '  enable <名稱>        啟用 plugin（恢復投影）',
  '  remove <名稱>        移除 plugin',
  '  forget <名稱>        移除 marketplace（含其全部安裝）',
  '  help                 這份說明清單',
].join('\n');

const KEBAB_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// ---- Git marketplace helpers (#92) ----

const OWNER_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\.git)?$/;

function isGitCandidate(input: string): boolean {
  const t = input.trim();
  if (OWNER_REPO_RE.test(t) && !t.includes('://') && !t.includes('@')) return true;
  if (t.includes('://')) return true;
  if (/^[^@\s]+@[^:\s]+:[^\s]+$/.test(t)) return true;
  return false;
}

function expandOwnerRepo(input: string): string {
  return `https://github.com/${input.trim()}`;
}

function padRight(str: string, length: number): string {
  return str.length >= length ? str : str + ' '.repeat(length - str.length);
}

function formatOverview(state: MinimalBridgeState): string[] {
  const sections: string[] = [];

  // 1. Marketplaces Section
  const marketLines: string[] = ['Marketplaces'];
  if (state.registrations.length === 0) {
    marketLines.push('  （尚未註冊任何 marketplace；使用 /codex-marketplace add <路徑|網址> 註冊）');
  } else {
    state.registrations.forEach((reg, idx) => {
      const num = padRight(` ${idx + 1}`, 4);
      const name = padRight(reg.marketplaceName || reg.alias || reg.id, 18);
      const format = padRight(reg.format ?? 'codex', 8);
      const sourceKind = padRight(reg.sourceKind === 'local' ? '本地' : 'git', 6);
      const source = reg.source;
      marketLines.push(`${num}${name}${format}${sourceKind}${source}`);
    });
  }
  sections.push(marketLines.join('\n'));

  // 2. Installed Section
  const installedLines: string[] = ['Installed'];
  if (state.installations.length === 0) {
    installedLines.push('  （尚未安裝任何 plugin）');
  } else {
    // Find marketplace name by registrationId
    const regMap = new Map(state.registrations.map((r) => [r.id, r.marketplaceName || r.alias || r.id]));
    state.installations.forEach((inst) => {
      const name = padRight(` ${inst.manifestName || inst.pluginId}`, 8);
      const mkt = `[${regMap.get(inst.registrationId) ?? inst.registrationId}]`;
      const mktPadded = padRight(mkt, 18);
      const skillCount = inst.skills ? inst.skills.length : 0;
      const skillsStr = `${skillCount} skills`;
      const isEnabled = isInstallationEnabled(inst as any);
      const stateStr = isEnabled ? '啟用' : '停用';
      installedLines.push(`${name}${mktPadded}${skillsStr} · ${stateStr}`);
    });
  }
  sections.push(installedLines.join('\n'));

  // 3. Usage Section
  sections.push(USAGE_LINE);

  return sections;
}

function formatCatalogError(findings: { code?: string; outcome?: string; rule?: string; pointer?: string }[]): string {
  if (findings.length === 0) return 'catalog 解析失敗';
  const first = findings[0];
  const detail = first.outcome || first.code || '未知錯誤';
  return detail;
}

// ---- Plugin enumeration presentation (#90, #91, #120) ----

function pluginStatus(plugin: MarketplacePluginCandidate): '可安裝' | '已裝啟用' | '已裝停用' | 'unavailable' {
  if (!plugin.structurallyInstallable) return 'unavailable';
  if (plugin.installationState === 'enabled') return '已裝啟用';
  if (plugin.installationState === 'disabled') return '已裝停用';
  return '可安裝';
}

function formatPluginListLines(state: MinimalBridgeState, filter?: string, opts: CommandOptions = {}): string[] {
  const { plugins: enumeration, diagnostics } = queryMarketplacePlugins(state, opts);
  const errorLines = diagnostics.map((diagnostic) => `⚠ marketplace [${diagnostic.marketplace}] ${diagnostic.error}`);
  if (enumeration.length === 0) {
    // No plugins at all (e.g., empty catalog, no registrations, or unreadable catalogs):
    // read failures are disclosed, never silently skipped (#91).
    return errorLines;
  }
  let filtered = enumeration;
  if (filter) {
    filtered = enumeration.filter(
      (plugin) => plugin.registration.marketplaceName === filter
        || plugin.registration.alias === filter
        || plugin.registration.id === filter,
    );
    if (filtered.length === 0) {
      return [
        `找不到 marketplace "${filter}"`,
        ...errorLines.filter((l) => l.includes(`[${filter}]`)),
      ];
    }
  }
  const lines: string[] = ['Plugins（編號／所屬 marketplace／狀態）'];
  const show = filter ? filtered : enumeration;
  for (const plugin of show) {
    const num = padRight(` ${plugin.number}`, 4);
    const name = padRight(plugin.candidateName, 18);
    const mkt = padRight(`[${plugin.marketplaceName}]`, 20);
    const stateLabel = pluginStatus(plugin);
    const status = stateLabel === 'unavailable'
      ? `unavailable（${plugin.unavailableReason ?? 'unavailable'}）`
      : stateLabel;
    lines.push(`${num}${name}${mkt}${status}`);
  }
  lines.push(...errorLines);
  return lines;
}

// ---- Lifecycle helpers (#93 maintainability, P0/P1) ----

function setInstallationEnabled(inst: MinimalBridgeState['installations'][number], enabled: boolean): void {
  (inst as any).enabled = enabled;
  (inst as any).installationState = enabled ? 'enabled' : 'disabled';
}

function matchesInstallation(inst: MinimalBridgeState['installations'][number], name: string): boolean {
  return inst.manifestName === name || inst.pluginId === name || inst.id === name;
}

function matchesRegistration(reg: MinimalBridgeState['registrations'][number], name: string): boolean {
  return reg.marketplaceName === name || reg.alias === name || reg.id === name;
}

function findInstallationIndex(state: MinimalBridgeState, name: string): number {
  return state.installations.findIndex((i) => matchesInstallation(i, name));
}

function findInstallationsByName(state: MinimalBridgeState, name: string): MinimalBridgeState['installations'] {
  return state.installations.filter((i) => matchesInstallation(i, name));
}

function findRegistrationsByName(state: MinimalBridgeState, name: string): MinimalBridgeState['registrations'] {
  return state.registrations.filter((r) => matchesRegistration(r, name));
}

function findRegistrationIndex(state: MinimalBridgeState, name: string): number {
  return state.registrations.findIndex((r) => matchesRegistration(r, name));
}

/**
 * Best-effort reread for enable: mirrors install Step1-3 (Marketplace Root -> readCatalog -> entry -> resolveContained -> collectSkillNames).
 * Returns undefined on any missing cache/catalog/entry/path — caller falls back to stored skills.
 * Pure-logic branches (find/entry.path/resolveContained outcome) do not throw; only I/O (readMarketplaceCatalog/collectSkillNames) is try/catch guarded.
 */
function tryRereadSkills(
  reg: MinimalBridgeState['registrations'][number],
  inst: MinimalBridgeState['installations'][number],
  opts: CommandOptions,
): string[] | undefined {
  const marketplaceRoot = resolveMarketplaceRoot(reg, opts);
  if (!marketplaceRoot) return undefined;
  let read: MarketplaceCatalogReadResult | undefined;
  try {
    read = readMarketplaceCatalog(marketplaceRoot, reg.format ?? 'codex');
  } catch {
    // best-effort: catalog 讀取/解析失敗（cache 缺失或損毀）則沿用舊 skills
    return undefined;
  }
  if (read.error || !read.catalog) return undefined;
  const entry = findEntryByManifestName(read.catalog, inst.manifestName);
  if (!entry?.path) return undefined;
  const contained = resolveContained(marketplaceRoot, entry.path, 'directory');
  if (contained.outcome.kind !== 'ok') return undefined;
  try {
    return collectSkillNames(contained.outcome.canonicalPath, (reg.format ?? 'codex') as 'codex' | 'claude');
  } catch {
    // best-effort: 目錄掃描失敗則沿用舊 skills
    return undefined;
  }
}

function detectCollidingSkills(
  skillList: string[],
  installations: MinimalBridgeState['installations'],
  isExcluded?: (inst: MinimalBridgeState['installations'][number]) => boolean,
): string[] {
  const existing = new Map<string, number>();
  for (const other of installations) {
    if (isExcluded?.(other)) continue;
    if (!isInstallationEnabled(other)) continue;
    for (const s of (other as any).skills ?? []) existing.set(s, (existing.get(s) ?? 0) + 1);
  }
  return [...new Set(skillList.filter((s) => existing.has(s)))].sort((a, b) => a.localeCompare(b));
}

interface PluginRereadOutcome {
  ok: boolean;
  manifestName: string;
  skillNames: string[];
  /** true when the latest material differs from the installation record（有變化） */
  changed: boolean;
  colliding: string[];
  error?: string;
}

/**
 * 重裝＝更新（#94）：對已安裝 plugin 在最新材料root（本機 live 路徑或 git 新 cache entry）重讀
 * catalog → 重解析 manifest＋skills，回傳刷新結果由呼叫端套用。純邏輯分支不拋；
 * 僅 I/O（readMarketplaceCatalog／readManifestName／collectSkillNames）由各函式內部 try/catch 守護。
 */
function rereadInstalledPlugin(
  root: string,
  format: 'codex' | 'claude',
  inst: MinimalBridgeState['installations'][number],
  installations: MinimalBridgeState['installations'],
): PluginRereadOutcome {
  const read = readMarketplaceCatalog(root, format);
  if (read.error || !read.catalog) {
    return {
      ok: false,
      manifestName: inst.manifestName,
      skillNames: [],
      changed: false,
      colliding: [],
      error: read.error ?? 'catalog 讀取失敗',
    };
  }
  const entry = findEntryByManifestName(read.catalog, inst.manifestName);
  if (!entry?.path) {
    return {
      ok: false,
      manifestName: inst.manifestName,
      skillNames: [],
      changed: false,
      colliding: [],
      error: '找不到對應 catalog entry（已從 marketplace 移除？）',
    };
  }
  const contained = resolveContained(root, entry.path, 'directory');
  if (contained.outcome.kind !== 'ok') {
    const reason =
      contained.outcome.kind === 'blocking' ? contained.outcome.reason : `plugin 目錄不存在（${entry.path}）`;
    return {
      ok: false,
      manifestName: inst.manifestName,
      skillNames: [],
      changed: false,
      colliding: [],
      error: reason,
    };
  }
  const pluginDir = contained.outcome.canonicalPath;
  const manifestRes = readManifestName(pluginDir);
  if (manifestRes.error || !manifestRes.name) {
    return {
      ok: false,
      manifestName: inst.manifestName,
      skillNames: [],
      changed: false,
      colliding: [],
      error: manifestRes.error ?? 'manifest 讀取失敗',
    };
  }
  const skillNames = collectSkillNames(pluginDir, format);
  const oldSkills = [...(inst.skills ?? [])].sort((a, b) => a.localeCompare(b));
  const newSkills = [...skillNames].sort((a, b) => a.localeCompare(b));
  const changed = manifestRes.name !== inst.manifestName || JSON.stringify(oldSkills) !== JSON.stringify(newSkills);
  const colliding = detectCollidingSkills(skillNames, installations, (other) => other.id === inst.id);
  return { ok: true, manifestName: manifestRes.name, skillNames, changed, colliding };
}

function tryWriteState(state: MinimalBridgeState, opts: CommandOptions): string | undefined {
  try {
    writeMinimalBridgeState(state, opts);
    return undefined;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return msg;
  }
}

// ---- Skill discovery helpers ----

function descriptorSkillName(skillDir: string, descriptorPath: string): string | undefined {
  try {
    const text = readFileSync(descriptorPath, 'utf-8');
    const { frontmatter } = parseFrontmatter<Record<string, unknown>>(text);
    const description = frontmatter?.description;
    if (typeof description !== 'string' || description.trim().length === 0) return undefined;
    const declared = frontmatter?.name;
    const name = typeof declared === 'string' && declared.trim().length > 0 ? declared.trim() : basename(skillDir);
    if (!KEBAB_RE.test(name)) return undefined;
    return name;
  } catch {
    return undefined;
  }
}

function collectSkillNames(pluginDir: string, format: 'codex' | 'claude' = 'codex'): string[] {
  if (format === 'claude') {
    // For claude, manifest declares skills array; fallback to directory scan if needed
    const manifestPath = join(pluginDir, '.claude-plugin', 'plugin.json');
    if (existsSync(manifestPath)) {
      try {
        const raw = readFileSync(manifestPath, 'utf-8');
        const manifest = JSON.parse(raw) as Record<string, unknown>;
        if (Array.isArray(manifest.skills)) {
          const names: string[] = [];
          for (const decl of manifest.skills) {
            if (typeof decl !== 'string') continue;
            const resolved = resolveContained(pluginDir, decl, 'directory');
            if (resolved.outcome.kind !== 'ok') continue;
            const skillDir = resolved.outcome.canonicalPath;
            const descriptor = join(skillDir, 'SKILL.md');
            if (!existsSync(descriptor)) continue;
            const name = descriptorSkillName(skillDir, descriptor);
            if (name) names.push(name);
          }
          // If manifest skills yielded something, return sorted
          if (names.length > 0) return names.sort((a, b) => a.localeCompare(b));
        }
      } catch {
        // fall through to directory scan
      }
    }
    // fallback: scan skills dir like codex
  }

  const skillsDir = join(pluginDir, 'skills');
  if (!existsSync(skillsDir)) return [];
  try {
    if (!statSync(skillsDir).isDirectory()) return [];
  } catch {
    return [];
  }
  let entries;
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillDir = join(skillsDir, entry.name);
    const descriptor = join(skillDir, 'SKILL.md');
    if (!existsSync(descriptor)) continue;
    const name = descriptorSkillName(skillDir, descriptor);
    if (name) found.push(name);
  }
  return found.sort((a, b) => a.localeCompare(b));
}

function readManifestName(pluginDir: string): { name?: string; error?: string; path?: string } {
  const candidates = [
    join(pluginDir, '.codex-plugin', 'plugin.json'),
    join(pluginDir, '.claude-plugin', 'plugin.json'),
    join(pluginDir, 'plugin.json'),
  ];
  for (const cand of candidates) {
    if (!existsSync(cand)) continue;
    try {
      const raw = readFileSync(cand, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const n = parsed.name;
      if (typeof n !== 'string' || !n.trim()) {
        return { error: `manifest ${cand} 缺少合法 name 欄位`, path: cand };
      }
      const trimmed = n.trim();
      if (!KEBAB_RE.test(trimmed)) {
        return { error: `manifest name '${trimmed}' 非 lowercase kebab-case`, path: cand };
      }
      return { name: trimmed, path: cand };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { error: `manifest 解析失敗 (${cand})：${msg}`, path: cand };
    }
  }
  return { error: '找不到 plugin manifest（.codex-plugin/plugin.json 或 plugin.json）' };
}

export async function runCommand(
  argv: string[] | string,
  opts: CommandOptions = {},
): Promise<CommandResult> {
  const rawArgs = typeof argv === 'string' ? argv.trim().split(/\s+/).filter(Boolean) : [...argv];

  // Credentialed Acquisition (#109，#117)：逐次核准的 credential helper allowlist。
  // env 顯式設定 → 完全覆蓋；未設定／空白 → 自動偵測固定白名單（gh／keychain／store），
  // 開箱即用（私有 repo 不再要求先設 env）。解析結果只經既有 AcquisitionTrustOptions
  // 傳給 Git 取得；底層不讀環境變數，未核准（偵測也無結果）時 trust 為 undefined，
  // 行為與 credential-free 完全一致。
  const resolved = resolveApprovedHelpers(process.env[CREDENTIAL_HELPERS_ENV], opts.credentialHelperDetector);
  const acquireTrust: { allowedCredentialHelpers: string[]; helperMode: 'detected' | 'approved' } | undefined =
    resolved.helpers.length > 0 ? { allowedCredentialHelpers: resolved.helpers, helperMode: resolved.mode as 'detected' | 'approved' } : undefined;

  // Strip leading command token if passed
  if (rawArgs.length > 0 && (rawArgs[0] === '/codex-marketplace' || rawArgs[0] === 'codex-marketplace')) {
    rawArgs.shift();
  }

  let state: MinimalBridgeState;
  let wasReset = false;
  let resetReason: string | undefined;
  try {
    const read = readMinimalBridgeState(opts);
    state = read.state;
    wasReset = read.wasReset;
    resetReason = read.resetReason;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const messages = [`錯誤：讀取 Bridge State 失敗：${msg}`];
    return { messages, lines: messages, output: messages.join('\n\n'), reload: false, stateReset: false };
  }

  const messages: string[] = [];
  if (wasReset) {
    messages.push(`⚠️ Bridge State 檔案損壞或格式不符，已重置為空狀態。請重新註冊與安裝。${resetReason ? ` (${resetReason})` : ''}`);
  }

  let reload = false;

  if (rawArgs.length === 0) {
    // Overview (no arguments)
    messages.push(...formatOverview(state));
  } else {
    const subcmd = rawArgs[0].toLowerCase();
    const subargs = rawArgs.slice(1);

    switch (subcmd) {
      case 'help':
      case '-h':
      case '--help': {
        messages.push(HELP_TEXT);
        break;
      }
      case 'add': {
        if (subargs.length === 0) {
          messages.push('用法：/codex-marketplace add <路徑|網址>');
        } else {
          const input = subargs[0];
          // ---- Git candidate detection (#92): owner/repo shorthand or URL ----
          if (isGitCandidate(input)) {
            let locatorInput = input.trim();
            if (OWNER_REPO_RE.test(locatorInput) && !locatorInput.includes('://') && !locatorInput.includes('@')) {
              locatorInput = expandOwnerRepo(locatorInput);
            }
            const locRes = normalizeGitLocator(locatorInput);
            if (!locRes.ok) {
              const outcome = locRes.findings[0]?.outcome ?? 'Git 網址格式不正確';
              const allOutcomes = locRes.findings.map((f) => f.outcome).join('；');
              messages.push(`錯誤：Git 網址不合法 — ${outcome}`);
              if (allOutcomes && allOutcomes !== outcome) messages.push(`詳細：${allOutcomes}`);
              break;
            }
            const locator = locRes.locator!;
            const canonicalUrl = locator.canonicalUrl;

            const duplicateGit = state.registrations.find((r) => r.sourceKind === 'git' && r.source === canonicalUrl);
            if (duplicateGit) {
              messages.push(`已註冊過相同來源 "${canonicalUrl}"，想更新？\`update\`；想換？先 \`remove\` 再 \`add\``);
              break;
            }

            let acquireResult;
            try {
              acquireResult = await acquireGitSource({
                locator,
                executor: opts.gitExecutor,
                trust: acquireTrust,
              });
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              messages.push(`錯誤：git 取得失敗 — ${msg}`);
              break;
            }
            if (!acquireResult.ok) {
              const outcome = acquireResult.findings[0]?.outcome ?? acquireResult.stderr ?? 'git 取得失敗';
              messages.push(`錯誤：git 取得失敗 — ${outcome}`);
              if (acquireResult.findings.length > 1) {
                const extra = acquireResult.findings.slice(1, 3).map((f) => f.outcome).join('；');
                if (extra) messages.push(`詳細：${extra}`);
              }
              if (acquireResult.acquiredPath && acquireResult.createdTemp) {
                try { cleanupAcquisition(acquireResult.acquiredPath); } catch {}
              }
              break;
            }

            const acquiredPath = acquireResult.acquiredPath!;
            const resolvedRevision = acquireResult.resolvedRevision!;
            const createdTemp = acquireResult.createdTemp ?? false;
            const cleanupOnFail = (): void => {
              if (createdTemp) {
                try { cleanupAcquisition(acquiredPath); } catch {}
              }
            };

            const detectedFormat = detectMarketplaceFormat(acquiredPath);
            if (!detectedFormat) {
              messages.push(
                `錯誤：找不到 marketplace catalog（${CODEX_MARKETPLACE_CATALOG_RELPATH} 或 ${CLAUDE_MARKETPLACE_CATALOG_RELPATH}）— catalog 缺失，請確認 marketplace 根目錄包含正確的 catalog 檔案`,
              );
              cleanupOnFail();
              break;
            }

            const catalogResult = readMarketplaceCatalog(acquiredPath, detectedFormat);
            if (catalogResult.error || !catalogResult.catalog) {
              messages.push(`錯誤：${catalogResult.error ?? 'catalog 解析失敗'}`);
              if (catalogResult.findings.length > 0) {
                const detail = formatCatalogError(catalogResult.findings as any);
                messages.push(`錯誤：catalog 解析失敗：${detail} — catalog malformed`);
                const extra = catalogResult.findings.slice(0, 3).map((f) => `${f.code} ${f.outcome}`).join('；');
                if (extra) messages.push(`詳細：${extra}`);
              }
              cleanupOnFail();
              break;
            }

            const catalog = catalogResult.catalog;

            const sourceKey = gitSourceKey(locator);
            const snapRes = buildGitSnapshot(acquiredPath, sourceKey, {
              canonicalLocator: canonicalUrl,
              resolvedRevision,
              selectorCanonical: sourceKey.selector!,
            });
            if (!snapRes.ok || !snapRes.snapshot) {
              const outcome = snapRes.findings[0]?.outcome ?? 'snapshot 建立失敗';
              messages.push(`錯誤：snapshot 建立失敗 — ${outcome}`);
              if (snapRes.findings.length > 1) {
                const extra = snapRes.findings.slice(0, 3).map((f) => `${f.code} ${f.outcome}`).join('；');
                if (extra) messages.push(`詳細：${extra}`);
              }
              cleanupOnFail();
              break;
            }
            const fingerprint = snapRes.snapshot.fingerprint;

            const cache = new SourceCache({ agentDir: opts.agentDir });
            try {
              await cache.storeTree(acquiredPath, fingerprint);
              cache.recordIndex({
                fingerprint,
                resolvedRevision,
                canonicalLocator: canonicalUrl,
                selectorCanonical: sourceKey.selector!,
              });
            } catch {}
            if (createdTemp) {
              try { cleanupAcquisition(acquiredPath); } catch {}
            }

            const newReg = {
              id: randomUUID(),
              marketplaceName: catalog.name,
              format: detectedFormat,
              sourceKind: 'git' as const,
              source: canonicalUrl,
              snapshot: fingerprint,
            };

            state.registrations.push(newReg);
            try {
              writeMinimalBridgeState(state, opts);
            } catch (e) {
              state.registrations.pop();
              const msg = e instanceof Error ? e.message : String(e);
              messages.push(`錯誤：寫入 Bridge State 失敗：${msg}`);
              break;
            }

            messages.push(`偵測：${detectedFormat} marketplace · ${catalog.entries.length} plugins`);
            messages.push(`已註冊 "${catalog.name}"`);
          } else {
            const cwd = opts.cwd ?? process.cwd();
            const absoluteInput = isAbsolute(input) ? input : resolve(cwd, input);

            const skRes = localSourceKey(absoluteInput);
            if (!skRes.ok) {
              const reason = skRes.error || '無法解析路徑';
              messages.push(`錯誤：無法解析 marketplace 路徑 "${input}"：${reason}`);
              break;
            }
            const canonicalPath = skRes.sourceKey!.canonicalPath!;
            const sourceKeyStr = skRes.sourceKey!.key;

            const duplicate = state.registrations.find((r) => r.sourceKind === 'local' && r.source === canonicalPath);
            if (duplicate) {
              void sourceKeyStr;
              messages.push(`已註冊過相同來源 "${canonicalPath}"，想更新？\`update\`；想換？先 \`remove\` 再 \`add\``);
              break;
            }

            const detectedFormat = detectMarketplaceFormat(canonicalPath);
            if (!detectedFormat) {
              messages.push(
                `錯誤：找不到 marketplace catalog（${CODEX_MARKETPLACE_CATALOG_RELPATH} 或 ${CLAUDE_MARKETPLACE_CATALOG_RELPATH}）— catalog 缺失，請確認 marketplace 根目錄包含正確的 catalog 檔案`,
              );
              break;
            }

            const catalogResult = readMarketplaceCatalog(canonicalPath, detectedFormat);
            if (catalogResult.error || !catalogResult.catalog) {
              messages.push(`錯誤：${catalogResult.error ?? 'catalog 解析失敗'}`);
              if (catalogResult.findings.length > 0) {
                const detail = formatCatalogError(catalogResult.findings as any);
                messages.push(`錯誤：catalog 解析失敗：${detail} — catalog malformed`);
                const extra = catalogResult.findings.slice(0, 3).map((f) => `${f.code} ${f.outcome}`).join('；');
                if (extra) messages.push(`詳細：${extra}`);
              }
              break;
            }

            const catalog = catalogResult.catalog;

            const newReg = {
              id: randomUUID(),
              marketplaceName: catalog.name,
              format: detectedFormat,
              sourceKind: 'local' as const,
              source: canonicalPath,
            };

            state.registrations.push(newReg);
            try {
              writeMinimalBridgeState(state, opts);
            } catch (e) {
              state.registrations.pop();
              const msg = e instanceof Error ? e.message : String(e);
              messages.push(`錯誤：寫入 Bridge State 失敗：${msg}`);
              break;
            }

            messages.push(`偵測：${detectedFormat} marketplace · ${catalog.entries.length} plugins`);
            messages.push(`已註冊 "${catalog.name}"`);
          }
        }
        break;
      }
      case 'list': {
        // list [名稱] — filter by marketplace name if provided
        // Enhanced for #90: also show plugin enumeration with 編號／所屬 marketplace／狀態
        if (subargs.length > 0) {
          const filter = subargs[0];
          const filteredRegs = state.registrations.filter(
            (r) => r.marketplaceName === filter || r.alias === filter || r.id === filter,
          );
          if (filteredRegs.length === 0 && state.registrations.length > 0) {
            messages.push(`找不到 marketplace "${filter}"`);
            // Still show all for discoverability
            messages.push(...formatOverview(state));
            const pluginLines = formatPluginListLines(state, undefined, opts);
            if (pluginLines.length > 0) messages.push(pluginLines.join('\n'));
          } else if (filteredRegs.length > 0) {
            // Show filtered overview (reuse format but only filtered regs)
            const filteredState: MinimalBridgeState = {
              ...state,
              registrations: filteredRegs,
              installations: state.installations.filter((inst) => filteredRegs.some((r) => r.id === inst.registrationId)),
            };
            messages.push(...formatOverview(filteredState));
            const pluginLines = formatPluginListLines(state, filter, opts);
            if (pluginLines.length > 0) messages.push(pluginLines.join('\n'));
          } else {
            // No registrations at all
            messages.push('尚無可列出的 plugin 或 marketplace。');
            messages.push(USAGE_LINE);
          }
        } else {
          if (state.registrations.length === 0 && state.installations.length === 0) {
            messages.push('尚無可列出的 plugin 或 marketplace。');
            messages.push(USAGE_LINE);
          } else {
            messages.push(...formatOverview(state));
            const pluginLines = formatPluginListLines(state, undefined, opts);
            if (pluginLines.length > 0) messages.push(pluginLines.join('\n'));
          }
        }
        break;
      }
      case 'install': {
        if (subargs.length === 0) {
          messages.push('用法：/codex-marketplace install <編號|名稱>');
        } else {
          const arg = subargs[0];
          // ---- Step 0: build enumeration to resolve arg ----
          if (state.registrations.length === 0) {
            messages.push('錯誤：尚未註冊任何 marketplace，請先使用 `/codex-marketplace add <路徑>` 註冊');
            break;
          }
          const { plugins: enumeration, diagnostics } = queryMarketplacePlugins(state, opts);
          const pushCatalogErrors = (): void => {
            for (const diagnostic of diagnostics) {
              messages.push(`⚠ marketplace [${diagnostic.marketplace}] ${diagnostic.error}`);
            }
          };
          if (enumeration.length === 0) {
            messages.push('錯誤：目前沒有可安裝的 plugin（marketplace 內無可用 entry）');
            pushCatalogErrors();
            break;
          }

          let target: MarketplacePluginCandidate | undefined;
          const num = Number(arg);
          const isNumeric = !isNaN(num) && String(num) === arg && Number.isInteger(num) && num >= 1;
          if (isNumeric) {
            target = enumeration.find((e) => e.number === num);
            if (!target) {
              messages.push(`錯誤：找不到編號 ${num} 對應的 plugin（可用編號 1–${enumeration.length}）`);
              pushCatalogErrors();
              break;
            }
          } else {
            // treat as name: match the query's Plugin candidate name exactly
            const candidates = enumeration.filter((plugin) => plugin.candidateName === arg);
            if (candidates.length === 0) {
              // Also try to match manifestName of already installed? But enumeration already covers all catalog entries.
              messages.push(`錯誤：找不到名稱 "${arg}" 對應的 plugin`);
              pushCatalogErrors();
              break;
            }
            if (candidates.length > 1) {
              // Ambiguous: list candidates
              const list = candidates
                .map((candidate) => `${candidate.number}:${candidate.candidateName}[${candidate.registration.marketplaceName}]`)
                .join('、');
              messages.push(`錯誤：名稱 "${arg}" 對應多個 plugin（${list}），請改用編號安裝`);
              break;
            }
            target = candidates[0];
          }

          const targetReg = target.registration;
          const targetEntry = target.entry;

          // ---- Step 1: Unavailable Entry refusal (#91) + contained path check ----
          if (!target.structurallyInstallable) {
            messages.push(
              `錯誤：plugin "${target.candidateName}" unavailable，無法安裝：${target.unavailableReason}`,
            );
            break;
          }
          const sourceRoot = target.marketplaceRoot;
          const contained = resolveContained(sourceRoot, targetEntry.path!, 'directory');
          if (contained.outcome.kind === 'blocking') {
            messages.push(`錯誤：plugin 路徑檢查失敗（Contained Path 違規）— ${contained.outcome.reason}`);
            break;
          }
          if (contained.outcome.kind === 'missing') {
            messages.push(`錯誤：找不到 plugin 目錄（${targetEntry.path} 於 marketplace 根內不存在）`);
            break;
          }
          const pluginDir = contained.outcome.canonicalPath;

          // ---- Step 2: read manifest name (plugin id構成) ----
          const manifestRes = readManifestName(pluginDir);
          if (manifestRes.error || !manifestRes.name) {
            messages.push(`錯誤：無法讀取 plugin manifest — ${manifestRes.error}`);
            break;
          }
          const manifestName = manifestRes.name;

          // ---- Step 3: skill discovery (投影推導) ----
          const format = (targetReg.format ?? 'codex') as 'codex' | 'claude';
          const skillNames = collectSkillNames(pluginDir, format);

          // ---- Step 4: collision detection (同名衝突) ----
          // 以 helper 收斂重複邏輯：僅純邏輯，排除同 plugin 的重裝自身
          const colliding = detectCollidingSkills(
            skillNames,
            state.installations,
            (other) =>
              other.registrationId === targetReg.id &&
              (other.manifestName === manifestName || other.pluginId === manifestName),
          );
          // 同 plugin 內重複 skill 亦視為衝突（全拒）
          for (const s of skillNames) {
            const dupInSelf = skillNames.filter((x) => x === s).length > 1;
            if (dupInSelf && !colliding.includes(s)) colliding.push(s);
          }
          colliding.sort((a, b) => a.localeCompare(b));
          // For all-denied policy, if a new skill collides, existing holder also becomes denied, but we only list new's colliding.

          // ---- Step 5: write enabled installation record (重抓最新覆寫) ----
          const existingIdx = state.installations.findIndex(
            (i) => i.registrationId === targetReg.id && (i.manifestName === manifestName || i.pluginId === manifestName),
          );
          const isUpdate = existingIdx >= 0;
          const installationId = isUpdate ? state.installations[existingIdx].id : manifestName; // use manifestName as stable id for simplicity, or UUID? Use manifestName to be stable across reinstalls
          // To keep stable id for e2e expectations, use manifestName as id if not update, else preserve.
          const newInstallation: MinimalBridgeState['installations'][number] = {
            id: installationId,
            pluginId: manifestName,
            enabled: true,
            installationState: 'enabled' as const,
            registrationId: targetReg.id,
            manifestName,
            sourceKind: targetReg.sourceKind as 'local' | 'git',
            source: targetReg.source,
            snapshot: targetReg.sourceKind === 'git' ? (targetReg as unknown as { snapshot?: string }).snapshot : undefined,
            skills: skillNames,
          };

          // Backup for rollback
          const backup = isUpdate ? { ...state.installations[existingIdx] } : undefined;
          if (isUpdate) {
            state.installations[existingIdx] = newInstallation as any;
          } else {
            state.installations.push(newInstallation as any);
          }

          try {
            writeMinimalBridgeState(state, opts);
          } catch (e) {
            // rollback
            if (isUpdate && backup) {
              state.installations[existingIdx] = backup as any;
            } else {
              state.installations.pop();
            }
            const msg = e instanceof Error ? e.message : String(e);
            messages.push(`錯誤：寫入 Bridge State 失敗：${msg}`);
            break;
          }

          // ---- Step 6: output + reload flag ----
          reload = true;
          // 成功話術：不得宣稱 reload 後 skill 已在 host 內可見（host 無內省 API）
          // Must say 「已重新載入生效」 and list skills.
          if (skillNames.length === 0) {
            messages.push(`安裝 "${manifestName}"（0 skills）· 已重新載入生效`);
          } else {
            messages.push(`安裝 "${manifestName}"（${skillNames.length} skills：${skillNames.join(', ')}）· 已重新載入生效`);
          }
          if (colliding.length > 0) {
            // Per spec: 逐項列出「未投影（名稱衝突）」
            for (const name of colliding.sort((a, b) => a.localeCompare(b))) {
              messages.push(`⚠ skill "${name}" 與既有同名，未投影（名稱衝突）`);
            }
            // Also combined line for test diagnosability
            // messages.push(`未投影（名稱衝突）：${colliding.join(', ')}`);
          }
          // Optional: if update, no extra error
        }
        break;
      }
      case 'update': {
        // #94：對全部已註冊 marketplace 重抓「當下最新」（本機重讀、git 重抓），
        // 有變化的 plugin 升到最新（重裝＝更新，不引入更新計畫機械），無變化各自顯示「無變化」。
        if (state.registrations.length === 0) {
          messages.push('尚無已註冊的 marketplace。');
          break;
        }
        // 整包 deep backup：任一 marketplace 失敗不影響其他；最後一次寫入，寫失敗即回滾全部。
        const stateBackup = JSON.parse(JSON.stringify(state)) as MinimalBridgeState;
        const updateLines: string[] = [];
        let anyChanged = false;   // 有 plugin 實際升到最新 → reload＋結尾「已重新載入生效」
        let gitAdvanced = false; // git registration 已推進到新 fingerprint → 需持久化（即使無已安裝 plugin）

        for (const reg of state.registrations) {
          const display = reg.marketplaceName || reg.alias || reg.id;
          const format = (reg.format ?? 'codex') as 'codex' | 'claude';
          const insts = state.installations.filter((i) => i.registrationId === reg.id);
          const upgraded: string[] = [];
          const failures: string[] = [];

          if (reg.sourceKind === 'git') {
            // ---- git 重抓（當下最新）：ls-remote → clone → checkout → snapshot fingerprint ----
            if (!reg.snapshot || !/^[0-9a-f]{64}$/.test(reg.snapshot)) {
              updateLines.push(`⚠ marketplace [${display}] git cache 指紋缺失，無法重抓（請先重新 add）`);
              continue;
            }
            const locRes = normalizeGitLocator(reg.source);
            if (!locRes.ok) {
              updateLines.push(`⚠ marketplace [${display}] Git 網址不合法：${locRes.findings[0]?.outcome ?? '未知錯誤'}`);
              continue;
            }
            let acquireResult;
            try {
              acquireResult = await acquireGitSource({
                locator: locRes.locator!,
                executor: opts.gitExecutor,
                trust: acquireTrust,
              });
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              updateLines.push(`錯誤：git 重抓失敗 — ${msg}`);
              continue;
            }
            if (!acquireResult.ok) {
              const outcome = acquireResult.findings[0]?.outcome ?? acquireResult.stderr ?? 'git 重抓失敗';
              updateLines.push(`錯誤：git 重抓失敗 — ${outcome}`);
              if (acquireResult.findings.length > 1) {
                const extra = acquireResult.findings.slice(1, 3).map((f) => f.outcome).join('；');
                if (extra) updateLines.push(`詳細：${extra}`);
              }
              if (acquireResult.acquiredPath && acquireResult.createdTemp) {
                try { cleanupAcquisition(acquireResult.acquiredPath); } catch {}
              }
              continue;
            }

            const acquiredPath = acquireResult.acquiredPath!;
            const resolvedRevision = acquireResult.resolvedRevision!;
            const createdTemp = acquireResult.createdTemp ?? false;
            const cleanupAcquired = (): void => {
              if (createdTemp) {
                try { cleanupAcquisition(acquiredPath); } catch {}
              }
            };

            const sourceKey = gitSourceKey(locRes.locator!);
            const snapRes = buildGitSnapshot(acquiredPath, sourceKey, {
              canonicalLocator: reg.source,
              resolvedRevision,
              selectorCanonical: sourceKey.selector!,
            });
            if (!snapRes.ok || !snapRes.snapshot) {
              cleanupAcquired();
              updateLines.push(`⚠ marketplace [${display}] snapshot 建立失敗 — ${snapRes.findings[0]?.outcome ?? '未知錯誤'}`);
              continue;
            }
            const fingerprint = snapRes.snapshot.fingerprint;

            if (fingerprint === reg.snapshot) {
              // 當下最新與上次相同 → 無變化
              cleanupAcquired();
              updateLines.push(`${display}  重新抓取… 無變化`);
              continue;
            }

            // 有新版本：寫入 fingerprint 位址化的新 cache entry，registration 指向新材料
            const cache = new SourceCache({ agentDir: opts.agentDir });
            try {
              await cache.storeTree(acquiredPath, fingerprint);
              cache.recordIndex({
                fingerprint,
                resolvedRevision,
                canonicalLocator: reg.source,
                selectorCanonical: sourceKey.selector!,
              });
            } catch (e) {
              cleanupAcquired();
              const msg = e instanceof Error ? e.message : String(e);
              updateLines.push(`錯誤：cache 寫入失敗（fingerprint ${fingerprint.slice(0, 12)}…）：${msg}`);
              continue;
            }
            cleanupAcquired();
            reg.snapshot = fingerprint;
            gitAdvanced = true;

            // 重裝＝更新：從最新 cache 材料重裝全部已安裝 plugin（投影直讀新位址）
            const cacheRoot = resolveMarketplaceRoot(reg, opts);
            if (cacheRoot) {
              for (const inst of insts) {
                const outcome = rereadInstalledPlugin(cacheRoot, format, inst, state.installations);
                if (!outcome.ok) {
                  failures.push(`${inst.manifestName} 更新失敗：${outcome.error}`);
                  continue;
                }
                inst.manifestName = outcome.manifestName;
                inst.pluginId = outcome.manifestName;
                inst.skills = outcome.skillNames;
                inst.snapshot = fingerprint;
                upgraded.push(outcome.manifestName);
                for (const c of outcome.colliding) {
                  updateLines.push(`⚠ skill "${c}" 與既有同名，未投影（名稱衝突）`);
                }
              }
            } else {
              for (const inst of insts) failures.push(`${inst.manifestName} 更新失敗：cache 材料無法解析`);
            }

            for (const f of failures) updateLines.push(`⚠ marketplace [${display}] ${f}`);
            if (upgraded.length > 0) {
              updateLines.push(`${display}  重新抓取… ${upgraded.join(', ')} 有新版本`);
              anyChanged = true;
            } else if (insts.length === 0) {
              // upstream 移動但沒有已安裝 plugin：registration 已指向最新，下次 install 即用最新
              updateLines.push(`${display}  重新抓取… 有新版本`);
            }
          } else {
            // ---- 本機重讀（live 路徑）----
            if (!reg.source || !existsSync(reg.source)) {
              updateLines.push(`⚠ marketplace [${display}] 本機路徑不存在（${reg.source ?? '未記錄'}）`);
              continue;
            }
            // 先 probe catalog：不可讀時不能聲稱「無變化」，必須明示（不靜默略過）
            const probe = readMarketplaceCatalog(reg.source, format);
            if (probe.error) {
              updateLines.push(`⚠ marketplace [${display}] ${probe.error}`);
              continue;
            }
            if (insts.length === 0) {
              updateLines.push(`${display}  重新抓取… 無變化`);
              continue;
            }
            let changed = false;
            for (const inst of insts) {
              const outcome = rereadInstalledPlugin(reg.source, format, inst, state.installations);
              if (!outcome.ok) {
                failures.push(`${inst.manifestName} 更新失敗：${outcome.error}`);
                continue;
              }
              inst.manifestName = outcome.manifestName;
              inst.pluginId = outcome.manifestName;
              inst.skills = outcome.skillNames;
              changed = changed || outcome.changed;
              upgraded.push(outcome.manifestName);
              for (const c of outcome.colliding) {
                updateLines.push(`⚠ skill "${c}" 與既有同名，未投影（名稱衝突）`);
              }
            }
            for (const f of failures) updateLines.push(`⚠ marketplace [${display}] ${f}`);
            if (upgraded.length === 0) continue; // 全部失敗，⚠ 已明示
            if (changed) {
              updateLines.push(`${display}  重新抓取… ${upgraded.join(', ')} 有新版本`);
              anyChanged = true;
            } else {
              updateLines.push(`${display}  重新抓取… 無變化`);
            }
          }
        }

        if (gitAdvanced || anyChanged) {
          try {
            writeMinimalBridgeState(state, opts);
          } catch (e) {
            // 寫入失敗 → 回滾全部已套用的更新（registration snapshot 與安裝記錄）
            state.registrations = stateBackup.registrations;
            state.installations = stateBackup.installations;
            const msg = e instanceof Error ? e.message : String(e);
            messages.push(`錯誤：寫入 Bridge State 失敗：${msg}`);
            break;
          }
          if (anyChanged) reload = true;
        }
        messages.push(...updateLines);
        if (anyChanged) messages.push('已重新載入生效');
        break;
      }
      case 'disable': {
        if (subargs.length === 0) {
          messages.push('用法：/codex-marketplace disable <名稱>');
        } else {
          const name = subargs[0];
          const matches = findInstallationsByName(state, name);
          if (matches.length === 0) {
            messages.push(`錯誤：找不到已安裝的 plugin "${name}"`);
          } else if (matches.length > 1) {
            const list = matches.map((m) => `${m.manifestName}[${m.registrationId}]`).join('、');
            messages.push(`錯誤：名稱 "${name}" 對應多個已安裝 plugin（${list}），請改用更精確的識別`);
          } else {
            const target = matches[0];
            const idx = state.installations.indexOf(target);
            const inst = target;
            if (!isInstallationEnabled(inst as any)) {
              messages.push(`"${name}" 已是停用狀態`);
            } else {
              const backup = { ...inst };
              setInstallationEnabled(inst as any, false);
              const writeErr = tryWriteState(state, opts);
              if (!writeErr) {
                messages.push(`已停用 "${name}"`);
              } else {
                state.installations[idx] = backup as any;
                messages.push(`錯誤：寫入 Bridge State 失敗：${writeErr}`);
              }
            }
          }
        }
        break;
      }
      case 'enable': {
        if (subargs.length === 0) {
          messages.push('用法：/codex-marketplace enable <名稱>');
        } else {
          const name = subargs[0];
          const matches = findInstallationsByName(state, name);
          if (matches.length === 0) {
            messages.push(`錯誤：找不到已安裝的 plugin "${name}"`);
          } else if (matches.length > 1) {
            const list = matches.map((m) => `${m.manifestName}[${m.registrationId}]`).join('、');
            messages.push(`錯誤：名稱 "${name}" 對應多個已安裝 plugin（${list}），請改用更精確的識別`);
          } else {
            const target = matches[0];
            const idx = state.installations.indexOf(target);
            const inst = target;
            if (isInstallationEnabled(inst as any)) {
              messages.push(`"${name}" 已是啟用狀態`);
            } else {
              const reg = state.registrations.find((r) => r.id === inst.registrationId);
              // 收斂 best-effort 邊界：僅 I/O 包 try/catch，純邏輯不拋；失敗則沿用舊 skills
              const refreshedSkills = reg ? tryRereadSkills(reg as any, inst as any, opts) : undefined;
              const backup = { ...inst };
              setInstallationEnabled(inst as any, true);
              if (refreshedSkills) (inst as any).skills = refreshedSkills;
              const skillList = (refreshedSkills ?? inst.skills ?? []) as string[];
              const colliding = detectCollidingSkills(skillList, state.installations, (other) => other.id === inst.id);
              const writeErr = tryWriteState(state, opts);
              if (!writeErr) {
                reload = true;
                if (skillList.length === 0) {
                  messages.push(`已啟用 "${name}"（0 skills）· 已重新載入生效`);
                } else {
                  messages.push(`已啟用 "${name}"（${skillList.length} skills：${skillList.join(', ')}）· 已重新載入生效`);
                }
                for (const c of colliding) {
                  messages.push(`⚠ skill "${c}" 與既有同名，未投影（名稱衝突）`);
                }
              } else {
                state.installations[idx] = backup as any;
                messages.push(`錯誤：寫入 Bridge State 失敗：${writeErr}`);
              }
            }
          }
        }
        break;
      }
      case 'remove': {
        if (subargs.length === 0) {
          messages.push('用法：/codex-marketplace remove <名稱>');
        } else {
          const name = subargs[0];
          const matches = findInstallationsByName(state, name);
          if (matches.length === 0) {
            messages.push(`錯誤：找不到已安裝的 plugin "${name}"`);
          } else if (matches.length > 1) {
            const list = matches.map((m) => `${m.manifestName}[${m.registrationId}]`).join('、');
            messages.push(`錯誤：名稱 "${name}" 對應多個已安裝 plugin（${list}），請改用更精確的識別`);
          } else {
            const target = matches[0];
            const idx = state.installations.indexOf(target);
            const backup = state.installations.slice();
            state.installations.splice(idx, 1);
            const writeErr = tryWriteState(state, opts);
            if (!writeErr) {
              messages.push(`已移除 "${name}"`);
            } else {
              state.installations = backup as any;
              messages.push(`錯誤：寫入 Bridge State 失敗：${writeErr}`);
            }
          }
        }
        break;
      }
      case 'forget': {
        if (subargs.length === 0) {
          messages.push('用法：/codex-marketplace forget <名稱>');
        } else {
          const name = subargs[0];
          const matches = findRegistrationsByName(state, name);
          if (matches.length === 0) {
            messages.push(`錯誤：找不到 marketplace "${name}"`);
          } else if (matches.length > 1) {
            const list = matches.map((r) => `${r.marketplaceName || r.alias || r.id}[${r.id}]`).join('、');
            messages.push(`錯誤：名稱 "${name}" 對應多個 marketplace（${list}），請改用更精確的識別`);
          } else {
            const reg = matches[0];
            const regIdx = state.registrations.indexOf(reg);
            const relatedCount = state.installations.filter((i) => i.registrationId === reg.id).length;
            const backupRegs = state.registrations.slice();
            const backupInsts = state.installations.slice();
            state.registrations.splice(regIdx, 1);
            state.installations = state.installations.filter((i) => i.registrationId !== reg.id);
            const writeErr = tryWriteState(state, opts);
            if (!writeErr) {
              if (relatedCount > 0) {
                messages.push(`已移除 marketplace "${name}"（含 ${relatedCount} 個安裝）`);
              } else {
                messages.push(`已移除 marketplace "${name}"`);
              }
            } else {
              state.registrations = backupRegs as any;
              state.installations = backupInsts as any;
              messages.push(`錯誤：寫入 Bridge State 失敗：${writeErr}`);
            }
          }
        }
        break;
      }
      default: {
        messages.push(`未知子命令 "${rawArgs[0]}"`);
        messages.push(USAGE_LINE);
        break;
      }
    }
  }

  return {
    messages,
    lines: messages,
    output: messages.join('\n\n'),
    reload,
    stateReset: wasReset,
  };
}
