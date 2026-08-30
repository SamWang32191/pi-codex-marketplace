/**
 * Narrow Bridge autocomplete provider — thin Pi adapter (TUI session only) (#119, #121, #122).
 *
 * Pi 0.84.2's built-in combined provider completes the slash-command name and inserts a
 * trailing space without exposing empty-prefix argument completion (root subcommands) when
 * the editor holds exactly `/codex-marketplace`. This wrapper intercepts that exact editor
 * content and presents the nine root candidates. It also owns the second-level `install`
 * argument context on forced (Tab) requests, which Pi 0.84.2 routes to file completion
 * instead of slash-command argument completion (its argument path only runs when `force` is
 * false) — the wrapper returns the state-aware install candidates there. Everything else —
 * other slash commands, text, file/path completion, suggestion generation and completion
 * application — delegates unchanged to the host's current provider.
 *
 * The wrapper is installed from a `session_start` handler via `ctx.ui.addAutocompleteProvider`,
 * which interactive (TUI) mode wires into the editor and RPC/JSON/print modes no-op, so a
 * terminal-only provider is never registered outside a TUI session.
 */

import type { AutocompleteProvider } from '@earendil-works/pi-tui';

import { completeArguments, type CompletionReadOptions } from '../../src/bridge/completion.js';

/** The exact editor content this provider owns. */
export const EXACT_COMMAND = '/codex-marketplace';

/** The second-level install argument context owned on forced requests: `/codex-marketplace install `. */
export const INSTALL_ARGUMENT_PREFIX = `${EXACT_COMMAND} install `;

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
      // Second-level install interception (#122): forced (Tab) requests inside `install `
      // are Bridge-owned — the host's combined provider would route them to file completion.
      // Natural typing (force=false) is delegated and reaches the same candidates through the
      // command's getArgumentCompletions. The prefix returned is the text after the command
      // name (`install ` or `install <query>`), matching the host's argument-text semantics.
      if (options.force && line.startsWith(INSTALL_ARGUMENT_PREFIX) && cursorCol >= INSTALL_ARGUMENT_PREFIX.length) {
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
