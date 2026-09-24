/**
 * Batch Skill Exclusion and reset (#157).
 *
 * Verified from the command entry point (`runCommand`) through Bridge State to Runtime Skill
 * Exposure, asserting on user-visible messages and the contributed skill directories rather
 * than on internal field manipulation. Seams are the ones the parent spec pre-agreed: the
 * command entry, `discoverProjectedSkillPaths`, and the extension `resources_discover` handler.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCommand } from '../../../src/bridge/command.js';
import { readMinimalBridgeState, writeMinimalBridgeState } from '../../../src/bridge/state.js';
import { discoverProjectedSkillPaths } from '../../../src/projection/exposure.js';
import { SourceCache } from '../../../src/cache/source-cache.js';

function makeCodexMarketplace(
  root: string,
  name: string,
  plugins: { name: string; path: string; skills?: string[] }[],
): void {
  mkdirSync(join(root, '.agents', 'plugins'), { recursive: true });
  writeFileSync(
    join(root, '.agents', 'plugins', 'marketplace.json'),
    JSON.stringify({ name, plugins: plugins.map((p) => ({ name: p.name, source: { source: 'local', path: p.path } })) }),
  );
  for (const p of plugins) {
    const abs = join(root, p.path.replace(/^\.\//, ''));
    mkdirSync(abs, { recursive: true });
    mkdirSync(join(abs, '.codex-plugin'), { recursive: true });
    writeFileSync(join(abs, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: p.name }));
    for (const skill of p.skills ?? []) {
      const sdir = join(abs, 'skills', skill);
      mkdirSync(sdir, { recursive: true });
      writeFileSync(
        join(sdir, 'SKILL.md'),
        `---\nname: ${skill}\ndescription: Desc for ${skill}\n---\n\nBody for ${skill}\n`,
      );
    }
  }
}

describe('Skill Exclusion — batch keep-only and reset (#157)', () => {
  let mktRoot: string;
  let agentDir: string;

  beforeEach(() => {
    mktRoot = mkdtempSync(join(tmpdir(), 'mkt157-'));
    agentDir = mkdtempSync(join(tmpdir(), 'agent157-'));
  });

  afterEach(() => {
    rmSync(mktRoot, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  });

  async function installOne(
    plugins: { name: string; path: string; skills?: string[] }[],
    installName: string,
    marketplace = 'demo-marketplace',
  ): Promise<void> {
    makeCodexMarketplace(mktRoot, marketplace, plugins);
    expect((await runCommand(['add', mktRoot], { agentDir })).output).toContain('已註冊');
    expect((await runCommand(['install', installName], { agentDir })).output).toContain('已重新載入生效');
  }

  it('keeps only the named skills, excluding the current rest in one adjustment', async () => {
    await installOne(
      [{ name: 'release-helper', path: './plugins/release-helper', skills: ['changelog', 'release-notes', 'scratch'] }],
      'release-helper',
    );

    const only = await runCommand(['skills', 'release-helper', 'only', 'changelog', 'release-notes'], { agentDir });

    expect(only.ok).toBe(true);
    expect(only.reload).toBe(true);
    expect(only.output).toContain('已重新載入生效');
    expect(readMinimalBridgeState({ agentDir }).state.installations[0]!.skillExclusions).toEqual(['scratch']);
    expect(discoverProjectedSkillPaths({ agentDir }).exposed.map((s) => s.name).sort()).toEqual(['changelog', 'release-notes']);
    // A batch exclusion is a choice, not a source-level failure: the Plugin stays enabled.
    expect(readMinimalBridgeState({ agentDir }).state.installations[0]!.enabled).toBe(true);
  });

  it('re-keeps an excluded name, preserves a vanished-name exclusion, and lets a later skill stay allowed', async () => {
    await installOne(
      [{ name: 'release-helper', path: './plugins/release-helper', skills: ['changelog', 'release-notes', 'scratch'] }],
      'release-helper',
    );
    const seeded = readMinimalBridgeState({ agentDir }).state;
    seeded.installations[0]!.skillExclusions = ['changelog', 'vanished-skill'];
    writeMinimalBridgeState(seeded, { agentDir });

    const only = await runCommand(['skills', 'release-helper', 'only', 'changelog', 'release-notes'], { agentDir });

    expect(only.ok).toBe(true);
    expect(only.reload).toBe(true);
    // changelog is kept (so no longer excluded), scratch joins the list, and the name the
    // source no longer offers survives untouched.
    expect(readMinimalBridgeState({ agentDir }).state.installations[0]!.skillExclusions).toEqual(['scratch', 'vanished-skill']);
    expect(discoverProjectedSkillPaths({ agentDir }).exposed.map((s) => s.name).sort()).toEqual(['changelog', 'release-notes']);

    // Upstream later adds a name: it was never in the kept or excluded set, so it is allowed.
    const added = join(mktRoot, 'plugins', 'release-helper', 'skills', 'new-notes');
    mkdirSync(added, { recursive: true });
    writeFileSync(join(added, 'SKILL.md'), '---\nname: new-notes\ndescription: New notes\n---\n\nBody\n');
    await runCommand(['update'], { agentDir });
    expect(readMinimalBridgeState({ agentDir }).state.installations[0]!.skillExclusions).toEqual(['scratch', 'vanished-skill']);
    expect(discoverProjectedSkillPaths({ agentDir }).exposed.map((s) => s.name).sort()).toEqual(['changelog', 'new-notes', 'release-notes']);
  });

  it('refuses one unknown name among valid ones and leaves the whole exclusion list untouched', async () => {
    await installOne(
      [{ name: 'release-helper', path: './plugins/release-helper', skills: ['changelog', 'release-notes'] }],
      'release-helper',
    );
    await runCommand(['skills', 'release-helper', 'exclude', 'release-notes'], { agentDir });

    const refused = await runCommand(['skills', 'release-helper', 'only', 'changelog', 'not-a-skill'], { agentDir });

    expect(refused.ok).toBe(false);
    expect(refused.reload).toBe(false);
    expect(refused.output).toContain('錯誤：');
    expect(refused.output).toContain('not-a-skill');
    expect(readMinimalBridgeState({ agentDir }).state.installations[0]!.skillExclusions).toEqual(['release-notes']);
    expect(discoverProjectedSkillPaths({ agentDir }).exposed.map((s) => s.name)).toEqual(['changelog']);
  });

  it('refuses a bare only instead of excluding every skill by omission', async () => {
    await installOne(
      [{ name: 'release-helper', path: './plugins/release-helper', skills: ['changelog', 'release-notes'] }],
      'release-helper',
    );

    const refused = await runCommand(['skills', 'release-helper', 'only'], { agentDir });

    expect(refused.ok).toBe(false);
    expect(refused.reload).toBe(false);
    expect(refused.output).toContain('錯誤：');
    expect(refused.output).toContain('用法：/codex-marketplace skills');
    expect(readMinimalBridgeState({ agentDir }).state.installations[0]!.skillExclusions).toBeUndefined();
    expect(discoverProjectedSkillPaths({ agentDir }).exposed.map((s) => s.name).sort()).toEqual(['changelog', 'release-notes']);
  });

  it('refuses to keep names when the source cannot be read, changing nothing', async () => {
    await installOne(
      [{ name: 'release-helper', path: './plugins/release-helper', skills: ['changelog', 'release-notes'] }],
      'release-helper',
    );
    rmSync(join(mktRoot, 'plugins', 'release-helper'), { recursive: true, force: true });

    const refused = await runCommand(['skills', 'release-helper', 'only', 'changelog'], { agentDir });

    expect(refused.ok).toBe(false);
    expect(refused.reload).toBe(false);
    expect(refused.output).toContain('錯誤：');
    expect(readMinimalBridgeState({ agentDir }).state.installations[0]!.skillExclusions).toBeUndefined();
  });

  it('leaves no partial exclusion when the Bridge State write fails', async () => {
    await installOne(
      [{ name: 'release-helper', path: './plugins/release-helper', skills: ['changelog', 'release-notes'] }],
      'release-helper',
    );
    const stateDir = join(agentDir, 'codex-marketplace');
    chmodSync(stateDir, 0o555);
    let failed;
    try {
      failed = await runCommand(['skills', 'release-helper', 'only', 'changelog'], { agentDir, lockTimeoutMs: 50 });
    } finally {
      chmodSync(stateDir, 0o755);
    }

    expect(failed.ok).toBe(false);
    expect(failed.reload).toBe(false);
    expect(failed.output).toContain('錯誤：寫入 Bridge State 失敗');
    expect(readMinimalBridgeState({ agentDir }).state.installations[0]!.skillExclusions).toBeUndefined();
    expect(discoverProjectedSkillPaths({ agentDir }).exposed.map((s) => s.name).sort()).toEqual(['changelog', 'release-notes']);
  });

  it('reports an already-matching keep-only without writing or requesting a reload', async () => {
    await installOne(
      [{ name: 'release-helper', path: './plugins/release-helper', skills: ['changelog', 'release-notes'] }],
      'release-helper',
    );
    await runCommand(['skills', 'release-helper', 'exclude', 'release-notes'], { agentDir });

    const again = await runCommand(['skills', 'release-helper', 'only', 'changelog'], { agentDir });

    expect(again.ok).toBe(true);
    expect(again.reload).toBe(false);
    expect(again.output).toContain('未變更');
    expect(readMinimalBridgeState({ agentDir }).state.installations[0]!.skillExclusions).toEqual(['release-notes']);
  });

  it('resets every exclusion including a vanished name and requests a reload', async () => {
    await installOne(
      [{ name: 'release-helper', path: './plugins/release-helper', skills: ['changelog', 'release-notes'] }],
      'release-helper',
    );
    const seeded = readMinimalBridgeState({ agentDir }).state;
    seeded.installations[0]!.skillExclusions = ['release-notes', 'vanished-skill'];
    writeMinimalBridgeState(seeded, { agentDir });

    const reset = await runCommand(['skills', 'release-helper', 'reset'], { agentDir });

    expect(reset.ok).toBe(true);
    expect(reset.reload).toBe(true);
    expect(reset.output).toContain('已重新載入生效');
    expect(readMinimalBridgeState({ agentDir }).state.installations[0]!.skillExclusions).toEqual([]);
    expect(discoverProjectedSkillPaths({ agentDir }).exposed.map((s) => s.name).sort()).toEqual(['changelog', 'release-notes']);
  });

  it('resets without reading the source and keeps a disabled Plugin disabled', async () => {
    await installOne(
      [{ name: 'release-helper', path: './plugins/release-helper', skills: ['changelog', 'release-notes'] }],
      'release-helper',
    );
    await runCommand(['skills', 'release-helper', 'exclude', 'release-notes'], { agentDir });
    await runCommand(['disable', 'release-helper'], { agentDir });
    rmSync(join(mktRoot, 'plugins', 'release-helper'), { recursive: true, force: true });

    const reset = await runCommand(['skills', 'release-helper', 'reset'], { agentDir });

    expect(reset.ok).toBe(true);
    expect(reset.reload).toBe(true);
    const state = readMinimalBridgeState({ agentDir }).state;
    expect(state.installations[0]!.skillExclusions).toEqual([]);
    expect(state.installations[0]!.enabled).toBe(false);
    expect(state.installations[0]!.installationState).toBe('disabled');
  });

  it('reports an empty exclusion list reset without writing or requesting a reload', async () => {
    await installOne(
      [{ name: 'release-helper', path: './plugins/release-helper', skills: ['changelog'] }],
      'release-helper',
    );

    const reset = await runCommand(['skills', 'release-helper', 'reset'], { agentDir });

    expect(reset.ok).toBe(true);
    expect(reset.reload).toBe(false);
    expect(reset.output).toContain('未變更');
    expect(readMinimalBridgeState({ agentDir }).state.installations[0]!.skillExclusions).toBeUndefined();
  });

  it('leaves no partial clear when a reset write fails', async () => {
    await installOne(
      [{ name: 'release-helper', path: './plugins/release-helper', skills: ['changelog', 'release-notes'] }],
      'release-helper',
    );
    await runCommand(['skills', 'release-helper', 'exclude', 'release-notes'], { agentDir });
    const stateDir = join(agentDir, 'codex-marketplace');
    chmodSync(stateDir, 0o555);
    let failed;
    try {
      failed = await runCommand(['skills', 'release-helper', 'reset'], { agentDir, lockTimeoutMs: 50 });
    } finally {
      chmodSync(stateDir, 0o755);
    }

    expect(failed.ok).toBe(false);
    expect(failed.reload).toBe(false);
    expect(failed.output).toContain('錯誤：寫入 Bridge State 失敗');
    expect(readMinimalBridgeState({ agentDir }).state.installations[0]!.skillExclusions).toEqual(['release-notes']);
    expect(discoverProjectedSkillPaths({ agentDir }).exposed.map((s) => s.name)).toEqual(['changelog']);
  });

  it('allows every current skill when the whole current list is named explicitly', async () => {
    await installOne(
      [{ name: 'release-helper', path: './plugins/release-helper', skills: ['changelog', 'release-notes'] }],
      'release-helper',
    );
    await runCommand(['skills', 'release-helper', 'exclude', 'release-notes'], { agentDir });

    const only = await runCommand(['skills', 'release-helper', 'only', 'release-notes', 'changelog'], { agentDir });

    expect(only.ok).toBe(true);
    expect(only.reload).toBe(true);
    expect(readMinimalBridgeState({ agentDir }).state.installations[0]!.skillExclusions).toEqual([]);
    expect(discoverProjectedSkillPaths({ agentDir }).exposed.map((s) => s.name).sort()).toEqual(['changelog', 'release-notes']);
  });

  it('refuses a multi-name exclude instead of silently changing only the first', async () => {
    await installOne(
      [{ name: 'release-helper', path: './plugins/release-helper', skills: ['changelog', 'release-notes', 'scratch'] }],
      'release-helper',
    );

    const refused = await runCommand(['skills', 'release-helper', 'exclude', 'changelog', 'release-notes'], { agentDir });

    expect(refused.ok).toBe(false);
    expect(refused.reload).toBe(false);
    expect(refused.output).toContain('錯誤：');
    expect(refused.output).toContain('一次只能指定一個 skill');
    expect(readMinimalBridgeState({ agentDir }).state.installations[0]!.skillExclusions).toBeUndefined();
    expect(discoverProjectedSkillPaths({ agentDir }).exposed.map((s) => s.name).sort()).toEqual(['changelog', 'release-notes', 'scratch']);
  });

  it('releases a colliding name through a batch keep-only so the other source can project it', async () => {
    const otherRoot = join(agentDir, 'other-marketplace');
    makeCodexMarketplace(mktRoot, 'alpha-marketplace', [{ name: 'alpha', path: './plugins/alpha', skills: ['shared', 'alpha-only'] }]);
    makeCodexMarketplace(otherRoot, 'beta-marketplace', [{ name: 'beta', path: './plugins/beta', skills: ['shared'] }]);
    await runCommand(['add', mktRoot], { agentDir });
    await runCommand(['install', 'alpha'], { agentDir });
    await runCommand(['add', otherRoot], { agentDir });
    await runCommand(['install', 'beta'], { agentDir });
    // Same-layer Bridge colliders deny each other, so `shared` projects from neither.
    expect(discoverProjectedSkillPaths({ agentDir }).exposed.map((s) => `${s.pluginId}/${s.name}`).sort()).toEqual(['alpha/alpha-only']);

    const only = await runCommand(['skills', 'alpha', 'only', 'alpha-only'], { agentDir });

    expect(only.ok).toBe(true);
    expect(only.reload).toBe(true);
    expect(readMinimalBridgeState({ agentDir }).state.installations[0]!.skillExclusions).toEqual(['shared']);
    // An excluded name no longer reserves itself: the other source's skill now survives.
    expect(discoverProjectedSkillPaths({ agentDir }).exposed.map((s) => `${s.pluginId}/${s.name}`).sort()).toEqual(['alpha/alpha-only', 'beta/shared']);
  });

  it('applies a batch keep-only for a Claude-format Marketplace', async () => {
    mkdirSync(join(mktRoot, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(mktRoot, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'claude-marketplace',
        owner: { name: 'Test Owner' },
        plugins: [{ name: 'claude-plugin', source: './plugins/claude-plugin' }],
      }),
    );
    const pluginDir = join(mktRoot, 'plugins', 'claude-plugin');
    mkdirSync(join(pluginDir, '.claude-plugin'), { recursive: true });
    const declared = ['claude-skill', 'other-skill', 'third-skill'];
    writeFileSync(
      join(pluginDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'claude-plugin', skills: declared.map((skill) => `./skills/${skill}`) }),
    );
    for (const skill of declared) {
      const sdir = join(pluginDir, 'skills', skill);
      mkdirSync(sdir, { recursive: true });
      writeFileSync(join(sdir, 'SKILL.md'), `---\nname: ${skill}\ndescription: Desc for ${skill}\n---\n\nBody\n`);
    }
    expect((await runCommand(['add', mktRoot], { agentDir })).output).toContain('claude');
    expect((await runCommand(['install', 'claude-plugin'], { agentDir })).output).toContain('已重新載入生效');

    const only = await runCommand(['skills', 'claude-plugin', 'only', 'claude-skill', 'third-skill'], { agentDir });

    expect(only.ok).toBe(true);
    expect(only.reload).toBe(true);
    expect(readMinimalBridgeState({ agentDir }).state.installations[0]!.skillExclusions).toEqual(['other-skill']);
    expect(discoverProjectedSkillPaths({ agentDir }).exposed.map((s) => s.name).sort()).toEqual(['claude-skill', 'third-skill']);
  });

  it('applies a batch keep-only for a Git-sourced Installation from its pinned Source Cache material', async () => {
    makeCodexMarketplace(mktRoot, 'demo-marketplace', [
      { name: 'release-helper', path: './plugins/release-helper', skills: ['changelog', 'release-notes', 'scratch'] },
    ]);
    const fingerprint = 'c'.repeat(64);
    await new SourceCache({ agentDir }).storeTree(mktRoot, fingerprint);
    writeMinimalBridgeState({
      schemaVersion: 1,
      registrations: [
        {
          id: '44444444-4444-4444-8444-444444444444',
          alias: 'acme',
          marketplaceName: 'demo-marketplace',
          format: 'codex',
          sourceKind: 'git',
          source: 'https://github.com/acme/marketplace.git',
          snapshot: fingerprint,
        },
      ],
      installations: [
        {
          id: 'release-helper',
          pluginId: 'release-helper',
          enabled: true,
          installationState: 'enabled',
          registrationId: '44444444-4444-4444-8444-444444444444',
          manifestName: 'release-helper',
          sourceKind: 'git',
          source: 'https://github.com/acme/marketplace.git',
          snapshot: fingerprint,
          skills: ['changelog', 'release-notes', 'scratch'],
        },
      ],
    }, { agentDir });

    const only = await runCommand(['skills', 'release-helper', 'only', 'changelog'], { agentDir });

    expect(only.ok).toBe(true);
    expect(only.reload).toBe(true);
    expect(readMinimalBridgeState({ agentDir }).state.installations[0]!.skillExclusions).toEqual(['release-notes', 'scratch']);
    expect(discoverProjectedSkillPaths({ agentDir }).exposed.map((s) => s.name)).toEqual(['changelog']);
  });
});
