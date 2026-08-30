import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from '@earendil-works/pi-tui';
import { CombinedAutocompleteProvider } from '@earendil-works/pi-tui';

import registerBridgeExtension from '../../extensions/pi/index.js';
import { createBridgeAutocompleteProvider } from '../../extensions/pi/autocomplete.js';

const ROOT_LABELS = ['add', 'list', 'install', 'update', 'disable', 'enable', 'remove', 'forget', 'help'];

// ---- #122 fixture: two local marketplaces (one same-named sibling unavailable #91) ----
// Full enumeration: 1=shared(alpha, local), 2=demo(alpha, local, installed+enabled) and
// 3=shared(beta, github → unavailable). Candidates: `shared` inserts its enumeration number
// (name is ambiguous in the full enumeration), `demo` keeps its unique name.
function makeInstallFixture(): { root: string; statePath: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), 'bridge-e2e-install-'));
  const statePath = join(root, 'state.json');
  const mktA = join(root, 'mkt-a');
  const mktB = join(root, 'mkt-b');
  const writeCatalog = (mktRoot: string, name: string, entries: unknown[]): void => {
    const dir = join(mktRoot, '.agents', 'plugins');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'marketplace.json'), JSON.stringify({ name, plugins: entries }));
  };
  writeCatalog(mktA, 'alpha-market', [
    { name: 'shared', source: { source: 'local', path: './plugins/shared-a' } },
    { name: 'demo', source: { source: 'local', path: './plugins/demo' } },
  ]);
  writeCatalog(mktB, 'beta-market', [
    { name: 'shared', source: { source: 'github', repo: 'acme/shared-b' } },
  ]);
  writeFileSync(
    statePath,
    JSON.stringify(
      {
        schemaVersion: 1,
        registrations: [
          { id: 'reg-a', marketplaceName: 'alpha-market', format: 'codex', sourceKind: 'local', source: mktA },
          { id: 'reg-b', marketplaceName: 'beta-market', format: 'codex', sourceKind: 'local', source: mktB },
        ],
        installations: [
          { id: 'inst-demo', pluginId: 'demo', enabled: true, installationState: 'enabled', registrationId: 'reg-a', manifestName: 'demo', sourceKind: 'local', source: mktA, skills: [] },
        ],
      },
      null,
      2,
    ),
  );
  return { root, statePath, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

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

    // The `add` argument is free-form (path or Git locator) and never Bridge-owned (#124);
    // second-token install text is not owned either.
    expect(command.getArgumentCompletions!('add some/path')).toBeNull();
    expect(command.getArgumentCompletions!('add https://github.com/acme/skills')).toBeNull();
    expect(command.getArgumentCompletions!('install foo bar')).toBeNull();
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

  it('does not chain-reopen the root subcommand list after an applied argument — the next forced Tab owns the install context (#122)', async () => {
    const captured = captureExtension();
    const current = fakeCurrentProvider();

    // After applying "install " the editor holds "/codex-marketplace install "; a subsequent
    // Tab is a forced request. It must not re-intercept the line as the exact root command
    // (that would chain-reopen the nine subcommands); it owns the second-level install
    // context instead, reading the (empty, hermetic) state passively.
    const wrapper = createBridgeAutocompleteProvider(current, { statePath: join(tmpdir(), 'bridge-e2e-no-such-state.json') });

    const result = await wrapper.getSuggestions(['/codex-marketplace install '], 0, '/codex-marketplace install '.length, {
      signal: new AbortController().signal,
      force: true,
    });

    expect(current.calls).toEqual([]);
    expect(result!.prefix).toBe('install ');
    expect(result!.items).toEqual([]);
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

describe('state-aware install autocomplete thin Pi adapter (#122)', () => {
  it('intercepts a forced Tab inside `install ` with state-aware candidates and does not consult the current provider', async () => {
    const fixture = makeInstallFixture();
    try {
      const captured = captureExtension();
      const current = fakeCurrentProvider();
      // Explicit readOptions keep the test hermetic (defaults would read the real agent dir).
      const wrapper = createBridgeAutocompleteProvider(current, { statePath: fixture.statePath });

      const line = '/codex-marketplace install ';
      const result = await wrapper.getSuggestions([line], 0, line.length, {
        signal: new AbortController().signal,
        force: true,
      });

      expect(current.calls).toEqual([]);
      expect(result!.prefix).toBe('install ');
      expect(result!.items.map((item) => item.label)).toEqual(['shared (#1)', 'demo']);
      // Same-named `shared` (with an unavailable sibling) inserts its enumeration number.
      expect(result!.items[0].value).toBe('install 1');
      expect(result!.items[0].description).toContain('[alpha-market]');
      // Unique name keeps the name form; reinstall of the enabled plugin is offered.
      expect(result!.items[1].value).toBe('install demo');
      expect(result!.items[1].description).toContain('已裝啟用');
    } finally {
      fixture.cleanup();
    }
  });

  it('filters forced install candidates by the typed query and returns the matching argument prefix', async () => {
    const fixture = makeInstallFixture();
    try {
      const captured = captureExtension();
      const current = fakeCurrentProvider();
      const wrapper = createBridgeAutocompleteProvider(current, { statePath: fixture.statePath });

      const line = '/codex-marketplace install dem';
      const result = await wrapper.getSuggestions([line], 0, line.length, {
        signal: new AbortController().signal,
        force: true,
      });

      expect(current.calls).toEqual([]);
      expect(result!.prefix).toBe('install dem');
      expect(result!.items.map((item) => item.label)).toEqual(['demo']);
      expect(result!.items[0].value).toBe('install demo');
    } finally {
      fixture.cleanup();
    }
  });

  it('does not intercept a forced install request with a mid-line cursor and trailing text', async () => {
    const fixture = makeInstallFixture();
    try {
      const captured = captureExtension();
      const current = fakeCurrentProvider({
        suggestions: { items: [{ value: 'x', label: 'x' }], prefix: 'x' },
      });
      const wrapper = createBridgeAutocompleteProvider(current, { statePath: fixture.statePath });

      // Cursor in the middle of the line, text after it: applying a candidate would produce
      // a malformed line, so the wrapper must not own this context (root branch has the same
      // end-of-line guard) and delegates to the host provider.
      const line = '/codex-marketplace install dem junk';
      const result = await wrapper.getSuggestions([line], 0, '/codex-marketplace install dem'.length, {
        signal: new AbortController().signal,
        force: true,
      });

      expect(current.calls).toEqual(['getSuggestions']);
      expect(result).toEqual({ items: [{ value: 'x', label: 'x' }], prefix: 'x' });
    } finally {
      fixture.cleanup();
    }
  });

  it('delegates natural (non-forced) requests inside the install argument context to the host provider', async () => {
    const captured = captureExtension();
    const current = fakeCurrentProvider({
      suggestions: { items: [{ value: 'x', label: 'x' }], prefix: 'x' },
    });
    const wrapper = installFactory(captured)(current) as AutocompleteProvider;

    const line = '/codex-marketplace install dem';
    const result = await wrapper.getSuggestions([line], 0, line.length, {
      signal: new AbortController().signal,
      force: false,
    });

    // force=false is the host's natural argument-completion path (getArgumentCompletions
    // owns it); the wrapper must not double-intercept.
    expect(current.calls).toEqual(['getSuggestions']);
    expect(result).toEqual({ items: [{ value: 'x', label: 'x' }], prefix: 'x' });
  });

  it('applies an install candidate through Pi 0.84.2 real combined provider, cursor at the inserted argument end', async () => {
    const fixture = makeInstallFixture();
    try {
      const captured = captureExtension();
      const command = captured.commands.get('codex-marketplace')!;
      const wrapper = createBridgeAutocompleteProvider(
        new CombinedAutocompleteProvider(
          [{ name: 'codex-marketplace', getArgumentCompletions: command.getArgumentCompletions }],
          '/tmp',
          null,
        ),
        { statePath: fixture.statePath },
      );

      const line = '/codex-marketplace install ';
      const suggestions = await wrapper.getSuggestions([line], 0, line.length, {
        signal: new AbortController().signal,
        force: true,
      });
      const demo = suggestions!.items.find((item) => item.value === 'install demo')!;
      const applied = wrapper.applyCompletion([line], 0, line.length, demo, suggestions!.prefix);
      expect(applied.lines[0]).toBe('/codex-marketplace install demo');
      expect(applied.cursorCol).toBe('/codex-marketplace install demo'.length);

      // Number insertion for the same-named candidate resolves to a working command too.
      const shared = suggestions!.items.find((item) => item.value === 'install 1')!;
      const appliedShared = wrapper.applyCompletion([line], 0, line.length, shared, suggestions!.prefix);
      expect(appliedShared.lines[0]).toBe('/codex-marketplace install 1');
      expect(appliedShared.cursorCol).toBe('/codex-marketplace install 1'.length);
    } finally {
      fixture.cleanup();
    }
  });
});

// ---- #123 fixture: two marketplaces, one enabled and one disabled Installation ----
function makeLifecycleFixture(): { root: string; statePath: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), 'bridge-e2e-lifecycle-'));
  const statePath = join(root, 'state.json');
  writeFileSync(
    statePath,
    JSON.stringify(
      {
        schemaVersion: 1,
        registrations: [
          { id: 'reg-a', marketplaceName: 'alpha-market', format: 'codex', sourceKind: 'local', source: join(root, 'mkt-a') },
          { id: 'reg-b', marketplaceName: 'beta-market', format: 'codex', sourceKind: 'local', source: join(root, 'mkt-b') },
        ],
        installations: [
          { id: 'inst-demo', pluginId: 'demo', enabled: true, installationState: 'enabled', registrationId: 'reg-a', manifestName: 'demo', sourceKind: 'local', source: join(root, 'mkt-a'), skills: [] },
          { id: 'inst-paused', pluginId: 'paused', enabled: false, installationState: 'disabled', registrationId: 'reg-b', manifestName: 'paused', sourceKind: 'local', source: join(root, 'mkt-b'), skills: [] },
        ],
      },
      null,
      2,
    ),
  );
  return { root, statePath, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('Installation lifecycle autocomplete thin Pi adapter (#123)', () => {
  it('intercepts a forced Tab inside `enable ` / `disable ` / `remove ` with state-aware candidates', async () => {
    const fixture = makeLifecycleFixture();
    try {
      const current = fakeCurrentProvider();
      const wrapper = createBridgeAutocompleteProvider(current, { statePath: fixture.statePath });

      const disable = await wrapper.getSuggestions(['/codex-marketplace disable '], 0, '/codex-marketplace disable '.length, {
        signal: new AbortController().signal,
        force: true,
      });
      expect(current.calls).toEqual([]);
      expect(disable!.prefix).toBe('disable ');
      expect(disable!.items.map((item) => item.value)).toEqual(['disable demo']);
      expect(disable!.items[0].description).toContain('[alpha-market]');

      const enable = await wrapper.getSuggestions(['/codex-marketplace enable '], 0, '/codex-marketplace enable '.length, {
        signal: new AbortController().signal,
        force: true,
      });
      expect(enable!.prefix).toBe('enable ');
      expect(enable!.items.map((item) => item.value)).toEqual(['enable paused']);
      expect(enable!.items[0].description).toContain('[beta-market]');

      const remove = await wrapper.getSuggestions(['/codex-marketplace remove '], 0, '/codex-marketplace remove '.length, {
        signal: new AbortController().signal,
        force: true,
      });
      expect(remove!.prefix).toBe('remove ');
      expect(remove!.items.map((item) => item.value)).toEqual(['remove demo', 'remove paused']);
    } finally {
      fixture.cleanup();
    }
  });

  it('filters forced lifecycle candidates by the typed query and returns the matching argument prefix', async () => {
    const fixture = makeLifecycleFixture();
    try {
      const captured = captureExtension();
      const current = fakeCurrentProvider();
      const wrapper = createBridgeAutocompleteProvider(current, { statePath: fixture.statePath });

      const line = '/codex-marketplace disable dem';
      const result = await wrapper.getSuggestions([line], 0, line.length, {
        signal: new AbortController().signal,
        force: true,
      });

      expect(current.calls).toEqual([]);
      expect(result!.prefix).toBe('disable dem');
      expect(result!.items.map((item) => item.label)).toEqual(['demo']);
      expect(result!.items[0].value).toBe('disable demo');
    } finally {
      fixture.cleanup();
    }
  });

  it('does not intercept a forced lifecycle request with a mid-line cursor and trailing text', async () => {
    const fixture = makeLifecycleFixture();
    try {
      const captured = captureExtension();
      const current = fakeCurrentProvider({
        suggestions: { items: [{ value: 'x', label: 'x' }], prefix: 'x' },
      });
      const wrapper = createBridgeAutocompleteProvider(current, { statePath: fixture.statePath });

      const line = '/codex-marketplace disable dem junk';
      const result = await wrapper.getSuggestions([line], 0, '/codex-marketplace disable dem'.length, {
        signal: new AbortController().signal,
        force: true,
      });

      expect(current.calls).toEqual(['getSuggestions']);
      expect(result).toEqual({ items: [{ value: 'x', label: 'x' }], prefix: 'x' });
    } finally {
      fixture.cleanup();
    }
  });

  it('delegates natural (non-forced) requests inside a lifecycle argument context to the host provider', async () => {
    const captured = captureExtension();
    const current = fakeCurrentProvider({
      suggestions: { items: [{ value: 'x', label: 'x' }], prefix: 'x' },
    });
    const wrapper = installFactory(captured)(current) as AutocompleteProvider;

    const line = '/codex-marketplace disable dem';
    const result = await wrapper.getSuggestions([line], 0, line.length, {
      signal: new AbortController().signal,
      force: false,
    });

    // force=false is the host's natural argument-completion path (getArgumentCompletions
    // owns it); the wrapper must not double-intercept.
    expect(current.calls).toEqual(['getSuggestions']);
    expect(result).toEqual({ items: [{ value: 'x', label: 'x' }], prefix: 'x' });
  });

  it('applies a lifecycle candidate through Pi 0.84.2 real combined provider, cursor at the inserted argument end', async () => {
    const fixture = makeLifecycleFixture();
    try {
      const captured = captureExtension();
      const command = captured.commands.get('codex-marketplace')!;
      const wrapper = createBridgeAutocompleteProvider(
        new CombinedAutocompleteProvider(
          [{ name: 'codex-marketplace', getArgumentCompletions: command.getArgumentCompletions }],
          '/tmp',
          null,
        ),
        { statePath: fixture.statePath },
      );

      const line = '/codex-marketplace disable ';
      const suggestions = await wrapper.getSuggestions([line], 0, line.length, {
        signal: new AbortController().signal,
        force: true,
      });
      const demo = suggestions!.items.find((item) => item.value === 'disable demo')!;
      const applied = wrapper.applyCompletion([line], 0, line.length, demo, suggestions!.prefix);
      expect(applied.lines[0]).toBe('/codex-marketplace disable demo');
      expect(applied.cursorCol).toBe('/codex-marketplace disable demo'.length);
    } finally {
      fixture.cleanup();
    }
  });

  it('does not chain-reopen the root subcommand list after an applied lifecycle argument (#123)', async () => {
    const fixture = makeLifecycleFixture();
    try {
      const captured = captureExtension();
      const current = fakeCurrentProvider();
      const wrapper = createBridgeAutocompleteProvider(current, { statePath: fixture.statePath });

      // After applying "disable " the editor holds "/codex-marketplace disable "; a subsequent
      // Tab is a forced request. It must not re-intercept the line as the exact root command
      // (that would chain-reopen the nine subcommands); it owns the second-level lifecycle
      // context instead.
      const result = await wrapper.getSuggestions(['/codex-marketplace disable '], 0, '/codex-marketplace disable '.length, {
        signal: new AbortController().signal,
        force: true,
      });

      expect(current.calls).toEqual([]);
      expect(result!.prefix).toBe('disable ');
      expect(result!.items.map((item) => item.label)).toEqual(['demo']);
    } finally {
      fixture.cleanup();
    }
  });
});

// ---- #124 fixture: two same-named marketplaces plus a unique one, one git-sourced ----
function makeRegistrationFixture(): { root: string; statePath: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), 'bridge-e2e-registration-'));
  const statePath = join(root, 'state.json');
  writeFileSync(
    statePath,
    JSON.stringify(
      {
        schemaVersion: 1,
        registrations: [
          { id: 'reg-a', marketplaceName: 'shared-market', format: 'codex', sourceKind: 'local', source: join(root, 'mkt-a') },
          { id: 'reg-b', marketplaceName: 'shared-market', format: 'claude', sourceKind: 'git', source: 'https://github.com/acme/skills' },
          { id: 'reg-c', marketplaceName: 'unique-market', format: 'codex', sourceKind: 'local', source: join(root, 'mkt-c') },
        ],
        installations: [],
      },
      null,
      2,
    ),
  );
  return { root, statePath, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('Marketplace Registration autocomplete thin Pi adapter (#124)', () => {
  it('intercepts a forced Tab inside `list ` / `forget ` with Registration candidates and does not consult the current provider', async () => {
    const fixture = makeRegistrationFixture();
    try {
      const current = fakeCurrentProvider();
      const wrapper = createBridgeAutocompleteProvider(current, { statePath: fixture.statePath });

      const list = await wrapper.getSuggestions(['/codex-marketplace list '], 0, '/codex-marketplace list '.length, {
        signal: new AbortController().signal,
        force: true,
      });
      expect(current.calls).toEqual([]);
      expect(list!.prefix).toBe('list ');
      // `shared-market` is ambiguous in the fixture (reg-a + reg-b), so the ids are inserted;
      // only unique names keep the readable form.
      expect(list!.items[0].value).toBe('list reg-a');
      expect(list!.items[1].value).toBe('list reg-b');
      expect(list!.items[0].description).toContain('[codex]');
      expect(list!.items[1].description).toContain('[claude]');
      expect(list!.items[2].value).toBe('list unique-market');

      const forget = await wrapper.getSuggestions(['/codex-marketplace forget '], 0, '/codex-marketplace forget '.length, {
        signal: new AbortController().signal,
        force: true,
      });
      expect(current.calls).toEqual([]);
      expect(forget!.prefix).toBe('forget ');
      expect(forget!.items.map((item) => item.value)).toEqual(['forget reg-a', 'forget reg-b', 'forget unique-market']);
    } finally {
      fixture.cleanup();
    }
  });

  it('filters forced Registration candidates by the typed query and returns the matching argument prefix', async () => {
    const fixture = makeRegistrationFixture();
    try {
      const current = fakeCurrentProvider();
      const wrapper = createBridgeAutocompleteProvider(current, { statePath: fixture.statePath });

      const line = '/codex-marketplace list uni';
      const result = await wrapper.getSuggestions([line], 0, line.length, {
        signal: new AbortController().signal,
        force: true,
      });

      expect(current.calls).toEqual([]);
      expect(result!.prefix).toBe('list uni');
      expect(result!.items.map((item) => item.label)).toEqual(['unique-market']);
      expect(result!.items[0].value).toBe('list unique-market');
    } finally {
      fixture.cleanup();
    }
  });

  it('keeps a forced Tab inside `add ` under Pi native filesystem completion (#124)', async () => {
    const fixture = makeRegistrationFixture();
    try {
      const current = fakeCurrentProvider({
        suggestions: { items: [{ value: '/some/root/path', label: '/some/root/path' }], prefix: '' },
      });
      const wrapper = createBridgeAutocompleteProvider(current, { statePath: fixture.statePath });

      // `add ` is not Bridge-owned: a forced Tab must consult the host provider exactly like
      // any other stacked provider (Pi's filesystem completion), never Bridge candidates.
      const line = '/codex-marketplace add ';
      const result = await wrapper.getSuggestions([line], 0, line.length, {
        signal: new AbortController().signal,
        force: true,
      });

      expect(current.calls).toEqual(['getSuggestions']);
      expect(result).toEqual({ items: [{ value: '/some/root/path', label: '/some/root/path' }], prefix: '' });
    } finally {
      fixture.cleanup();
    }
  });

  it('never constrains a free-form Git locator typed after `add ` (#124)', async () => {
    const fixture = makeRegistrationFixture();
    try {
      const current = fakeCurrentProvider({
        suggestions: { items: [], prefix: 'add https://github.com/acme/skills' },
      });
      const wrapper = createBridgeAutocompleteProvider(current, { statePath: fixture.statePath });

      const line = '/codex-marketplace add https://github.com/acme/skills';
      const result = await wrapper.getSuggestions([line], 0, line.length, {
        signal: new AbortController().signal,
        force: true,
      });

      expect(current.calls).toEqual(['getSuggestions']);
      expect(result!.prefix).toBe('add https://github.com/acme/skills');
    } finally {
      fixture.cleanup();
    }
  });

  it('does not intercept a forced Registration request with a mid-line cursor and trailing text', async () => {
    const fixture = makeRegistrationFixture();
    try {
      const current = fakeCurrentProvider({
        suggestions: { items: [{ value: 'x', label: 'x' }], prefix: 'x' },
      });
      const wrapper = createBridgeAutocompleteProvider(current, { statePath: fixture.statePath });

      const line = '/codex-marketplace list uni junk';
      const result = await wrapper.getSuggestions([line], 0, '/codex-marketplace list uni'.length, {
        signal: new AbortController().signal,
        force: true,
      });

      expect(current.calls).toEqual(['getSuggestions']);
      expect(result).toEqual({ items: [{ value: 'x', label: 'x' }], prefix: 'x' });
    } finally {
      fixture.cleanup();
    }
  });

  it('delegates natural (non-forced) requests inside a Registration argument context to the host provider', async () => {
    const captured = captureExtension();
    const current = fakeCurrentProvider({
      suggestions: { items: [{ value: 'x', label: 'x' }], prefix: 'x' },
    });
    const wrapper = installFactory(captured)(current) as AutocompleteProvider;

    const line = '/codex-marketplace list uni';
    const result = await wrapper.getSuggestions([line], 0, line.length, {
      signal: new AbortController().signal,
      force: false,
    });

    // force=false is the host's natural argument-completion path (getArgumentCompletions
    // owns it); the wrapper must not double-intercept.
    expect(current.calls).toEqual(['getSuggestions']);
    expect(result).toEqual({ items: [{ value: 'x', label: 'x' }], prefix: 'x' });
  });

  it('applies a Registration candidate through Pi 0.84.2 real combined provider, cursor at the inserted argument end', async () => {
    const fixture = makeRegistrationFixture();
    try {
      const captured = captureExtension();
      const command = captured.commands.get('codex-marketplace')!;
      const wrapper = createBridgeAutocompleteProvider(
        new CombinedAutocompleteProvider(
          [{ name: 'codex-marketplace', getArgumentCompletions: command.getArgumentCompletions }],
          '/tmp',
          null,
        ),
        { statePath: fixture.statePath },
      );

      const line = '/codex-marketplace list ';
      const suggestions = await wrapper.getSuggestions([line], 0, line.length, {
        signal: new AbortController().signal,
        force: true,
      });
      const unique = suggestions!.items.find((item) => item.value === 'list unique-market')!;
      const applied = wrapper.applyCompletion([line], 0, line.length, unique, suggestions!.prefix);
      expect(applied.lines[0]).toBe('/codex-marketplace list unique-market');
      expect(applied.cursorCol).toBe('/codex-marketplace list unique-market'.length);

      // The id insertion for the same-named Registration candidate resolves to a working
      // `forget <id>` command too (the command resolves by id exactly like `forget <名稱>`).
      const forgetLine = '/codex-marketplace forget ';
      const forgetSuggestions = await wrapper.getSuggestions([forgetLine], 0, forgetLine.length, {
        signal: new AbortController().signal,
        force: true,
      });
      const byId = forgetSuggestions!.items.find((item) => item.value === 'forget reg-b')!;
      const appliedForget = wrapper.applyCompletion([forgetLine], 0, forgetLine.length, byId, forgetSuggestions!.prefix);
      expect(appliedForget.lines[0]).toBe('/codex-marketplace forget reg-b');
      expect(appliedForget.cursorCol).toBe('/codex-marketplace forget reg-b'.length);
    } finally {
      fixture.cleanup();
    }
  });

  it('does not chain-reopen the root subcommand list after an applied Registration argument (#124)', async () => {
    const fixture = makeRegistrationFixture();
    try {
      const current = fakeCurrentProvider();
      const wrapper = createBridgeAutocompleteProvider(current, { statePath: fixture.statePath });

      const result = await wrapper.getSuggestions(['/codex-marketplace list '], 0, '/codex-marketplace list '.length, {
        signal: new AbortController().signal,
        force: true,
      });

      expect(current.calls).toEqual([]);
      expect(result!.prefix).toBe('list ');
      expect(result!.items.map((item) => item.label)).toEqual([
        'shared-market (reg-a)',
        'shared-market (reg-b)',
        'unique-market',
      ]);
    } finally {
      fixture.cleanup();
    }
  });
});
