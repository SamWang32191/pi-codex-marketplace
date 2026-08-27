import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseGitEntrySpec,
  normalizeEntryLocator,
  resolveEntrySelector,
  acquireGitEntry,
  acquireGitEntries,
  checkEntryDrift,
  type NormalizedGitEntrySpec,
} from '../../../src/registration/entry-acquisition.js';
import type { GitExecutor } from '../../../src/registration/git-acquisition.js';
import { CODE, RULE } from '../../../src/registration/findings.js';

function makeEntryFixture(root: string, opts: { withSubdir?: string; files?: Record<string, string> } = {}) {
  const targetDir = opts.withSubdir ? join(root, opts.withSubdir) : root;
  mkdirSync(targetDir, { recursive: true });

  const files = opts.files ?? {
    'SKILL.md': '---\nname: my-skill\ndescription: test skill\n---\nHello from skill',
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'entry-plugin', skills: ['./skills/my-skill'] }),
  };

  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = join(targetDir, relPath);
    mkdirSync(join(fullPath, '..'), { recursive: true });
    writeFileSync(fullPath, content);
  }
}

function makeMockGitExecutor(
  fixtureRoot: string,
  opts: {
    lsRemoteSha?: string;
    hostKeyError?: 'unknown' | 'changed';
    redirectError?: boolean;
    cloneError?: string;
    record?: { args: string[][]; envs: (Record<string, string> | undefined)[] };
  } = {},
): GitExecutor {
  const record = opts.record ?? { args: [], envs: [] };
  const sha = opts.lsRemoteSha ?? 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4';
  return async (args, execOpts) => {
    record.args.push(args);
    record.envs.push(execOpts?.env);

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
      const ref = args[args.length - 1];
      return { exitCode: 0, stdout: `${sha}\t${ref}\n`, stderr: '' };
    }

    if (args.includes('clone')) {
      if (opts.hostKeyError) {
        const msg = opts.hostKeyError === 'changed' ? 'Offending ECDSA key' : 'Host key verification failed.';
        return { exitCode: 1, stdout: '', stderr: msg };
      }
      if (opts.cloneError) {
        return { exitCode: 1, stdout: '', stderr: opts.cloneError };
      }
      const dest = args[args.length - 1];
      cpSync(fixtureRoot, dest, { recursive: true });
      mkdirSync(join(dest, '.git'), { recursive: true });
      return { exitCode: 0, stdout: '', stderr: '' };
    }

    if (args.includes('remote') && args.includes('get-url')) {
      return { exitCode: 0, stdout: 'https://github.com/owner/repo\n', stderr: '' };
    }

    if (args.includes('cat-file') || args.includes('checkout') || args.includes('fetch')) {
      return { exitCode: 0, stdout: '', stderr: '' };
    }

    return { exitCode: 0, stdout: '', stderr: '' };
  };
}

