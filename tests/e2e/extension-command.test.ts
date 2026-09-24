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
    expect(notifications[0].message).toContain('skills');
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

  it('requests ctx.reload for a Skill Exclusion change and never for a read-only listing', async () => {
    const mktRoot = join(cwd, 'skills-marketplace');
    mkdirSync(join(mktRoot, '.agents', 'plugins'), { recursive: true });
    writeFileSync(
      join(mktRoot, '.agents', 'plugins', 'marketplace.json'),
      JSON.stringify({
        name: 'skills-mkt',
        plugins: [{ name: 'skill-plugin', source: { source: 'local', path: './plugins/skill-plugin' } }],
      }),
    );
    mkdirSync(join(mktRoot, 'plugins', 'skill-plugin', '.codex-plugin'), { recursive: true });
    writeFileSync(
      join(mktRoot, 'plugins', 'skill-plugin', '.codex-plugin', 'plugin.json'),
      JSON.stringify({ name: 'skill-plugin' }),
    );
    for (const skill of ['drop-me', 'keep-me']) {
      mkdirSync(join(mktRoot, 'plugins', 'skill-plugin', 'skills', skill), { recursive: true });
      writeFileSync(
        join(mktRoot, 'plugins', 'skill-plugin', 'skills', skill, 'SKILL.md'),
        `---\nname: ${skill}\ndescription: ${skill}\n---\n\nBody\n`,
      );
    }

    const command = captureCodexMarketplaceCommand();
    let reloads = 0;
    const ctx = {
      cwd,
      mode: 'tui',
      hasUI: true,
      ui: { notify() {} },
      reload: async () => {
        reloads += 1;
      },
    };

    await command.handler(`add ${mktRoot}`, ctx);
    await command.handler('install skill-plugin', ctx);
    const afterInstall = reloads;
    expect(afterInstall).toBeGreaterThan(0);

    await command.handler('skills skill-plugin', ctx);
    expect(reloads).toBe(afterInstall);

    await command.handler('skills skill-plugin exclude drop-me', ctx);
    expect(reloads).toBe(afterInstall + 1);

    await command.handler('skills skill-plugin include drop-me', ctx);
    expect(reloads).toBe(afterInstall + 2);

    // #157: a batch keep-only is a state change; repeating it is not, and reset is again.
    await command.handler('skills skill-plugin only keep-me', ctx);
    expect(reloads).toBe(afterInstall + 3);

    await command.handler('skills skill-plugin only keep-me', ctx);
    expect(reloads).toBe(afterInstall + 3);

    await command.handler('skills skill-plugin reset', ctx);
    expect(reloads).toBe(afterInstall + 4);

    await command.handler('skills skill-plugin', ctx);
    expect(reloads).toBe(afterInstall + 4);
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
