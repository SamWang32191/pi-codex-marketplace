import { describe, expect, it } from 'vitest';

import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from '@earendil-works/pi-tui';
import { CombinedAutocompleteProvider } from '@earendil-works/pi-tui';

import registerBridgeExtension from '../../extensions/pi/index.js';

const ROOT_LABELS = ['add', 'list', 'install', 'update', 'disable', 'enable', 'remove', 'forget', 'help'];

interface CapturedCommand {
  handler(args: string, ctx: unknown): Promise<void>;
  getArgumentCompletions?: (argumentPrefix: string) => AutocompleteItem[] | null;
}

type SessionStartHandler = (
  event: unknown,
  ctx: { ui: { addAutocompleteProvider: (factory: (current: AutocompleteProvider) => AutocompleteProvider) => void } },
) => void | Promise<void>;

interface CapturedExtension {
  commands: Map<string, CapturedCommand>;
  sessionStartHandlers: SessionStartHandler[];
  /** The factory captured from ctx.ui.addAutocompleteProvider during a session_start. */
  autocompleteFactory?: (current: AutocompleteProvider) => AutocompleteProvider;
}

function captureExtension(): CapturedExtension {
  const captured: CapturedExtension = { commands: new Map(), sessionStartHandlers: [] };
  registerBridgeExtension({
    on(event: string, handler: SessionStartHandler) {
      if (event === 'session_start') {
        captured.sessionStartHandlers.push(handler);
      }
      // other events (resources_discover / …) are only registered, never emitted here
    },
    registerCommand(name: string, command: CapturedCommand) {
      captured.commands.set(name, command);
    },
  } as never);
  return captured;
}

/** Emit the captured session_start with a host ui context, returning the installed factory. */
function installFactory(captured: CapturedExtension): (current: AutocompleteProvider) => AutocompleteProvider {
  const ctx = {
    mode: 'tui',
    hasUI: true,
    cwd: '/tmp',
    ui: {
      addAutocompleteProvider(factory: (current: AutocompleteProvider) => AutocompleteProvider) {
        captured.autocompleteFactory = factory;
      },
    },
  };
  for (const handler of captured.sessionStartHandlers) {
    void handler({ type: 'session_start', reason: 'startup' }, ctx as never);
  }
  const factory = captured.autocompleteFactory;
  if (!factory) throw new Error('session_start did not install an autocomplete provider factory');
  return factory;
}

function fakeCurrentProvider(options: {
  suggestions?: AutocompleteSuggestions | null;
} = {}): AutocompleteProvider & { calls: string[] } {
  const calls: string[] = [];
  const provider: AutocompleteProvider = {
    async getSuggestions(lines, cursorLine, cursorCol, _options) {
      calls.push('getSuggestions');
      return options.suggestions ?? null;
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      calls.push(`applyCompletion:${item.value}` as string);
      return { lines, cursorLine, cursorCol };
    },
  };
  return Object.assign(provider, { calls });
}

