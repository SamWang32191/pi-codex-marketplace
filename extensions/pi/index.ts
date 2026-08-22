/**
 * Bridge Extension — Pi runtime entry for pi-codex-marketplace
 * Single extension "pi" package, Pi 0.84.2 compatible.
 *
 * Provides:
 * - /codex-marketplace command: partitioned Global Scope / Project Scope empty state
 * - Bridge State reading via dual-document store (global + project)
 *
 * Domain vocabulary follows CONTEXT.md (Bridge Package, Bridge Extension, Bridge State, State Revision, etc.)
 */

import type { ExtensionAPI, Theme } from '@earendil-works/pi-coding-agent';
import { truncateToWidth } from '@earendil-works/pi-tui';

import { readBridgeStateSync } from '../../src/bridge-state/store.js';
import type { BridgeState, ReadResult } from '../../src/bridge-state/types.js';
import { runLocalRegistrationFlow } from './registration.js';
import { runGitRegistrationFlow } from './git-registration.js';
import { runPluginInstallationFlow, runPluginStateFlow } from './installation.js';
import {
  runEffectiveStateView,
  runRemoveScopeOverrideFlow,
  runScopeOverrideFlow,
} from './scope-overrides.js';

// Closed helper to format state summary for disclosure
function formatStateSummary(result: ReadResult, scopeLabel: string): string {
  if (result.status === 'missing') {
    const s = result.state!;
    return `${scopeLabel}: empty · schema v${s.schemaVersion} · revision ${s.stateRevision} · 0 registrations · 0 installations`;
  }
  if (result.status === 'ok') {
    const s = result.state!;
    const regCount = s.registrations.length;
    const instEnabled = s.installations.filter((i) => i.installationState === 'enabled').length;
    const instDisabled = s.installations.filter((i) => i.installationState === 'disabled').length;
    const ov = s.scopeOverrides.length;
    const ovPart = scopeLabel === 'Project Scope' ? ` · ${ov} overrides` : '';
    return `${scopeLabel}: revision ${s.stateRevision} · ${regCount} registrations · ${instEnabled} enabled / ${instDisabled} disabled${ovPart}`;
  }
  if (result.status === 'incompatible') {
    return `${scopeLabel}: incompatible — ${result.error} (requires newer Bridge Package)`;
  }
  return `${scopeLabel}: corrupted — ${result.error} (Persistence Indeterminate, no auto-rollback)`;
}

class MarketplaceComponent {
  private theme: Theme;
  private onClose: () => void;
  private global: ReadResult;
  private project: ReadResult;
  private cwd: string;
  private width?: number;
  private cached?: string[];

  constructor(
    global: ReadResult,
    project: ReadResult,
    cwd: string,
    theme: Theme,
    onClose: () => void,
  ) {
    this.global = global;
    this.project = project;
    this.cwd = cwd;
    this.theme = theme;
    this.onClose = onClose;
  }

  handleInput(data: string): void {
    // Close on Escape, q, or Ctrl+C
    if (data === '\x1b' || data === 'q' || data === '\x03') {
      this.onClose();
    }
  }

