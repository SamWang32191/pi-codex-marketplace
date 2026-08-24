import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import registerBridgeExtension from '../../extensions/pi/index.js';
import { uiText } from '../../extensions/pi/ui-strings.js';
import { commitBridgeState } from '../../src/bridge-state/store.js';
import { appendReceipt } from '../../src/journal/journal.js';
import { createReceipt } from '../../src/registration/receipt.js';

interface CapturedCommand {
  handler(args: string, ctx: unknown): Promise<void>;
}

function captureCodexMarketplaceCommand(): CapturedCommand {
  const commands = new Map<string, CapturedCommand>();
  registerBridgeExtension({
    on() {},
    registerCommand(name: string, command: CapturedCommand) {
      commands.set(name, command);
    },
  } as never);
  const command = commands.get('codex-marketplace');
  if (!command) throw new Error('codex-marketplace command was not registered');
  return command;
}

const identityTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_token: string, text: string) => text,
  bold: (text: string) => text,
};

describe('/codex-marketplace Bridge Ledger command seam', () => {
  let cwd: string;
  let agentDir: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'bridge-ledger-command-cwd-'));
    agentDir = mkdtempSync(join(tmpdir(), 'bridge-ledger-command-agent-'));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_AGENT_DIR = agentDir;
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    delete process.env.PI_CODING_AGENT_DIR;
    delete process.env.PI_AGENT_DIR;
  });

  it('opens the custom Bridge Ledger workspace directly instead of the flat action select', async () => {
    const command = captureCodexMarketplaceCommand();
    const rendered = new Map<number, string[]>();
    let customCalls = 0;

    const ui = {
      select: async () => {
        throw new Error('flat action select must not be used');
      },
      input: async () => undefined,
      confirm: async () => false,
      notify() {},
      custom: async (factory: Function) => {
        customCalls += 1;
        let completed = false;
        let result: unknown;
        const component = await factory(
          { requestRender() {} },
          identityTheme,
          {},
          (value: unknown) => {
            completed = true;
            result = value;
          },
        );
        for (const width of [120, 80, 60]) rendered.set(width, component.render(width));
        component.handleInput?.('q');
        expect(completed).toBe(true);
        return result;
      },
    };

    await command.handler('', {
      cwd,
      mode: 'tui',
      hasUI: true,
      isProjectTrusted: () => true,
      ui,
    });

    expect(customCalls).toBe(1);
    for (const width of [120, 80, 60]) {
      const screen = rendered.get(width)!.join('\n');
      expect(screen).toContain('BRIDGE LEDGER');
      expect(screen).toMatch(/GLOBAL|\bG\b/);
      expect(screen).toMatch(/PROJECT|\bP\b/);
      expect(screen).toMatch(/rev(?:ision)?\s+"?0"?/i);
      expect(screen).toContain(uiText('ledger.rail.trust.granted'));
      expect(screen).toMatch(/Esc.*q|q.*Esc/i);
    }
  });

  it('re-reads authoritative state before reopening after an action', async () => {
    const command = captureCodexMarketplaceCommand();
    const screens: string[][] = [];
    let customCalls = 0;

    const ui = {
      notify() {},
      select: async () => {
        throw new Error('Observe action must not open the legacy flat select');
      },
      custom: async (factory: Function) => {
        customCalls += 1;
        let result: unknown;
        let completed = false;
        const component = await factory(
          { requestRender() {} },
          identityTheme,
          {},
          (value: unknown) => {
            completed = true;
            result = value;
          },
        );
        screens.push(component.render(80));
        if (customCalls === 1) {
          component.handleInput?.('\r'); // drill into the section (single-column layout at 80)
          component.handleInput?.('\r'); // activate the first available structured action
          await commitBridgeState(
            'global',
            (state) => ({
              ...state,
              registrations: [
                {
                  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                  alias: 'after-action',
                },
              ],
            }),
            { cwd, agentDir },
          );
        } else {
          component.handleInput?.('q');
        }
        expect(completed).toBe(true);
        return result;
      },
    };

    await command.handler('', {
      cwd,
      mode: 'tui',
      hasUI: true,
      isProjectTrusted: () => true,
      ui,
    });

    expect(customCalls).toBe(2);
    expect(screens[0]!.join('\n')).toContain(uiText('ledger.rail.revision', { marker: 'G', revision: '"0"' }));
    expect(screens[1]!.join('\n')).toContain(uiText('ledger.rail.revision', { marker: 'G', revision: '"1"' }));
    expect(screens[1]!.join('\n')).toContain(uiText('ledger.rail.registrations', { count: 1 }));
  });

  it('keeps the Global Pending Barrier visible while disabling Project mutations', async () => {
    await appendReceipt(
      'global',
      createReceipt({
        operation: 'Plugin Installation',
        scope: 'global',
        trigger: 'install',
        expectedStateRevision: '0',
        targetStateRevision: '1',
        observedStateRevision: '1',
        durableOutcome: 'committed',
        runtimeOutcome: 'pending-application',
        summary: 'Pending Application',
      }),
      { cwd, agentDir },
    );
    const command = captureCodexMarketplaceCommand();
    let screen = '';

    await command.handler('', {
      cwd,
      mode: 'tui',
      hasUI: true,
      isProjectTrusted: () => true,
      ui: {
        notify() {},
        select: async () => {
          throw new Error('Barrier workspace must not use the flat select');
        },
        custom: async (factory: Function) => {
          let result: unknown;
          const component = await factory(
            { requestRender() {} },
            identityTheme,
            {},
            (value: unknown) => {
              result = value;
            },
          );
          component.render(120);
          component.handleInput?.('\x1b[C');
          const globalScreen = component.render(120).join('\n');
          component.handleInput?.('p');
          const projectScreen = component.render(120).join('\n');
          screen = `${globalScreen}\n${projectScreen}`;
          component.handleInput?.('q');
          return result;
        },
      },
    });

    expect(screen).toContain(uiText('ledger.badge.barrierActive'));
    // Blocked Project mutation: availability is icon+word, and its reason is visible on selection.
    expect(screen).toContain(`○ ${uiText('ledger.availability.blocked')} ${uiText('ledger.action.register-local')}`);
    expect(screen).toMatch(/Global Pending Barrier/);
    expect(screen).not.toMatch(/\[available\]|\[Unavailable\]|disabled:/);
    expect(screen).toContain(`● ${uiText('ledger.availability.ready')} ${uiText('ledger.action.register-local')}`);
  });

  it.each([
    { args: '', mode: 'rpc', hasUI: false },
    { args: 'list', mode: 'tui', hasUI: true },
    { args: 'inspect', mode: 'tui', hasUI: true },
  ])('keeps the non-interactive/read-only path for %o', async ({ args, mode, hasUI }) => {
    const command = captureCodexMarketplaceCommand();
    const notifications: string[] = [];
    await command.handler(args, {
      cwd,
      mode,
      hasUI,
      isProjectTrusted: () => true,
      ui: {
        notify(message: string) {
          notifications.push(message);
        },
        select: async () => {
          throw new Error('read-only fallback must not select');
        },
        custom: async () => {
          throw new Error('read-only fallback must not open custom TUI');
        },
      },
    });

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toContain('Global Scope');
    expect(notifications[0]).toContain('Project Scope');
  });
});
