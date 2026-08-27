import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, cpSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  preflightGitRegistration,
  confirmGitRegistration,
  cancelGitRegistration,
  disclosureSummaryGit,
} from '../../../src/registration/git-flow.js';
import { readBridgeState } from '../../../src/bridge-state/store.js';
import { commitBridgeState } from '../../../src/bridge-state/store.js';
import type { GitExecutor } from '../../../src/registration/git-acquisition.js';

type Env = { agentDir: string; tmpRoot: string };

function makeEnv(): Env {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'git-flow-'));
  return { agentDir: join(tmpRoot, 'agent'), tmpRoot };
}

function makeMarketplace(root: string, name = 'acme-marketplace', plugins: Record<string, string> = { 'release-helper': './plugins/release-helper' }) {
  mkdirSync(join(root, '.agents', 'plugins'), { recursive: true });
  for (const [pname, path] of Object.entries(plugins)) {
    mkdirSync(join(root, 'plugins', pname), { recursive: true });
    writeFileSync(join(root, 'plugins', pname, 'plugin.json'), JSON.stringify({ name: pname }));
    writeFileSync(join(root, 'plugins', pname, 'SKILL.md'), '# ' + pname);
  }
  writeFileSync(
    join(root, '.agents', 'plugins', 'marketplace.json'),
    JSON.stringify({ name, plugins: Object.entries(plugins).map(([pname, path]) => ({ name: pname, path })) }, null, 2),
  );
}