describe('Entry Acquisition Engine — Spec Parsing and Normalization', () => {
  describe('Shorthand & Locator Normalization (Acceptance Criteria 2)', () => {
    it('normalizes string owner/repo shorthand to https://github.com/<owner>/<repo>', () => {
      const res = parseGitEntrySpec('octocat/Hello-World');
      expect(res.ok).toBe(true);
      expect(res.isGitFamily).toBe(true);
      expect(res.spec!.shape).toBe('github');
      expect(res.spec!.locator.canonicalUrl).toBe('https://github.com/octocat/Hello-World');
      expect(res.spec!.selector.kind).toBe('default');
      expect(res.spec!.effectivePin).toBe('default');
    });

    it('normalizes github object with shorthand repo to https://github.com/<owner>/<repo>', () => {
      const res = parseGitEntrySpec({ source: 'github', repo: 'samwang/my-plugin' });
      expect(res.ok).toBe(true);
      expect(res.isGitFamily).toBe(true);
      expect(res.spec!.shape).toBe('github');
      expect(res.spec!.locator.canonicalUrl).toBe('https://github.com/samwang/my-plugin');
    });

    it('normalizes full URL in url object', () => {
      const res = parseGitEntrySpec({ source: 'url', url: 'https://gitlab.com/group/project.git' });
      expect(res.ok).toBe(true);
      expect(res.isGitFamily).toBe(true);
      expect(res.spec!.shape).toBe('url');
      expect(res.spec!.locator.canonicalUrl).toBe('https://gitlab.com/group/project.git');
    });

    it('normalizes git-subdir object and captures subpath', () => {
      const res = parseGitEntrySpec({
        source: 'git-subdir',
        url: 'https://github.com/org/monorepo.git',
        path: 'plugins/core-plugin',
      });
      expect(res.ok).toBe(true);
      expect(res.isGitFamily).toBe(true);
      expect(res.spec!.shape).toBe('git-subdir');
      expect(res.spec!.locator.canonicalUrl).toBe('https://github.com/org/monorepo.git');
      expect(res.spec!.subpath).toBe('plugins/core-plugin');
    });

    it('normalizes git-subdir object with shorthand repo', () => {
      const res = parseGitEntrySpec({
        source: 'git-subdir',
        repo: 'org/monorepo',
        path: 'packages/plugin-a',
      });
      expect(res.ok).toBe(true);
      expect(res.spec!.shape).toBe('git-subdir');
      expect(res.spec!.locator.canonicalUrl).toBe('https://github.com/org/monorepo');
      expect(res.spec!.subpath).toBe('packages/plugin-a');
    });

    it('supports codex git source kind { source: "git", url: "...", path: "..." }', () => {
      const res = parseGitEntrySpec({
        source: 'git',
        url: 'https://github.com/codex/sample.git',
        path: 'subplugin',
      });
      expect(res.ok).toBe(true);
      expect(res.isGitFamily).toBe(true);
      expect(res.spec!.locator.canonicalUrl).toBe('https://github.com/codex/sample.git');
      expect(res.spec!.subpath).toBe('subplugin');
    });
  });

  describe('Security Rejection: Credentials & Plaintext (Acceptance Criteria 2)', () => {
    it('rejects embedded credentials in https locator with GIT_LOCATOR_CREDENTIAL', () => {
      const res = parseGitEntrySpec({
        source: 'github',
        repo: 'https://token:secret@github.com/owner/repo',
      });
      expect(res.ok).toBe(false);
      expect(res.isGitFamily).toBe(true);
      expect(res.findings.some((f) => f.code === CODE.GIT_LOCATOR_CREDENTIAL)).toBe(true);
    });

    it('rejects embedded credentials in ssh locator with GIT_LOCATOR_CREDENTIAL', () => {
      const res = parseGitEntrySpec({
        source: 'url',
        url: 'ssh://user:pass@github.com/owner/repo',
      });
      expect(res.ok).toBe(false);
      expect(res.findings.some((f) => f.code === CODE.GIT_LOCATOR_CREDENTIAL)).toBe(true);
    });

    it('rejects plaintext http:// transport with GIT_LOCATOR_PLAINTEXT', () => {
      const res = parseGitEntrySpec({
        source: 'url',
        url: 'http://github.com/owner/repo',
      });
      expect(res.ok).toBe(false);
      expect(res.findings.some((f) => f.code === CODE.GIT_LOCATOR_PLAINTEXT)).toBe(true);
    });

    it('rejects file:// transport with GIT_LOCATOR_PLAINTEXT', () => {
      const res = parseGitEntrySpec({
        source: 'url',
        url: 'file:///etc/passwd',
      });
      expect(res.ok).toBe(false);
      expect(res.findings.some((f) => f.code === CODE.GIT_LOCATOR_PLAINTEXT)).toBe(true);
    });

    it('rejects ambiguous percent-encoding in locator with GIT_LOCATOR_AMBIGUOUS_ENCODING', () => {
      const res = parseGitEntrySpec({
        source: 'url',
        url: 'https://github.com/owner%2frepo',
      });
      expect(res.ok).toBe(false);
      expect(res.findings.some((f) => f.code === CODE.GIT_LOCATOR_AMBIGUOUS_ENCODING)).toBe(true);
    });

    it('rejects control characters in locator with GIT_LOCATOR_CONTROL_CHARS', () => {
      const res = parseGitEntrySpec({
        source: 'url',
        url: 'https://github.com/owner\x00/repo',
      });
      expect(res.ok).toBe(false);
      expect(res.findings.some((f) => f.code === CODE.GIT_LOCATOR_CONTROL_CHARS)).toBe(true);
    });

    it('rejects query parameters or fragment in locator with GIT_LOCATOR_QUERY_FRAGMENT', () => {
      const res = parseGitEntrySpec({
        source: 'url',
        url: 'https://github.com/owner/repo?branch=main',
      });
      expect(res.ok).toBe(false);
      expect(res.findings.some((f) => f.code === CODE.GIT_LOCATOR_QUERY_FRAGMENT)).toBe(true);
    });
  });

  describe('Selector Mapping & Pin Matrix (Acceptance Criteria 1)', () => {
    it('maps 40-hex sha to commit selector with effectivePin = "sha"', () => {
      const sha = '1234567890abcdef1234567890abcdef12345678';
      const res = parseGitEntrySpec({ source: 'github', repo: 'owner/repo', sha });
      expect(res.ok).toBe(true);
      expect(res.spec!.selector.kind).toBe('commit');
      expect(res.spec!.selector.canonical).toBe(sha);
      expect(res.spec!.effectivePin).toBe('sha');
    });

    it('maps 64-hex sha (SHA-256 object name) to commit selector', () => {
      const sha = 'a'.repeat(64);
      const res = parseGitEntrySpec({ source: 'github', repo: 'owner/repo', sha });
      expect(res.ok).toBe(true);
      expect(res.spec!.selector.kind).toBe('commit');
      expect(res.spec!.selector.canonical).toBe(sha);
      expect(res.spec!.effectivePin).toBe('sha');
    });

    it('normalizes uppercase sha to lowercase canonical', () => {
      const sha = '1234567890ABCDEF1234567890ABCDEF12345678';
      const res = parseGitEntrySpec({ source: 'github', repo: 'owner/repo', sha });
      expect(res.ok).toBe(true);
      expect(res.spec!.selector.canonical).toBe(sha.toLowerCase());
    });

    it('rejects abbreviated commit sha with GIT_SELECTOR_COMMIT_INVALID', () => {
      const res = parseGitEntrySpec({ source: 'github', repo: 'owner/repo', sha: '1234567' });
      expect(res.ok).toBe(false);
      expect(res.findings.some((f) => f.code === CODE.GIT_SELECTOR_COMMIT_INVALID)).toBe(true);
    });

    it('rejects non-hex sha with GIT_SELECTOR_COMMIT_INVALID', () => {
      const res = parseGitEntrySpec({ source: 'github', repo: 'owner/repo', sha: 'z'.repeat(40) });
      expect(res.ok).toBe(false);
      expect(res.findings.some((f) => f.code === CODE.GIT_SELECTOR_COMMIT_INVALID)).toBe(true);
    });

    it('maps explicit branch ref to branch selector with effectivePin = "ref"', () => {
      const res = parseGitEntrySpec({ source: 'github', repo: 'owner/repo', ref: 'refs/heads/feature-x' });
      expect(res.ok).toBe(true);
      expect(res.spec!.selector.kind).toBe('branch');
      expect(res.spec!.selector.canonical).toBe('refs/heads/feature-x');
      expect(res.spec!.effectivePin).toBe('ref');
    });

    it('maps explicit tag ref to tag selector with effectivePin = "ref"', () => {
      const res = parseGitEntrySpec({ source: 'github', repo: 'owner/repo', ref: 'refs/tags/v2.1.0' });
      expect(res.ok).toBe(true);
      expect(res.spec!.selector.kind).toBe('tag');
      expect(res.spec!.selector.canonical).toBe('refs/tags/v2.1.0');
      expect(res.spec!.effectivePin).toBe('ref');
    });

    it('maps plain branch name to branch selector', () => {
      const res = parseGitEntrySpec({ source: 'github', repo: 'owner/repo', ref: 'main' });
      expect(res.ok).toBe(true);
      expect(res.spec!.selector.kind).toBe('branch');
      expect(res.spec!.selector.canonical).toBe('refs/heads/main');
      expect(res.spec!.effectivePin).toBe('ref');
    });

    it('maps v-prefixed tag name to tag selector', () => {
      const res = parseGitEntrySpec({ source: 'github', repo: 'owner/repo', ref: 'v1.0.0' });
      expect(res.ok).toBe(true);
      expect(res.spec!.selector.kind).toBe('tag');
      expect(res.spec!.selector.canonical).toBe('refs/tags/v1.0.0');
      expect(res.spec!.effectivePin).toBe('ref');
    });

    it('maps neither sha nor ref to default movable selector with effectivePin = "default"', () => {
      const res = parseGitEntrySpec({ source: 'github', repo: 'owner/repo' });
      expect(res.ok).toBe(true);
      expect(res.spec!.selector.kind).toBe('default');
      expect(res.spec!.selector.canonical).toBe('default');
      expect(res.spec!.effectivePin).toBe('default');
    });

    it('handles coexistence: sha is effective pin; ref is validated for syntax (Acceptance Criteria 1)', () => {
      const sha = '1234567890abcdef1234567890abcdef12345678';
      const res = parseGitEntrySpec({
        source: 'github',
        repo: 'owner/repo',
        sha,
        ref: 'main',
      });
      expect(res.ok).toBe(true);
      expect(res.spec!.effectivePin).toBe('sha');
      expect(res.spec!.selector.kind).toBe('commit');
      expect(res.spec!.selector.canonical).toBe(sha);
      expect(res.spec!.verifiedRef).toMatchObject({
        kind: 'branch',
        canonical: 'refs/heads/main',
      });
    });

    it('rejects invalid ref syntax even when sha is valid', () => {
      const sha = '1234567890abcdef1234567890abcdef12345678';
      const res = parseGitEntrySpec({
        source: 'github',
        repo: 'owner/repo',
        sha,
        ref: '-option-injection',
      });
      expect(res.ok).toBe(false);
      expect(res.findings.some((f) => f.code === CODE.GIT_SELECTOR_INVALID)).toBe(true);
    });

    it('rejects ref with revision chars (~^:) or reflog (@{)', () => {
      for (const badRef of ['main~1', 'main^2', 'main@{yesterday}', 'HEAD', 'main:file']) {
        const res = parseGitEntrySpec({ source: 'github', repo: 'owner/repo', ref: badRef });
        expect(res.ok).toBe(false);
        expect(res.findings.some((f) => f.code === CODE.GIT_SELECTOR_INVALID)).toBe(true);
      }
    });
  });

  describe('Non-git entry forms remain Unavailable', () => {
    it('discloses npm source as Unavailable with stable reason', () => {
      const res = parseGitEntrySpec({ source: 'npm', package: '@scope/pkg' });
      expect(res.ok).toBe(false);
      expect(res.isGitFamily).toBe(false);
      expect(res.unavailableReason).toBe('npm source entries are not supported');
    });

    it('discloses archive source as Unavailable with stable reason', () => {
      const res = parseGitEntrySpec({ source: 'archive', url: 'https://example.test/a.zip' });
      expect(res.ok).toBe(false);
      expect(res.isGitFamily).toBe(false);
      expect(res.unavailableReason).toBe('archive source entries are not supported');
    });

    it('discloses command source as permanently disqualified', () => {
      const res = parseGitEntrySpec({ source: 'command', command: 'make' });
      expect(res.ok).toBe(false);
      expect(res.isGitFamily).toBe(false);
      expect(res.unavailableReason).toBe('command source entries are permanently disqualified');
    });

    it('identifies local ./path as non-git (handled by local flow)', () => {
      const res = parseGitEntrySpec('./plugins/local');
      expect(res.ok).toBe(false);
      expect(res.isGitFamily).toBe(false);
    });
  });
});

