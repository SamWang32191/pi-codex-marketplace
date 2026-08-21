import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  commitBridgeState,
  readBridgeState,
  readBridgeStateSync,
  writeBridgeState,
} from '../../src/bridge-state/store.js';
import { getGlobalStatePath, getProjectStatePath, getAgentDir } from '../../src/bridge-state/paths.js';
import { CURRENT_SCHEMA_VERSION, createEmptyState, nextRevision } from '../../src/bridge-state/types.js';

function makeTempEnv() {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'bridge-store-test-'));
  const agentDir = join(tmpRoot, 'agent');
  const projectDir = join(tmpRoot, 'project');
  // mk dirs
  return { tmpRoot, agentDir, projectDir };
}

describe('Bridge State store — dual documents, atomicity, corruption', () => {
  let env: ReturnType<typeof makeTempEnv>;

  beforeEach(() => {
    env = makeTempEnv();
  });

  afterEach(() => {
    try {
      rmSync(env.tmpRoot, { recursive: true, force: true });
    } catch {}
  });

  it('reads missing files as empty state with revision 0', async () => {
    const g = await readBridgeState('global', { agentDir: env.agentDir, cwd: env.projectDir });
    const p = await readBridgeState('project', { agentDir: env.agentDir, cwd: env.projectDir });
    expect(g.status).toBe('missing');
    expect(g.state!.stateRevision).toBe('0');
    expect(g.state!.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(g.state!.registrations).toEqual([]);
    expect(p.status).toBe('missing');
    expect(p.state!.stateRevision).toBe('0');
  });

  it('global and project are isolated documents with independent revisions', async () => {
    // Commit to global
    const r1 = await commitBridgeState(
      'global',
      (cur) => ({ ...cur, registrations: [{ id: '11111111-1111-4111-8111-111111111111', alias: 'global-mp' }] }),
      { agentDir: env.agentDir, cwd: env.projectDir },
    );
    expect(r1.success).toBe(true);
    expect(r1.newRevision).toBe('1');

    // Commit to project — should still be 1 independently
    const r2 = await commitBridgeState(
      'project',
      (cur) => ({ ...cur, registrations: [{ id: '22222222-2222-4222-8222-222222222222', alias: 'proj-mp' }] }),
      { agentDir: env.agentDir, cwd: env.projectDir },
    );
    expect(r2.success).toBe(true);
    expect(r2.newRevision).toBe('1');

    // Verify isolation
    const g = await readBridgeState('global', { agentDir: env.agentDir, cwd: env.projectDir });
    const p = await readBridgeState('project', { agentDir: env.agentDir, cwd: env.projectDir });
    expect(g.state!.registrations[0].alias).toBe('global-mp');
    expect(p.state!.registrations[0].alias).toBe('proj-mp');
    expect(g.state!.stateRevision).toBe('1');
    expect(p.state!.stateRevision).toBe('1');

    // Second global commit bumps to 2, project stays 1
    const r3 = await commitBridgeState(
      'global',
      (cur) => ({
        ...cur,
        installations: [{ id: 'inst-1', pluginId: 'mp/plugin@1.0.0', installationState: 'enabled' }],
      }),
      { agentDir: env.agentDir, cwd: env.projectDir },
    );
    expect(r3.newRevision).toBe('2');
    const g2 = await readBridgeState('global', { agentDir: env.agentDir, cwd: env.projectDir });
    const p2 = await readBridgeState('project', { agentDir: env.agentDir, cwd: env.projectDir });
    expect(g2.state!.stateRevision).toBe('2');
    expect(p2.state!.stateRevision).toBe('1');
  });

  it('State Revision monotonic increments on each successful commit', async () => {
    for (let i = 1; i <= 5; i++) {
      const res = await commitBridgeState(
        'global',
        (cur) => ({ ...cur, registrations: [{ id: `id-${i}`, alias: `mp-${i}` }] }),
        { agentDir: env.agentDir, cwd: env.projectDir },
      );
      expect(res.success).toBe(true);
      expect(res.newRevision).toBe(String(i));
    }
    const final = await readBridgeState('global', { agentDir: env.agentDir, cwd: env.projectDir });
    expect(final.state!.stateRevision).toBe('5');
  });

  it('persists only authoritative fields (no Effective State / catalogs)', async () => {
    await commitBridgeState(
      'global',
      () => ({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        stateRevision: '0', // will be bumped
        registrations: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', alias: 'test' }],
        installations: [{ id: 'global:test/plugin', pluginId: 'test/plugin', installationState: 'enabled' }],
        scopeOverrides: [{ kind: 'installation', targetId: 'some-id' }], // global should be normalized to empty
      }),
      { agentDir: env.agentDir, cwd: env.projectDir },
    );
    const gPath = getGlobalStatePath(env.agentDir);
    const raw = JSON.parse(readFileSync(gPath, 'utf-8'));
    expect(raw.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(raw.stateRevision).toBe('1');
    expect(raw.registrations).toHaveLength(1);
    expect(raw.installations).toHaveLength(1);
    // Scaffold: global overrides are cleared (project-only)
    expect(raw.scopeOverrides).toEqual([]);
    // No Effective State fields
    expect(raw.effectiveState).toBeUndefined();
    expect(raw.catalog).toBeUndefined();
    expect(raw.diagnostics).toBeUndefined();
  });

  it('project preserves scopeOverrides', async () => {
    await commitBridgeState(
      'project',
      () => ({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        stateRevision: '0',
        registrations: [],
        installations: [],
        scopeOverrides: [{ kind: 'registration', targetId: 'reg-123' }],
      }),
      { agentDir: env.agentDir, cwd: env.projectDir },
    );
    const pPath = getProjectStatePath(env.projectDir);
    const raw = JSON.parse(readFileSync(pPath, 'utf-8'));
    expect(raw.scopeOverrides).toEqual([{ kind: 'registration', targetId: 'reg-123' }]);
  });

  it('atomic write: temp+fsync+rename preserves file on success and verifies', async () => {
    const r = await commitBridgeState(
      'global',
      (cur) => ({ ...cur, registrations: [{ id: 'b-b', alias: 'a' }] }),
      { agentDir: env.agentDir, cwd: env.projectDir },
    );
    expect(r.success).toBe(true);
    const gPath = getGlobalStatePath(env.agentDir);
    expect(existsSync(gPath)).toBe(true);
    const content = readFileSync(gPath, 'utf-8');
    // Should be pretty printed JSON ending with newline
    expect(content.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(content);
    expect(parsed.stateRevision).toBe('1');
    // No temp files left
    const dirContents = readFileSync(gPath, 'utf-8'); // just sanity
    expect(dirContents).toBe(content);
  });

  it('handles corrupted JSON as corrupted (Indeterminate) without auto-rollback', async () => {
    const gPath = getGlobalStatePath(env.agentDir);
    // Write initial valid
    await commitBridgeState('global', (c) => ({ ...c }), { agentDir: env.agentDir, cwd: env.projectDir });
    expect((await readBridgeState('global', { agentDir: env.agentDir, cwd: env.projectDir })).status).toBe('ok');
    // Corrupt file
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(env.agentDir, 'codex-marketplace'), { recursive: true });
    writeFileSync(gPath, '{ corrupted json,,', 'utf-8');

    const corrupted = await readBridgeState('global', { agentDir: env.agentDir, cwd: env.projectDir });
    expect(corrupted.status).toBe('corrupted');
    expect(corrupted.error).toMatch(/Corrupted JSON/i);

    // Attempt to commit should fail as Indeterminate, not overwrite
    const attempt = await commitBridgeState('global', (c) => ({ ...c }), {
      agentDir: env.agentDir,
      cwd: env.projectDir,
    });
    expect(attempt.success).toBe(false);
    expect(attempt.isIndeterminate).toBe(true);
    expect(attempt.error).toMatch(/Indeterminate/i);

    // File should still be corrupted (no auto-rollback)
    const stillCorrupted = readFileSync(gPath, 'utf-8');
    expect(stillCorrupted).toBe('{ corrupted json,,');
  });

  it('handles unknown future schemaVersion as incompatible (not corrupted, not auto-migrated)', async () => {
    const gPath = getGlobalStatePath(env.agentDir);
    const futureState = {
      schemaVersion: CURRENT_SCHEMA_VERSION + 1,
      stateRevision: '1',
      registrations: [],
      installations: [],
      scopeOverrides: [],
    };
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(env.agentDir, 'codex-marketplace'), { recursive: true });
    writeFileSync(gPath, JSON.stringify(futureState, null, 2), 'utf-8');

    const result = await readBridgeState('global', { agentDir: env.agentDir, cwd: env.projectDir });
    expect(result.status).toBe('incompatible');
    expect(result.error).toMatch(/Incompatible.*schemaVersion/i);

    // Commit should be rejected, not auto-downgrade
    const attempt = await commitBridgeState('global', (c) => ({ ...c }), {
      agentDir: env.agentDir,
      cwd: env.projectDir,
    });
    expect(attempt.success).toBe(false);
    expect(attempt.error).toMatch(/Incompatible/i);
    // File unchanged
    const raw = JSON.parse(readFileSync(gPath, 'utf-8'));
    expect(raw.schemaVersion).toBe(CURRENT_SCHEMA_VERSION + 1);
  });

  it('handles empty file as corrupted (Indeterminate)', async () => {
    const gPath = getGlobalStatePath(env.agentDir);
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(env.agentDir, 'codex-marketplace'), { recursive: true });
    writeFileSync(gPath, '', 'utf-8');
    const r = await readBridgeState('global', { agentDir: env.agentDir, cwd: env.projectDir });
    expect(r.status).toBe('corrupted');
  });

  it('readBridgeStateSync mirrors async behavior', async () => {
    await commitBridgeState('global', (c) => ({ ...c }), { agentDir: env.agentDir, cwd: env.projectDir });
    const asyncR = await readBridgeState('global', { agentDir: env.agentDir, cwd: env.projectDir });
    const syncR = readBridgeStateSync('global', { agentDir: env.agentDir, cwd: env.projectDir });
    expect(syncR.status).toBe(asyncR.status);
    expect(syncR.state!.stateRevision).toBe(asyncR.state!.stateRevision);
  });

  it('dual-path: getAgentDir honors PI_CODING_AGENT_DIR env', () => {
    const custom = join(env.tmpRoot, 'custom-agent');
    process.env.PI_CODING_AGENT_DIR = custom;
    const dir = getAgentDir();
    expect(dir).toBe(custom);
    delete process.env.PI_CODING_AGENT_DIR;
  });

  it('writeBridgeState directly respects atomicity and version', async () => {
    const state = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      stateRevision: '1',
      registrations: [],
      installations: [],
      scopeOverrides: [],
    };
    const w = await writeBridgeState('global', state, { agentDir: env.agentDir, cwd: env.projectDir });
    expect(w.success).toBe(true);
    const r = await readBridgeState('global', { agentDir: env.agentDir, cwd: env.projectDir });
    expect(r.state!.stateRevision).toBe('1');
  });
});
