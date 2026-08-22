import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SourceCache } from '../../src/cache/source-cache.js';
import { readBridgeState } from '../../src/bridge-state/store.js';
import { refreshRegistration } from '../../src/lifecycle/refresh.js';
import { confirmGitRegistration, preflightGitRegistration } from '../../src/registration/git-flow.js';
import type { GitExecutor } from '../../src/registration/git-acquisition.js';
import type { GitSelectorInput } from '../../src/registration/git-selector.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const OFFLINE_ERR = 'fatal: Could not resolve host: github.com';

function makeEnv() {
  const root = mkdtempSync(join(tmpdir(), 'cache-drift-git-'));
  return {
    root,
    agentDir: join(root, 'agent'),
    projectDir: join(root, 'project'),
    fixture: join(root, 'fixture'),
  };
}

function makeFixture(root: string, opts: { extra?: boolean } = {}): void {
  mkdirSync(join(root, '.agents', 'plugins'), { recursive: true });
  mkdirSync(join(root, 'plugins', 'demo', '.codex-plugin'), { recursive: true });
  mkdirSync(join(root, 'plugins', 'demo', 'skills', 'demo-skill'), { recursive: true });
  writeFileSync(join(root, 'plugins', 'demo', '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'demo', skills: './skills/' }));
  writeFileSync(
    join(root, 'plugins', 'demo', 'skills', 'demo-skill', 'SKILL.md'),
    '---\nname: demo-skill\ndescription: Demo\n---\n\nDemo.\n',
  );
  writeFileSync(
    join(root, '.agents', 'plugins', 'marketplace.json'),
    JSON.stringify({ name: 'demo-marketplace', plugins: [{ name: 'demo', path: './plugins/demo' }] }),
  );
  if (opts.extra) {
    mkdirSync(join(root, 'plugins', 'demo', 'skills', 'extra-skill'), { recursive: true });
    writeFileSync(
      join(root, 'plugins', 'demo', 'skills', 'extra-skill', 'SKILL.md'),
      '---\nname: extra-skill\ndescription: Extra\n---\n\nExtra.\n',
    );
  }
}

interface Counters { clones: number }

function makeExecutor(fixtureRoot: string, sha: string, counters?: Counters, offline = false): GitExecutor {
  return async (args) => {
    if (args.includes('ls-remote')) {
      if (offline) return { exitCode: 128, stdout: '', stderr: OFFLINE_ERR };
      const ref = args[args.length - 1];
      return { exitCode: 0, stdout: `${sha}\t${ref}\n`, stderr: '' };
    }
    if (args.includes('clone')) {
      if (offline) return { exitCode: 128, stdout: '', stderr: OFFLINE_ERR };
      if (counters) counters.clones += 1;
      const dest = args[args.length - 1];
      cpSync(fixtureRoot, dest, { recursive: true });
      mkdirSync(join(dest, '.git'), { recursive: true });
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
}

describe('Source Cache + Source Drift — Git lifecycle (#22)', () => {
  let env: ReturnType<typeof makeEnv>;
  let counters: Counters;

  beforeEach(() => {
    env = makeEnv();
    makeFixture(env.fixture);
    counters = { clones: 0 };
  });

  afterEach(() => rmSync(env.root, { recursive: true, force: true }));

  async function register(sha: string): Promise<string> {
    const opts = { agentDir: env.agentDir, cwd: env.projectDir, executor: makeExecutor(env.fixture, sha, counters) };
    const preflight = await preflightGitRegistration('global', 'https://github.com/acme/plugins.git', { kind: 'branch', value: 'main' }, opts);
    expect(preflight.ok).toBe(true);
    if (!preflight.ok) throw new Error('preflight failed');
    const confirmed = await confirmGitRegistration(preflight.preflight, true, opts);
    expect(confirmed.status).toBe('completed');
    return confirmed.status === 'completed' ? confirmed.registration.id : '';
  }

  it('registration populates the fingerprint-addressed cache and index', async () => {
    const registrationId = await register(SHA_A);
    const state = await readBridgeState('global', { agentDir: env.agentDir, cwd: env.projectDir });
    const fingerprint = state.state!.registrations[0].validationSnapshot!;
    const cache = new SourceCache({ agentDir: env.agentDir });
    const hit = await cache.hitExact(fingerprint);
    expect(hit).not.toBeNull();
    expect(existsSync(join(hit!.path, '.agents', 'plugins', 'marketplace.json'))).toBe(true);
    const rec = cache.readIndex()['https://github.com/acme/plugins.git\u001frefs/heads/main'];
    expect(rec?.fingerprint).toBe(fingerprint);
    void registrationId;
  });

  it('a same-revision refresh hits the cache without any clone (p50 path)', async () => {
    const registrationId = await register(SHA_A);
    expect(counters.clones).toBeGreaterThanOrEqual(1);

    // Second refresh at the same Resolved Revision: served entirely from cache.
    const secondCounters: Counters = { clones: 0 };
    const start = Date.now();
    const outcome = await refreshRegistration('global', registrationId, {
      agentDir: env.agentDir,
      cwd: env.projectDir,
      executor: makeExecutor(env.fixture, SHA_A, secondCounters),
    });
    const elapsed = Date.now() - start;
    expect(outcome.status).toBe('no-change');
    expect(secondCounters.clones).toBe(0);
    // Exact-fingerprint hit path stays well under the 200ms p50 budget on fixture trees.
    expect(elapsed).toBeLessThan(200);
  });

  it('an offline refresh reuses only the exact fingerprint hit and never mutates state', async () => {
    const registrationId = await register(SHA_A);
    const before = await readBridgeState('global', { agentDir: env.agentDir, cwd: env.projectDir });

    const outcome = await refreshRegistration('global', registrationId, {
      agentDir: env.agentDir,
      cwd: env.projectDir,
      executor: makeExecutor(env.fixture, SHA_A, undefined, true),
    });

    expect(outcome.status).toBe('no-change');
    if (outcome.status !== 'no-change') return;
    expect(outcome.receipt.stateChanged).toBe(false);
    const after = await readBridgeState('global', { agentDir: env.agentDir, cwd: env.projectDir });
    expect(after.state!.stateRevision).toBe(before.state!.stateRevision);
  });

  it('a tampered cached tree offline is Source Drift — Blocking Finding, never success', async () => {
    const registrationId = await register(SHA_A);
    const state = await readBridgeState('global', { agentDir: env.agentDir, cwd: env.projectDir });
    const fingerprint = state.state!.registrations[0].validationSnapshot!;
    const before = await readBridgeState('global', { agentDir: env.agentDir, cwd: env.projectDir });

    // External tampering of the local cached tree.
    writeFileSync(
      join(new SourceCache({ agentDir: env.agentDir }).entryPath(fingerprint), 'plugins', 'demo', 'skills', 'demo-skill', 'SKILL.md'),
      '---\nname: demo-skill\ndescription: drifted\n---\n\ndrifted.\n',
    );

    const outcome = await refreshRegistration('global', registrationId, {
      agentDir: env.agentDir,
      cwd: env.projectDir,
      executor: makeExecutor(env.fixture, SHA_A, undefined, true),
    });

    expect(outcome.status).toBe('blocked');
    if (outcome.status !== 'blocked') return;
    expect(outcome.findings.map((f) => f.code)).toContain('SOURCE_DRIFT');
    expect(outcome.findings[0].rule).toBe('DRIFT-01');
    expect(outcome.receipt.summary).toBe('Blocked');
    const after = await readBridgeState('global', { agentDir: env.agentDir, cwd: env.projectDir });
    expect(after.state!.stateRevision).toBe(before.state!.stateRevision);
    expect(after.state!.registrations[0].validationSnapshot).toBe(fingerprint);
  });

  it('pins an Update Candidate fingerprint so LRU pruning never evicts it', async () => {
    const registrationId = await register(SHA_A);

    // Upstream advances.
    makeFixture(env.fixture, { extra: true });
    const outcome = await refreshRegistration('global', registrationId, {
      agentDir: env.agentDir,
      cwd: env.projectDir,
      executor: makeExecutor(env.fixture, SHA_B, counters),
    });
    expect(outcome.status).toBe('update-candidate');
    if (outcome.status !== 'update-candidate') return;

    const cache = new SourceCache({ agentDir: env.agentDir });
    const pending = cache.pendingUpdates().filter((r) => r.registrationId === registrationId);
    expect(pending.map((r) => r.fingerprint)).toEqual([outcome.candidate.snapshot.fingerprint]);
    // Candidate tree is cached under its fingerprint.
    expect(await cache.hitExact(outcome.candidate.snapshot.fingerprint)).not.toBeNull();
    // Pruning (even forced) keeps the pending candidate.
    await cache.prune();
    expect(await cache.hitExact(outcome.candidate.snapshot.fingerprint)).not.toBeNull();
  });
});