describe('Entry Acquisition Engine — Mock Execution & Snapshot Generation', () => {
  let fixtureDir: string;

  beforeEach(() => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'entry-acq-fixture-'));
    makeEntryFixture(fixtureDir, {
      files: {
        'SKILL.md': '---\nname: hello-skill\ndescription: Hello\n---\nBody content',
        '.claude-plugin/plugin.json': JSON.stringify({ name: 'test-plugin' }),
      },
    });
  });

  afterEach(() => {
    try {
      if (existsSync(fixtureDir)) rmSync(fixtureDir, { recursive: true, force: true });
    } catch {}
  });

  it('acquires a sha-pinned github entry and binds full commit SHA (Acceptance Criteria 1)', async () => {
    const sha = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4';
    const parsed = parseGitEntrySpec({ source: 'github', repo: 'owner/repo', sha });
    expect(parsed.ok).toBe(true);

    const executor = makeMockGitExecutor(fixtureDir, { lsRemoteSha: sha });
    const res = await acquireGitEntry({
      spec: parsed.spec!,
      entryId: '/plugins/0',
      executor,
    });

    expect(res.ok).toBe(true);
    expect(res.resolvedRevision).toBe(sha);
    expect(res.snapshot).toBeDefined();
    expect(res.snapshot!.resolvedRevision).toBe(sha);
    expect(res.snapshot!.fingerprint).toHaveLength(64);
    expect(res.snapshot!.entries.some((e) => e.relPath === 'SKILL.md')).toBe(true);

    if (res.createdTemp && res.acquiredPath) {
      rmSync(res.acquiredPath, { recursive: true, force: true });
    }
  });

  it('acquires a movable ref entry and binds the resolved commit at acquisition time (Acceptance Criteria 1)', async () => {
    const resolvedSha = 'beefdeadbeefdeadbeefdeadbeefdeadbeefdead';
    const parsed = parseGitEntrySpec({ source: 'github', repo: 'owner/repo', ref: 'main' });
    expect(parsed.ok).toBe(true);

    const executor = makeMockGitExecutor(fixtureDir, { lsRemoteSha: resolvedSha });
    const res = await acquireGitEntry({
      spec: parsed.spec!,
      entryId: '/plugins/1',
      executor,
    });

    expect(res.ok).toBe(true);
    expect(res.resolvedRevision).toBe(resolvedSha);
    expect(res.snapshot!.resolvedRevision).toBe(resolvedSha);

    if (res.createdTemp && res.acquiredPath) {
      rmSync(res.acquiredPath, { recursive: true, force: true });
    }
  });

  it('acquires a movable default entry and binds the HEAD commit (Acceptance Criteria 1)', async () => {
    const defaultSha = 'cafe1234cafe1234cafe1234cafe1234cafe1234';
    const parsed = parseGitEntrySpec('owner/repo');
    expect(parsed.ok).toBe(true);

    const executor = makeMockGitExecutor(fixtureDir, { lsRemoteSha: defaultSha });
    const res = await acquireGitEntry({
      spec: parsed.spec!,
      entryId: '/plugins/0',
      executor,
    });

    expect(res.ok).toBe(true);
    expect(res.resolvedRevision).toBe(defaultSha);

    if (res.createdTemp && res.acquiredPath) {
      rmSync(res.acquiredPath, { recursive: true, force: true });
    }
  });

  it('acquires a git-subdir entry and sets entryRootPath to the contained subdirectory', async () => {
    // Add a subdirectory fixture inside fixtureDir
    const subdir = 'packages/sub-plugin';
    mkdirSync(join(fixtureDir, subdir), { recursive: true });
    writeFileSync(join(fixtureDir, subdir, 'SKILL.md'), '---\nname: sub-skill\n---\nSub content');
    writeFileSync(join(fixtureDir, subdir, 'plugin.json'), '{"name":"sub-plugin"}');

    const sha = '1111222233334444555566667777888899990000';
    const parsed = parseGitEntrySpec({
      source: 'git-subdir',
      url: 'https://github.com/owner/monorepo.git',
      path: subdir,
      sha,
    });
    expect(parsed.ok).toBe(true);

    const executor = makeMockGitExecutor(fixtureDir, { lsRemoteSha: sha });
    const res = await acquireGitEntry({
      spec: parsed.spec!,
      entryId: '/plugins/2',
      executor,
    });

    expect(res.findings).toEqual([]);
    expect(res.ok).toBe(true);
    expect(res.entryRootPath).toContain(subdir);
    expect(res.snapshot!.entries.some((e) => e.relPath === 'SKILL.md')).toBe(true);

    if (res.createdTemp && res.acquiredPath) {
      rmSync(res.acquiredPath, { recursive: true, force: true });
    }
  });

  it('rejects git-subdir with escaping subpath (../) with PATH_CONTAINMENT_VIOLATION', async () => {
    const sha = '1111222233334444555566667777888899990000';
    const parsed = parseGitEntrySpec({
      source: 'git-subdir',
      url: 'https://github.com/owner/repo.git',
      path: '../outside',
      sha,
    });
    expect(parsed.ok).toBe(true);

    const executor = makeMockGitExecutor(fixtureDir, { lsRemoteSha: sha });
    const res = await acquireGitEntry({
      spec: parsed.spec!,
      entryId: '/plugins/0',
      executor,
    });

    expect(res.ok).toBe(false);
    expect(res.findings.some((f) => f.code === CODE.PATH_CONTAINMENT_VIOLATION)).toBe(true);
  });

  it('rejects git-subdir with non-existent subpath with SOURCE_NOT_EXISTS', async () => {
    const sha = '1111222233334444555566667777888899990000';
    const parsed = parseGitEntrySpec({
      source: 'git-subdir',
      url: 'https://github.com/owner/repo.git',
      path: 'non/existent/path',
      sha,
    });
    expect(parsed.ok).toBe(true);

    const executor = makeMockGitExecutor(fixtureDir, { lsRemoteSha: sha });
    const res = await acquireGitEntry({
      spec: parsed.spec!,
      entryId: '/plugins/0',
      executor,
    });

    expect(res.ok).toBe(false);
    expect(res.findings.some((f) => f.code === CODE.SOURCE_NOT_EXISTS)).toBe(true);
  });
});

