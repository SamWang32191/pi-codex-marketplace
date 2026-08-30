/**
 * Bridge Extension — Pi runtime entry for pi-codex-marketplace
 * Single extension "pi" package, Pi 0.84.2 compatible.
 *
 * Provides:
 * - /codex-marketplace command: Thin Pi adapter delegating to pure runCommand
 * - resources_discover: Runtime Skill Exposure contributing Projected Skill paths
 *
 * 極簡表面（#87）：無 TUI、無 ledger/journal/生命周期機械。指令輸出與 reload 旗標
 * 完全由 runCommand 決定；reload 是唯一生效動作，失敗不影響已記錄狀態。
 */

import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';

import { runCommand } from '../../src/bridge/command.js';
import { discoverProjectedSkillPaths } from '../../src/projection/exposure.js';
import { completeArguments } from '../../src/bridge/completion.js';
import { createBridgeAutocompleteProvider } from './autocomplete.js';

export default function (pi: ExtensionAPI) {
  // Root-level autocomplete (#121) + second-level autocomplete (#122–#123): stack a narrow
  // provider for the exact `/codex-marketplace` editor text and the forced `install ` and
  // Installation lifecycle (`enable ` / `disable ` / `remove `) argument contexts (Pi
  // otherwise completes just the command name plus a space, and routes forced argument Tabs
  // to file completion). session_start supplies the full TUI ui context;
  // RPC/JSON/print modes no-op ctx.ui.addAutocompleteProvider, so a terminal-only provider is
  // never registered outside a TUI session and command execution is unchanged.
  pi.on('session_start', (_event, ctx) => {
    ctx.ui.addAutocompleteProvider((current) => createBridgeAutocompleteProvider(current));
  });
  // Runtime Skill Exposure (ADR 0001): contribute Projected Skills through Pi's
  // resource-discovery seam at every startup and reload. Passive existence inspection over the
  // current Effective State only — no fingerprint validation and no Bridge State mutation.
  // Missing snapshot material is skipped individually; discovery never fails the host's
  // resource pass.
  pi.on('resources_discover', async (_event, _ctx) => {
    try {
      return {
        skillPaths: discoverProjectedSkillPaths({}).skillPaths,
      };
    } catch {
      return {};
    }
  });

  pi.registerCommand('codex-marketplace', {
    description: 'codex / claude marketplace 管理（add/list/install/update/disable/enable/remove/forget/help）',
    // Standard argument completion (#121–#123): typed subcommand and `install <query>` /
    // lifecycle `<query>` prefixes go through Pi's normal autocomplete; unowned syntax
    // returns null so Pi falls through to its own behavior.
    getArgumentCompletions: (argumentPrefix: string) => completeArguments(argumentPrefix),
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const rawArgs = (args ?? '').trim();
      const argv = rawArgs.length > 0 ? rawArgs.split(/\s+/) : [];
      const result = await runCommand(argv);

      if (result.output) {
        ctx.ui.notify(result.output, 'info');
      }
      if (result.reload) {
        await ctx.reload();
      }
    },
  });
}