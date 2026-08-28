import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCommand } from '../../../src/bridge/command.js';
import { readMinimalBridgeState } from '../../../src/bridge/state.js';
import { discoverProjectedSkillPaths } from '../../../src/projection/exposure.js';

function makeCodexMarketplace(root: string, name: string, plugins: { name: string; path: string; skills?: string[] }[]) {
  mkdirSync(join(root, '.agents', 'plugins'), { recursive: true });
  writeFileSync(join(root, '.agents', 'plugins', 'marketplace.json'), JSON.stringify({ name, plugins: plugins.map(p=>({name:p.name, source:{source:'local', path:p.path}})) }));
  for (const p of plugins) {
    const abs = join(root, p.path.replace(/^\.\//, ''));
    mkdirSync(abs, { recursive: true });
    mkdirSync(join(abs, '.codex-plugin'), { recursive: true });
    writeFileSync(join(abs, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: p.name }));
    writeFileSync(join(abs, 'plugin.json'), JSON.stringify({ name: p.name }));
    if (p.skills) {
      for (const skill of p.skills) {
        const sdir = join(abs, 'skills', skill);
        mkdirSync(sdir, { recursive: true });
        writeFileSync(join(sdir, 'SKILL.md'), `---\nname: ${skill}\ndescription: Desc for ${skill}\n---\n\nBody for ${skill}\n`);
      }
    }
  }
}

describe('install #90', () => {
  let tmpDir: string;
  let statePath: string;
  let mktRoot: string;
  let mktRoot2: string;
  let agentDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bridge90-'));
    statePath = join(tmpDir, 'state.json');
    mktRoot = mkdtempSync(join(tmpdir(), 'mkt90-'));
    mktRoot2 = mkdtempSync(join(tmpdir(), 'mkt90-2-'));
    agentDir = mkdtempSync(join(tmpdir(), 'agent90-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(mktRoot, { recursive: true, force: true });
    rmSync(mktRoot2, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  });

  it('list shows plugin numbers and install succeeds with reload', async () => {
    makeCodexMarketplace(mktRoot, 'demo-marketplace', [
      { name: 'demo', path: './plugins/demo', skills: ['skill-a', 'skill-b'] },
      { name: 'empty', path: './plugins/empty', skills: [] },
    ]);
    let res = await runCommand(['add', mktRoot], { statePath });
    expect(res.output).toContain('已註冊');
    res = await runCommand(['list'], { statePath });
    expect(res.output).toContain('Plugins');
    expect(res.output).toContain('可安裝');
    // enumerate should contain 1 and 2
    expect(res.output).toMatch(/1.*demo/);
    expect(res.output).toMatch(/2.*empty/);

    res = await runCommand(['install', '1'], { statePath });
    expect(res.output).toContain('安裝 \"demo\"');
    expect(res.output).toContain('2 skills');
    expect(res.output).toContain('已重新載入生效');
    expect(res.reload).toBe(true);
    const st = readMinimalBridgeState({ statePath });
    expect(st.state.installations).toHaveLength(1);
    expect(st.state.installations[0].manifestName).toBe('demo');
    expect(st.state.installations[0].skills).toEqual(['skill-a', 'skill-b'].sort());
  });

  it('0 skills case', async () => {
    makeCodexMarketplace(mktRoot, 'demo-marketplace', [
      { name: 'demo', path: './plugins/demo', skills: ['skill-a'] },
      { name: 'empty', path: './plugins/empty', skills: [] },
    ]);
    await runCommand(['add', mktRoot], { statePath });
    const res = await runCommand(['install', '2'], { statePath });
    expect(res.output).toContain('安裝 \"empty\"');
    expect(res.output).toContain('0 skills');
    expect(res.output).toContain('已重新載入生效');
  });

  it('repeat install overwrites', async () => {
    makeCodexMarketplace(mktRoot, 'demo-marketplace', [
      { name: 'demo', path: './plugins/demo', skills: ['skill-a'] },
    ]);
    await runCommand(['add', mktRoot], { statePath });
    await runCommand(['install', '1'], { statePath });
    // add new skill file
    const demoPluginDir = join(mktRoot, 'plugins/demo');
    const newSkillDir = join(demoPluginDir, 'skills', 'skill-c');
    mkdirSync(newSkillDir, { recursive: true });
    writeFileSync(join(newSkillDir, 'SKILL.md'), `---\nname: skill-c\ndescription: Desc c\n---\n\nBody c\n`);
    const res = await runCommand(['install', '1'], { statePath });
    expect(res.output).toContain('2 skills');
    expect(res.output).toContain('skill-c');
    const st = readMinimalBridgeState({ statePath });
    expect(st.state.installations).toHaveLength(1);
    expect(st.state.installations[0].skills).toContain('skill-c');
  });

  it('collision detection', async () => {
    makeCodexMarketplace(mktRoot, 'demo-marketplace', [
      { name: 'demo', path: './plugins/demo', skills: ['skill-a', 'skill-b'] },
    ]);
    // Use new helper that writes source path correctly
    // Need to fix makeCodexMarketplace plugins entry to include path as nested source
    // Already done via source field
    await runCommand(['add', mktRoot], { statePath });
    await runCommand(['install', '1'], { statePath });

    makeCodexMarketplace(mktRoot2, 'second-marketplace', [
      { name: 'other', path: './plugins/other', skills: ['skill-a', 'skill-x'] },
    ]);
    await runCommand(['add', mktRoot2], { statePath });
    const res = await runCommand(['install', '2'], { statePath });
    // other should be number 2 (since demo 1, other 2)
    expect(res.output).toContain('未投影（名稱衝突）');
    expect(res.output).toContain('skill-a');
  });

  it('e2e projection', async () => {
    const mktE2E = mkdtempSync(join(tmpdir(), 'mkt-e2e-'));
    try {
      makeCodexMarketplace(mktE2E, 'e2e-marketplace', [
        { name: 'e2e-plugin', path: './plugins/e2e-plugin', skills: ['e2e-skill'] },
      ]);
      let res = await runCommand(['add', mktE2E], { agentDir });
      expect(res.output).toContain('已註冊');
      res = await runCommand(['install', '1'], { agentDir });
      expect(res.output).toContain('已重新載入生效');
      expect(res.reload).toBe(true);
      const proj = discoverProjectedSkillPaths({ agentDir });
      expect(proj.skillPaths.some(p => p.includes('e2e-skill'))).toBe(true);
    } finally {
      rmSync(mktE2E, { recursive: true, force: true });
    }
  });

  it('list shows 已裝啟用 after install', async () => {
    makeCodexMarketplace(mktRoot, 'demo-marketplace', [
      { name: 'demo', path: './plugins/demo', skills: ['skill-a'] },
    ]);
    await runCommand(['add', mktRoot], { statePath });
    await runCommand(['install', '1'], { statePath });
    const res = await runCommand(['list'], { statePath });
    expect(res.output).toContain('已裝啟用');
  });

  it('install by name', async () => {
    makeCodexMarketplace(mktRoot, 'demo-marketplace', [
      { name: 'demo', path: './plugins/demo', skills: ['skill-a'] },
    ]);
    await runCommand(['add', mktRoot], { statePath });
    const res = await runCommand(['install', 'demo'], { statePath });
    expect(res.output).toContain('安裝 \"demo\"');
    expect(res.reload).toBe(true);
  });
});