describe('Entry Acquisition Engine — Trust Base & Fail-Closed Errors (Acceptance Criteria 4)', () => {
  let fixtureDir: string;

  beforeEach(() => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'entry-trust-fixture-'));
    makeEntryFixture(fixtureDir);
  });

  afterEach(() => {
    try {
      if (existsSync(fixtureDir)) rmSync(fixtureDir, { recursive: true, force: true });
    } catch {}
  });

  it('blocks unknown SSH host key with GIT_TRUST_HOST_KEY_UNKNOWN', async () => {
    const parsed = parseGitEntrySpec({
      source: 'url',
      url: 'ssh://git@github.com/owner/repo.git',
    });
    expect(parsed.ok).toBe(true);

    const executor = makeMockGitExecutor(fixtureDir, { hostKeyError: 'unknown' });
    const res = await acquireGitEntry({
      spec: parsed.spec!,
      entryId: '/plugins/0',
      executor,
    });

    expect(res.ok).toBe(false);
    expect(res.findings.some((f) => f.code === CODE.GIT_TRUST_HOST_KEY_UNKNOWN)).toBe(true);
  });

  it('blocks changed SSH host key with GIT_TRUST_HOST_KEY_CHANGED', async () => {
    const parsed = parseGitEntrySpec({
      source: 'url',
      url: 'ssh://git@github.com/owner/repo.git',
    });
    expect(parsed.ok).toBe(true);

    const executor = makeMockGitExecutor(fixtureDir, { hostKeyError: 'changed' });
    const res = await acquireGitEntry({
      spec: parsed.spec!,
      entryId: '/plugins/0',
      executor,
    });

    expect(res.ok).toBe(false);
    expect(res.findings.some((f) => f.code === CODE.GIT_TRUST_HOST_KEY_CHANGED)).toBe(true);
  });

  it('blocks redirect changing locator with GIT_TRUST_REDIRECT', async () => {
    const parsed = parseGitEntrySpec({
      source: 'url',
      url: 'https://github.com/owner/repo.git',
    });
    expect(parsed.ok).toBe(true);

    const executor = makeMockGitExecutor(fixtureDir, { redirectError: true });
    const res = await acquireGitEntry({
      spec: parsed.spec!,
      entryId: '/plugins/0',
      executor,
    });

    expect(res.ok).toBe(false);
    expect(res.findings.some((f) => f.code === CODE.GIT_TRUST_REDIRECT)).toBe(true);
  });

  it('blocks git clone failure with GIT_ACQUISITION_FAILED', async () => {
    const parsed = parseGitEntrySpec('owner/repo');
    expect(parsed.ok).toBe(true);

    const executor = makeMockGitExecutor(fixtureDir, { cloneError: 'fatal: repository not found' });
    const res = await acquireGitEntry({
      spec: parsed.spec!,
      entryId: '/plugins/0',
      executor,
    });

    expect(res.ok).toBe(false);
    expect(res.findings.some((f) => f.code === CODE.GIT_ACQUISITION_FAILED)).toBe(true);
  });
});

