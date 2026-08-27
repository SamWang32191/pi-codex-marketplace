import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCommand } from '../../../src/bridge/command.js';
import { writeMinimalBridgeState, type MinimalBridgeState } from '../../../src/bridge/state.js';

describe('runCommand dispatch seam (#88)', () => {
  let tmpDir: string;
  let statePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bridge-cmd-test-'));
    statePath = join(tmpDir, 'state.json');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('outputs overview with empty state text when state is empty (no args)', async () => {
    const result = await runCommand([], { statePath });

    expect(result.reload).toBe(false);
    expect(result.output).toContain('Marketplaces');
    expect(result.output).toContain('Installed');
    expect(result.output).toContain('用法：/codex-marketplace <add|list|install|update|disable|enable|remove|forget|help>');

    // Reasonably clear empty state message
    expect(result.output).toMatch(/尚未註冊|尚無註冊/);
    expect(result.output).toMatch(/尚未安裝|尚無安裝/);
  });

  it('outputs overview with populated state when registrations and installations exist', async () => {
    const state: MinimalBridgeState = {
      schemaVersion: 1,
      registrations: [
        {
          id: 'reg-1',
          marketplaceName: 'samwang-skills',
          format: 'codex',
          sourceKind: 'local',
          source: '/Users/samwang/skills',
        },
        {
          id: 'reg-2',
          marketplaceName: 'mattpocock',
          format: 'claude',
          sourceKind: 'git',
          source: 'https://github.com/mattpocock/skills',
        },
      ],
      installations: [
        {
          id: 'cmd',
          pluginId: 'cmd',
          enabled: true,
          installationState: 'enabled',
          registrationId: 'reg-1',
          manifestName: 'cmd',
          sourceKind: 'local',
          source: '/Users/samwang/skills',
          skills: ['a', 'b'],
        },
        {
          id: 'dev',
          pluginId: 'dev',
          enabled: false,
          installationState: 'disabled',
          registrationId: 'reg-1',
          manifestName: 'dev',
          sourceKind: 'local',
          source: '/Users/samwang/skills',
          skills: ['x'],
        },
      ],
    };
    writeMinimalBridgeState(state, { statePath });

    const result = await runCommand([], { statePath });

    expect(result.reload).toBe(false);
    expect(result.output).toContain('samwang-skills');
    expect(result.output).toContain('codex');
    expect(result.output).toContain('本地');
    expect(result.output).toContain('mattpocock');
    expect(result.output).toContain('claude');
    expect(result.output).toContain('git');

    expect(result.output).toContain('cmd');
    expect(result.output).toContain('[samwang-skills]');
    expect(result.output).toContain('2 skills');
    expect(result.output).toContain('啟用');

    expect(result.output).toContain('dev');
    expect(result.output).toContain('1 skills');
    expect(result.output).toContain('停用');
  });

  it('help subcommand lists all nine subcommands', async () => {
    const result = await runCommand(['help'], { statePath });

    expect(result.reload).toBe(false);
    const subcommands = [
      'add',
      'list',
      'install',
      'update',
      'disable',
      'enable',
      'remove',
      'forget',
      'help',
    ];
    for (const subcmd of subcommands) {
      expect(result.output).toContain(subcmd);
    }
  });

  it('unknown subcommand outputs usage hint and does not crash', async () => {
    const result = await runCommand(['foobar', 'extra-arg'], { statePath });

    expect(result.reload).toBe(false);
    expect(result.output).toContain('foobar');
    expect(result.output).toContain('用法：/codex-marketplace <add|list|install|update|disable|enable|remove|forget|help>');
  });

  it('resets corrupted state file, outputs reset warning notice, and presents empty state', async () => {
    writeFileSync(statePath, 'INVALID JSON CONTENT', 'utf-8');

    const result = await runCommand([], { statePath });

    expect(result.stateReset).toBe(true);
    expect(result.output).toMatch(/損壞|重置/);
    expect(result.output).toContain('Marketplaces');
    expect(result.output).toContain('Installed');
    expect(result.output).toContain('用法：/codex-marketplace <add|list|install|update|disable|enable|remove|forget|help>');
  });

  it('runs purely in Node environment with assertions on messages, lines, and reload flag', async () => {
    const stringArgResult = await runCommand('help', { statePath });
    expect(Array.isArray(stringArgResult.messages)).toBe(true);
    expect(Array.isArray(stringArgResult.lines)).toBe(true);
    expect(stringArgResult.messages).toEqual(stringArgResult.lines);
    expect(stringArgResult.output).toBe(stringArgResult.messages.join('\n'));
    expect(typeof stringArgResult.reload).toBe('boolean');
  });

  it('handles subcommands skeleton gracefully with usage hints on missing arguments', async () => {
    const subcommandsWithArgs = [
      { name: 'add', expected: /用法：.*add/ },
      { name: 'install', expected: /用法：.*install/ },
      { name: 'disable', expected: /用法：.*disable/ },
      { name: 'enable', expected: /用法：.*enable/ },
      { name: 'remove', expected: /用法：.*remove/ },
      { name: 'forget', expected: /用法：.*forget/ },
    ];

    for (const { name, expected } of subcommandsWithArgs) {
      const result = await runCommand([name], { statePath });
      expect(result.output).toMatch(expected);
      expect(result.reload).toBe(false);
    }
  });
});
