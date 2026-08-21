import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  realpathSync,
  openSync,
  closeSync,
  unlinkSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';

import {
  preflightLocalRegistration,
  confirmLocalRegistration,
  cancelLocalRegistration,
} from '../../src/registration/flow.js';
import { readBridgeState } from '../../src/bridge-state/store.js';
import { getStatePath } from '../../src/bridge-state/paths.js';

function makeEnv() {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'reg-integ-'));
  const agentDir = join(tmpRoot, 'agent');
  const projectDir = join(tmpRoot, 'project');
  return { tmpRoot, agentDir, projectDir };
}

function makeMarketplace(root: string) {
  mkdirSync(join(root, '.agents', 'plugins'), { recursive: true });
  mkdirSync(join(root, 'plugins', 'demo'), { recursive: true });
  writeFileSync(join(root, 'plugins', 'demo', 'plugin.json'), '{"name":"demo"}');
  writeFileSync(
    join(root, '.agents', 'plugins', 'marketplace.json'),
    JSON.stringify({ name: 'demo-marketplace', plugins: [{ name: 'demo', path: './plugins/demo' }] }),
  );
}

const CHILD = `
const fs = require('node:fs');
const path = require('node:path');
const agentDir = process.argv[1];
const holdMs = process.argv[2];
const statePath = path.join(agentDir, 'codex-marketplace', 'state.json');
const fencePath = statePath + '.fence';
fs.mkdirSync(path.dirname(fencePath), { recursive: true });
try {
  const fd = fs.openSync(fencePath, 'wx', 0o600);
  console.log('acquired');
  setTimeout(() => { fs.closeSync(fd); fs.unlinkSync(fencePath); }, Number(holdMs));
} catch (e) {
  console.log('denied:' + e.code);
  process.exit(0);
}
`;

function holdFenceInChild(agentDir: string, holdMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['-e', CHILD, agentDir, String(holdMs)],
      { timeout: 15000 },
      (err, stdout, stderr) => {
        if (err) reject(err);
        else resolve(stdout.trim());
      },
    );
  });
}

describe('Local Marketplace Registration integration (fence + atomic persistence)', () => {
  let env: ReturnType<typeof makeEnv>;
  let root: string;

  beforeEach(() => {
    env = makeEnv();
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'mkt-int-')));
    makeMarketplace(root);
  });
  afterEach(() => {
    try {
      rmSync(env.tmpRoot, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    } catch {}
  });

  it('commits under the Attempt Fence with a bumped, persisted State Revision', async () => {
    const opts = { agentDir: env.agentDir, cwd: env.projectDir, fenceTimeoutMs: 500 };
    const pf = await preflightLocalRegistration('global', root, opts);
    expect(pf.ok).toBe(true);
    if (!pf.ok) return;

    const outcome = await confirmLocalRegistration(pf.preflight, true, opts);
    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') return;

    // fresh read from a *second* process perspective: revision persisted atomically
    const state = await readBridgeState('global', { agentDir: env.agentDir, cwd: env.projectDir });
    expect(state.status).toBe('ok');
    expect(state.state!.stateRevision).toBe('1');
    expect(state.state!.registrations).toHaveLength(1);
    const reg = state.state!.registrations[0];
    expect(reg.sourceKey!.kind).toBe('local');
    expect(reg.validationSnapshot).toMatch(/^[0-9a-f]{64}$/);
    // fence released after terminal outcome: a fresh attempt on a *different* root succeeds
    const otherRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'mkt-int2-')));
    try {
      makeMarketplace(otherRoot);
      const pf2 = await preflightLocalRegistration('global', otherRoot, { ...opts, fenceTimeoutMs: 500 });
      expect(pf2.ok).toBe(true);
      if (pf2.ok) cancelLocalRegistration(pf2.preflight);
    } finally {
      try {
        rmSync(otherRoot, { recursive: true, force: true });
      } catch {}
    }
  });

  it('blocks a second PROCESS holding the scope fence (ATTEMPT_IN_PROGRESS)', async () => {
    const opts = { agentDir: env.agentDir, cwd: env.projectDir, fenceTimeoutMs: 500 };
    const first = await preflightLocalRegistration('global', root, opts);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // a child process attempting the same scope is denied
    const childOut = await holdFenceInChild(env.agentDir, 2000);
    expect(childOut).toBe('denied:EEXIST');

    // after cancel, the same child protocol can acquire
    cancelLocalRegistration(first.preflight);
    const childOut2 = await holdFenceInChild(env.agentDir, 200);
    expect(childOut2).toBe('acquired');
  });

  it('fail-closed on corrupted state: preflight yields Persistence Indeterminate, state untouched', async () => {
    const statePath = getStatePath('global', { agentDir: env.agentDir, cwd: env.projectDir });
    mkdirSync(join(env.agentDir, 'codex-marketplace'), { recursive: true });
    writeFileSync(statePath, '{ corrupted', 'utf-8');

    const res = await preflightLocalRegistration('global', root, { agentDir: env.agentDir, cwd: env.projectDir });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.outcome.status).toBe('persistence-failed');
    if (res.outcome.status !== 'persistence-failed') return;
    expect(res.outcome.isIndeterminate).toBe(true);
    expect(res.outcome.receipt.summary).toBe('Persistence Indeterminate');

    // still corrupted — no auto-rollback
    const statePathExists = existsSync(statePath);
    expect(statePathExists).toBe(true);
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(statePath, 'utf-8')).toBe('{ corrupted');
    // fence was never acquired (no cleanup needed); no stray lock files
    expect(existsSync(`${statePath}.fence`)).toBe(false);
  });
});