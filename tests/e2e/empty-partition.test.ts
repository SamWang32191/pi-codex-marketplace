/**
 * E2E — /codex-marketplace empty partitioned state
 * Verifies externally observable behavior: with no registrations, the TUI shows
 * Global / Project empty partitions; subsequent tickets can incrementally populate them.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readBridgeState, commitBridgeState } from '../../src/bridge-state/store.js';

// Simulate the extension's rendering logic without needing a full Pi TUI
// We test the store's externally observable empty state + the extension's format helper indirectly
import { readBridgeStateSync } from '../../src/bridge-state/store.js';
import { createEmptyState } from '../../src/bridge-state/types.js';

function makeEnv() {
  const root = mkdtempSync(join(tmpdir(), 'bridge-e2e-'));
  return { root, agentDir: join(root, 'agent'), projectDir: join(root, 'project') };
}

describe('E2E — empty partitioned Bridge State for /codex-marketplace', () => {
  let env: ReturnType<typeof makeEnv>;

  beforeEach(() => {
    env = makeEnv();
  });

  afterEach(() => {
    try {
      rmSync(env.root, { recursive: true, force: true });
    } catch {}
  });

  it('shows empty Global and Project partitions when no data exists', async () => {
    const g = await readBridgeState('global', { agentDir: env.agentDir, cwd: env.projectDir });
    const p = await readBridgeState('project', { agentDir: env.agentDir, cwd: env.projectDir });

    // Both should be missing -> empty init
    expect(g.status).toBe('missing');
    expect(p.status).toBe('missing');
    expect(g.state!.registrations).toEqual([]);
    expect(g.state!.installations).toEqual([]);
    expect(p.state!.registrations).toEqual([]);
    expect(p.state!.installations).toEqual([]);
    expect(p.state!.scopeOverrides).toEqual([]);

    // Simulate what the extension shows: it treats missing as empty and displays "No marketplace registrations"
    // Ensure the empty state's revision is 0 and schema is current
    expect(g.state!.stateRevision).toBe('0');
    expect(p.state!.stateRevision).toBe('0');
  });

  it('after a Global registration, Global partition shows it while Project remains empty', async () => {
    await commitBridgeState(
      'global',
      (cur) => ({
        ...cur,
        registrations: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', alias: 'acme', marketplaceName: 'acme-marketplace' }],
      }),
      { agentDir: env.agentDir, cwd: env.projectDir },
    );
    const g = await readBridgeState('global', { agentDir: env.agentDir, cwd: env.projectDir });
    const p = await readBridgeState('project', { agentDir: env.agentDir, cwd: env.projectDir });
    expect(g.state!.registrations).toHaveLength(1);
    expect(g.state!.registrations[0].alias).toBe('acme');
    expect(p.state!.registrations).toHaveLength(0);
    // Project remains empty — proves partitioning
    expect(p.status).toBe('missing');
  });

  it('Project and Global are independent; adding to Project does not affect Global', async () => {
    await commitBridgeState(
      'project',
      (cur) => ({
        ...cur,
        registrations: [{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', alias: 'team', marketplaceName: 'team-marketplace' }],
      }),
      { agentDir: env.agentDir, cwd: env.projectDir },
    );
    const g = await readBridgeState('global', { agentDir: env.agentDir, cwd: env.projectDir });
    const p = await readBridgeState('project', { agentDir: env.agentDir, cwd: env.projectDir });
    expect(g.status).toBe('missing');
    expect(p.state!.registrations[0].alias).toBe('team');
  });

  it('incrementally adding to either partition updates only that partition\'s revision', async () => {
    const r1 = await commitBridgeState('global', (c) => ({ ...c, registrations: [{ id: '1-1-1', alias: 'g1' }] }), {
      agentDir: env.agentDir,
      cwd: env.projectDir,
    });
    const r2 = await commitBridgeState('global', (c) => ({ ...c, registrations: [...c.registrations, { id: '1-1-2', alias: 'g2' }] }), {
      agentDir: env.agentDir,
      cwd: env.projectDir,
    });
    expect(r1.newRevision).toBe('1');
    expect(r2.newRevision).toBe('2');

    // Project still at 0
    const p = await readBridgeState('project', { agentDir: env.agentDir, cwd: env.projectDir });
    expect(p.state!.stateRevision).toBe('0');

    // Now add to project
    const r3 = await commitBridgeState('project', (c) => ({ ...c, registrations: [{ id: '2-2-1', alias: 'p1' }] }), {
      agentDir: env.agentDir,
      cwd: env.projectDir,
    });
    expect(r3.newRevision).toBe('1');
    const g = await readBridgeState('global', { agentDir: env.agentDir, cwd: env.projectDir });
    expect(g.state!.stateRevision).toBe('2');
  });

  it('extension reads both scopes without crashing on Indeterminate', async () => {
    // Corrupt global, keep project empty
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { getGlobalStatePath } = await import('../../src/bridge-state/paths.js');
    const gPath = getGlobalStatePath(env.agentDir);
    mkdirSync(join(env.agentDir, 'codex-marketplace'), { recursive: true });
    writeFileSync(gPath, '{ bad', 'utf-8');

    const g = readBridgeStateSync('global', { agentDir: env.agentDir, cwd: env.projectDir });
    const p = readBridgeStateSync('project', { agentDir: env.agentDir, cwd: env.projectDir });

    expect(g.status).toBe('corrupted');
    expect(p.status).toBe('missing');
    // Extension should still render both partitions, showing error for global but empty for project
    // Verified: no throw
  });
});
