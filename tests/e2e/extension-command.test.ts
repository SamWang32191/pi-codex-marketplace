import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import registerBridgeExtension from '../../extensions/pi/index.js';
import { writeMinimalBridgeState, type MinimalBridgeState } from '../../src/bridge/state.js';

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

describe('/codex-marketplace thin Pi adapter seam (#88)', () => {
  let cwd: string;
  let agentDir: string;
  let statePath: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'bridge-adapter-cwd-'));
    agentDir = mkdtempSync(join(tmpdir(), 'bridge-adapter-agent-'));
    statePath = join(agentDir, 'codex-marketplace', 'state.json');
    mkdirSync(join(agentDir, 'codex-marketplace'), { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_AGENT_DIR = agentDir;
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    delete process.env.PI_CODING_AGENT_DIR;
    delete process.env.PI_AGENT_DIR;
  });

  it('routes overview output to ctx.ui.notify on no arguments', async () => {
    const command = captureCodexMarketplaceCommand();
    const notifications: { message: string; type: string }[] = [];

    const ctx = {
      cwd,
      mode: 'tui',
      hasUI: true,
      ui: {
        notify(message: string, type: string) {
          notifications.push({ message, type });
        },
      },
      reload: async () => {},
    };

    await command.handler('', ctx);

    expect(notifications).toHaveLength(1);
    expect(notifications[0].type).toBe('info');
    expect(notifications[0].message).toContain('Marketplaces');
    expect(notifications[0].message).toContain('Installed');
    expect(notifications[0].message).toContain('用法：/codex-marketplace');
  });

  it('routes help output to ctx.ui.notify on help argument', async () => {
    const command = captureCodexMarketplaceCommand();
    const notifications: { message: string; type: string }[] = [];

    const ctx = {
      cwd,
      mode: 'tui',
      hasUI: true,
      ui: {
        notify(message: string, type: string) {
          notifications.push({ message, type });
        },
      },
      reload: async () => {},
    };

    await command.handler('help', ctx);

    expect(notifications).toHaveLength(1);
    expect(notifications[0].message).toContain('add');
    expect(notifications[0].message).toContain('list');
    expect(notifications[0].message).toContain('install');
    expect(notifications[0].message).toContain('update');
    expect(notifications[0].message).toContain('disable');
    expect(notifications[0].message).toContain('enable');
    expect(notifications[0].message).toContain('remove');
    expect(notifications[0].message).toContain('forget');
    expect(notifications[0].message).toContain('help');
  });

  it('notifies warning notice and resets corrupted state file', async () => {
    writeFileSync(statePath, 'INVALID JSON CONTENT', 'utf-8');

    const command = captureCodexMarketplaceCommand();
    const notifications: { message: string; type: string }[] = [];

    const ctx = {
      cwd,
      mode: 'tui',
      hasUI: true,
      ui: {
        notify(message: string, type: string) {
          notifications.push({ message, type });
        },
      },
      reload: async () => {},
    };

    await command.handler('', ctx);

    expect(notifications).toHaveLength(1);
    expect(notifications[0].message).toMatch(/損壞|重置/);
    expect(notifications[0].message).toContain('Marketplaces');
  });

  it('does not invoke ctx.reload when reload flag is false', async () => {
    const command = captureCodexMarketplaceCommand();
    let reloaded = false;

    const ctx = {
      cwd,
      mode: 'tui',
      hasUI: true,
      ui: {
        notify() {},
      },
      reload: async () => {
        reloaded = true;
      },
    };

    await command.handler('help', ctx);
    expect(reloaded).toBe(false);
  });
});
