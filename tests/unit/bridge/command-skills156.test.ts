/**
 * Skill Exclusion command surface (#156).
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

function makeClaudeMarketplace(
  root: string,
  name: string,
  plugins: { name: string; path: string; skills?: string[] }[],
): void {
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(root, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      name,
      owner: { name: 'Test Owner' },
      plugins: plugins.map((p) => ({ name: p.name, source: p.path })),
    }),
  );
  for (const p of plugins) {
    const abs = join(root, p.path.replace(/^\.\//, ''));
    mkdirSync(join(abs, '.claude-plugin'), { recursive: true });
    const declared = (p.skills ?? []).map((skill) => `./skills/${skill}`);
    writeFileSync(
      join(abs, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: p.name, skills: declared }),
    );
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

describe('Skill Exclusion — per-item view and adjustment (#156)', () => {
  let mktRoot: string;
  let agentDir: string;

  beforeEach(() => {
    mktRoot = mkdtempSync(join(tmpdir(), 'mkt156-'));
    agentDir = mkdtempSync(join(tmpdir(), 'agent156-'));
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

  it('lists an Installation skills with their exclusion state without requesting a reload', async () => {
    await installOne(
      [{ name: 'release-helper', path: './plugins/release-helper', skills: ['changelog', 'release-notes'] }],
      'release-helper',
    );

    const listed = await runCommand(['skills', 'release-helper'], { agentDir });

    expect(listed.ok).toBe(true);
    expect(listed.reload).toBe(false);
    expect(listed.output).toContain('release-helper');
    expect(listed.output).toContain('changelog');
    expect(listed.output).toContain('release-notes');
    expect(listed.output).not.toContain('已排除');
  });

  it('marks excluded skills in the list, including a name the current source no longer offers', async () => {
    await installOne(
      [{ name: 'release-helper', path: './plugins/release-helper', skills: ['changelog', 'release-notes'] }],
      'release-helper',
    );
    const seeded = readMinimalBridgeState({ agentDir }).state;
    seeded.installations[0]!.skillExclusions = ['changelog', 'vanished-skill'];
    writeMinimalBridgeState(seeded, { agentDir });

    const listed = await runCommand(['skills', 'release-helper'], { agentDir });

    expect(listed.ok).toBe(true);
    expect(listed.reload).toBe(false);
    expect(listed.output).toMatch(/changelog（已排除）/);
    // A name that disappeared upstream stays visible and restorable.
    expect(listed.output).toMatch(/vanished-skill（已排除）/);
    expect(listed.output).toContain('release-notes（可貢獻）');
    expect(listed.output).not.toContain('已載入');
  });

  it('excludes a currently discovered skill, records it, and requests a reload', async () => {
    await installOne(
      [{ name: 'release-helper', path: './plugins/release-helper', skills: ['changelog', 'release-notes'] }],
      'release-helper',
    );

    const excluded = await runCommand(['skills', 'release-helper', 'exclude', 'changelog'], { agentDir });

    expect(excluded.ok).toBe(true);
    expect(excluded.reload).toBe(true);
    expect(excluded.output).toContain('已重新載入生效');
    expect(excluded.output).toContain('changelog');
    expect(readMinimalBridgeState({ agentDir }).state.installations[0]!.skillExclusions).toEqual(['changelog']);
    // The excluded skill is no longer contributed; the Plugin stays installed and enabled.
    const proj = discoverProjectedSkillPaths({ agentDir });
    expect(proj.exposed.map((s) => s.name)).toEqual(['release-notes']);
    expect(readMinimalBridgeState({ agentDir }).state.installations[0]!.enabled).toBe(true);
  });

  it('excludes a skill of a Git-sourced Installation from its pinned Source Cache material', async () => {
    makeCodexMarketplace(mktRoot, 'demo-marketplace', [
      { name: 'release-helper', path: './plugins/release-helper', skills: ['changelog', 'release-notes'] },
    ]);
    const fingerprint = 'b'.repeat(64);
    await new SourceCache({ agentDir }).storeTree(mktRoot, fingerprint);
    writeMinimalBridgeState({
      schemaVersion: 1,
      registrations: [
        {
          id: '33333333-3333-4333-8333-333333333333',
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
          registrationId: '33333333-3333-4333-8333-333333333333',
          manifestName: 'release-helper',
          sourceKind: 'git',
          source: 'https://github.com/acme/marketplace.git',
          snapshot: fingerprint,
          skills: ['changelog', 'release-notes'],
        },
      ],
    }, { agentDir });

    const excluded = await runCommand(['skills', 'release-helper', 'exclude', 'release-notes'], { agentDir });

    expect(excluded.ok).toBe(true);
    expect(excluded.reload).toBe(true);
    expect(readMinimalBridgeState({ agentDir }).state.installations[0]!.skillExclusions).toEqual(['release-notes']);
    expect(discoverProjectedSkillPaths({ agentDir }).exposed.map((s) => s.name)).toEqual(['changelog']);
  });

  it('refuses an unknown skill name and leaves Bridge State and exposure untouched', async () => {
    await installOne(
      [{ name: 'release-helper', path: './plugins/release-helper', skills: ['changelog', 'release-notes'] }],
      'release-helper',
    );

    const refused = await runCommand(['skills', 'release-helper', 'exclude', 'not-a-skill'], { agentDir });

    expect(refused.ok).toBe(false);
    expect(refused.reload).toBe(false);
    expect(refused.output).toContain('錯誤：');
    expect(refused.output).toContain('not-a-skill');
    expect(readMinimalBridgeState({ agentDir }).state.installations[0]!.skillExclusions).toBeUndefined();
    expect(discoverProjectedSkillPaths({ agentDir }).exposed.map((s) => s.name).sort()).toEqual(['changelog', 'release-notes']);
  });

  it('refuses an ambiguous Plugin name without changing either Installation', async () => {
    const otherRoot = join(agentDir, 'other-marketplace');
    makeCodexMarketplace(mktRoot, 'alpha-marketplace', [
      { name: 'shared-name', path: './plugins/shared-name', skills: ['alpha-skill'] },
    ]);
    makeCodexMarketplace(otherRoot, 'beta-marketplace', [
      { name: 'shared-name', path: './plugins/shared-name', skills: ['beta-skill'] },
    ]);
    await runCommand(['add', mktRoot], { agentDir });
    await runCommand(['add', otherRoot], { agentDir });
    await runCommand(['install', '1'], { agentDir });
    await runCommand(['install', '2'], { agentDir });

    const refused = await runCommand(['skills', 'shared-name', 'exclude', 'alpha-skill'], { agentDir });

    expect(refused.ok).toBe(false);
    expect(refused.reload).toBe(false);
    expect(refused.output).toContain('對應多個已安裝 plugin');
    for (const installation of readMinimalBridgeState({ agentDir }).state.installations) {
      expect(installation.skillExclusions).toBeUndefined();
    }
  });

  it('refuses an exclusion when the Marketplace Catalog cannot be read', async () => {
    await installOne(
      [{ name: 'release-helper', path: './plugins/release-helper', skills: ['changelog'] }],
      'release-helper',
    );
    rmSync(join(mktRoot, '.agents', 'plugins', 'marketplace.json'));

    const refused = await runCommand(['skills', 'release-helper', 'exclude', 'changelog'], { agentDir });

    expect(refused.ok).toBe(false);
    expect(refused.reload).toBe(false);
    expect(refused.output).toContain('錯誤：');
    expect(readMinimalBridgeState({ agentDir }).state.installations[0]!.skillExclusions).toBeUndefined();
  });

  it('refuses an exclusion when the Plugin directory no longer exists in the source', async () => {
    await installOne(
      [{ name: 'release-helper', path: './plugins/release-helper', skills: ['changelog'] }],
      'release-helper',
    );
    rmSync(join(mktRoot, 'plugins', 'release-helper'), { recursive: true, force: true });

    const refused = await runCommand(['skills', 'release-helper', 'exclude', 'changelog'], { agentDir });

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
      failed = await runCommand(['skills', 'release-helper', 'exclude', 'changelog'], { agentDir, lockTimeoutMs: 50 });
    } finally {
      chmodSync(stateDir, 0o755);
    }

    expect(failed.ok).toBe(false);
    expect(failed.reload).toBe(false);
    expect(failed.output).toContain('錯誤：寫入 Bridge State 失敗');
    expect(readMinimalBridgeState({ agentDir }).state.installations[0]!.skillExclusions).toBeUndefined();
    expect(discoverProjectedSkillPaths({ agentDir }).exposed.map((s) => s.name).sort()).toEqual(['changelog', 'release-notes']);
  });

  it('restores an excluded skill and requests a reload, without needing the source again', async () => {
    await installOne(
      [{ name: 'release-helper', path: './plugins/release-helper', skills: ['changelog', 'release-notes'] }],
      'release-helper',
    );
    await runCommand(['skills', 'release-helper', 'exclude', 'changelog'], { agentDir });
    const seeded = readMinimalBridgeState({ agentDir }).state;
    seeded.installations[0]!.skillExclusions = ['changelog', 'vanished-skill'];
    writeMinimalBridgeState(seeded, { agentDir });

    const restored = await runCommand(['skills', 'release-helper', 'include', 'changelog'], { agentDir });

    expect(restored.ok).toBe(true);
    expect(restored.reload).toBe(true);
    expect(restored.output).toContain('已重新載入生效');
    expect(readMinimalBridgeState({ agentDir }).state.installations[0]!.skillExclusions).toEqual(['vanished-skill']);
    expect(discoverProjectedSkillPaths({ agentDir }).exposed.map((s) => s.name).sort()).toEqual(['changelog', 'release-notes']);

    // A name that disappeared from the source stays restorable: restoring never rereads it.
    const vanished = await runCommand(['skills', 'release-helper', 'include', 'vanished-skill'], { agentDir });
    expect(vanished.ok).toBe(true);
    expect(vanished.reload).toBe(true);
    expect(readMinimalBridgeState({ agentDir }).state.installations[0]!.skillExclusions).toEqual([]);
  });

  it('restores an exclusion whose source has become unreadable', async () => {
    await installOne(
      [{ name: 'release-helper', path: './plugins/release-helper', skills: ['changelog'] }],
      'release-helper',
    );
    await runCommand(['skills', 'release-helper', 'exclude', 'changelog'], { agentDir });
    rmSync(join(mktRoot, 'plugins', 'release-helper'), { recursive: true, force: true });

    const restored = await runCommand(['skills', 'release-helper', 'include', 'changelog'], { agentDir });

    expect(restored.ok).toBe(true);
    expect(restored.reload).toBe(true);
    expect(readMinimalBridgeState({ agentDir }).state.installations[0]!.skillExclusions).toEqual([]);
  });

  it('refuses to restore a skill that is not excluded and changes nothing', async () => {
    await installOne(
      [{ name: 'release-helper', path: './plugins/release-helper', skills: ['changelog'] }],
      'release-helper',
    );

    const refused = await runCommand(['skills', 'release-helper', 'include', 'changelog'], { agentDir });

    expect(refused.ok).toBe(false);
    expect(refused.reload).toBe(false);
    expect(refused.output).toContain('錯誤：');
    expect(readMinimalBridgeState({ agentDir }).state.installations[0]!.skillExclusions).toBeUndefined();
  });

  it('keeps exclusions across reinstall and update, and lets a newly added skill be exposed', async () => {
    await installOne(
      [{ name: 'release-helper', path: './plugins/release-helper', skills: ['changelog', 'release-notes'] }],
      'release-helper',
    );
    await runCommand(['skills', 'release-helper', 'exclude', 'changelog'], { agentDir });

    const reinstalled = await runCommand(['install', 'release-helper'], { agentDir });
    expect(reinstalled.output).toContain('已重新載入生效');
    expect(readMinimalBridgeState({ agentDir }).state.installations[0]!.skillExclusions).toEqual(['changelog']);
    expect(discoverProjectedSkillPaths({ agentDir }).exposed.map((s) => s.name)).toEqual(['release-notes']);

    // Upstream adds a skill: update keeps the exclusion and exposes the new name by default.
    const addedSkill = join(mktRoot, 'plugins', 'release-helper', 'skills', 'new-notes');
    mkdirSync(addedSkill, { recursive: true });
    writeFileSync(join(addedSkill, 'SKILL.md'), '---\nname: new-notes\ndescription: New notes\n---\n\nBody\n');
    const updated = await runCommand(['update'], { agentDir });
    expect(updated.reload).toBe(true);
    expect(readMinimalBridgeState({ agentDir }).state.installations[0]!.skillExclusions).toEqual(['changelog']);
    expect(discoverProjectedSkillPaths({ agentDir }).exposed.map((s) => s.name).sort()).toEqual(['new-notes', 'release-notes']);
  });

  it('keeps exclusions across disable and enable', async () => {
    await installOne(
      [{ name: 'release-helper', path: './plugins/release-helper', skills: ['changelog', 'release-notes'] }],
      'release-helper',
    );
    await runCommand(['skills', 'release-helper', 'exclude', 'changelog'], { agentDir });

    await runCommand(['disable', 'release-helper'], { agentDir });
    const enabled = await runCommand(['enable', 'release-helper'], { agentDir });

    expect(enabled.output).toContain('已重新載入生效');
    expect(readMinimalBridgeState({ agentDir }).state.installations[0]!.skillExclusions).toEqual(['changelog']);
    expect(discoverProjectedSkillPaths({ agentDir }).exposed.map((s) => s.name)).toEqual(['release-notes']);
  });

  it('drops exclusions when the Installation is removed or its Marketplace is forgotten', async () => {
    await installOne(
      [{ name: 'release-helper', path: './plugins/release-helper', skills: ['changelog', 'release-notes'] }],
      'release-helper',
    );
    await runCommand(['skills', 'release-helper', 'exclude', 'changelog'], { agentDir });

    await runCommand(['remove', 'release-helper'], { agentDir });
    await runCommand(['install', 'release-helper'], { agentDir });
    expect(readMinimalBridgeState({ agentDir }).state.installations[0]!.skillExclusions).toBeUndefined();
    expect(discoverProjectedSkillPaths({ agentDir }).exposed.map((s) => s.name).sort()).toEqual(['changelog', 'release-notes']);

    await runCommand(['skills', 'release-helper', 'exclude', 'changelog'], { agentDir });
    await runCommand(['forget', 'demo-marketplace'], { agentDir });
    expect(readMinimalBridgeState({ agentDir }).state.installations).toEqual([]);
    await runCommand(['add', mktRoot], { agentDir });
    await runCommand(['install', 'release-helper'], { agentDir });
    expect(readMinimalBridgeState({ agentDir }).state.installations[0]!.skillExclusions).toBeUndefined();
  });

  it('treats an Installation recorded without the field as all-allow without resetting Bridge State', async () => {
    await installOne(
      [{ name: 'release-helper', path: './plugins/release-helper', skills: ['changelog', 'release-notes'] }],
      'release-helper',
    );
    const legacy = readMinimalBridgeState({ agentDir }).state;
    delete legacy.installations[0]!.skillExclusions;
    writeMinimalBridgeState(legacy, { agentDir });

    const read = readMinimalBridgeState({ agentDir });

    expect(read.wasReset).toBe(false);
    expect(read.state.installations[0]!.skillExclusions).toBeUndefined();
    expect(discoverProjectedSkillPaths({ agentDir }).exposed.map((s) => s.name).sort()).toEqual(['changelog', 'release-notes']);
    expect((await runCommand(['skills', 'release-helper'], { agentDir })).output).not.toContain('已排除');
  });

  it('does not treat an excluded skill of another Installation as a name conflict', async () => {
    const otherRoot = join(agentDir, 'other-marketplace');
    makeCodexMarketplace(mktRoot, 'alpha-marketplace', [{ name: 'alpha', path: './plugins/alpha', skills: ['shared'] }]);
    makeCodexMarketplace(otherRoot, 'beta-marketplace', [{ name: 'beta', path: './plugins/beta', skills: ['shared'] }]);
    await runCommand(['add', mktRoot], { agentDir });
    await runCommand(['install', 'alpha'], { agentDir });
    await runCommand(['skills', 'alpha', 'exclude', 'shared'], { agentDir });
    await runCommand(['add', otherRoot], { agentDir });

    const installed = await runCommand(['install', 'beta'], { agentDir });

    expect(installed.ok).toBe(true);
    expect(installed.output).not.toContain('名稱衝突');
    expect(discoverProjectedSkillPaths({ agentDir }).exposed.map((s) => `${s.pluginId}/${s.name}`)).toEqual(['beta/shared']);
  });

  it('does not treat a reinstalled Plugins own excluded skill as a name conflict', async () => {
    const otherRoot = join(agentDir, 'other-marketplace');
    makeCodexMarketplace(mktRoot, 'alpha-marketplace', [{ name: 'alpha', path: './plugins/alpha', skills: ['shared'] }]);
    makeCodexMarketplace(otherRoot, 'beta-marketplace', [{ name: 'beta', path: './plugins/beta', skills: ['shared'] }]);
    await runCommand(['add', mktRoot], { agentDir });
    await runCommand(['add', otherRoot], { agentDir });
    await runCommand(['install', 'alpha'], { agentDir });
    await runCommand(['install', 'beta'], { agentDir });
    await runCommand(['skills', 'alpha', 'exclude', 'shared'], { agentDir });

    const reinstalled = await runCommand(['install', 'alpha'], { agentDir });

    expect(reinstalled.output).not.toContain('名稱衝突');
    expect(discoverProjectedSkillPaths({ agentDir }).exposed.map((s) => `${s.pluginId}/${s.name}`)).toEqual(['beta/shared']);
  });

  it('does not treat an excluded skill as a name conflict when the Plugin is re-enabled', async () => {
    const otherRoot = join(agentDir, 'other-marketplace');
    makeCodexMarketplace(mktRoot, 'alpha-marketplace', [{ name: 'alpha', path: './plugins/alpha', skills: ['shared'] }]);
    makeCodexMarketplace(otherRoot, 'beta-marketplace', [{ name: 'beta', path: './plugins/beta', skills: ['shared'] }]);
    await runCommand(['add', mktRoot], { agentDir });
    await runCommand(['add', otherRoot], { agentDir });
    await runCommand(['install', 'alpha'], { agentDir });
    await runCommand(['install', 'beta'], { agentDir });
    await runCommand(['skills', 'alpha', 'exclude', 'shared'], { agentDir });
    await runCommand(['disable', 'alpha'], { agentDir });

    const enabled = await runCommand(['enable', 'alpha'], { agentDir });

    expect(enabled.output).not.toContain('名稱衝突');
    expect(discoverProjectedSkillPaths({ agentDir }).exposed.map((s) => `${s.pluginId}/${s.name}`)).toEqual(['beta/shared']);
  });

  it('reports an already-excluded skill without rereading an unreadable source', async () => {
    await installOne([{ name: 'release-helper', path: './plugins/release-helper', skills: ['changelog'] }], 'release-helper');
    await runCommand(['skills', 'release-helper', 'exclude', 'changelog'], { agentDir });
    rmSync(join(mktRoot, 'plugins', 'release-helper'), { recursive: true, force: true });

    const again = await runCommand(['skills', 'release-helper', 'exclude', 'changelog'], { agentDir });

    expect(again.ok).toBe(true);
    expect(again.reload).toBe(false);
    expect(again.output).toContain('已是排除狀態');
    expect(readMinimalBridgeState({ agentDir }).state.installations[0]!.skillExclusions).toEqual(['changelog']);
  });

  it('keeps the Plugin installed and enabled when every skill is excluded', async () => {
    await installOne(
      [{ name: 'release-helper', path: './plugins/release-helper', skills: ['changelog', 'release-notes'] }],
      'release-helper',
    );
    await runCommand(['skills', 'release-helper', 'exclude', 'changelog'], { agentDir });

    const all = await runCommand(['skills', 'release-helper', 'exclude', 'release-notes'], { agentDir });

    expect(all.ok).toBe(true);
    expect(all.reload).toBe(true);
    const state = readMinimalBridgeState({ agentDir }).state;
    expect(state.installations[0]!.enabled).toBe(true);
    expect(state.installations[0]!.installationState).toBe('enabled');
    const proj = discoverProjectedSkillPaths({ agentDir });
    expect(proj.skillPaths).toEqual([]);
    // A fully excluded Plugin is a choice, not a source-level failure.
    expect(proj.skipped).toEqual([]);
    expect((await runCommand(['skills', 'release-helper'], { agentDir })).output).toContain('已排除 2');
  });

  it('keeps an exclusion for a name that vanishes upstream, and treats a rename as a new skill', async () => {
    await installOne(
      [{ name: 'release-helper', path: './plugins/release-helper', skills: ['changelog', 'release-notes'] }],
      'release-helper',
    );
    await runCommand(['skills', 'release-helper', 'exclude', 'release-notes'], { agentDir });

    // Upstream drops the name: the exclusion record survives the update.
    rmSync(join(mktRoot, 'plugins', 'release-helper', 'skills', 'release-notes'), { recursive: true, force: true });
    await runCommand(['update'], { agentDir });
    expect(readMinimalBridgeState({ agentDir }).state.installations[0]!.skillExclusions).toEqual(['release-notes']);

    // The same name reappears upstream: it stays excluded.
    const reappeared = join(mktRoot, 'plugins', 'release-helper', 'skills', 'release-notes');
    mkdirSync(reappeared, { recursive: true });
    writeFileSync(join(reappeared, 'SKILL.md'), '---\nname: release-notes\ndescription: Back again\n---\n\nBody\n');
    await runCommand(['update'], { agentDir });
    expect(discoverProjectedSkillPaths({ agentDir }).exposed.map((s) => s.name)).toEqual(['changelog']);

    // A renamed skill is a new Skill Descriptor name and is allowed by default.
    rmSync(join(mktRoot, 'plugins', 'release-helper', 'skills', 'changelog'), { recursive: true, force: true });
    const renamed = join(mktRoot, 'plugins', 'release-helper', 'skills', 'changes');
    mkdirSync(renamed, { recursive: true });
    writeFileSync(join(renamed, 'SKILL.md'), '---\nname: changes\ndescription: Renamed\n---\n\nBody\n');
    await runCommand(['update'], { agentDir });
    expect(discoverProjectedSkillPaths({ agentDir }).exposed.map((s) => s.name)).toEqual(['changes']);
  });

  it('adjusts the exclusion list while the Plugin is disabled and applies it on re-enable', async () => {
    await installOne(
      [{ name: 'release-helper', path: './plugins/release-helper', skills: ['changelog', 'release-notes'] }],
      'release-helper',
    );
    await runCommand(['disable', 'release-helper'], { agentDir });

    const excluded = await runCommand(['skills', 'release-helper', 'exclude', 'changelog'], { agentDir });

    expect(excluded.ok).toBe(true);
    expect(readMinimalBridgeState({ agentDir }).state.installations[0]!.skillExclusions).toEqual(['changelog']);
    await runCommand(['enable', 'release-helper'], { agentDir });
    expect(discoverProjectedSkillPaths({ agentDir }).exposed.map((s) => s.name)).toEqual(['release-notes']);
  });

  it('applies exclusions for a Claude-format Marketplace', async () => {
    makeClaudeMarketplace(mktRoot, 'claude-marketplace', [
      { name: 'claude-plugin', path: './plugins/claude-plugin', skills: ['claude-skill', 'other-skill'] },
    ]);
    expect((await runCommand(['add', mktRoot], { agentDir })).output).toContain('claude');
    expect((await runCommand(['install', 'claude-plugin'], { agentDir })).output).toContain('已重新載入生效');

    const excluded = await runCommand(['skills', 'claude-plugin', 'exclude', 'claude-skill'], { agentDir });

    expect(excluded.ok).toBe(true);
    expect(excluded.reload).toBe(true);
    expect(readMinimalBridgeState({ agentDir }).state.installations[0]!.skillExclusions).toEqual(['claude-skill']);
    expect(discoverProjectedSkillPaths({ agentDir }).exposed.map((s) => s.name)).toEqual(['other-skill']);
  });
});
