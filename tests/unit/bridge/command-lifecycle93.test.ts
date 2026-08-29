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
  let mktRoot: string;
  let mktRoot2: string;
  let agentDir: string;

  beforeEach(() => {
    mktRoot = mkdtempSync(join(tmpdir(), 'mkt93-'));
    mktRoot2 = mkdtempSync(join(tmpdir(), 'mkt93b-'));
    agentDir = mkdtempSync(join(tmpdir(), 'agent93-'));
  });

  afterEach(() => {
    rmSync(mktRoot, { recursive: true, force: true });
    rmSync(mktRoot2, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  });

  it('disable 後輸出確認；縫層斷言該 installation 不再進入投影（與 enable 的增減成對）', async () => {
    makeCodexMarketplace(mktRoot, 'mkt-b', [{ name: 'p1', path: './plugins/p1', skills: ['s1'] }]);
    let res = await runCommand(['add', mktRoot], { agentDir });
    expect(res.output).toContain('已註冊');
    res = await runCommand(['install', '1'], { agentDir });
    expect(res.reload).toBe(true);
    let proj = discoverProjectedSkillPaths({ agentDir });
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
    expect(existsSync(join(mktRoot, 'plugins/demo'))).toBe(true);
    const beforeCatalog = readFileSync(join(mktRoot, '.agents/plugins/marketplace.json'), 'utf8');
    const beforePluginJson = readFileSync(join(mktRoot, 'plugins/demo/.codex-plugin/plugin.json'), 'utf8');

    let res = await runCommand(['remove', 'demo'], { agentDir });
    expect(res.output).toContain('已移除');
    expect(res.reload).toBe(false);
    st = readMinimalBridgeState({ agentDir });
    expect(st.state.installations).toHaveLength(0);
    expect(st.state.registrations).toHaveLength(1);
    expect(st.state.registrations[0].marketplaceName).toBe('demo-marketplace');
    // marketplace 與來源資料不動：內容 hash 比對而非僅存在性
    expect(readFileSync(join(mktRoot, '.agents/plugins/marketplace.json'), 'utf8')).toBe(beforeCatalog);
    expect(readFileSync(join(mktRoot, 'plugins/demo/.codex-plugin/plugin.json'), 'utf8')).toBe(beforePluginJson);
    expect(existsSync(join(mktRoot, 'plugins/demo'))).toBe(true);
    // 投影已移除
    let proj = discoverProjectedSkillPaths({ agentDir });
    expect(proj.skillPaths.some(p=>p.includes('skill-a'))).toBe(false);
    // list should show 可安裝 again
    res = await runCommand(['list'], { agentDir });
    expect(res.output).toContain('可安裝');
    expect(res.reload).toBe(false);
    // re-install should succeed（驗證 remove 後可再 install，透過名稱）
    res = await runCommand(['install', 'demo'], { agentDir });
    expect(res.output).toContain('已重新載入生效');
    expect(res.reload).toBe(true);
    st = readMinimalBridgeState({ agentDir });
    expect(st.state.installations).toHaveLength(1);
    proj = discoverProjectedSkillPaths({ agentDir });
    expect(proj.skillPaths.some(p=>p.includes('skill-a'))).toBe(true);
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
    expect(st.state.registrations[0].marketplaceName).toBe('demo-marketplace');
    const beforeCatalog = readFileSync(join(mktRoot, '.agents/plugins/marketplace.json'), 'utf8');

    const res = await runCommand(['forget', 'demo-marketplace'], { agentDir });
    expect(res.output).toContain('已移除 marketplace');
    expect(res.output).toContain('2');
    expect(res.reload).toBe(false);
    st = readMinimalBridgeState({ agentDir });
    expect(st.state.registrations).toHaveLength(0);
    expect(st.state.installations).toHaveLength(0);
    // marketplace 來源仍在檔案系統且內容不動
    expect(existsSync(join(mktRoot, '.agents/plugins/marketplace.json'))).toBe(true);
    expect(readFileSync(join(mktRoot, '.agents/plugins/marketplace.json'), 'utf8')).toBe(beforeCatalog);
    // 投影應清空
    const proj = discoverProjectedSkillPaths({ agentDir });
    expect(proj.skillPaths.some(p=>p.includes('skill-a'))).toBe(false);
    expect(proj.skillPaths.some(p=>p.includes('skill-x'))).toBe(false);
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

  it('remove 後可再 install（編號復用走 runCommand 縫）', async () => {
    makeCodexMarketplace(mktRoot, 'demo-marketplace', [
      { name: 'demo', path: './plugins/demo', skills: ['skill-a'] },
    ]);
    await runCommand(['add', mktRoot], { agentDir });
    await runCommand(['install', '1'], { agentDir });
    let res = await runCommand(['remove', 'demo'], { agentDir });
    expect(res.reload).toBe(false);
    // 編號復用：移除後 list 回到可安裝，編號 1 仍對應同一 plugin
    res = await runCommand(['list'], { agentDir });
    expect(res.output).toContain('可安裝');
    res = await runCommand(['install', '1'], { agentDir });
    expect(res.output).toContain('已重新載入生效');
    expect(res.reload).toBe(true);
    const st = readMinimalBridgeState({ agentDir });
    expect(st.state.installations[0].enabled).toBe(true);
    const proj = discoverProjectedSkillPaths({ agentDir });
    expect(proj.skillPaths.some(p=>p.includes('skill-a'))).toBe(true);
  });

  it('走 runCommand 縫測試：disable/enable/remove/forget 錯誤處理', async () => {
    let res = await runCommand(['disable', 'nonexist'], { agentDir });
    expect(res.output).toContain('找不到');
    expect(res.reload).toBe(false);
    res = await runCommand(['enable', 'nonexist'], { agentDir });
    expect(res.output).toContain('找不到');
    expect(res.reload).toBe(false);
    res = await runCommand(['remove', 'nonexist'], { agentDir });
    expect(res.output).toContain('找不到');
    expect(res.reload).toBe(false);
    res = await runCommand(['forget', 'nonexist'], { agentDir });
    expect(res.output).toContain('找不到');
    expect(res.reload).toBe(false);

    // missing args
    res = await runCommand(['disable'], { agentDir });
    expect(res.output).toMatch(/用法/);
    expect(res.reload).toBe(false);
    res = await runCommand(['enable'], { agentDir });
    expect(res.output).toMatch(/用法/);
    expect(res.reload).toBe(false);
    res = await runCommand(['remove'], { agentDir });
    expect(res.output).toMatch(/用法/);
    expect(res.reload).toBe(false);
    res = await runCommand(['forget'], { agentDir });
    expect(res.output).toMatch(/用法/);
    expect(res.reload).toBe(false);
  });

  it('enable 後輸出確認＋reload 旗標；再投影，且處理 collision', async () => {
    makeCodexMarketplace(mktRoot, 'm1', [{ name: 'p1', path: './plugins/p1', skills: ['shared'] }]);
    makeCodexMarketplace(mktRoot2, 'm2', [{ name: 'p2', path: './plugins/p2', skills: ['shared', 'other'] }]);
    await runCommand(['add', mktRoot], { agentDir });
    await runCommand(['add', mktRoot2], { agentDir });
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
    // 同層 collider 全否決：p1 與 p2 皆有 shared，兩者皆不投影；p2 的 other 仍投影
    expect(proj.skillPaths.some(p=>p.includes('other'))).toBe(true);
    expect(proj.skillPaths.some(p=>p.includes('shared'))).toBe(false);
    // After disabling p2, shared should be available via p1
    await runCommand(['disable', 'p2'], { agentDir });
    const proj2 = discoverProjectedSkillPaths({ agentDir });
    expect(proj2.skillPaths.some(p=>p.includes('shared'))).toBe(true);
  });

  it('disable 已停用 / enable 已啟用 分支', async () => {
    makeCodexMarketplace(mktRoot, 'demo-marketplace', [{ name: 'demo', path: './plugins/demo', skills: ['skill-a'] }]);
    await runCommand(['add', mktRoot], { agentDir });
    await runCommand(['install', '1'], { agentDir });

    let res = await runCommand(['disable', 'demo'], { agentDir });
    expect(res.output).toContain('已停用');
    expect(res.reload).toBe(false);
    // 已是停用狀態再 disable
    res = await runCommand(['disable', 'demo'], { agentDir });
    expect(res.output).toContain('已是停用狀態');
    expect(res.reload).toBe(false);
    let st = readMinimalBridgeState({ agentDir });
    expect(st.state.installations[0].enabled).toBe(false);

    res = await runCommand(['enable', 'demo'], { agentDir });
    expect(res.output).toContain('已啟用');
    expect(res.reload).toBe(true);
    // 已是啟用狀態再 enable
    res = await runCommand(['enable', 'demo'], { agentDir });
    expect(res.output).toContain('已是啟用狀態');
    expect(res.reload).toBe(false);
    st = readMinimalBridgeState({ agentDir });
    expect(st.state.installations[0].enabled).toBe(true);
  });

  it('remove 歧義：同一 manifestName 橫跨兩 registrations 時回報多個對應', async () => {
    // 兩個 marketplace 各有同名 plugin "dup"
    makeCodexMarketplace(mktRoot, 'm1', [{ name: 'dup', path: './plugins/dup', skills: ['skill-a'] }]);
    makeCodexMarketplace(mktRoot2, 'm2', [{ name: 'dup', path: './plugins/dup', skills: ['skill-b'] }]);
    await runCommand(['add', mktRoot], { agentDir });
    await runCommand(['add', mktRoot2], { agentDir });
    await runCommand(['install', '1'], { agentDir }); // dup from m1
    await runCommand(['install', '2'], { agentDir }); // dup from m2
    let st = readMinimalBridgeState({ agentDir });
    expect(st.state.installations).toHaveLength(2);
    expect(st.state.registrations).toHaveLength(2);

    const beforeCatalog1 = readFileSync(join(mktRoot, '.agents/plugins/marketplace.json'), 'utf8');
    const beforeCatalog2 = readFileSync(join(mktRoot2, '.agents/plugins/marketplace.json'), 'utf8');

    const res = await runCommand(['remove', 'dup'], { agentDir });
    expect(res.output).toContain('對應多個已安裝 plugin');
    expect(res.reload).toBe(false);
    // 歧義時不應刪除任何安裝，來源亦不動
    st = readMinimalBridgeState({ agentDir });
    expect(st.state.installations).toHaveLength(2);
    expect(readFileSync(join(mktRoot, '.agents/plugins/marketplace.json'), 'utf8')).toBe(beforeCatalog1);
    expect(readFileSync(join(mktRoot2, '.agents/plugins/marketplace.json'), 'utf8')).toBe(beforeCatalog2);
  });
});
