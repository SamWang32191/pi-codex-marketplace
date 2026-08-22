import { mkdirSync, mkdtempSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readBridgeState } from '../../src/bridge-state/store.js';
import { refreshRegistration } from '../../src/lifecycle/refresh.js';
import { confirmGitRegistration, preflightGitRegistration } from '../../src/registration/git-flow.js';
import type { GitExecutor } from '../../src/registration/git-acquisition.js';
import type { GitSelectorInput } from '../../src/registration/git-selector.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function makeEnv() {
  const root = mkdtempSync(join(tmpdir(), 'lifecycle-refresh-git-'));
  return {
    root,
    agentDir: join(root, 'agent'),
    projectDir: join(root, 'project'),
    fixture: join(root, 'fixture'),
  };
}

function makeFixture(root: string, opts: { extra?: boolean } = {}) {
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
    // Upstream moved: a second skill joins the Plugin at the new revision.
    mkdirSync(join(root, 'plugins', 'demo', 'skills', 'extra-skill'), { recursive: true });
    writeFileSync(
      join(root, 'plugins', 'demo', 'skills', 'extra-skill', 'SKILL.md'),
      '---\nname: extra-skill\ndescription: Extra\n---\n\nExtra.\n',
    );
  }
}

function makeMockExecutor(fixtureRoot: string, lsRemoteSha: string): GitExecutor {
  return async (args) => {
    if (args.includes('ls-remote')) {
      const ref = args[args.length - 1];
      return { exitCode: 0, stdout: `${lsRemoteSha}\t${ref}\n`, stderr: '' };
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

describe('Marketplace Refresh — Git Resolved Revision binding', () => {
  let env: ReturnType<typeof makeEnv>;

  beforeEach(() => {
    env = makeEnv();
  });

  afterEach(() => rmSync(env.root, { recursive: true, force: true }));

  async function register(selector: GitSelectorInput, sha: string) {
    const opts = { agentDir: env.agentDir, cwd: env.projectDir, executor: makeMockExecutor(env.fixture, sha) };
    const preflight = await preflightGitRegistration('global', 'https://github.com/acme/plugins.git', selector, opts);
    expect(preflight.ok).toBe(true);
    if (!preflight.ok) throw new Error(`preflight failed: ${'findings' in preflight.outcome ? preflight.outcome.findings.map((f) => f.outcome).join('; ') : preflight.outcome.receipt.summary}`);
    const confirmed = await confirmGitRegistration(preflight.preflight, true, opts);
    expect(confirmed.status).toBe('completed');
    if (confirmed.status !== 'completed') throw new Error('confirm failed');
    return { registrationId: confirmed.registration.id, opts };
  }

  it('reports no change while the Resolved Revision is unchanged', async () => {
    makeFixture(env.fixture);
    const { registrationId, opts } = await register({ kind: 'branch', value: 'main' }, SHA_A);

    const outcome = await refreshRegistration('global', registrationId, opts);

    expect(outcome.status).toBe('no-change');
    if (outcome.status !== 'no-change') return;
    expect(outcome.receipt.stateChanged).toBe(false);
    const state = await readBridgeState('global', opts);
    expect(state.state!.registrations[0].resolvedRevision).toBe(SHA_A);
  });

  it('produces an Update Candidate when the branch resolves to a new Resolved Revision', async () => {
    makeFixture(env.fixture);
    const { registrationId, opts } = await register({ kind: 'branch', value: 'main' }, SHA_A);
    const before = await readBridgeState('global', opts);

    // Upstream advances and its tree changes.
    makeFixture(env.fixture, { extra: true });
    const outcome = await refreshRegistration('global', registrationId, { ...opts, executor: makeMockExecutor(env.fixture, SHA_B) });

    expect(outcome.status).toBe('update-candidate');
    if (outcome.status !== 'update-candidate') return;
    expect(outcome.candidate.resolvedRevision).toBe(SHA_B);
    expect(outcome.candidate.recordedResolvedRevision).toBe(SHA_A);
    expect(outcome.candidate.snapshot.resolvedRevision).toBe(SHA_B);
    expect(outcome.candidate.snapshot.fingerprint).not.toBe(before.state!.registrations[0].validationSnapshot);
    // Non-mutating.
    const after = await readBridgeState('global', opts);
    expect(after.state!.stateRevision).toBe(before.state!.stateRevision);
    expect(after.state!.registrations[0].resolvedRevision).toBe(SHA_A);
  });

  it('never produces a Candidate from ref movement alone under a full-commit selector', async () => {
    makeFixture(env.fixture, { extra: false });
    const { registrationId, opts } = await register({ kind: 'commit', value: SHA_A }, SHA_A);

    // The branch tip moves to SHA_B and the tree changes — but the selector pins SHA_A.
    makeFixture(env.fixture, { extra: true });
    const outcome = await refreshRegistration('global', registrationId, { ...opts, executor: makeMockExecutor(env.fixture, SHA_B) });

    expect(outcome.status).toBe('no-change');
    const state = await readBridgeState('global', opts);
    expect(state.state!.registrations[0].resolvedRevision).toBe(SHA_A);
  });
});
