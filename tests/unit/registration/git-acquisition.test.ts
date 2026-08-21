import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireGitSource, type GitExecutor } from '../../../src/registration/git-acquisition.js';
import { normalizeGitLocator } from '../../../src/registration/git-locator.js';
import { normalizeGitSelector } from '../../../src/registration/git-selector.js';

function makeFixture(root: string) {
  mkdirSync(join(root, '.agents', 'plugins'), { recursive: true });
  mkdirSync(join(root, 'plugins', 'demo'), { recursive: true });
  writeFileSync(join(root, 'plugins', 'demo', 'plugin.json'), '{"name":"demo"}');
  writeFileSync(
    join(root, '.agents', 'plugins', 'marketplace.json'),
    JSON.stringify({ name: 'demo-marketplace', plugins: [{ name: 'demo', path: './plugins/demo' }] }),
  );
}

function makeMockExecutor(
  fixtureRoot: string,
  opts: {
    lsRemoteSha?: string;
    hostKeyError?: 'unknown' | 'changed';
    redirectError?: boolean;
    record?: { args: string[][]; envs: (Record<string, string> | undefined)[] };
  } = {},
): GitExecutor {
  const record = opts.record ?? { args: [], envs: [] };
  const sha = opts.lsRemoteSha ?? 'a'.repeat(40);
  return async (args, execOpts) => {
    record.args.push(args);
    record.envs.push(execOpts?.env);
    const cmd = args.join(' ');
    // ls-remote
    if (args.includes('ls-remote')) {
      if (opts.hostKeyError) {
        const msg = opts.hostKeyError === 'changed'
          ? 'Host key verification failed. Offending key ...'
          : 'Host key verification failed.';
        return { exitCode: 1, stdout: '', stderr: msg };
      }
      if (opts.redirectError) {
        return { exitCode: 1, stdout: '', stderr: 'fatal: unable to access ... Redirect ... http.followRedirects=false' };
      }
      // return sha for the requested ref
      const ref = args[args.length - 1];
      // For HEAD or refs/heads/* etc, return sha
      return { exitCode: 0, stdout: `${sha}\t${ref}\n`, stderr: '' };
    }
    if (args.includes('clone')) {
      if (opts.hostKeyError) {
        const msg = opts.hostKeyError === 'changed' ? 'Offending ECDSA key' : 'Host key verification failed.';
        return { exitCode: 1, stdout: '', stderr: msg };
      }
      if (opts.redirectError) {
        return { exitCode: 1, stdout: '', stderr: 'fatal: unable to access ... redirect ...' };
      }
      const dest = args[args.length - 1];
      // simulate clone --no-checkout by copying fixture
      // but clone dest should be empty dir we fill
      cpSync(fixtureRoot, dest, { recursive: true });
      // create .git marker so snapshot walk ignores .git
      mkdirSync(join(dest, '.git'), { recursive: true });
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (args.includes('remote') && args.includes('get-url')) {
      // return canonicalUrl as stored
      // args: [..., '-C', dest, 'remote', 'get-url', 'origin']
      // We need to find locator canonicalUrl — we can just return the clone url arg previously? But we don't have.
      // Return a plausible origin that matches canonical for success case
      // The test will pass locator.canonicalUrl via closure? Simpler return the canonicalUrl we know: we can extract from last clone call.
      // For now return first ls-remote url? Not available.
      // We'll just return '' and caller will ignore (we handle empty as not redirect)
      // To detect redirect we need to simulate different host — we can check opts.redirectError already handled.
      // So for success, return an origin that matches expected host (we'll return https://github.com/owner/repo)
      // This will be validated in acquireGitSource's redirect check — we should return the same as locator canonical to pass.
      // We don't know locator, so we return a generic https://github.com/owner/repo which matches most tests using that locator.
      // For tests with different locator we may need to adjust — but we can just return empty to skip check? In code, if remoteRes exitCode !=0 we skip.
      // So return success with that generic.
      return { exitCode: 0, stdout: 'https://github.com/owner/repo\n', stderr: '' };
    }
    if (args.includes('cat-file')) {
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (args.includes('checkout')) {
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (args.includes('fetch')) {
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
}

describe('Git Source Acquisition — non-executing and Trust Base', () => {
  let fixture: string;
  let tmpRoot: string;

  beforeEach(() => {
    fixture = mkdtempSync(join(tmpdir(), 'git-fixture-'));
    makeFixture(fixture);
    tmpRoot = mkdtempSync(join(tmpdir(), 'acq-test-'));
  });
  afterEach(() => {
    try { rmSync(fixture, { recursive: true, force: true }); } catch {}
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  it('acquires via clone --no-checkout with hardened config and resolves branch to full commit', async () => {
    const loc = normalizeGitLocator('https://github.com/owner/repo', 'global').locator!;
    const sel = normalizeGitSelector({ kind: 'branch', value: 'main' }, 'global').selector!;
    const record: { args: string[][]; envs: (Record<string, string> | undefined)[] } = { args: [], envs: [] };
    const exec = makeMockExecutor(fixture, { lsRemoteSha: 'b'.repeat(40), record });
    const res = await acquireGitSource({ scope: 'global', locator: loc, selector: sel, executor: exec });
    expect(res.ok).toBe(true);
    expect(res.resolvedRevision).toBe('b'.repeat(40));
    expect(res.acquiredPath).toBeDefined();
    // Verify clone args include --no-checkout and hardened config
    const cloneCall = record.args.find((a) => a.includes('clone'));
    expect(cloneCall).toBeDefined();
    expect(cloneCall!.join(' ')).toContain('--no-checkout');
    expect(cloneCall!.join(' ')).toContain('core.hooksPath=/dev/null');
    expect(cloneCall!.join(' ')).toContain('credential.helper=');
    expect(cloneCall!.join(' ')).toContain('http.followRedirects=false');
    expect(cloneCall!.join(' ')).toContain('http.sslVerify=true');
    expect(cloneCall!.join(' ')).toContain('filter.lfs.process=');
    // Verify ls-remote called
    const lsCall = record.args.find((a) => a.includes('ls-remote'));
    expect(lsCall).toBeDefined();
    expect(lsCall!.join(' ')).toContain('refs/heads/main');
    // Verify env hardens SSH and terminal
    const someEnv = record.envs.find((e) => e?.GIT_TERMINAL_PROMPT === '0');
    expect(someEnv).toBeDefined();
    expect(someEnv!.GIT_ASKPASS).toBe('echo');
    // Cleanup
    if (res.acquiredPath && existsSync(res.acquiredPath)) rmSync(res.acquiredPath, { recursive: true, force: true });
  });

  it('resolves commit selector directly without ls-remote for commit prefix', async () => {
    const loc = normalizeGitLocator('https://github.com/owner/repo', 'global').locator!;
    const sha = 'C'.repeat(40); // upper
    const sel = normalizeGitSelector({ kind: 'commit', value: sha }, 'global').selector!;
    expect(sel.canonical).toBe(sha.toLowerCase());
    const record: { args: string[][]; envs: any } = { args: [], envs: [] };
    const exec = makeMockExecutor(fixture, { record });
    const res = await acquireGitSource({ scope: 'global', locator: loc, selector: sel, executor: exec });
    expect(res.ok).toBe(true);
    expect(res.resolvedRevision).toBe(sha.toLowerCase());
    // ls-remote should NOT be called for commit? Our implementation returns directly for commit, so no ls-remote
    const lsCall = record.args.find((a) => a.includes('ls-remote'));
    expect(lsCall).toBeUndefined();
    if (res.acquiredPath) rmSync(res.acquiredPath, { recursive: true, force: true });
  });

  it('rejects on unknown host key (Blocking)', async () => {
    const loc = normalizeGitLocator('ssh://git@github.com/owner/repo', 'global').locator!;
    const sel = normalizeGitSelector({ kind: 'branch', value: 'main' }, 'global').selector!;
    const exec = makeMockExecutor(fixture, { hostKeyError: 'unknown' });
    const res = await acquireGitSource({ scope: 'global', locator: loc, selector: sel, executor: exec });
    expect(res.ok).toBe(false);
    expect(res.findings[0].code).toBe('GIT_TRUST_HOST_KEY_UNKNOWN');
    expect(res.findings[0].rule).toBe('GIT-31');
  });

  it('rejects on changed host key (Blocking)', async () => {
    const loc = normalizeGitLocator('ssh://git@github.com/owner/repo', 'global').locator!;
    const sel = normalizeGitSelector({ kind: 'branch', value: 'main' }, 'global').selector!;
    const exec = makeMockExecutor(fixture, { hostKeyError: 'changed' });
    const res = await acquireGitSource({ scope: 'global', locator: loc, selector: sel, executor: exec });
    expect(res.ok).toBe(false);
    expect(res.findings[0].code).toBe('GIT_TRUST_HOST_KEY_CHANGED');
  });

  it('rejects on redirect changing canonical locator (Blocking)', async () => {
    const loc = normalizeGitLocator('https://github.com/owner/repo', 'global').locator!;
    const sel = normalizeGitSelector({ kind: 'branch', value: 'main' }, 'global').selector!;
    const exec = makeMockExecutor(fixture, { redirectError: true });
    const res = await acquireGitSource({ scope: 'global', locator: loc, selector: sel, executor: exec });
    expect(res.ok).toBe(false);
    expect(res.findings[0].code).toBe('GIT_TRUST_REDIRECT');
  });

  it('ensures GIT_SSH_COMMAND contains StrictHostKeyChecking for ssh transport', async () => {
    const loc = normalizeGitLocator('ssh://git@github.com/owner/repo', 'global').locator!;
    const sel = normalizeGitSelector({ kind: 'branch', value: 'main' }, 'global').selector!;
    const record: { args: string[][]; envs: (Record<string, string> | undefined)[] } = { args: [], envs: [] };
    const exec = makeMockExecutor(fixture, { record });
    const res = await acquireGitSource({ scope: 'global', locator: loc, selector: sel, executor: exec });
    expect(res.ok).toBe(true);
    const envWithSsh = record.envs.find((e) => e?.GIT_SSH_COMMAND);
    expect(envWithSsh).toBeDefined();
    expect(envWithSsh!.GIT_SSH_COMMAND).toContain('StrictHostKeyChecking=yes');
    expect(envWithSsh!.GIT_SSH_COMMAND).toContain('BatchMode=yes');
    expect(envWithSsh!.GIT_SSH_COMMAND).toContain('UserKnownHostsFile=');
    if (res.acquiredPath) rmSync(res.acquiredPath, { recursive: true, force: true });
  });

  it('does not include --recurse-submodules and includes --filter=blob:none', async () => {
    const loc = normalizeGitLocator('https://github.com/owner/repo', 'global').locator!;
    const sel = normalizeGitSelector({ kind: 'branch', value: 'main' }, 'global').selector!;
    const record: { args: string[][]; envs: any } = { args: [], envs: [] };
    const exec = makeMockExecutor(fixture, { record });
    const res = await acquireGitSource({ scope: 'global', locator: loc, selector: sel, executor: exec });
    expect(res.ok).toBe(true);
    const cloneCall = record.args.find((a) => a.includes('clone'))!.join(' ');
    expect(cloneCall).not.toContain('--recurse-submodules');
    expect(cloneCall).toContain('--filter=blob:none');
    if (res.acquiredPath) rmSync(res.acquiredPath, { recursive: true, force: true });
  });
});
