/**
 * Narrow Bridge autocomplete provider — thin Pi adapter (TUI session only) (#119, #121).
 *
 * Pi 0.84.2's built-in combined provider completes the slash-command name and inserts a
 * trailing space without exposing empty-prefix argument completion (root subcommands) when
 * the editor holds exactly `/codex-marketplace`. This wrapper intercepts only that exact
 * editor content and presents the nine root candidates; everything else — other slash
 * commands, text, file/path completion, suggestion generation and completion application —
 * delegates unchanged to the host's current provider.
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
 * Wrap the host's current autocomplete provider. Suggestion generation intercepts only the
 * exact `/codex-marketplace` line; completion application and file-trigger decisions delegate
 * to the current provider's semantics, so selection behavior stays Pi-native.
 */
export function createBridgeAutocompleteProvider(
  current: AutocompleteProvider,
  readOptions: CompletionReadOptions = {},
): AutocompleteProvider {
  return {
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const line = lines[cursorLine] ?? '';
      // Intercept only when the editor content is exactly the complete command text — a
      // mid-command cursor or trailing text after the command is not "editor 內容恰為
      // /codex-marketplace" and must fall through to the host provider unchanged.
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
