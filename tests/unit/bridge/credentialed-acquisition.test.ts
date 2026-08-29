import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCommand } from '../../../src/bridge/command.js';
import { readMinimalBridgeState } from '../../../src/bridge/state.js';
import type { GitExecutor } from '../../../src/registration/git-acquisition.js';
import { CREDENTIAL_HELPERS_ENV } from '../../../src/registration/credential-helpers.js';

function makeCodexMarketplace(root: string, name: string, plugins: { name: string; path: string; skills?: string[] }[]) {
  mkdirSync(join(root, '.agents', 'plugins'), { recursive: true });
  writeFileSync(join(root, '.agents', 'plugins', 'marketplace.json'), JSON.stringify({ name, plugins }));
  for (const p of plugins) {
    const abs = join(root, p.path.replace(/^\.\//, ''));
    mkdirSync(abs, { recursive: true });
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

/**
 * 私有 repo 模擬：只有當 git 命令列攜帶已核准 credential.helper 時才放行，
 * 否則回 401（Authentication failed）——與真實私有 HTTPS repo 未核准時的行為一致。
 */
function makeAuthGatedGitExecutor(fixtureRoot: string, sha: string, approvedHelpers: string[]): GitExecutor {
  const approved = (args: string[]): boolean => {
    const seen = args.filter((a) => a.startsWith('credential.helper='));
    return approvedHelpers.every((h) => seen.includes(`credential.helper=${h}`));
  };
  return async (args) => {
    if (!approved(args)) {
      return {
        exitCode: 128,
        stdout: '',
        stderr: "fatal: Authentication failed for 'https://github.com/acme/private-mkt/'",
      };
    }
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

/** 永遠 401 的 executor：即使 helper 已核准也失敗 */
function makeAlwaysAuthFailGitExecutor(): GitExecutor {
  return async () => ({ exitCode: 128, stdout: '', stderr: "fatal: Authentication failed for 'https://github.com/acme/private-mkt/'" });
}

describe('Credentialed Acquisition add 接線（#109）', () => {
  let tmpDir: string;
  let agentDir: string;
  let gitRepo: string;

  beforeEach(() => {
    delete process.env[CREDENTIAL_HELPERS_ENV];
    tmpDir = mkdtempSync(join(tmpdir(), 't109-'));
    agentDir = join(tmpDir, 'agent');
    mkdirSync(agentDir, { recursive: true });
    gitRepo = mkdtempSync(join(tmpDir, 'gitrepo'));
  });

  afterEach(() => {
    delete process.env[CREDENTIAL_HELPERS_ENV];
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('未核准（env 未設定）→ 401 失敗、不註冊；輸出不含任何 helper 字串', async () => {
    makeCodexMarketplace(gitRepo, 'private-mkt', [{ name: 'p1', path: './plugins/p1' }]);
    const helper = 'approved-helper-a';
    const executor = makeAuthGatedGitExecutor(gitRepo, 'a'.repeat(40), [helper]);

    const res = await runCommand(['add', 'https://github.com/acme/private-mkt'], { agentDir, gitExecutor: executor });

    expect(res.output).toContain('錯誤：git 取得失敗');
    expect(res.output).not.toContain(helper);
    const st = readMinimalBridgeState({ agentDir });
    expect(st.state.registrations).toHaveLength(0);
  });

  it('未核准（env 為空字串）→ 與未設定相同：401 失敗、不註冊', async () => {
    process.env[CREDENTIAL_HELPERS_ENV] = '  ,  ';
    makeCodexMarketplace(gitRepo, 'private-mkt', [{ name: 'p1', path: './plugins/p1' }]);
    const executor = makeAuthGatedGitExecutor(gitRepo, 'a'.repeat(40), ['approved-helper-a']);

    const res = await runCommand(['add', 'https://github.com/acme/private-mkt'], { agentDir, gitExecutor: executor });

    expect(res.output).toContain('錯誤：git 取得失敗');
    expect(readMinimalBridgeState({ agentDir }).state.registrations).toHaveLength(0);
  });

  it('已核准 helper → add 成功註冊；偵測（格式、plugin 數）與公開 repo 一致；輸出與 Bridge State 不含 helper 字串', async () => {
    makeCodexMarketplace(gitRepo, 'private-mkt', [
      { name: 'p1', path: './plugins/p1' },
      { name: 'p2', path: './plugins/p2' },
    ]);
    const helper = 'approved-helper-a';
    process.env[CREDENTIAL_HELPERS_ENV] = `  ${helper} , cache `;
    const executor = makeAuthGatedGitExecutor(gitRepo, 'a'.repeat(40), [helper]);

    const res = await runCommand(['add', 'https://github.com/acme/private-mkt'], { agentDir, gitExecutor: executor });

    expect(res.reload).toBe(false);
    expect(res.output).toContain('偵測：codex marketplace');
    expect(res.output).toMatch(/2 plugins/);
    expect(res.output).toContain('已註冊');
    expect(res.output).toContain('private-mkt');
    expect(res.output).not.toContain(helper);

    const st = readMinimalBridgeState({ agentDir });
    expect(st.state.registrations).toHaveLength(1);
    expect(st.state.registrations[0].sourceKind).toBe('git');
    expect(st.state.registrations[0].snapshot).toMatch(/^[0-9a-f]{64}$/);
    // 憑證不進入 Bridge State（含 helper 字串與 env 值）
    expect(JSON.stringify(st.state)).not.toContain(helper);
    expect(JSON.stringify(st.state)).not.toContain('cache');
  });

  it('已核准但仍 401 → 錯誤訊息為「核准後仍失敗」變體（提示檢查憑證），非「未核准」變體', async () => {
    process.env[CREDENTIAL_HELPERS_ENV] = 'approved-helper-a';
    const executor = makeAlwaysAuthFailGitExecutor();

    const res = await runCommand(['add', 'https://github.com/acme/private-mkt'], { agentDir, gitExecutor: executor });

    expect(res.output).toContain('錯誤：git 取得失敗');
    expect(res.output).toMatch(/check your credentials|憑證/i);
    expect(res.output).not.toMatch(/not approved/i);
    expect(readMinimalBridgeState({ agentDir }).state.registrations).toHaveLength(0);
  });

  it('未核准 → 錯誤訊息為「未核准」變體（提示核准或 SSH）', async () => {
    delete process.env[CREDENTIAL_HELPERS_ENV];
    const executor = makeAlwaysAuthFailGitExecutor();

    const res = await runCommand(['add', 'https://github.com/acme/private-mkt'], { agentDir, gitExecutor: executor });

    expect(res.output).toContain('錯誤：git 取得失敗');
    expect(res.output).toMatch(/not approved/i);
    expect(res.output).not.toMatch(/check your credentials|憑證/i);
  });
});

describe('Credentialed Acquisition update 接線（#109）', () => {
  let tmpDir: string;
  let agentDir: string;
  let gitRepo: string;
  let gitRepo2: string;

  beforeEach(() => {
    delete process.env[CREDENTIAL_HELPERS_ENV];
    tmpDir = mkdtempSync(join(tmpdir(), 't109u-'));
    agentDir = join(tmpDir, 'agent');
    mkdirSync(agentDir, { recursive: true });
    gitRepo = mkdtempSync(join(tmpDir, 'gitrepo'));
    gitRepo2 = mkdtempSync(join(tmpDir, 'gitrepo2'));
  });

  afterEach(() => {
    delete process.env[CREDENTIAL_HELPERS_ENV];
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('未核准 → 重抓失敗（未核准變體）、snapshot 不變、不 reload；輸出不含 helper 字串', async () => {
    makeCodexMarketplace(gitRepo, 'private-mkt', [{ name: 'p1', path: './plugins/p1' }]);
    const helper = 'approved-helper-a';
    const sha = 'a'.repeat(40);
    process.env[CREDENTIAL_HELPERS_ENV] = helper;
    await runCommand(['add', 'https://github.com/acme/private-mkt'], { agentDir, gitExecutor: makeAuthGatedGitExecutor(gitRepo, sha, [helper]) });
    const before = readMinimalBridgeState({ agentDir });
    delete process.env[CREDENTIAL_HELPERS_ENV];

    // 未核准：即使 executor 認識 helper 也不放行
    const res = await runCommand(['update'], { agentDir, gitExecutor: makeAuthGatedGitExecutor(gitRepo, sha, [helper]) });

    expect(res.output).toContain('錯誤：git 重抓失敗');
    expect(res.output).toMatch(/not approved/i);
    expect(res.output).not.toContain(helper);
    expect(res.reload).toBe(false);
    const after = readMinimalBridgeState({ agentDir });
    expect(after.state.registrations[0].snapshot).toBe(before.state.registrations[0].snapshot);
  });

  it('已核准 → 對私有 repo 成功重抓當下最新（新 sha 新 tree → 有新版本＋reload＋snapshot 推進）', async () => {
    makeCodexMarketplace(gitRepo, 'private-mkt', [{ name: 'p1', path: './plugins/p1', skills: ['s1'] }]);
    const helper = 'approved-helper-a';
    const shaA = 'a'.repeat(40);
    process.env[CREDENTIAL_HELPERS_ENV] = helper;
    await runCommand(['add', 'https://github.com/acme/private-mkt'], { agentDir, gitExecutor: makeAuthGatedGitExecutor(gitRepo, shaA, [helper]) });
    await runCommand(['install', '1'], { agentDir, gitExecutor: makeAuthGatedGitExecutor(gitRepo, shaA, [helper]) });
    const oldFp = readMinimalBridgeState({ agentDir }).state.registrations[0].snapshot!;

    // upstream 升級：新 sha＋新 tree（新增 plugin p2）
    const shaB = 'b'.repeat(40);
    makeCodexMarketplace(gitRepo2, 'private-mkt', [
      { name: 'p1', path: './plugins/p1', skills: ['s1'] },
      { name: 'p2', path: './plugins/p2' },
    ]);

    const res = await runCommand(['update'], { agentDir, gitExecutor: makeAuthGatedGitExecutor(gitRepo2, shaB, [helper]) });

    expect(res.output).toContain('private-mkt  重新抓取… p1 有新版本');
    expect(res.output).toContain('已重新載入生效');
    expect(res.reload).toBe(true);

    const st = readMinimalBridgeState({ agentDir });
    const newFp = st.state.registrations[0].snapshot!;
    expect(newFp).not.toBe(oldFp);
    expect(newFp).toMatch(/^[0-9a-f]{64}$/);
    expect(st.state.installations[0].skills).toEqual(['s1']);

    // 憑證不進入任何可持久化位置：輸出、Bridge State、快照指紋
    expect(res.output).not.toContain(helper);
    expect(JSON.stringify(st.state)).not.toContain(helper);
    expect(oldFp).not.toContain(helper);
    expect(newFp).not.toContain(helper);
  });

  it('已核准但 upstream 無變化 → 「無變化」、不 reload、snapshot 不動', async () => {
    makeCodexMarketplace(gitRepo, 'private-mkt', [{ name: 'p1', path: './plugins/p1' }]);
    const helper = 'approved-helper-b';
    const sha = 'c'.repeat(40);
    process.env[CREDENTIAL_HELPERS_ENV] = helper;
    await runCommand(['add', 'https://github.com/acme/private-mkt'], { agentDir, gitExecutor: makeAuthGatedGitExecutor(gitRepo, sha, [helper]) });
    const before = readMinimalBridgeState({ agentDir });

    const res = await runCommand(['update'], { agentDir, gitExecutor: makeAuthGatedGitExecutor(gitRepo, sha, [helper]) });

    expect(res.output).toContain('private-mkt  重新抓取… 無變化');
    expect(res.reload).toBe(false);
    expect(readMinimalBridgeState({ agentDir }).state.registrations[0].snapshot).toBe(before.state.registrations[0].snapshot);
  });
});