describe('Entry Acquisition Engine — Batch Acquisition & Drift Detection (Acceptance Criteria 3 & 4)', () => {
  let fixtureDir: string;

  beforeEach(() => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'entry-batch-fixture-'));
    makeEntryFixture(fixtureDir);
  });

  afterEach(() => {
    try {
      if (existsSync(fixtureDir)) rmSync(fixtureDir, { recursive: true, force: true });
    } catch {}
  });

  it('acquires multiple git entries in a batch and populates entrySnapshots map (Acceptance Criteria 3)', async () => {
    const entries = [
      { entryId: '/plugins/0', source: 'org/plugin-one' },
      { entryId: '/plugins/1', source: { source: 'url', url: 'https://github.com/org/plugin-two.git', ref: 'main' } },
      { entryId: '/plugins/2', source: { source: 'github', repo: 'org/plugin-three', sha: 'a'.repeat(40) } },
    ];

    const executor = makeMockGitExecutor(fixtureDir);
    const batch = await acquireGitEntries(entries, { executor });

    expect(batch.ok).toBe(true);
    expect(batch.entries.size).toBe(3);
    expect(batch.entrySnapshots['/plugins/0']).toBeDefined();
    expect(batch.entrySnapshots['/plugins/1']).toBeDefined();
    expect(batch.entrySnapshots['/plugins/2']).toBeDefined();
    expect(batch.findings).toEqual([]);

    batch.cleanup();
  });

  it('fails closed when one entry in a batch fails, cleaning up all acquisitions (Acceptance Criteria 4)', async () => {
    const entries = [
      { entryId: '/plugins/0', source: 'org/plugin-one' },
      // Bad entry: embedded credentials
      { entryId: '/plugins/1', source: { source: 'url', url: 'https://user:pass@github.com/bad.git' } },
      { entryId: '/plugins/2', source: 'org/plugin-three' },
    ];

    const executor = makeMockGitExecutor(fixtureDir);
    const batch = await acquireGitEntries(entries, { executor });

    expect(batch.ok).toBe(false);
    expect(batch.entries.size).toBe(0);
    expect(batch.entrySnapshots).toEqual({});
    expect(batch.findings.some((f) => f.code === CODE.GIT_LOCATOR_CREDENTIAL)).toBe(true);
  });

  it('detects per-entry drift when recorded snapshot fingerprint differs from current (Acceptance Criteria 3)', async () => {
    const parsed = parseGitEntrySpec('owner/repo');
    const executor = makeMockGitExecutor(fixtureDir);
    const res = await acquireGitEntry({
      spec: parsed.spec!,
      entryId: '/plugins/0',
      executor,
    });

    expect(res.ok).toBe(true);
    const originalFingerprint = res.snapshot!.fingerprint;

    // No drift when same
    expect(checkEntryDrift(originalFingerprint, originalFingerprint)).toBe(false);

    // Drift detected when recorded differs from current
    const recordedFingerprint = '0'.repeat(64);
    expect(checkEntryDrift(originalFingerprint, recordedFingerprint)).toBe(true);

    if (res.createdTemp && res.acquiredPath) {
      rmSync(res.acquiredPath, { recursive: true, force: true });
    }
  });
});
