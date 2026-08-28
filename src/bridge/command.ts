/**
 * Pure runCommand dispatch seam (#88, #89, #87).
 *
 * Single pure entry point: runCommand(argv) -> { messages, lines, output, reload, stateReset }
 * Does not touch Pi host APIs; safe for direct assertion in pure Node environments.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import { readMinimalBridgeState, writeMinimalBridgeState, type MinimalBridgeState } from './state.js';
import { BUDGET } from '../registration/budget.js';
import { localSourceKey } from '../registration/source-key.js';
import {
  catalogContractFor,
  detectMarketplaceFormat,
  CODEX_MARKETPLACE_CATALOG_RELPATH,
  CLAUDE_MARKETPLACE_CATALOG_RELPATH,
} from '../registration/format.js';

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
        if (subargs.length > 0) {
          const filter = subargs[0];
          const filtered = state.registrations.filter(
            (r) => r.marketplaceName === filter || r.alias === filter || r.id === filter,
          );
          if (filtered.length === 0 && state.registrations.length > 0) {
            messages.push(`找不到 marketplace "${filter}"`);
            // Still show all for discoverability
            messages.push(...formatOverview(state));
          } else if (filtered.length > 0) {
            // Show filtered overview (reuse format but only filtered regs)
            const filteredState: MinimalBridgeState = {
              ...state,
              registrations: filtered,
              installations: state.installations.filter((inst) => filtered.some((r) => r.id === inst.registrationId)),
            };
            messages.push(...formatOverview(filteredState));
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
          }
        }
        break;
      }
      case 'install': {
        if (subargs.length === 0) {
          messages.push('用法：/codex-marketplace install <編號|名稱>');
        } else {
          messages.push(`安裝 "${subargs[0]}"（骨架建立中，功能即將推出）`);
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