  render(width: number): string[] {
    if (this.cached && this.width === width) return this.cached;
    const th = this.theme;
    const lines: string[] = [];
    const hr = th.fg('borderMuted', '─'.repeat(Math.max(0, width - 2)));

    lines.push('');
    lines.push(truncateToWidth(th.fg('accent', th.bold(' Codex Marketplace ')) + th.fg('borderMuted', '─'.repeat(Math.max(0, width - 22))), width));
    lines.push(truncateToWidth(`  ${th.fg('dim', 'Bridge State · partitioned by Global Scope / Project Scope · State Revision per scope · Effective State derived at read time')}`, width));
    lines.push('');

    // Global Section
    lines.push(truncateToWidth(`  ${th.fg('accent', '▸ Global Scope')}  ${th.fg('dim', formatStateSummary(this.global, 'Global Scope'))}`, width));
    lines.push(truncateToWidth(`    ${th.fg('dim', 'Global document: {getAgentDir()}/codex-marketplace/state.json — authoritative fields only: schemaVersion / stateRevision / registrations / installations / scopeOverrides')}`, width));
    if (this.global.status === 'ok' || this.global.status === 'missing') {
      const s: BridgeState = this.global.state!;
      if (s.registrations.length === 0 && s.installations.length === 0) {
        lines.push(truncateToWidth(`    ${th.fg('muted', '— No marketplace registrations —')}`, width));
        lines.push(truncateToWidth(`    ${th.fg('dim', 'Empty registration list — use the Registration flow (「註冊本地 Marketplace…」menu) to add a local Marketplace Source. Each Registration gets an immutable Registration ID (UUIDv4) before preflight.')}`, width));
        lines.push(truncateToWidth(`    ${th.fg('dim', 'Projected Plugins will appear here once installations are created. Collision is per-skill; whole-Plugin classification is atomic.')}`, width));
      } else {
        // Future tickets will render registrations/installations incrementally
        for (const r of s.registrations) {
          lines.push(truncateToWidth(`    ${th.fg('text', `• ${r.alias ?? r.marketplaceName ?? r.id.slice(0, 8)}`)} ${th.fg('dim', `(${r.sourceKind ?? 'unknown'} · ${r.id.slice(0, 8)}…)`)}`, width));
        }
        for (const inst of s.installations) {
          const badge = inst.installationState === 'enabled' ? th.fg('success', 'enabled') : th.fg('dim', 'disabled');
          lines.push(truncateToWidth(`      ${th.fg('muted', inst.pluginId)} — ${badge}`, width));
        }
      }
    } else {
      lines.push(truncateToWidth(`    ${th.fg('error', this.global.status === 'incompatible' ? 'Incompatible schema — update Bridge Package' : 'Persistence Indeterminate — file corrupted, no auto-rollback')}`, width));
      if (this.global.error) lines.push(truncateToWidth(`    ${th.fg('dim', this.global.error)}`, width));
    }
    lines.push('');

    // Project Section
    lines.push(truncateToWidth(`  ${th.fg('accent', '▸ Project Scope')}  ${th.fg('dim', formatStateSummary(this.project, 'Project Scope'))}`, width));
    lines.push(truncateToWidth(`    ${th.fg('dim', `Project document: ${this.cwd}/.pi/codex-marketplace/state.json — Project Trust gates mutation/effective participation; overrides suppress Global without mutating it`)}`, width));
    if (this.project.status === 'ok' || this.project.status === 'missing') {
      const s: BridgeState = this.project.state!;
      if (s.registrations.length === 0 && s.installations.length === 0 && s.scopeOverrides.length === 0) {
        lines.push(truncateToWidth(`    ${th.fg('muted', '— No project registrations —')}`, width));
        lines.push(truncateToWidth(`    ${th.fg('dim', 'Project Scope inherits Global registrations via Effective State; add project-local registrations or Scope Overrides to diverge.')}`, width));
        lines.push(truncateToWidth(`    ${th.fg('dim', 'Overrides are sparse, keyed by Registration ID / Installation ID; removing an override reveals the inherited Global record.')}`, width));
      } else {
        for (const r of s.registrations) {
          lines.push(truncateToWidth(`    ${th.fg('text', `• ${r.alias ?? r.marketplaceName ?? r.id.slice(0, 8)}`)} ${th.fg('dim', `(${r.sourceKind ?? 'unknown'} · ${r.id.slice(0, 8)}…)`)}`, width));
        }
        for (const inst of s.installations) {
          const badge = inst.installationState === 'enabled' ? th.fg('success', 'enabled') : th.fg('dim', 'disabled');
          lines.push(truncateToWidth(`      ${th.fg('muted', inst.pluginId)} — ${badge}`, width));
        }
        for (const ov of s.scopeOverrides) {
          lines.push(truncateToWidth(`    ${th.fg('warning', `⊘ override ${ov.kind} ${ov.targetId.slice(0, 8)}…`)}`, width));
        }
      }
    } else {
      lines.push(truncateToWidth(`    ${th.fg('error', this.project.status === 'incompatible' ? 'Incompatible schema — update Bridge Package' : 'Persistence Indeterminate — file corrupted, no auto-rollback')}`, width));
      if (this.project.error) lines.push(truncateToWidth(`    ${th.fg('dim', this.project.error)}`, width));
    }

    lines.push('');
    lines.push(truncateToWidth(hr, width));
    lines.push(truncateToWidth(`  ${th.fg('dim', 'Bridge State holds only registrations / installations (with Installation State) / scopeOverrides / schemaVersion / stateRevision. Effective State, catalogs, compatibility, diagnostics are recomputed.')}`, width));
    lines.push(truncateToWidth(`  ${th.fg('dim', 'State Revision is opaque monotonic per scope; writes are atomic (temp→fsync→rename) under file lock with read-after-verify. Corrupted/unknown schema ⇒ Indeterminate/incompatible, never auto-rollback.')}`, width));
    lines.push(truncateToWidth(`  ${th.fg('dim', 'Scope Override / Effective State / Runtime Skill Collision flows are available: 建立或移除 Override、檢視投影與碰撞診斷。Available 僅由宿主獨立證據確立。')}`, width));
    lines.push('');
    lines.push(truncateToWidth(`  ${th.fg('dim', 'Press Esc / q to close · 「註冊本地 Marketplace…」執行驗證 + 綁定確認（預設 No）的端到端本地註冊流。')}`, width));
    lines.push('');

    this.width = width;
    this.cached = lines;
    return lines;
  }

