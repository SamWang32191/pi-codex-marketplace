/**
 * E2E — /codex-marketplace single Global partition
 * Verifies externally observable behavior: with no registrations, the Bridge State is a single
 * empty Global document; commits bump its revision monotonically; corrupted bytes stay closed.
 *
 * D2 (Global-only #61): the legacy project state file ({cwd}/.pi/codex-marketplace/state.json)
 * is never read, never prompted about, and never deleted — it must remain byte-identical and
 * invisible to every store read.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readBridgeState, readBridgeStateSync, commitBridgeState } from '../../src/bridge-state/store.js';

function makeEnv() {
  const root = mkdtempSync(join(tmpdir(), 'bridge-e2e-'));
  return { root, agentDir: join(root, 'agent'), cwd: join(root, 'project') };
}

describe('E2E — single-partition Bridge State for /codex-marketplace', () => {
  let env: ReturnType<typeof makeEnv>;

  beforeEach(() => {
    env = makeEnv();
  });

  afterEach(() => {
    try {
      rmSync(env.root, { recursive: true, force: true });
    } catch {}
  });

  it('starts from an empty Global document when no data exists', async () => {
    const g = await readBridgeState({ agentDir: env.agentDir });

    expect(g.status).toBe('missing');
    expect(g.state!.registrations).toEqual([]);
    expect(g.state!.installations).toEqual([]);
    expect(g.state!.stateRevision).toBe('0');
  });

  it('after a registration, the Global document shows it', async () => {
    await commitBridgeState((cur) => ({
        ...cur,
        registrations: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', alias: 'acme', marketplaceName: 'acme-marketplace' }],
      }),
      { agentDir: env.agentDir },
    );
    const g = await readBridgeState({ agentDir: env.agentDir });
    expect(g.state!.registrations).toHaveLength(1);
    expect(g.state!.registrations[0].alias).toBe('acme');
  });

  it('commits bump only the Global revision, monotonically', async () => {
    const r1 = await commitBridgeState((c) => ({ ...c, registrations: [{ id: '1-1-1', alias: 'g1' }] }), {
      agentDir: env.agentDir,
    });
    const r2 = await commitBridgeState((c) => ({ ...c, registrations: [...c.registrations, { id: '1-1-2', alias: 'g2' }] }), {
      agentDir: env.agentDir,
    });
    expect(r1.newRevision).toBe('1');
    expect(r2.newRevision).toBe('2');

    const g = await readBridgeState({ agentDir: env.agentDir });
    expect(g.state!.stateRevision).toBe('2');
  });

  it('reads without crashing on Indeterminate bytes (closed corruption handling)', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { getGlobalStatePath } = await import('../../src/bridge-state/paths.js');
    mkdirSync(join(env.agentDir, 'codex-marketplace'), { recursive: true });
    writeFileSync(getGlobalStatePath(env.agentDir), '{ bad', 'utf-8');

    const g = readBridgeStateSync({ agentDir: env.agentDir });
    expect(g.status).toBe('corrupted');
  });

  it('D2: a legacy project state file is never read, prompted, or deleted', async () => {
    const { mkdirSync, writeFileSync, readFileSync, existsSync } = await import('node:fs');
    // Seed a legacy project-scope document in the working directory.
    const projectStatePath = join(env.cwd, '.pi', 'codex-marketplace', 'state.json');
    mkdirSync(join(env.cwd, '.pi', 'codex-marketplace'), { recursive: true });
    const legacyBytes = JSON.stringify({
      schemaVersion: 1,
      stateRevision: '7',
      registrations: [{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', alias: 'legacy-project' }],
      installations: [],
      scopeOverrides: [],
    }, null, 2);
    writeFileSync(projectStatePath, legacyBytes, 'utf-8');

    // Every store surface ignores it entirely.
    const g = await readBridgeState({ agentDir: env.agentDir });
    expect(g.status).toBe('missing');
    expect(g.state!.registrations).toEqual([]);

    const synced = readBridgeStateSync({ agentDir: env.agentDir });
    expect(synced.status).toBe('missing');

    // A commit writes only under the agent dir; the project file stays byte-identical on disk.
    await commitBridgeState((cur) => ({
      ...cur,
      registrations: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', alias: 'global-only' }],
    }), { agentDir: env.agentDir });

    expect(existsSync(projectStatePath)).toBe(true);
    expect(readFileSync(projectStatePath, 'utf-8')).toBe(legacyBytes);
  });
});