describe('/codex-marketplace autocomplete thin Pi adapter (#121)', () => {
  it('registers the command with Bridge-owned argument completion', () => {
    const captured = captureExtension();
    const command = captured.commands.get('codex-marketplace');
    expect(command).toBeDefined();
    expect(typeof command!.getArgumentCompletions).toBe('function');

    const items = command!.getArgumentCompletions!('');
    expect(items!.map((item) => item.label)).toEqual(ROOT_LABELS);
  });

  it('argument completion narrows by typed prefix and stays null for unowned syntax', () => {
    const captured = captureExtension();
    const command = captured.commands.get('codex-marketplace')!;

    const narrowed = command.getArgumentCompletions!('INSTL');
    expect(narrowed!.map((item) => item.label)).toEqual(['install']);

    expect(command.getArgumentCompletions!('install my-plugin')).toBeNull();
  });

  it('installs an autocomplete provider factory through session_start', () => {
    const captured = captureExtension();
    const factory = installFactory(captured);
    expect(typeof factory).toBe('function');
  });

  it('intercepts the exact /codex-marketplace editor text with all nine subcommands and does not consult the current provider', async () => {
    const captured = captureExtension();
    const current = fakeCurrentProvider();
    const wrapper = installFactory(captured)(current) as AutocompleteProvider;

    const result = await wrapper.getSuggestions(['/codex-marketplace'], 0, '/codex-marketplace'.length, {
      signal: new AbortController().signal,
      force: false,
    });

    expect(current.calls).toEqual([]);
    expect(result).not.toBeNull();
    expect(result!.prefix).toBe('');
    expect(result!.items.map((item) => item.label)).toEqual(ROOT_LABELS);
  });

  it('delegates suggestion generation for unrelated editor text to the current provider', async () => {
    const captured = captureExtension();
    const current = fakeCurrentProvider({
      suggestions: { items: [{ value: 'x', label: 'x' }], prefix: 'x' },
    });
    const wrapper = installFactory(captured)(current) as AutocompleteProvider;

    const result = await wrapper.getSuggestions(['/other'], 0, 6, {
      signal: new AbortController().signal,
      force: false,
    });

    expect(current.calls).toEqual(['getSuggestions']);
    expect(result).toEqual({ items: [{ value: 'x', label: 'x' }], prefix: 'x' });
  });

  it('delegates completion application to the current provider', () => {
    const captured = captureExtension();
    const current = fakeCurrentProvider();
    const wrapper = installFactory(captured)(current) as AutocompleteProvider;

    const lines = ['/codex-marketplace'];
    const result = wrapper.applyCompletion(lines, 0, 16, { value: 'install ', label: 'install' }, '');

    expect(current.calls).toEqual(['applyCompletion:install ']);
    expect(result).toEqual({ lines, cursorLine: 0, cursorCol: 16 });
  });

  it('delegates file-completion triggering to the current provider when present', async () => {
    const captured = captureExtension();
    const current = fakeCurrentProvider();
    const wrapper = installFactory(captured)(current) as AutocompleteProvider;

    expect(wrapper.shouldTriggerFileCompletion?.(['import x from "./a'], 0, 18)).toBe(true);
  });

  it('applies an intercepted subcommand through Pi 0.84.2 real combined provider, cursor after the trailing space', async () => {
    // Real host provider: CombinedAutocompleteProvider is what interactive mode wraps.
    const captured = captureExtension();
    const command = captured.commands.get('codex-marketplace')!;
    const base = new CombinedAutocompleteProvider(
      [{ name: 'codex-marketplace', getArgumentCompletions: command.getArgumentCompletions }],
      '/tmp',
      null,
    );
    const wrapper = installFactory(captured)(base) as AutocompleteProvider;

    const line = '/codex-marketplace';
    const suggestions = await wrapper.getSuggestions([line], 0, line.length, {
      signal: new AbortController().signal,
      force: false,
    });
    const install = suggestions!.items.find((item) => item.label === 'install')!;
    const applied = wrapper.applyCompletion([line], 0, line.length, install, suggestions!.prefix);

    expect(applied.lines[0]).toBe('/codex-marketplace install ');
    expect(applied.cursorCol).toBe('/codex-marketplace install '.length);

    const update = suggestions!.items.find((item) => item.label === 'update')!;
    const appliedUpdate = wrapper.applyCompletion([line], 0, line.length, update, suggestions!.prefix);
    expect(appliedUpdate.lines[0]).toBe('/codex-marketplace update');
    expect(appliedUpdate.cursorCol).toBe('/codex-marketplace update'.length);
  });

  it('does not intercept when the line holds trailing text after the command', async () => {
    const captured = captureExtension();
    const current = fakeCurrentProvider();
    const wrapper = installFactory(captured)(current) as AutocompleteProvider;

    await wrapper.getSuggestions(['/codex-marketplace pasted-junk'], 0, 18, {
      signal: new AbortController().signal,
      force: false,
    });

    // "editor 內容恰為 /codex-marketplace" — trailing text means not Bridge-owned here.
    expect(current.calls).toEqual(['getSuggestions']);
  });

  it('does not chain-reopen the subcommand list after an applied argument (next Tab is delegated, force path)', async () => {
    const captured = captureExtension();
    const current = fakeCurrentProvider();
    const wrapper = installFactory(captured)(current) as AutocompleteProvider;

    // After applying "install " the editor holds "/codex-marketplace install "; a subsequent
    // Tab is a forced request and must not re-intercept the line as the exact command.
    await wrapper.getSuggestions(['/codex-marketplace install '], 0, 25, {
      signal: new AbortController().signal,
      force: true,
    });

    expect(current.calls).toEqual(['getSuggestions']);
  });

  it('registers nothing terminal-only and keeps command execution when the host ui no-ops (RPC/JSON/print modes)', () => {
    // runner.js / rpc-mode give session_start contexts a no-op ui.addAutocompleteProvider —
    // the extension must still register the command and never install a terminal-only provider.
    const captured = captureExtension();
    let uiCalls = 0;
    for (const handler of captured.sessionStartHandlers) {
      void handler(
        { type: 'session_start' },
        {
          ui: {
            addAutocompleteProvider() {
              uiCalls += 1;
              // no-op, exactly like ExtensionRunner's default UI context and RPC mode
            },
          },
        } as never,
      );
    }

    expect(uiCalls).toBe(1);
    expect(captured.autocompleteFactory).toBeUndefined();
    const command = captured.commands.get('codex-marketplace');
    expect(command).toBeDefined();
    expect(typeof command!.getArgumentCompletions).toBe('function');
    // Command execution behavior is unaffected by the no-op ui.
    expect(typeof command!.handler).toBe('function');
  });
});
