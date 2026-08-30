/**
 * Narrow Bridge autocomplete provider — thin Pi adapter (TUI session only) (#119, #121–#124).
 *
 * Pi 0.84.2's built-in combined provider completes the slash-command name and inserts a
 * trailing space without exposing empty-prefix argument completion (root subcommands) when
 * the editor holds exactly `/codex-marketplace`. This wrapper intercepts that exact editor
 * content and presents the nine root candidates. It also owns the second-level argument
 * contexts (`install` #122, the Installation lifecycle `enable` / `disable` / `remove` #123,
 * and the Marketplace Registration `list` / `forget` #124) on forced (Tab) requests, which
 * Pi 0.84.2 routes to file completion instead of slash-command argument completion (its
 * argument path only runs when `force` is false) — the wrapper returns the state-aware
 * candidates there. `add` stays free-form (#124): its forced Tab keeps Pi's native
 * filesystem completion, and a typed Git locator or path is never constrained by Bridge
 * candidates. Everything else — other slash commands, text, file/path completion, suggestion
 * generation and completion application — delegates unchanged to the host's current provider.
 *
 * The wrapper is installed from a `session_start` handler via `ctx.ui.addAutocompleteProvider`,
 * which interactive (TUI) mode wires into the editor and RPC/JSON/print modes no-op, so a
 * terminal-only provider is never registered outside a TUI session.
 */

import type { AutocompleteProvider } from '@earendil-works/pi-tui';

import { completeArguments, type CompletionReadOptions } from '../../src/bridge/completion.js';

/** The exact editor content this provider owns. */
export const EXACT_COMMAND = '/codex-marketplace';

/**
 * The Bridge-owned second-level argument contexts on forced requests: `install` plus the
 * installation lifecycle actions plus the Marketplace Registration commands — each followed
 * by the trailing space root candidates insert. `add` is deliberately absent (#124): its
 * argument is an arbitrary path or Git locator that stays under Pi's native completion.
 */
export const SECOND_LEVEL_ARGUMENT_RE = /^\/codex-marketplace (?:install|list|forget|enable|disable|remove) /;

/**
 * Wrap the host's current autocomplete provider. Suggestion generation intercepts only the
 * Bridge-owned editor contexts (the exact `/codex-marketplace` line and the forced `install `
 * argument context); completion application and file-trigger decisions delegate to the
 * current provider's semantics, so selection behavior stays Pi-native.
 */
export function createBridgeAutocompleteProvider(
  current: AutocompleteProvider,
  readOptions: CompletionReadOptions = {},
): AutocompleteProvider {
  return {
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const line = lines[cursorLine] ?? '';
      // Root-level interception (#121): only when the editor content is exactly the complete
      // command text — a mid-command cursor or trailing text after the command is not
      // "editor 內容恰為 /codex-marketplace" and must fall through to the host provider.
      if (line === EXACT_COMMAND && cursorCol === EXACT_COMMAND.length) {
        const items = completeArguments('', readOptions);
        if (items && items.length > 0) {
          // The intercepted prefix is the whole line before the cursor (prefix ''), so the
          // insertion value must carry the separator space the editor content lacks.
          return {
            items: items.map((item) => ({ ...item, value: ` ${item.value}` })),
            prefix: '',
          };
        }
      }
      // Second-level argument interception (#122, #123, #124): forced (Tab) requests inside a
      // Bridge-owned argument context (`install ` / `enable ` / `disable ` / `remove ` /
      // `list ` / `forget `) are Bridge-owned — the host's combined provider would route them
      // to file completion. Natural typing (force=false) is delegated and reaches the same
      // candidates through the command's getArgumentCompletions. Like the root branch, the
      // cursor must be at the end of the line: a mid-line cursor with trailing text would
      // otherwise produce a malformed line after applying a candidate. The prefix returned is
      // the text after the command name (`install <query>` etc.), matching the host's
      // argument-text semantics. `add ` is not Bridge-owned (#124), so a forced Tab there
      // falls through to the host provider's filesystem completion unchanged.
      if (options.force && cursorCol === line.length && SECOND_LEVEL_ARGUMENT_RE.test(line)) {
        const argumentText = line.slice(EXACT_COMMAND.length + 1, cursorCol);
        const items = completeArguments(argumentText, readOptions);
        if (items) {
          return { items, prefix: argumentText };
        }
      }
      return current.getSuggestions(lines, cursorLine, cursorCol, options);
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },
    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  };
}