  invalidate(): void {
    this.cached = undefined;
    this.width = undefined;
  }
}

export default function (pi: ExtensionAPI) {
  pi.on('session_start', async (_event, ctx) => {
    // No startup reconciliation yet (future tickets: Pending Application etc.)
    // Scaffold just ensures extension loads cleanly.
  });

  pi.registerCommand('codex-marketplace', {
    description: 'Manage Codex Marketplaces — partitioned Global / Project Bridge State + local Registration flow',
    handler: async (_args, ctx) => {
      const cwd = ctx.cwd;

      // Non-TUI fallback: notify with summary
      if (ctx.mode !== 'tui' || !ctx.hasUI) {
        const global = readBridgeStateSync('global', { cwd });
        const project = readBridgeStateSync('project', { cwd });
        const g = formatStateSummary(global, 'Global Scope');
        const p = formatStateSummary(project, 'Project Scope');
        ctx.ui.notify(`${g}\n${p}\n互動 Registration 需 TUI 模式（/codex-marketplace 於 TUI 內）`, 'info');
        return;
      }

      const choice = await ctx.ui.select('Codex Marketplace — Bridge State', [
        '檢視 Global / Project 分區',
        '註冊本地 Marketplace…',
        '註冊 Git Marketplace…',
        '安裝 Compatible Plugin…',
        '管理已安裝 Plugin（Enable / Disable）…',
        '建立 Scope Override（覆蓋全域）…',
        '移除 Scope Override（還原繼承）…',
        '檢視 Effective State 與 Projected Skills…',
      ]);
      if (!choice) return;

      if (choice === '註冊本地 Marketplace…') {
        await runLocalRegistrationFlow(ctx);
        return;
      }
      if (choice === '註冊 Git Marketplace…') {
        await runGitRegistrationFlow(ctx);
        return;
      }
      if (choice === '安裝 Compatible Plugin…') {
        await runPluginInstallationFlow(ctx);
        return;
      }
      if (choice === '管理已安裝 Plugin（Enable / Disable）…') {
        await runPluginStateFlow(ctx);
        return;
      }
      if (choice === '建立 Scope Override（覆蓋全域）…') {
        await runScopeOverrideFlow(ctx);
        return;
      }
      if (choice === '移除 Scope Override（還原繼承）…') {
        await runRemoveScopeOverrideFlow(ctx);
        return;
      }
      if (choice === '檢視 Effective State 與 Projected Skills…') {
        await runEffectiveStateView(ctx);
        return;
      }

      const global = readBridgeStateSync('global', { cwd });
      const project = readBridgeStateSync('project', { cwd });

      await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
        return new MarketplaceComponent(global, project, cwd, theme, () => done());
      });
    },
  });
}
