import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { acquireGitSource, resolveGitRevision, type GitExecutor } from '../../../src/registration/git-acquisition.js';
import { normalizeGitLocator } from '../../../src/registration/git-locator.js';
import { CODE, RULE } from '../../../src/registration/findings.js';
import { CREDENTIAL_HELPERS_ENV } from '../../../src/registration/credential-helpers.js';

const SHA = 'a'.repeat(40);

function locatorOf(url: string) {
  const res = normalizeGitLocator(url);
  if (!res.ok || !res.locator) throw new Error('locator should normalize');
  return res.locator;
}

const URL = 'https://github.com/acme/private-mkt';

/** ls-remote 成功、clone 以指定 stderr 失敗 */
function makeCloneFailExecutor(stderr: string): GitExecutor {
  return async (args) => {
    if (args.includes('ls-remote')) {
      const ref = args[args.length - 1];
      return { exitCode: 0, stdout: `${SHA}\t${ref}\n`, stderr: '' };
    }
    if (args.includes('clone')) {
      return { exitCode: 128, stdout: '', stderr };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
}

/** 一律以指定 stderr 失敗 */
function makeFailExecutor(stderr: string): GitExecutor {
  return async () => ({ exitCode: 128, stdout: '', stderr });
}

function tmpGitAcqDirs(): Set<string> {
  return new Set(readdirSync(tmpdir()).filter((n) => n.startsWith('git-acq-')));
}

function makeFixtureRepo(root: string): void {
  mkdirSync(join(root, '.agents', 'plugins'), { recursive: true });
  writeFileSync(
    join(root, '.agents', 'plugins', 'marketplace.json'),
    JSON.stringify({ name: 'private-mkt', plugins: [{ name: 'p1', source: { source: 'local', path: './plugins/p1' } }] }),
  );
  writeFileSync(join(root, 'plugin.json'), JSON.stringify({ name: 'p1' }));
}

describe('認證失敗分類（GIT-34）— ls-remote 路徑', () => {
  it('未核准＋401（Authentication failed）→ GIT-34 未核准變體：含 env 變數名稱與 SSH 指引，無「not approved」', async () => {
    const res = await resolveGitRevision(locatorOf(URL), {
      executor: makeFailExecutor("fatal: Authentication failed for 'https://github.com/acme/private-mkt/'"),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0].code).toBe(CODE.GIT_TRUST_AUTH_REQUIRED);
    expect(res.findings[0].rule).toBe(RULE.GIT_TRUST_AUTH_REQUIRED);
    expect(res.findings[0].outcome).toContain(CREDENTIAL_HELPERS_ENV);
    expect(res.findings[0].outcome).toMatch(/SSH/i);
    expect(res.findings[0].outcome).not.toMatch(/not approved/i);
  });

  it('已核准＋401 → GIT-34 已核准變體：指引檢查登入（gh auth status／keychain），無「not approved」', async () => {
    const res = await resolveGitRevision(locatorOf(URL), {
      executor: makeFailExecutor("fatal: Authentication failed for 'https://github.com/acme/private-mkt/'"),
      trust: { allowedCredentialHelpers: ['my-helper'] },
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.findings[0].code).toBe(CODE.GIT_TRUST_AUTH_REQUIRED);
    expect(res.findings[0].rule).toBe(RULE.GIT_TRUST_AUTH_REQUIRED);
    expect(res.findings[0].outcome).toMatch(/gh auth status/);
    expect(res.findings[0].outcome).toMatch(/keychain/i);
    expect(res.findings[0].outcome).not.toMatch(/not approved/i);
    expect(res.findings[0].outcome).not.toContain(CREDENTIAL_HELPERS_ENV);
  });

  it('helper 拒絕字串（could not read Username）→ GIT-33 保留：not approved＋env 指引', async () => {
    const res = await resolveGitRevision(locatorOf(URL), {
      executor: makeFailExecutor("fatal: could not read Username for 'https://github.com': terminal prompts disabled"),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.findings[0].code).toBe(CODE.GIT_TRUST_CREDENTIAL_HELPER);
    expect(res.findings[0].rule).toBe(RULE.GIT_TRUST_CREDENTIAL_HELPER);
    expect(res.findings[0].outcome).toMatch(/not approved/i);
    expect(res.findings[0].outcome).toContain(CREDENTIAL_HELPERS_ENV);
  });

  it('helper 拒絕＋已核准 → GIT-33 已核准變體（檢查登入），無「not approved」', async () => {
    const res = await resolveGitRevision(locatorOf(URL), {
      executor: makeFailExecutor("fatal: could not read Username for 'https://github.com': terminal prompts disabled"),
      trust: { allowedCredentialHelpers: ['my-helper'] },
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.findings[0].code).toBe(CODE.GIT_TRUST_CREDENTIAL_HELPER);
    expect(res.findings[0].rule).toBe(RULE.GIT_TRUST_CREDENTIAL_HELPER);
    expect(res.findings[0].outcome).toMatch(/gh auth status/);
    expect(res.findings[0].outcome).toMatch(/keychain/i);
    expect(res.findings[0].outcome).not.toMatch(/not approved/i);
  });

  it('not-found 字串（Repository not found）→ 標明 repo 不存在', async () => {
    const res = await resolveGitRevision(locatorOf(URL), {
      executor: makeFailExecutor("ERROR: Repository not found\nfatal: Could not read from remote repository."),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.findings[0].code).toBe(CODE.GIT_REPO_NOT_FOUND);
    expect(res.findings[0].outcome).toMatch(/does not exist/i);
    expect(res.findings[0].outcome).toContain(URL);
  });
});

describe('認證失敗分類（GIT-34）— clone 路徑（與 ls-remote 一致）', () => {
  it('未核准＋clone 401 → 同一分類與未核准變體', async () => {
    const res = await acquireGitSource({
      locator: locatorOf(URL),
      executor: makeCloneFailExecutor("fatal: Authentication failed for 'https://github.com/acme/private-mkt/'"),
    });
    expect(res.ok).toBe(false);
    expect(res.findings[0].code).toBe(CODE.GIT_TRUST_AUTH_REQUIRED);
    expect(res.findings[0].rule).toBe(RULE.GIT_TRUST_AUTH_REQUIRED);
    expect(res.findings[0].outcome).toContain(CREDENTIAL_HELPERS_ENV);
    expect(res.findings[0].outcome).toMatch(/SSH/i);
  });

  it('已核准＋clone 401 → 已核准變體（gh auth status／keychain）', async () => {
    const res = await acquireGitSource({
      locator: locatorOf(URL),
      executor: makeCloneFailExecutor("fatal: Authentication failed for 'https://github.com/acme/private-mkt/'"),
      trust: { allowedCredentialHelpers: ['my-helper'] },
    });
    expect(res.ok).toBe(false);
    expect(res.findings[0].code).toBe(CODE.GIT_TRUST_AUTH_REQUIRED);
    expect(res.findings[0].outcome).toMatch(/gh auth status/);
    expect(res.findings[0].outcome).toMatch(/keychain/i);
  });

  it('clone not-found → 標明 repo 不存在', async () => {
    const res = await acquireGitSource({
      locator: locatorOf(URL),
      executor: makeCloneFailExecutor("fatal: repository 'https://github.com/acme/private-mkt' not found"),
    });
    expect(res.ok).toBe(false);
    expect(res.findings[0].code).toBe(CODE.GIT_REPO_NOT_FOUND);
    expect(res.findings[0].outcome).toMatch(/does not exist/i);
    expect(res.findings[0].outcome).toContain(URL);
  });

  it('clone 401 失敗 → 暫時目錄無殘留', async () => {
    const before = tmpGitAcqDirs();
    const res = await acquireGitSource({
      locator: locatorOf(URL),
      executor: makeCloneFailExecutor("fatal: Authentication failed for 'https://github.com/acme/private-mkt/'"),
    });
    expect(res.ok).toBe(false);
    const gained = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith('git-acq-') && !before.has(n)));
    expect([...gained]).toEqual([]);
  });
});

describe('取得成功路徑（GIT-34 不誤傷）', () => {
  it('ls-remote＋clone 成功 → ok 且無 findings', async () => {
    const dest = mkdtempSync(join(tmpdir(), 'git-acq-ok-'));
    makeFixtureRepo(dest);
    const executor: GitExecutor = async (args) => {
      if (args.includes('ls-remote')) {
        const ref = args[args.length - 1];
        return { exitCode: 0, stdout: `${SHA}\t${ref}\n`, stderr: '' };
      }
      if (args.includes('clone')) {
        const target = args[args.length - 1];
        rmSync(target, { recursive: true, force: true });
        // 直接沿用 fixture（mock 不做真實 clone）
        mkdirSync(join(target, '.git'), { recursive: true });
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const res = await acquireGitSource({ locator: locatorOf(URL), executor, destDir: dest });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.resolvedRevision).toBe(SHA);
      expect(res.findings).toEqual([]);
    }
    rmSync(dest, { recursive: true, force: true });
  });
});