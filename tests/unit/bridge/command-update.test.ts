import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCommand } from '../../../src/bridge/command.js';
import { readMinimalBridgeState } from '../../../src/bridge/state.js';
import { discoverProjectedSkillPaths } from '../../../src/projection/exposure.js';
import type { GitExecutor } from '../../../src/registration/git-acquisition.js';
import { getCacheDir, getCacheEntriesDir } from '../../../src/cache/paths.js';

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

function addSkillToPlugin(pluginDir: string, skill: string): void {
  const sdir = join(pluginDir, 'skills', skill);
  mkdirSync(sdir, { recursive: true });
  writeFileSync(join(sdir, 'SKILL.md'), `---\nname: ${skill}\ndescription: Desc for ${skill}\n---\n\nBody for ${skill}\n`);
}

function makeGitExecutor(fixtureRoot: string, sha: string): GitExecutor {
  return async (args) => {
    if (args.includes('ls-remote')) {
      const ref = args[args.length - 1];
      return { exitCode: 0, stdout: `${sha}\t${ref}\n`, stderr: '' };
    }
    if (args.includes('clone')) {
      const dest = args[args.length - 1];
      cpSync(fixtureRoot, dest, { recursive: true });
      mkdirSync(join(dest, '.git'), { recursive: true });
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
}

describe('update #94 全部重抓最新（本機重讀／git 重抓）', () => {
  let agentDir: string;
  let mktRoot: string;
  let mktRoot2: string;
  let gitRepo: string;
  let gitRepo2: string;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), 'agent94-'));
    mktRoot = mkdtempSync(join(tmpdir(), 'mkt94-'));
    mktRoot2 = mkdtempSync(join(tmpdir(), 'mkt94b-'));
    gitRepo = mkdtempSync(join(tmpdir(), 'git94-'));
    gitRepo2 = mkdtempSync(join(tmpdir(), 'git94b-'));
  });

  afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(mktRoot, { recursive: true, force: true });
    rmSync(mktRoot2, { recursive: true, force: true });
    rmSync(gitRepo, { recursive: true, force: true });
    rmSync(gitRepo2, { recursive: true, force: true });
  });

  it('無已註冊 marketplace → 提示且不 reload', async () => {
    const res = await runCommand(['update'], { agentDir });
    expect(res.output).toContain('尚無已註冊的 marketplace');
    expect(res.reload).toBe(false);
  });

  it('本機重讀：全部 plugin 無變化 → 顯示「無變化」、不 reload、記錄不變', async () => {
    makeCodexMarketplace(mktRoot, 'mkt-a', [{ name: 'p1', path: './plugins/p1', skills: ['s1'] }]);
    await runCommand(['add', mktRoot], { agentDir });
    await runCommand(['install', '1'], { agentDir });
    const before = readMinimalBridgeState({ agentDir });

    const res = await runCommand(['update'], { agentDir });
    expect(res.output).toContain('mkt-a  重新抓取… 無變化');
    expect(res.output).not.toContain('有新版本');
    expect(res.output).not.toContain('已重新載入生效');
    expect(res.reload).toBe(false);

    const after = readMinimalBridgeState({ agentDir });
    expect(after.state.registrations.length).toBe(before.state.registrations.length);
    expect(after.state.installations).toEqual(before.state.installations);
  });

  it('本機重讀：plugin 有新技能 → 「有新版本」＋「已重新載入生效」＋reload＋記錄刷新＋投影縫層斷言', async () => {
    makeCodexMarketplace(mktRoot, 'mkt-a', [{ name: 'p1', path: './plugins/p1', skills: ['s1'] }]);
    await runCommand(['add', mktRoot], { agentDir });
    await runCommand(['install', '1'], { agentDir });

    // live tree gains a new skill（有變化）
    addSkillToPlugin(join(mktRoot, 'plugins', 'p1'), 's2');

    const res = await runCommand(['update'], { agentDir });
    expect(res.output).toContain('mkt-a  重新抓取… p1 有新版本');
    expect(res.output).toContain('已重新載入生效');
    expect(res.reload).toBe(true);

    const st = readMinimalBridgeState({ agentDir });
    expect(st.state.installations).toHaveLength(1);
    expect(st.state.installations[0].skills).toEqual(['s1', 's2']);

    const proj = discoverProjectedSkillPaths({ agentDir });
    expect(proj.skillPaths.some((p) => p.includes('s1'))).toBe(true);
    expect(proj.skillPaths.some((p) => p.includes('s2'))).toBe(true);
  });

  it('兩個 marketplace 混合：一無變化一有新版本；各有「無變化／有新版本」行，結尾單一「已重新載入生效」', async () => {
    makeCodexMarketplace(mktRoot, 'mkt-a', [{ name: 'p1', path: './plugins/p1', skills: ['s1'] }]);
    makeCodexMarketplace(mktRoot2, 'mkt-b', [{ name: 'p2', path: './plugins/p2', skills: ['s2'] }]);
    await runCommand(['add', mktRoot], { agentDir });
    await runCommand(['add', mktRoot2], { agentDir });
    await runCommand(['install', '1'], { agentDir }); // p1（mkt-a）
    await runCommand(['install', '2'], { agentDir }); // p2（mkt-b）

    addSkillToPlugin(join(mktRoot2, 'plugins', 'p2'), 's3');

    const res = await runCommand(['update'], { agentDir });
    expect(res.output).toContain('mkt-a  重新抓取… 無變化');
    expect(res.output).toContain('mkt-b  重新抓取… p2 有新版本');
    const reloadLines = res.output.split('\n').filter((l) => l.includes('已重新載入生效'));
    expect(reloadLines).toHaveLength(1);
    expect(res.reload).toBe(true);

    const st = readMinimalBridgeState({ agentDir });
    const instB = st.state.installations.find((i) => i.manifestName === 'p2')!;
    expect(instB.skills).toEqual(['s2', 's3']);
  });

  it('本機重讀：catalog 讀取失敗 → 明示錯誤不靜默；其他 marketplace 照常處理；不 reload', async () => {
    makeCodexMarketplace(mktRoot, 'mkt-a', [{ name: 'p1', path: './plugins/p1', skills: ['s1'] }]);
    await runCommand(['add', mktRoot], { agentDir });
    // 破壞 catalog 後 update
    writeFileSync(join(mktRoot, '.agents', 'plugins', 'marketplace.json'), '{ broken,,');
    const res = await runCommand(['update'], { agentDir });
    expect(res.output).toMatch(/⚠ marketplace \[mkt-a\].*catalog/i);
    expect(res.reload).toBe(false);
    expect(res.output).not.toContain('無變化');
    const st = readMinimalBridgeState({ agentDir });
    expect(st.state.installations).toHaveLength(0);
  });

  it('本機重讀：已安裝 plugin 的 entry 從 catalog 消失 → ⚠ 明示失敗、不 crash、安裝保留、不 reload', async () => {
    makeCodexMarketplace(mktRoot, 'mkt-a', [{ name: 'p1', path: './plugins/p1', skills: ['s1'] }]);
    await runCommand(['add', mktRoot], { agentDir });
    await runCommand(['install', '1'], { agentDir });
    // catalog 移除 p1 entry
    makeCodexMarketplace(mktRoot, 'mkt-a', []);
    const res = await runCommand(['update'], { agentDir });
    expect(res.output).toMatch(/⚠ marketplace \[mkt-a\].*p1.*找不到對應/);
    expect(res.reload).toBe(false);
    const st = readMinimalBridgeState({ agentDir });
    expect(st.state.installations).toHaveLength(1);
    expect(st.state.installations[0].skills).toEqual(['s1']);
  });

  it('git 重抓：upstream 無變化（同 sha 同 tree）→ 「無變化」、不 reload、snapshot 不動', async () => {
    makeCodexMarketplace(gitRepo, 'git-mkt', [{ name: 'gp1', path: './plugins/gp1', skills: ['g1'] }]);
    const sha = 'a'.repeat(40);
    const gitExecutor = makeGitExecutor(gitRepo, sha);
    await runCommand(['add', 'https://github.com/acme/git-mkt'], { agentDir, gitExecutor });
    await runCommand(['install', '1'], { agentDir, gitExecutor });
    const before = readMinimalBridgeState({ agentDir });

    const res = await runCommand(['update'], { agentDir, gitExecutor });
    expect(res.output).toContain('git-mkt  重新抓取… 無變化');
    expect(res.output).not.toContain('有新版本');
    expect(res.output).not.toContain('已重新載入生效');
    expect(res.reload).toBe(false);

    const after = readMinimalBridgeState({ agentDir });
    expect(after.state.registrations[0].snapshot).toBe(before.state.registrations[0].snapshot);
    expect(after.state.installations).toEqual(before.state.installations);
  });

  it('git 重抓：upstream 升級（新 sha 新 tree）→ 「有新版本」＋reload＋reg.snapshot 指向新 fingerprint＋cache 新 entry＋投影自新 cache 位址（縫層斷言）', async () => {
    makeCodexMarketplace(gitRepo, 'git-mkt', [{ name: 'gp1', path: './plugins/gp1', skills: ['g1'] }]);
    const shaA = 'a'.repeat(40);
    const gitExecutor = makeGitExecutor(gitRepo, shaA);
    await runCommand(['add', 'https://github.com/acme/git-mkt'], { agentDir, gitExecutor });
    await runCommand(['install', '1'], { agentDir, gitExecutor });
    const oldFp = readMinimalBridgeState({ agentDir }).state.registrations[0].snapshot!;

    // upstream bump：新 sha 且新 tree（新增 skill）
    const shaB = 'b'.repeat(40);
    makeCodexMarketplace(gitRepo2, 'git-mkt', [{ name: 'gp1', path: './plugins/gp1', skills: ['g1', 'g2'] }]);
    const newExecutor = makeGitExecutor(gitRepo2, shaB);

    const res = await runCommand(['update'], { agentDir, gitExecutor: newExecutor });
    expect(res.output).toContain('git-mkt  重新抓取… gp1 有新版本');
    expect(res.output).toContain('已重新載入生效');
    expect(res.reload).toBe(true);

    const st = readMinimalBridgeState({ agentDir });
    const reg = st.state.registrations[0];
    expect(reg.snapshot).not.toBe(oldFp);
    const newFp = reg.snapshot!;
    expect(st.state.installations[0].skills).toEqual(['g1', 'g2']);
    expect(st.state.installations[0].snapshot).toBe(newFp);

    // cache 新 entry 存在、投影指向新 cache 位址（最新材料）
    const entriesDir = getCacheEntriesDir(getCacheDir(agentDir));
    expect(existsSync(join(entriesDir, newFp))).toBe(true);
    const proj = discoverProjectedSkillPaths({ agentDir });
    expect(proj.skillPaths.some((p) => p.includes(newFp))).toBe(true);
    expect(proj.skillPaths.some((p) => p.includes('g2'))).toBe(true);

    // 再 update 一次（同新版本）→ 無變化
    const again = await runCommand(['update'], { agentDir, gitExecutor: newExecutor });
    expect(again.output).toContain('git-mkt  重新抓取… 無變化');
    expect(again.reload).toBe(false);
    expect(readMinimalBridgeState({ agentDir }).state.registrations[0].snapshot).toBe(newFp);
  });

  it('git 重抓失敗（ls-remote 失敗）→ 明示錯誤、不 reload、state 不變', async () => {
    makeCodexMarketplace(gitRepo, 'git-mkt', [{ name: 'gp1', path: './plugins/gp1', skills: ['g1'] }]);
    const sha = 'a'.repeat(40);
    await runCommand(['add', 'https://github.com/acme/git-mkt'], { agentDir, gitExecutor: makeGitExecutor(gitRepo, sha) });
    await runCommand(['install', '1'], { agentDir, gitExecutor: makeGitExecutor(gitRepo, sha) });
    const before = readMinimalBridgeState({ agentDir });

    const failing: GitExecutor = async (args) => {
      if (args.includes('ls-remote')) return { exitCode: 1, stdout: '', stderr: 'boom' };
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const res = await runCommand(['update'], { agentDir, gitExecutor: failing });
    expect(res.output).toMatch(/錯誤.*git 重抓失敗|git 重抓失敗/);
    expect(res.reload).toBe(false);

    const after = readMinimalBridgeState({ agentDir });
    expect(after.state).toEqual(before.state);
  });
});