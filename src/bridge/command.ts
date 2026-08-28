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

import { readMinimalBridgeState, writeMinimalBridgeState, type MinimalBridgeState } from './state.js';
import { BUDGET } from '../registration/budget.js';
import { localSourceKey } from '../registration/source-key.js';
import {
  catalogContractFor,
  detectMarketplaceFormat,
  CODEX_MARKETPLACE_CATALOG_RELPATH,
  CLAUDE_MARKETPLACE_CATALOG_RELPATH,
} from '../registration/format.js';
import { resolveContained } from '../registration/contained.js';
import type { MarketplaceEntry } from '../registration/catalog.js';

export interface CommandOptions {
  statePath?: string;
  agentDir?: string;
  cwd?: string;
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
      const isEnabled = inst.enabled !== false && inst.installationState !== 'disabled';
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

// ---- Plugin enumeration helpers (#90) ----

interface EnumeratedPlugin {
  number: number;
  reg: MinimalBridgeState['registrations'][number];
  entry: MarketplaceEntry;
  pluginName: string;
  status: '可安裝' | '已裝啟用' | '已裝停用';
}

function getCatalogEntriesForReg(reg: MinimalBridgeState['registrations'][number]): MarketplaceEntry[] {
  const format = reg.format ?? 'codex';
  const contract = catalogContractFor(format as any);
  const catalogPath = join(reg.source, ...contract.relPath.split('/'));
  try {
    if (!existsSync(catalogPath)) return [];
    if (statSync(catalogPath).size > BUDGET.maxCatalogBytes) return [];
    const raw = readFileSync(catalogPath, 'utf-8');
    if (!raw.trim()) return [];
    const parsed = JSON.parse(raw);
    const res = contract.parse(parsed);
    if (res.catalog) return res.catalog.entries;
    // Even if not ok, return entries if present (e.g., partial)
    if ((res as any).catalog?.entries) return (res as any).catalog.entries;
    return [];
  } catch {
    return [];
  }
}

function enumeratePlugins(state: MinimalBridgeState): EnumeratedPlugin[] {
  const result: EnumeratedPlugin[] = [];
  let counter = 1;
  for (const reg of state.registrations) {
    const entries = getCatalogEntriesForReg(reg);
    for (const entry of entries) {
      // Only count entries that can supply a plugin? For #90 we include all local entries; but we include all entries for numbering
      // To keep numbers stable, include every entry regardless of availability? However unavailable entries should still be listed as unavailable?
      // For now, include all entries; status will reflect可安裝 even if unavailable? But we will include all.
      const pluginName = entry.name ?? (entry.path ? basename(entry.path) : `plugin-${entry.ordinal}`);
      const inst = state.installations.find(
        (i) => i.registrationId === reg.id && (i.manifestName === pluginName || i.pluginId === pluginName),
      );
      let status: EnumeratedPlugin['status'];
      if (!inst) status = '可安裝';
      else if (inst.enabled !== false && inst.installationState !== 'disabled') status = '已裝啟用';
      else status = '已裝停用';
      result.push({ number: counter, reg, entry, pluginName, status });
      counter++;
    }
  }
  return result;
}

function formatPluginListLines(state: MinimalBridgeState, filter?: string): string[] {
  const enumeration = enumeratePlugins(state);
  let filtered = enumeration;
  if (filter) {
    filtered = enumeration.filter(
      (e) => e.reg.marketplaceName === filter || e.reg.alias === filter || e.reg.id === filter,
    );
  }
  if (enumeration.length === 0) {
    // No plugins at all (e.g., empty catalog or no registrations)
    return [];
  }
  if (filter && filtered.length === 0) {
    return [`找不到 marketplace "${filter}"`];
  }
  const lines: string[] = ['Plugins（編號／所屬 marketplace／狀態）'];
  const show = filter ? filtered : enumeration;
  for (const e of show) {
    const num = padRight(` ${e.number}`, 4);
    const name = padRight(e.pluginName, 18);
    const mkt = padRight(`[${e.reg.marketplaceName || e.reg.alias || e.reg.id}]`, 20);
    const status = e.status;
    lines.push(`${num}${name}${mkt}${status}`);
  }
  return lines;
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

  // Strip leading command token if passed
  if (rawArgs.length > 0 && (rawArgs[0] === '/codex-marketplace' || rawArgs[0] === 'codex-marketplace')) {
    rawArgs.shift();
  }

  const { state, wasReset, resetReason } = readMinimalBridgeState(opts);

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
          // Resolve input path against cwd for relative paths
          const cwd = opts.cwd ?? process.cwd();
          const absoluteInput = isAbsolute(input) ? input : resolve(cwd, input);

          // 1) Resolve Source Key (local realpath)
          const skRes = localSourceKey(absoluteInput);
          if (!skRes.ok) {
            const reason = skRes.error || '無法解析路徑';
            messages.push(`錯誤：無法解析 marketplace 路徑 "${input}"：${reason}`);
            break;
          }
          const canonicalPath = skRes.sourceKey!.canonicalPath!;
          const sourceKeyStr = skRes.sourceKey!.key;

          // 2) Duplicate detection (same realpath)
          const duplicate = state.registrations.find(
            (r) => r.sourceKind === 'local' && r.source === canonicalPath,
          );
          // Also check via key equality in case stored source differs in slash style; canonicalPath comparison is primary.
          if (duplicate) {
            void sourceKeyStr; // keep for future git distinctness
            messages.push(
              `已註冊過相同來源 "${canonicalPath}"，想更新？\`update\`；想換？先 \`remove\` 再 \`add\``,
            );
            break;
          }

          // 3) Format detection (codex prioritized)
          const detectedFormat = detectMarketplaceFormat(canonicalPath);
          if (!detectedFormat) {
            messages.push(
              `錯誤：找不到 marketplace catalog（${CODEX_MARKETPLACE_CATALOG_RELPATH} 或 ${CLAUDE_MARKETPLACE_CATALOG_RELPATH}）— catalog 缺失，請確認 marketplace 根目錄包含正確的 catalog 檔案`,
            );
            break;
          }

          const contract = catalogContractFor(detectedFormat);
          const catalogPath = join(canonicalPath, ...contract.relPath.split('/'));

          // 4) Budget + read catalog file
          let catalogBytes = 0;
          try {
            catalogBytes = statSync(catalogPath).size;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            messages.push(
              `錯誤：找不到 marketplace catalog（${contract.relPath}）：${msg} — catalog 缺失`,
            );
            break;
          }
          if (catalogBytes > BUDGET.maxCatalogBytes) {
            messages.push(
              `錯誤：catalog 檔案過大（${catalogBytes} bytes > ${BUDGET.maxCatalogBytes}）— 超過 Validation Budget 上限，catalog 無法解析`,
            );
            break;
          }

          let raw: string;
          try {
            raw = readFileSync(catalogPath, 'utf-8');
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            messages.push(`錯誤：無法讀取 catalog（${contract.relPath}）：${msg}`);
            break;
          }

          if (raw.trim().length === 0) {
            messages.push(`錯誤：catalog 解析失敗（${contract.relPath}）：檔案為空 — catalog malformed`);
            break;
          }

          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            messages.push(`錯誤：catalog 解析失敗（${contract.relPath}）：${msg} — catalog malformed，無法解析 JSON`);
            break;
          }

