import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
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

describe('lifecycle 93 disable/enable/remove/forget', () => {
  let tmpDir: string;
  let statePath: string;
  let mktRoot: string;
  let agentDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bridge93-'));
    statePath = join(tmpDir, 'state.json');
    mktRoot = mkdtempSync(join(tmpdir(), 'mkt93-'));
    agentDir = mkdtempSync(join(tmpdir(), 'agent93-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(mktRoot, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  });

  it('disable 後輸出確認；縫層斷言該 installation 不再進入投影（與 enable 的增減成對）', async () => {
    makeCodexMarketplace(mktRoot, 'demo-marketplace', [
      { name: 'demo', path: './plugins/demo', skills: ['skill-a', 'skill-b'] },
    ]);
    await runCommand(['add', mktRoot], { statePath, agentDir });
    await runCommand(['install', '1'], { statePath, agentDir });
    // projection should contain
    let proj = discoverProjectedSkillPaths({ agentDir });
    // Note: need to use same agentDir as statePath? install used statePath but projection reads agentDir's state? We used agentDir for both add/install, so state is at agentDir. For this test we used statePath separate; but projection reads from agentDir, not statePath. So we need to use agentDir consistently.
    // Let's redo with agentDir only
    const mkt2 = mkdtempSync(join(tmpdir(), 'mkt93b-'));
    try {
      makeCodexMarketplace(mkt2, 'mkt-b', [{ name: 'p1', path: './plugins/p1', skills: ['s1'] }]);
      let res = await runCommand(['add', mkt2], { agentDir });
      expect(res.output).toContain('已註冊');
      res = await runCommand(['install', '1'], { agentDir });
      expect(res.reload).toBe(true);
      proj = discoverProjectedSkillPaths({ agentDir });
      expect(proj.skillPaths.some(p=>p.includes('s1'))).toBe(true);

      res = await runCommand(['disable', 'p1'], { agentDir });
      expect(res.output).toContain('已停用');
      expect(res.reload).toBe(false);
      const st = readMinimalBridgeState({ agentDir });
      expect(st.state.installations[0].enabled).toBe(false);
      proj = discoverProjectedSkillPaths({ agentDir });
      expect(proj.skillPaths.some(p=>p.includes('s1'))).toBe(false);

      res = await runCommand(['enable', 'p1'], { agentDir });
      expect(res.output).toContain('已啟用');
      expect(res.output).toContain('已重新載入生效');
      expect(res.reload).toBe(true);
      proj = discoverProjectedSkillPaths({ agentDir });
      expect(proj.skillPaths.some(p=>p.includes('s1'))).toBe(true);

      // overview should reflect
      res = await runCommand([], { agentDir });
      expect(res.output).toContain('啟用');
      // after disable again, overview should show 停用
      await runCommand(['disable', 'p1'], { agentDir });
      res = await runCommand([], { agentDir });
      expect(res.output).toContain('停用');
    } finally {
      rmSync(mkt2, { recursive: true, force: true });
    }
  });

  it('remove 單支：marketplace 與來源資料不動、安裝記錄移除；remove 後可再 install', async () => {
    makeCodexMarketplace(mktRoot, 'demo-marketplace', [
      { name: 'demo', path: './plugins/demo', skills: ['skill-a'] },
      { name: 'other', path: './plugins/other', skills: ['skill-x'] },
    ]);
    await runCommand(['add', mktRoot], { agentDir });
    await runCommand(['install', '1'], { agentDir });
    let st = readMinimalBridgeState({ agentDir });
    expect(st.state.installations).toHaveLength(1);
    // source file still exists
    expect(existsSync(join(mktRoot, 'plugins/demo'))).toBe(true);

    let res = await runCommand(['remove', 'demo'], { agentDir });
    expect(res.output).toContain('已移除');
    st = readMinimalBridgeState({ agentDir });
    expect(st.state.installations).toHaveLength(0);
    expect(st.state.registrations).toHaveLength(1);
    expect(existsSync(join(mktRoot, 'plugins/demo'))).toBe(true);
    // list should show 可安裝 again
    res = await runCommand(['list'], { agentDir });
    expect(res.output).toContain('可安裝');
    // re-install should succeed
    res = await runCommand(['install', 'demo'], { agentDir });
    expect(res.output).toContain('已重新載入生效');
    st = readMinimalBridgeState({ agentDir });
    expect(st.state.installations).toHaveLength(1);
  });

  it('forget：marketplace 及其全部安裝一併移除', async () => {
    makeCodexMarketplace(mktRoot, 'demo-marketplace', [
      { name: 'demo', path: './plugins/demo', skills: ['skill-a'] },
      { name: 'other', path: './plugins/other', skills: ['skill-x'] },
    ]);
    await runCommand(['add', mktRoot], { agentDir });
    await runCommand(['install', '1'], { agentDir });
    await runCommand(['install', '2'], { agentDir });
    let st = readMinimalBridgeState({ agentDir });
    expect(st.state.installations).toHaveLength(2);
    expect(st.state.registrations).toHaveLength(1);

    const res = await runCommand(['forget', 'demo-marketplace'], { agentDir });
    expect(res.output).toContain('已移除 marketplace');
    expect(res.output).toContain('2');
    st = readMinimalBridgeState({ agentDir });
    expect(st.state.registrations).toHaveLength(0);
    expect(st.state.installations).toHaveLength(0);
    // marketplace source still exists on filesystem
    expect(existsSync(join(mktRoot, '.agents/plugins/marketplace.json'))).toBe(true);
    // projection should be empty
    const proj = discoverProjectedSkillPaths({ agentDir });
    expect(proj.skillPaths.some(p=>p.includes('skill-a'))).toBe(false);
  });

  it('總覽顯示停用／啟用狀態', async () => {
    makeCodexMarketplace(mktRoot, 'demo-marketplace', [
      { name: 'demo', path: './plugins/demo', skills: ['skill-a'] },
    ]);
    await runCommand(['add', mktRoot], { agentDir });
    await runCommand(['install', '1'], { agentDir });
    let res = await runCommand([], { agentDir });
    expect(res.output).toContain('啟用');
    expect(res.output).toContain('demo');
    await runCommand(['disable', 'demo'], { agentDir });
    res = await runCommand([], { agentDir });
    expect(res.output).toContain('停用');
    // list should show 已裝停用
    res = await runCommand(['list'], { agentDir });
    expect(res.output).toContain('已裝停用');
    await runCommand(['enable', 'demo'], { agentDir });
    res = await runCommand(['list'], { agentDir });
    expect(res.output).toContain('已裝啟用');
  });

  it('remove 後可再 install（重新安裝）走 runCommand 縫', async () => {
    makeCodexMarketplace(mktRoot, 'demo-marketplace', [
      { name: 'demo', path: './plugins/demo', skills: ['skill-a'] },
    ]);
    await runCommand(['add', mktRoot], { agentDir });
    await runCommand(['install', '1'], { agentDir });
    await runCommand(['remove', 'demo'], { agentDir });
    const res = await runCommand(['install', '1'], { agentDir });
    expect(res.output).toContain('已重新載入生效');
    const st = readMinimalBridgeState({ agentDir });
    expect(st.state.installations[0].enabled).toBe(true);
  });

  it('走 runCommand 縫測試：disable/enable/remove/forget 錯誤處理', async () => {
    let res = await runCommand(['disable', 'nonexist'], { agentDir });
    expect(res.output).toContain('找不到');
    res = await runCommand(['enable', 'nonexist'], { agentDir });
    expect(res.output).toContain('找不到');
    res = await runCommand(['remove', 'nonexist'], { agentDir });
    expect(res.output).toContain('找不到');
    res = await runCommand(['forget', 'nonexist'], { agentDir });
    expect(res.output).toContain('找不到');

    // missing args
    res = await runCommand(['disable'], { agentDir });
    expect(res.output).toMatch(/用法/);
    res = await runCommand(['enable'], { agentDir });
    expect(res.output).toMatch(/用法/);
    res = await runCommand(['remove'], { agentDir });
    expect(res.output).toMatch(/用法/);
    res = await runCommand(['forget'], { agentDir });
    expect(res.output).toMatch(/用法/);
  });

  it('enable 後輸出確認＋reload 旗標；再投影，且處理 collision', async () => {
    const mkt2 = mkdtempSync(join(tmpdir(), 'mkt93c-'));
    try {
      makeCodexMarketplace(mktRoot, 'm1', [{ name: 'p1', path: './plugins/p1', skills: ['shared'] }]);
      makeCodexMarketplace(mkt2, 'm2', [{ name: 'p2', path: './plugins/p2', skills: ['shared', 'other'] }]);
      await runCommand(['add', mktRoot], { agentDir });
      await runCommand(['add', mkt2], { agentDir });
      await runCommand(['install', '1'], { agentDir }); // p1
      await runCommand(['install', '2'], { agentDir }); // p2 will collide shared
      // disable p2 then enable again should show collision again
      await runCommand(['disable', 'p2'], { agentDir });
      const res = await runCommand(['enable', 'p2'], { agentDir });
      expect(res.output).toContain('已啟用');
      expect(res.output).toContain('未投影（名稱衝突）');
      expect(res.output).toContain('shared');
      expect(res.reload).toBe(true);
      const proj = discoverProjectedSkillPaths({ agentDir });
      // due to collision, shared should be denied for both? But p1 still enabled, p2's shared should be unavailable, but 'other' should be projected
      expect(proj.skillPaths.some(p=>p.includes('other'))).toBe(true);
      // shared from p1 should maybe be denied too? In minimal, collision handling denies both? Actually exposure's collision denies all Bridge colliders when Pi layer not involved: group >1 => findings, survivors empty. So shared would be unavailable for both. Let's check behavior: both p1 and p2 have shared, so neither should be projected.
      // But install collision only warned for second install; first's skill might still be considered? However exposure will deny both after both are enabled.
      // After disabling p2, shared should be available via p1
      await runCommand(['disable', 'p2'], { agentDir });
      const proj2 = discoverProjectedSkillPaths({ agentDir });
      expect(proj2.skillPaths.some(p=>p.includes('shared'))).toBe(true);
    } finally {
      rmSync(mkt2, { recursive: true, force: true });
    }
  });
});
