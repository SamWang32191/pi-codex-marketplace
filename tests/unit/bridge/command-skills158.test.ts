/**
 * Status presentation and operation documentation (#158).
 *
 * Verified from the command entry point (`runCommand`) through Bridge State to Runtime Skill
 * Exposure: assertions use user-visible output (總覽, skill 明細, help) and the contributed
 * skill directories, never internal field manipulation. Seams are the ones the parent spec
 * pre-agreed: the command entry and `discoverProjectedSkillPaths`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCommand } from '../../../src/bridge/command.js';
import { readMinimalBridgeState } from '../../../src/bridge/state.js';
import { discoverProjectedSkillPaths } from '../../../src/projection/exposure.js';

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

describe('Skill Exclusion status presentation (#158)', () => {
  let mktRoot: string;
  let agentDir: string;

  beforeEach(() => {
    mktRoot = mkdtempSync(join(tmpdir(), 'mkt158-'));
    agentDir = mkdtempSync(join(tmpdir(), 'agent158-'));
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

  it('distinguishes enablement, current skills, and exclusions in the overview', async () => {
    await installOne(
      [{ name: 'release-helper', path: './plugins/release-helper', skills: ['changelog', 'release-notes', 'scratch'] }],
      'release-helper',
    );

    const before = await runCommand([], { agentDir });

    expect(before.output).toContain('3 skills');
    expect(before.output).toContain('啟用');
    expect(before.output).not.toContain('已排除');

    await runCommand(['skills', 'release-helper', 'exclude', 'scratch'], { agentDir });
    const after = await runCommand([], { agentDir });

    expect(after.output).toContain('3 skills（已排除 1）');
    expect(after.output).toContain('啟用');
    // The overview never claims Pi loaded the skills.
    expect(after.output).not.toContain('已載入');
  });

  it('distinguishes excluded, vanished, Bridge-known collision, and contributable skills', async () => {
    const otherRoot = join(agentDir, 'other-marketplace');
    makeCodexMarketplace(mktRoot, 'alpha-marketplace', [
      { name: 'alpha', path: './plugins/alpha', skills: ['shared', 'changelog', 'kept', 'retired'] },
    ]);
    makeCodexMarketplace(otherRoot, 'beta-marketplace', [{ name: 'beta', path: './plugins/beta', skills: ['shared'] }]);
    await runCommand(['add', mktRoot], { agentDir });
    await runCommand(['install', 'alpha'], { agentDir });
    await runCommand(['skills', 'alpha', 'exclude', 'changelog'], { agentDir });
    await runCommand(['add', otherRoot], { agentDir });
    await runCommand(['install', 'beta'], { agentDir });
    // The upstream drops `retired` after it was recorded: the record survives the read.
    rmSync(join(mktRoot, 'plugins', 'alpha', 'skills', 'retired'), { recursive: true, force: true });

    const listed = await runCommand(['skills', 'alpha'], { agentDir });

    expect(listed.ok).toBe(true);
    expect(listed.reload).toBe(false);
    expect(listed.output).toContain('目前 3 skills');
    expect(listed.output).toContain('已排除 1');
    expect(listed.output).toMatch(/changelog（已排除）/);
    expect(listed.output).toMatch(/shared（Bridge 已知同名衝突）/);
    expect(listed.output).toMatch(/kept（可貢獻）/);
    expect(listed.output).toMatch(/retired（來源已消失）/);
    // The listing is a report, never a claim that Pi loaded anything, and never a reload request.
    expect(listed.output).not.toContain('已載入');
    // Runtime Skill Exposure agrees with the reported statuses: same-layer Bridge colliders are
    // all unavailable, so only the non-colliding, non-excluded skill reaches Pi.
    expect(discoverProjectedSkillPaths({ agentDir }).exposed.map((s) => `${s.pluginId}/${s.name}`)).toEqual([
      'alpha/kept',
    ]);
  });

  it('reports a collision from the current material rather than a stale record', async () => {
    const otherRoot = join(agentDir, 'other-marketplace');
    makeCodexMarketplace(mktRoot, 'alpha-marketplace', [{ name: 'alpha', path: './plugins/alpha', skills: ['shared'] }]);
    // beta is installed before its upstream offers anything, so its record stays stale here.
    makeCodexMarketplace(otherRoot, 'beta-marketplace', [{ name: 'beta', path: './plugins/beta' }]);
    await runCommand(['add', mktRoot], { agentDir });
    await runCommand(['add', otherRoot], { agentDir });
    await runCommand(['install', 'alpha'], { agentDir });
    await runCommand(['install', 'beta'], { agentDir });
    const added = join(otherRoot, 'plugins', 'beta', 'skills', 'shared');
    mkdirSync(added, { recursive: true });
    writeFileSync(join(added, 'SKILL.md'), '---\nname: shared\ndescription: Shared from beta\n---\n\nBody\n');

    const listed = await runCommand(['skills', 'alpha'], { agentDir });

    // beta's live material claims the name, so alpha's skill is not contributable.
    expect(listed.output).toMatch(/shared（Bridge 已知同名衝突）/);
    expect(discoverProjectedSkillPaths({ agentDir }).exposed).toEqual([]);
  });

  it('reports a disabled Plugin skills as not projected instead of contributable', async () => {
    await installOne(
      [{ name: 'release-helper', path: './plugins/release-helper', skills: ['changelog', 'release-notes'] }],
      'release-helper',
    );
    await runCommand(['skills', 'release-helper', 'exclude', 'changelog'], { agentDir });
    await runCommand(['disable', 'release-helper'], { agentDir });

    const listed = await runCommand(['skills', 'release-helper'], { agentDir });

    expect(listed.output).toMatch(/release-notes（Plugin 已停用）/);
    expect(listed.output).toMatch(/changelog（已排除）/);
    expect(listed.output).not.toContain('可貢獻');
    expect(discoverProjectedSkillPaths({ agentDir }).exposed).toEqual([]);
  });

  it('reports an unreadable source as unconfirmed with the still-readable exclusions, never 0 skills', async () => {
    await installOne(
      [{ name: 'release-helper', path: './plugins/release-helper', skills: ['changelog', 'release-notes'] }],
      'release-helper',
    );
    await runCommand(['skills', 'release-helper', 'exclude', 'changelog'], { agentDir });
    rmSync(join(mktRoot, 'plugins', 'release-helper'), { recursive: true, force: true });

    const listed = await runCommand(['skills', 'release-helper'], { agentDir });
    const overview = await runCommand([], { agentDir });

    expect(listed.ok).toBe(true);
    expect(listed.reload).toBe(false);
    expect(listed.output).toContain('來源不可確認');
    expect(listed.output).toContain('無法確認目前 skills');
    expect(listed.output).toMatch(/changelog（已排除）/);
    expect(listed.output).toMatch(/release-notes（已記錄）/);
    expect(listed.output).not.toMatch(/0 skills/);
    expect(listed.output).not.toContain('已載入');
    expect(overview.output).toContain('skills 未確認');
    expect(overview.output).toContain('已排除 1');
    expect(overview.output).not.toMatch(/0 skills/);
    expect(overview.output).not.toContain('已載入');
  });

  it('documents per-item, keep-only, explicit all-exclusion, reset, and reload semantics in the help text', async () => {
    const help = await runCommand(['help'], { agentDir });

    expect(help.output).toContain('exclude <skill>');
    expect(help.output).toContain('include <skill>');
    expect(help.output).toContain('only <skill...>');
    expect(help.output).toContain('reset');
    // Excluding every skill is never what a missing name means.
    expect(help.output).toContain('逐一');
    // Reload semantics are stated without claiming the host confirmed a load.
    expect(help.output).toContain('reload');
    expect(help.output).not.toContain('已載入');
  });
});