          const catalogResult = contract.parse(parsed);
          if (!catalogResult.ok) {
            const detail = formatCatalogError(catalogResult.findings as any);
            const codes = catalogResult.findings.map((f) => f.code).join(', ');
            messages.push(
              `錯誤：catalog 解析失敗（${contract.relPath}）：${detail} — catalog malformed${codes ? ` (${codes})` : ''}`,
            );
            // Also surface first finding outcome for test diagnosability
            if (catalogResult.findings.length > 0) {
              const extra = catalogResult.findings
                .slice(0, 3)
                .map((f) => `${f.code} ${f.outcome}`)
                .join('；');
              if (extra) messages.push(`詳細：${extra}`);
            }
            break;
          }

          const catalog = catalogResult.catalog!;

          // 5) Persist registration
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
            // Rollback on write failure
            state.registrations.pop();
            const msg = e instanceof Error ? e.message : String(e);
            messages.push(`錯誤：寫入 Bridge State 失敗：${msg}`);
            break;
          }

          messages.push(`偵測：${detectedFormat} marketplace · ${catalog.entries.length} plugins`);
          messages.push(`已註冊 "${catalog.name}"`);
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
            const pluginLines = formatPluginListLines(state);
            if (pluginLines.length > 0) messages.push(pluginLines.join('\n'));
          } else if (filteredRegs.length > 0) {
            // Show filtered overview (reuse format but only filtered regs)
            const filteredState: MinimalBridgeState = {
              ...state,
              registrations: filteredRegs,
              installations: state.installations.filter((inst) => filteredRegs.some((r) => r.id === inst.registrationId)),
            };
            messages.push(...formatOverview(filteredState));
            const pluginLines = formatPluginListLines(state, filter);
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
            const pluginLines = formatPluginListLines(state);
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
          const enumeration = enumeratePlugins(state);
          if (enumeration.length === 0) {
            messages.push('錯誤：目前沒有可安裝的 plugin（marketplace 內無可用 entry）');
            break;
          }

          let target: EnumeratedPlugin | undefined;
          const num = Number(arg);
          const isNumeric = !isNaN(num) && String(num) === arg && Number.isInteger(num) && num >= 1;
          if (isNumeric) {
            target = enumeration.find((e) => e.number === num);
            if (!target) {
              messages.push(`錯誤：找不到編號 ${num} 對應的 plugin（可用編號 1–${enumeration.length}）`);
              break;
            }
          } else {
            // treat as name: match pluginName exactly
            const candidates = enumeration.filter((e) => e.pluginName === arg);
            if (candidates.length === 0) {
              // Also try to match manifestName of already installed? But enumeration already covers all catalog entries.
              messages.push(`錯誤：找不到名稱 "${arg}" 對應的 plugin`);
              break;
            }
            if (candidates.length > 1) {
              // Ambiguous: list candidates
              const list = candidates.map((c) => `${c.number}:${c.pluginName}[${c.reg.marketplaceName}]`).join('、');
              messages.push(`錯誤：名稱 "${arg}" 對應多個 plugin（${list}），請改用編號安裝`);
              break;
            }
            target = candidates[0];
          }

          const targetReg = target.reg;
          const targetEntry = target.entry;

          // ---- Step 1: contained path check ----
          if (!targetEntry.path) {
            messages.push(`錯誤：plugin "${target.pluginName}" 沒有可解析的本地路徑，無法安裝（unsupported source kind）`);
            break;
          }
          const contained = resolveContained(targetReg.source, targetEntry.path, 'directory');
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
          // Collect existing skill names from other enabled installations
          const existingSkillCounts = new Map<string, number>();
          // Also include other installations' skills
          for (const inst of state.installations) {
            const isEnabled = inst.enabled !== false && inst.installationState !== 'disabled';
            if (!isEnabled) continue;
            // For re-install of same plugin, exclude self from collision count temporarily
            if (inst.registrationId === targetReg.id && (inst.manifestName === manifestName || inst.pluginId === manifestName)) {
              continue;
            }
            if (!inst.skills) continue;
            for (const s of inst.skills) {
              existingSkillCounts.set(s, (existingSkillCounts.get(s) ?? 0) + 1);
            }
          }
          // Now for the new plugin's skills, determine colliding ones
          const colliding: string[] = [];
          const projectedForThisInstall: string[] = [];
          for (const s of skillNames) {
            if (existingSkillCounts.has(s)) {
              colliding.push(s);
            } else {
              // also check duplicate within same plugin? Collect within-plugin duplicates as colliding (all denied)
              // For now, if skillNames has duplicates, treat as colliding.
              const dupInSelf = skillNames.filter((x) => x === s).length > 1;
              if (dupInSelf) colliding.push(s);
              else projectedForThisInstall.push(s);
            }
          }
          // For all-denied policy, if a new skill collides, existing holder also becomes denied, but we only list new's colliding.

          // ---- Step 5: write enabled installation record (重抓最新覆寫) ----
          const existingIdx = state.installations.findIndex(
            (i) => i.registrationId === targetReg.id && (i.manifestName === manifestName || i.pluginId === manifestName),
          );
          const isUpdate = existingIdx >= 0;
          const installationId = isUpdate ? state.installations[existingIdx].id : manifestName; // use manifestName as stable id for simplicity, or UUID? Use manifestName to be stable across reinstalls
          // To keep stable id for e2e expectations, use manifestName as id if not update, else preserve.
          const newInstallation = {
            id: installationId,
            pluginId: manifestName,
            enabled: true,
            installationState: 'enabled' as const,
            registrationId: targetReg.id,
            manifestName,
            sourceKind: 'local' as const,
            source: targetReg.source,
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
        if (state.registrations.length === 0) {
          messages.push('尚無已註冊的 marketplace。');
        } else {
          messages.push('更新 marketplace（骨架建立中，功能即將推出）');
        }
        break;
      }
      case 'disable': {
        if (subargs.length === 0) {
          messages.push('用法：/codex-marketplace disable <名稱>');
        } else {
          messages.push(`停用 "${subargs[0]}"（骨架建立中，功能即將推出）`);
        }
        break;
      }
      case 'enable': {
        if (subargs.length === 0) {
          messages.push('用法：/codex-marketplace enable <名稱>');
        } else {
          messages.push(`啟用 "${subargs[0]}"（骨架建立中，功能即將推出）`);
        }
        break;
      }
      case 'remove': {
        if (subargs.length === 0) {
          messages.push('用法：/codex-marketplace remove <名稱>');
        } else {
          messages.push(`移除 "${subargs[0]}"（骨架建立中，功能即將推出）`);
        }
        break;
      }
      case 'forget': {
        if (subargs.length === 0) {
          messages.push('用法：/codex-marketplace forget <名稱>');
        } else {
          messages.push(`移除 marketplace "${subargs[0]}"（骨架建立中，功能即將推出）`);
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
