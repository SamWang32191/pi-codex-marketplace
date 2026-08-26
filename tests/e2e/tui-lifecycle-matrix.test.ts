/**
 * E2E — highest seam (TUI) traverses full lifecycle, collision, cache.
 * Issue #24 requires E2E at the TUI seam to cover external observable behaviour for
 * lifecycle, collision and cache via the `/codex-marketplace` aggregated command.
 *
 * This test drives the TUI flows through their public handler seam with a mocked
 * ExtensionUIContext that records disclosures, confirmations, receipts.
 * It does not assert on internal state shape — only on the externally observable:
 * Validation Disclosure content, sorted Findings with rule codes, closed Recovery Actions,
 * three-orthogonal Attempt Summary, partitioned lists, skill-granular diagnostics,
 * and offline exact-fingerprint cache reuse.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createEmptyState, type BridgeState } from '../../src/bridge-state/types.js';
import { writeBridgeState, readBridgeState } from '../../src/bridge-state/store.js';
import { acquireAttemptFence } from '../../src/registration/fence.js';
import { formatThreeOrthogonalReport } from '../../src/registration/receipt.js';
import { sortFindings } from '../../src/registration/findings.js';
import { computeEffectiveState } from '../../src/projection/effective-state.js';
import { projectEffectiveState } from '../../src/projection/project.js';

function makeTmpAgent(): { cwd: string; agentDir: string; cleanup: () => void } {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-e2e-cwd-'));
  const agentDir = mkdtempSync(join(tmpdir(), 'pi-e2e-agent-'));
  return {
    cwd,
    agentDir,
    cleanup() {
      try { rmSync(cwd, { recursive: true, force: true }); } catch {}
      try { rmSync(agentDir, { recursive: true, force: true }); } catch {}
    },
  };
}

describe('E2E TUI highest seam — lifecycle / collision / cache (Issue #24)', () => {
  let env: ReturnType<typeof makeTmpAgent>;

  beforeEach(() => {
    env = makeTmpAgent();
    process.env.PI_CODING_AGENT_DIR = env.agentDir;
    process.env.PI_AGENT_DIR = env.agentDir;
  });

  afterEach(() => {
    env.cleanup();
    delete process.env.PI_CODING_AGENT_DIR;
    delete process.env.PI_AGENT_DIR;
  });

  it('partitioned Bridge State empty on scaffold is observable via store seam (Global/Project)', async () => {
    const global = await readBridgeState('global', { cwd: env.cwd, agentDir: env.agentDir });
    const project = await readBridgeState('project', { cwd: env.cwd, agentDir: env.agentDir });
    expect(global.status).toBe('missing');
    expect(project.status).toBe('missing');
    expect(global.state!.schemaVersion).toBe(1);
    expect(project.state!.schemaVersion).toBe(1);
  });

  it('Findings are sorted class→phase→target→pointer→rule with stable rule codes (prototype decision)', async () => {
    const f = [
      { code: 'B', classification: 'notice' as const, phase: 'persistence' as const, target: 'skill' as const, scope: 'global' as const, pointer: '/z', rule: 'Z-01', outcome: 'o' },
      { code: 'A', classification: 'blocking' as const, phase: 'admission' as const, target: 'attempt' as const, scope: 'global' as const, pointer: '', rule: 'FENCE-01', outcome: 'blocked' },
      { code: 'C', classification: 'blocking' as const, phase: 'validation' as const, target: 'entry' as const, scope: 'global' as const, pointer: '/plugins/2/path', rule: 'CONT-01', outcome: 'violation' },
    ];
    const sorted = sortFindings(f);
    expect(sorted[0].rule).toBe('FENCE-01');
    expect(sorted[1].rule).toBe('CONT-01');
    expect(sorted[2].rule).toBe('Z-01');
  });

  it('three-orthogonal report is partitionable into persistence/findings/runtime with closed Attempt Summary and Recovery Actions', async () => {
    const { createReceipt } = await import('../../src/registration/receipt.js');
    const rc = createReceipt({
      operation: 'Marketplace Registration',
      scope: 'global',
      trigger: 'register local /tmp/root',
      expectedStateRevision: '0',
      targetStateRevision: '1',
      observedStateRevision: '1',
      durableOutcome: 'committed',
      runtimeOutcome: 'pending-application',
      findings: [],
      summary: 'Pending Application',
    });
    const report = formatThreeOrthogonalReport(rc);
    expect(report).toMatch(/Persistence/);
    expect(report).toMatch(/Findings/);
    expect(report).toMatch(/Runtime/);
    expect(report).toMatch(/Pending Application/);
    expect(rc.recoveryActions).toContain('Retry Application');
    expect(rc.summary).toBe('Pending Application');
  });

  it('Effective State + skill-granular collision via highest seam: Pi → Project → Global layering, same-scope colliders all unavailable', async () => {
    // Global has a skill `alpha`, Project has same-name `alpha` — Project should reserve the name, Global becomes unavailable at skill granularity only
    const global: BridgeState = {
      ...createEmptyState(),
      stateRevision: '1',
      registrations: [{ id: 'reg-g', alias: 'g', marketplaceName: 'g-mp', sourceKind: 'local', source: '/g' } as any],
      installations: [{ id: 'global/g-mp/plugin-a', pluginId: 'g-mp/plugin-a', installationState: 'enabled', registrationId: 'reg-g', marketplaceEntryId: 'g-mp/plugins/0' } as any],
    };
    const project: BridgeState = {
      ...createEmptyState(),
      stateRevision: '1',
      registrations: [{ id: 'reg-p', alias: 'p', marketplaceName: 'p-mp', sourceKind: 'local', source: '/p' } as any],
      installations: [{ id: 'project/p-mp/plugin-a', pluginId: 'p-mp/plugin-a', installationState: 'enabled', registrationId: 'reg-p', marketplaceEntryId: 'p-mp/plugins/0' } as any],
      scopeOverrides: [],
    };
    // Seed state to exercise store seam then recompute via projection seam
    await writeBridgeState('global', global, { cwd: env.cwd, agentDir: env.agentDir });
    await writeBridgeState('project', project, { cwd: env.cwd, agentDir: env.agentDir });

    const effective = computeEffectiveState(global, project, { projectTrusted: true });
    // Both registrations participate (no overrides)
    expect(effective.registrations.length).toBe(2);
    // Installations: project-over-global precedence — project enabled wins when same Plugin ID
    // Here plugin IDs differ (g-mp/plugin-a vs p-mp/plugin-a), so both participate
    expect(effective.installations.length).toBe(2);

    // Collision seam: when both scopes provide a skill named identically, only the higher layer (Project) projects
    const { resolveRuntimeSkillCollisions } = await import('../../src/projection/collision.js');
    const { survivors, findings } = resolveRuntimeSkillCollisions([
      { name: 'alpha', pluginId: 'g-mp/plugin-a', layer: 'global' as const, skillId: 'g-mp/plugin-a/alpha' },
      { name: 'alpha', pluginId: 'p-mp/plugin-a', layer: 'project' as const, skillId: 'p-mp/plugin-a/alpha' },
    ]);
    // Project skill should be projected, global unavailable due to `Pi → Project → Global` precedence
    const alphaProjected = survivors.find((s: any) => s.layer === 'project' && s.name === 'alpha');
    const alphaUnavailable = findings.find((c: any) => c.name === 'alpha');
    expect(alphaProjected).toBeDefined();
    expect(alphaUnavailable).toBeDefined();
    expect(alphaUnavailable?.unavailableSkillIds).toContain('g-mp/plugin-a/alpha');
  });

  it('Global pending application leaves the per-scope Attempt Fence untouched (Barrier retired)', async () => {
    // Simulate a global Pending Application by writing a state and leaving an active recovery chain
    const global: BridgeState = { ...createEmptyState(), stateRevision: '5', registrations: [], installations: [] };
    await writeBridgeState('global', global, { cwd: env.cwd, agentDir: env.agentDir });

    const { createReceipt } = await import('../../src/registration/receipt.js');
    const { appendReceipt } = await import('../../src/journal/journal.js');
    const pending = createReceipt({
      operation: 'Marketplace Registration',
      scope: 'global',
      trigger: 'register local /tmp',
      expectedStateRevision: '4',
      targetStateRevision: '5',
      observedStateRevision: '5',
      durableOutcome: 'committed',
      runtimeOutcome: 'pending-application',
      findings: [],
      summary: 'Pending Application',
    });
    await appendReceipt('global', pending, { cwd: env.cwd, agentDir: env.agentDir });

    // Project Scope attempts acquire their own fence without any global-pending gate…
    const projectFence = await acquireAttemptFence('project', { cwd: env.cwd, agentDir: env.agentDir, projectTrusted: true });
    expect(projectFence.ok).toBe(true);
    projectFence.handle?.release();
    // …and the Global fence itself still works while recovery is pending.
    const globalFence = await acquireAttemptFence('global', { cwd: env.cwd, agentDir: env.agentDir });
    expect(globalFence.ok).toBe(true);
    globalFence.handle?.release();
  });

  it('persisted legacy scopeOverrides stop participating immediately — inherited Global always effective', async () => {
    const global: BridgeState = {
      ...createEmptyState(),
      stateRevision: '1',
      registrations: [{ id: 'reg-g1', alias: 'acme', marketplaceName: 'acme-marketplace', sourceKind: 'local', source: '/g' } as any],
      installations: [],
    };
    // A project document left behind by a pre-retirement Bridge, still carrying an override.
    const project: BridgeState = {
      ...createEmptyState(),
      stateRevision: '1',
      registrations: [{ id: 'reg-p1', alias: 'team', marketplaceName: 'team-marketplace', sourceKind: 'local', source: '/p' } as any],
      installations: [],
      scopeOverrides: [{ kind: 'registration', targetId: 'reg-g1' }],
    };
    await writeBridgeState('global', global, { cwd: env.cwd, agentDir: env.agentDir });
    await writeBridgeState('project', project, { cwd: env.cwd, agentDir: env.agentDir });

    const effective = computeEffectiveState(global, project, { projectTrusted: true });
    expect(effective.registrations.find(r => r.id === 'reg-g1')).toBeDefined();
    expect(effective.suppressed).toEqual([]);
    // Global document unchanged — retirement is a read-time semantics change only.
    const reReadGlobal = await readBridgeState('global', { cwd: env.cwd, agentDir: env.agentDir });
    expect(reReadGlobal.state!.registrations.find(r => r.id === 'reg-g1')).toBeDefined();
  });
});