function makeMockExecutor(fixtureRoot: string, opts: { sha?: string; hostKeyError?: 'unknown' | 'changed'; redirectError?: boolean } = {}): GitExecutor {
  const sha = opts.sha ?? 'a'.repeat(40);
  return async (args) => {
    const joined = args.join(' ');
    if (args.includes('ls-remote')) {
      if (opts.hostKeyError) {
        const msg = opts.hostKeyError === 'changed' ? 'Offending ECDSA key' : 'Host key verification failed.';
        return { exitCode: 1, stdout: '', stderr: msg };
      }
      if (opts.redirectError) {
        return { exitCode: 1, stdout: '', stderr: 'redirect ... http.followRedirects=false' };
      }
      const ref = args[args.length - 1];
      return { exitCode: 0, stdout: `${sha}\t${ref}\n`, stderr: '' };
    }
    if (args.includes('clone')) {
      if (opts.hostKeyError) {
        return { exitCode: 1, stdout: '', stderr: 'Host key verification failed.' };
      }
      if (opts.redirectError) {
        return { exitCode: 1, stdout: '', stderr: 'redirect' };
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

function gitOpts(env: Env, executor: GitExecutor, extra: Record<string, unknown> = {}) {
  return { agentDir: env.agentDir, fenceTimeoutMs: 300, executor, ...extra };
}

describe('Git Marketplace Registration flow', () => {
  let env: Env;
  let fixture: string;
  const locator = 'https://github.com/owner/repo';
  const selectorBranch = { kind: 'branch' as const, value: 'main' };

  beforeEach(() => {
    env = makeEnv();
    const tmp = mkdtempSync(join(tmpdir(), 'mkt-git-fixture-'));
    fixture = realpathSync(tmp);
    makeMarketplace(fixture);
  });
  afterEach(() => {
    try { rmSync(env.tmpRoot, { recursive: true, force: true }); } catch {}
    try { rmSync(fixture, { recursive: true, force: true }); } catch {}
  });

  it('preflight produces Validation Disclosure with canonical locator, selector canonical, and resolved revision', async () => {
    const exec = makeMockExecutor(fixture, { sha: 'b'.repeat(40) });
    const res = await preflightGitRegistration(locator, selectorBranch, gitOpts(env, exec, { preallocatedId: '11111111-1111-4111-8111-111111111111' }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const pf = res.preflight;
    expect(pf.locator.canonicalUrl).toBe('https://github.com/owner/repo');
    expect(pf.selector.canonical).toBe('refs/heads/main');
    expect(pf.resolvedRevision).toBe('b'.repeat(40));
    expect(pf.sourceKey.kind).toBe('git');
    expect(pf.sourceKey.key).toBe(`git:${pf.locator.canonicalUrl}#${pf.selector.canonical}`);
    expect(pf.snapshot.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(pf.snapshot.canonicalLocator).toBe(pf.locator.canonicalUrl);
    expect(pf.snapshot.resolvedRevision).toBe(pf.resolvedRevision);
    const summary = disclosureSummaryGit(pf);
    expect(summary).toContain('Canonical Locator: https://github.com/owner/repo');
    expect(summary).toContain('Git Selector: branch → refs/heads/main');
    expect(summary).toContain(`Resolved Revision: ${'b'.repeat(40)}`);
    expect(summary).toContain('State Revision: 0');
    expect(summary).toContain('Validation Snapshot');
    cancelGitRegistration(pf);
  });

  it('accepts scp-like locator and normalizes to ssh canonical', async () => {
    const exec = makeMockExecutor(fixture);
    const res = await preflightGitRegistration('git@github.com:owner/repo.git', selectorBranch, gitOpts(env, exec));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.preflight.locator.canonicalUrl).toBe('ssh://git@github.com/owner/repo.git');
    expect(res.preflight.locator.transport).toBe('ssh');
    cancelGitRegistration(res.preflight);
  });

  it('normalizes tag and commit selectors correctly', async () => {
    const execTag = makeMockExecutor(fixture, { sha: 'c'.repeat(40) });
    const tagRes = await preflightGitRegistration(locator, { kind: 'tag', value: 'v1.0.0' }, gitOpts(env, execTag));
    expect(tagRes.ok).toBe(true);
    if (tagRes.ok) {
      expect(tagRes.preflight.selector.canonical).toBe('refs/tags/v1.0.0');
      cancelGitRegistration(tagRes.preflight);
    }

    const execCommit = makeMockExecutor(fixture, { sha: 'd'.repeat(40) });
    const commitSha = 'ABCDEF1234567890ABCDEF1234567890ABCDEF12';
    const commitRes = await preflightGitRegistration(locator, { kind: 'commit', value: commitSha }, gitOpts(env, execCommit));
    expect(commitRes.ok).toBe(true);
    if (commitRes.ok) {
      expect(commitRes.preflight.selector.canonical).toBe(commitSha.toLowerCase());
      expect(commitRes.preflight.resolvedRevision).toBe(commitSha.toLowerCase());
      cancelGitRegistration(commitRes.preflight);
    }
  });

  it('rejects invalid locator (plaintext http) with GIT_LOCATOR_PLAINTEXT', async () => {
    const exec = makeMockExecutor(fixture);
    const res = await preflightGitRegistration('http://github.com/owner/repo', selectorBranch, gitOpts(env, exec));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.outcome.status).toBe('blocked');
    if (res.outcome.status !== 'blocked') return;
    expect(res.outcome.findings[0].code).toBe('GIT_LOCATOR_PLAINTEXT');
  });

  it('rejects invalid locator with embedded credentials', async () => {
    const exec = makeMockExecutor(fixture);
    const res = await preflightGitRegistration('https://user:pass@github.com/owner/repo', selectorBranch, gitOpts(env, exec));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.outcome.status).toBe('blocked');
    if (res.outcome.status !== 'blocked') return;
    expect(res.outcome.findings[0].code).toBe('GIT_LOCATOR_CREDENTIAL');
  });

  it('rejects locator with query/fragment', async () => {
    const exec = makeMockExecutor(fixture);
    const res = await preflightGitRegistration('https://github.com/owner/repo?foo=bar', selectorBranch, gitOpts(env, exec));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.outcome.status).toBe('blocked');
    if (res.outcome.status !== 'blocked') return;
    expect(res.outcome.findings[0].code).toBe('GIT_LOCATOR_QUERY_FRAGMENT');
  });

  it('rejects invalid selector (abbreviated commit)', async () => {
    const exec = makeMockExecutor(fixture);
    const res = await preflightGitRegistration(locator, { kind: 'commit', value: 'abc123' }, gitOpts(env, exec));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.outcome.status).toBe('blocked');
    if (res.outcome.status !== 'blocked') return;
    expect(res.outcome.findings[0].code).toBe('GIT_SELECTOR_COMMIT_INVALID');
  });

  it('rejects selector with HEAD', async () => {
    const exec = makeMockExecutor(fixture);
    const res = await preflightGitRegistration(locator, { kind: 'branch', value: 'HEAD' }, gitOpts(env, exec));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.outcome.status).toBe('blocked');
    if (res.outcome.status !== 'blocked') return;
    expect(res.outcome.findings[0].code).toBe('GIT_SELECTOR_INVALID');
  });

  it('rejects selector with whitespace', async () => {
    const exec = makeMockExecutor(fixture);
    const res = await preflightGitRegistration(locator, { kind: 'branch', value: 'main ' }, gitOpts(env, exec));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.outcome.status).toBe('blocked');
    if (res.outcome.status !== 'blocked') return;
    expect(res.outcome.findings[0].code).toBe('GIT_SELECTOR_INVALID');
  });

  it('blocks Acquisition Trust Base violation: unknown host key', async () => {
    const exec = makeMockExecutor(fixture, { hostKeyError: 'unknown' });
    const res = await preflightGitRegistration('ssh://git@github.com/owner/repo', selectorBranch, gitOpts(env, exec));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.outcome.status).toBe('blocked');
    if (res.outcome.status !== 'blocked') return;
    expect(res.outcome.findings[0].code).toBe('GIT_TRUST_HOST_KEY_UNKNOWN');
  });

  it('blocks Acquisition Trust Base violation: redirect changing locator', async () => {
    const exec = makeMockExecutor(fixture, { redirectError: true });
    const res = await preflightGitRegistration(locator, selectorBranch, gitOpts(env, exec));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.outcome.status).toBe('blocked');
    if (res.outcome.status !== 'blocked') return;
    expect(res.outcome.findings[0].code).toBe('GIT_TRUST_REDIRECT');
  });

  it('confirmation yes commits atomically, bumps State Revision, and returns Completed receipt with git fields', async () => {
    const exec = makeMockExecutor(fixture, { sha: 'e'.repeat(40) });
    const res = await preflightGitRegistration(locator, selectorBranch, gitOpts(env, exec));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const outcome = await confirmGitRegistration(res.preflight, true, gitOpts(env, exec));
    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') return;
    expect(outcome.newRevision).toBe('1');
    expect(outcome.registration.sourceKind).toBe('git');
    expect(outcome.registration.canonicalLocator).toBe('https://github.com/owner/repo');
    expect(outcome.registration.gitSelector!.canonical).toBe('refs/heads/main');
    expect(outcome.registration.resolvedRevision).toBe('e'.repeat(40));
    expect(outcome.registration.sourceKey!.key).toBe(`git:https://github.com/owner/repo#refs/heads/main`);
    expect(outcome.receipt.summary).toBe('Completed');
    expect(outcome.receipt.observedStateRevision).toBe('1');

    const state = await readBridgeState({ agentDir: env.agentDir });
    expect(state.status).toBe('ok');
    expect(state.state!.registrations[0].sourceKind).toBe('git');
    expect(state.state!.registrations[0].canonicalLocator).toBe('https://github.com/owner/repo');
  });

  it('confirmation no declines without mutating state', async () => {
    const exec = makeMockExecutor(fixture);
    const res = await preflightGitRegistration(locator, selectorBranch, gitOpts(env, exec));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const outcome = await confirmGitRegistration(res.preflight, false, gitOpts(env, exec));
    expect(outcome.status).toBe('declined');
    if (outcome.status !== 'declined') return;
    expect(outcome.receipt.summary).toBe('Declined');
    const state = await readBridgeState({ agentDir: env.agentDir });
    expect(state.state!.registrations).toHaveLength(0);
  });

  it('detects duplicate git Source Key (same canonicalUrl + exact selector) and directs to existing', async () => {
    const exec1 = makeMockExecutor(fixture, { sha: 'a'.repeat(40) });
    const first = await preflightGitRegistration(locator, selectorBranch, gitOpts(env, exec1, { preallocatedId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect((await confirmGitRegistration(first.preflight, true, gitOpts(env, exec1))).status).toBe('completed');

    const exec2 = makeMockExecutor(fixture, { sha: 'a'.repeat(40) });
    const second = await preflightGitRegistration(locator, selectorBranch, gitOpts(env, exec2, { preallocatedId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }));
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.outcome.status).toBe('blocked');
    if (second.outcome.status !== 'blocked') return;
    expect(second.outcome.findings[0].code).toBe('DUPLICATE_SOURCE_KEY');
    expect(second.outcome.existing?.id).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  });

  it('allows same git locator with different selector (different Source Key)', async () => {
    const exec1 = makeMockExecutor(fixture, { sha: 'a'.repeat(40) });
    const first = await preflightGitRegistration(locator, { kind: 'branch', value: 'main' }, gitOpts(env, exec1));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect((await confirmGitRegistration(first.preflight, true, gitOpts(env, exec1))).status).toBe('completed');

    const exec2 = makeMockExecutor(fixture, { sha: 'b'.repeat(40) });
    const second = await preflightGitRegistration(locator, { kind: 'branch', value: 'dev' }, gitOpts(env, exec2));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect((await confirmGitRegistration(second.preflight, true, gitOpts(env, exec2))).status).toBe('completed');
    const state = await readBridgeState({ agentDir: env.agentDir });
    expect(state.state!.registrations).toHaveLength(2);
  });

  it('git and local Source Keys are mutually exclusive (not duplicates)', async () => {
    // Create a local registration
    const localRoot = mkdtempSync(join(tmpdir(), 'local-root-'));
    try {
      makeMarketplace(localRoot, 'demo-marketplace');
      const { preflightLocalRegistration, confirmLocalRegistration } = await import('../../../src/registration/flow.js');
      const localRes = await preflightLocalRegistration(localRoot, { agentDir: env.agentDir, fenceTimeoutMs: 300 });
      expect(localRes.ok).toBe(true);
      if (localRes.ok) {
        const out = await confirmLocalRegistration(localRes.preflight, true, { agentDir: env.agentDir });
        expect(out.status).toBe('completed');
      }

      // Git with same path content but git source key should not be considered duplicate
      const exec = makeMockExecutor(fixture);
      const gitRes = await preflightGitRegistration(locator, selectorBranch, gitOpts(env, exec));
      expect(gitRes.ok).toBe(true);
      if (gitRes.ok) {
        expect((await confirmGitRegistration(gitRes.preflight, true, gitOpts(env, exec))).status).toBe('completed');
      }
      const state = await readBridgeState({ agentDir: env.agentDir });
      expect(state.state!.registrations).toHaveLength(2);
      const kinds = state.state!.registrations.map((r) => r.sourceKind).sort();
      expect(kinds).toEqual(['git', 'local']);
    } finally {
      try { rmSync(localRoot, { recursive: true, force: true }); } catch {}
    }
  });

  
  it('rejects confirmation as Stale when State Revision changed', async () => {
    const exec = makeMockExecutor(fixture);
    const res = await preflightGitRegistration(locator, selectorBranch, gitOpts(env, exec));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    await commitBridgeState((c) => ({ ...c, registrations: [...c.registrations, { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', alias: 'other' }] }), { agentDir: env.agentDir });
    const outcome = await confirmGitRegistration(res.preflight, true, gitOpts(env, exec));
    expect(outcome.status).toBe('rejected-as-stale');
  });

  it('blocks a concurrent same-scope attempt with ATTEMPT_IN_PROGRESS', async () => {
    const exec1 = makeMockExecutor(fixture);
    const a = await preflightGitRegistration(locator, selectorBranch, gitOpts(env, exec1));
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const exec2 = makeMockExecutor(fixture);
    const b = await preflightGitRegistration(locator, selectorBranch, gitOpts(env, exec2, { fenceTimeoutMs: 100 }));
    expect(b.ok).toBe(false);
    if (b.ok) return;
    expect(b.outcome.status).toBe('blocked');
    if (b.outcome.status !== 'blocked') return;
    expect(b.outcome.findings[0].code).toBe('ATTEMPT_IN_PROGRESS');
    cancelGitRegistration(a.preflight);
    const exec3 = makeMockExecutor(fixture);
    const c = await preflightGitRegistration(locator, selectorBranch, gitOpts(env, exec3));
    expect(c.ok).toBe(true);
    if (c.ok) cancelGitRegistration(c.preflight);
  });

  
  it('fails when catalog missing after acquisition', async () => {
    const emptyFixture = mkdtempSync(join(tmpdir(), 'empty-git-'));
    try {
      const exec = makeMockExecutor(emptyFixture);
      const res = await preflightGitRegistration(locator, selectorBranch, gitOpts(env, exec));
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.outcome.status).toBe('blocked');
      if (res.outcome.status !== 'blocked') return;
      expect(res.outcome.findings[0].code).toBe('CATALOG_MISSING');
    } finally {
      try { rmSync(emptyFixture, { recursive: true, force: true }); } catch {}
    }
  });
});

describe('Marketplace Format detection wiring — git registration', () => {
  let env: ReturnType<typeof makeEnv>;
  let fixture: string;
  const locator = 'https://github.com/mattpocock/skills';

  beforeEach(() => {
    env = makeEnv();
    fixture = realpathSync(mkdtempSync(join(tmpdir(), 'mkt-git-claude-')));
    // claude-only repo: `.claude-plugin/` catalogs with a manifest-backed plugin
    mkdirSync(join(fixture, '.claude-plugin'), { recursive: true });
    const pluginRoot = join(fixture, 'plugins', 'mattpocock-skills');
    mkdirSync(join(pluginRoot, '.claude-plugin'), { recursive: true });
    mkdirSync(join(pluginRoot, 'skills', 'engineering', 'code-review'), { recursive: true });
    writeFileSync(
      join(pluginRoot, 'skills', 'engineering', 'code-review', 'SKILL.md'),
      '---\nname: code-review\ndescription: Review code changes\n---\n\nReview code.\n',
    );
    writeFileSync(
      join(pluginRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'mattpocock-skills', skills: ['./skills/engineering/code-review'] }),
    );
    writeFileSync(
      join(fixture, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'mattpocock-marketplace',
        owner: { name: 'Matt Pocock' },
        plugins: [{ name: 'mattpocock-skills', source: './plugins/mattpocock-skills' }],
      }),
    );
  });
  afterEach(() => {
    try { rmSync(env.tmpRoot, { recursive: true, force: true }); } catch {}
    try { rmSync(fixture, { recursive: true, force: true }); } catch {}
  });

  it('registers an acquired claude-only repo and fixes format=claude onto the Registration', async () => {
    const exec = makeMockExecutor(fixture, { sha: 'f'.repeat(40) });
    const res = await preflightGitRegistration(locator, { kind: 'branch', value: 'main' }, gitOpts(env, exec));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.preflight.format).toBe('claude');
    expect(disclosureSummaryGit(res.preflight)).toContain('Marketplace Format: claude');

    const outcome = await confirmGitRegistration(res.preflight, true, gitOpts(env, exec));
    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') return;
    expect(outcome.registration.format).toBe('claude');
    expect(outcome.receipt.marketplaceFormat).toBe('claude');

    const state = await readBridgeState({ agentDir: env.agentDir });
    expect(state.state!.registrations[0].format).toBe('claude');
    expect(state.state!.registrations[0].canonicalLocator).toBe(locator);
  });

  it('keeps CATALOG_MISSING unchanged when the acquired repo has neither catalog', async () => {
    const emptyFixture = realpathSync(mkdtempSync(join(tmpdir(), 'empty-git-claude-')));
    try {
      const exec = makeMockExecutor(emptyFixture);
      const res = await preflightGitRegistration(locator, { kind: 'branch', value: 'main' }, gitOpts(env, exec));
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.outcome.status).toBe('blocked');
      if (res.outcome.status !== 'blocked') return;
      expect(res.outcome.findings[0].code).toBe('CATALOG_MISSING');
    } finally {
      try { rmSync(emptyFixture, { recursive: true, force: true }); } catch {}
    }
  });
});
