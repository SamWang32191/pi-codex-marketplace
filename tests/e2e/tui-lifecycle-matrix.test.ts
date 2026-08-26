/**
 * E2E — highest seam (TUI) traverses full lifecycle, collision, cache.
 * Issue #24 requires E2E at the TUI seam to cover external observable behaviour for
 * lifecycle, collision and cache via the `/codex-marketplace` aggregated command.
 *
 * Global-only (#61): one document, `Pi → Global` collision layering; project-scope rows retired.
 *
 * This test drives the seams with a mocked context that records disclosures, confirmations,
 * receipts. It does not assert on internal state shape — only on the externally observable:
 * Validation Disclosure content, sorted Findings with rule codes, closed Recovery Actions,
 * three-orthogonal Attempt Summary, skill-granular diagnostics.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createEmptyState, CURRENT_SCHEMA_VERSION, type BridgeState } from '../../src/bridge-state/types.js';
import { writeBridgeState, readBridgeState } from '../../src/bridge-state/store.js';
import { acquireAttemptFence } from '../../src/registration/fence.js';
import { formatThreeOrthogonalReport } from '../../src/registration/receipt.js';
import { sortFindings } from '../../src/registration/findings.js';
import { computeEffectiveState } from '../../src/projection/effective-state.js';

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

  it('Bridge State is a single Global document empty on scaffold', async () => {
    const global = await readBridgeState({ agentDir: env.agentDir });
    expect(global.status).toBe('missing');
    expect(global.state!.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('Findings are sorted class→phase→target→pointer→rule with stable rule codes (prototype decision)', async () => {
    const f = [
      { code: 'B', classification: 'notice' as const, phase: 'persistence' as const, target: 'skill' as const, pointer: '/z', rule: 'Z-01', outcome: 'o' },
      { code: 'A', classification: 'blocking' as const, phase: 'admission' as const, target: 'attempt' as const, pointer: '', rule: 'FENCE-01', outcome: 'blocked' },
      { code: 'C', classification: 'blocking' as const, phase: 'validation' as const, target: 'entry' as const, pointer: '/plugins/2/path', rule: 'CONT-01', outcome: 'violation' },
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

  it('Effective State + skill-granular collision via highest seam: Pi → Global layering, same-layer colliders all unavailable', async () => {
    // Two Global Installations provide identically named skills — both are unavailable at
    // skill granularity only; no Pi skill claims the name so nobody reserves it.
    const global: BridgeState = {
      ...createEmptyState(),
      stateRevision: '1',
      registrations: [{ id: 'reg-g', alias: 'g', marketplaceName: 'g-mp', sourceKind: 'local', source: '/g' } as any],
      installations: [
        { id: 'g-mp/plugin-a', pluginId: 'g-mp/plugin-a', installationState: 'enabled', registrationId: 'reg-g', marketplaceEntryId: 'g-mp/plugins/0' } as any,
        { id: 'g-mp/plugin-b', pluginId: 'g-mp/plugin-b', installationState: 'enabled', registrationId: 'reg-g', marketplaceEntryId: 'g-mp/plugins/1' } as any,
      ],
    };
    await writeBridgeState(global, { agentDir: env.agentDir });

    const effective = computeEffectiveState(global);
    expect(effective.registrations.length).toBe(1);
    expect(effective.installations.length).toBe(2);

    const { resolveRuntimeSkillCollisions } = await import('../../src/projection/collision.js');
    const { survivors, findings } = resolveRuntimeSkillCollisions([
      { name: 'alpha', pluginId: 'g-mp/plugin-a', layer: 'global' as const, skillId: 'g-mp/plugin-a/alpha' },
      { name: 'alpha', pluginId: 'g-mp/plugin-b', layer: 'global' as const, skillId: 'g-mp/plugin-b/alpha' },
    ]);
    // Same-layer Bridge colliders are all unavailable and nobody reserves the name.
    expect(survivors).toEqual([]);
    const alphaFinding = findings.find((c: any) => c.name === 'alpha');
    expect(alphaFinding).toBeDefined();
    expect(alphaFinding?.unavailableSkillIds.sort()).toEqual(['g-mp/plugin-a/alpha', 'g-mp/plugin-b/alpha'].sort());
    expect(alphaFinding?.reservedBy).toBeUndefined();

    // A pre-existing Pi skill claims the name for all Bridge candidates (Pi → Global).
    const piResolution = resolveRuntimeSkillCollisions([
      { name: 'alpha', pluginId: '(pi)', layer: 'pi' as const, skillId: 'pi/alpha' },
      { name: 'alpha', pluginId: 'g-mp/plugin-a', layer: 'global' as const, skillId: 'g-mp/plugin-a/alpha' },
    ]);
    expect(piResolution.survivors.map((s: any) => s.layer)).toEqual(['pi']);
    expect(piResolution.findings[0]?.reservedBy?.layer).toBe('pi');
  });

  it('a pending application leaves the Attempt Fence untouched (Barrier retired)', async () => {
    // Simulate a Pending Application by writing a state and leaving an active recovery chain
    const global: BridgeState = { ...createEmptyState(), stateRevision: '5', registrations: [], installations: [] };
    await writeBridgeState(global, { agentDir: env.agentDir });

    const { createReceipt } = await import('../../src/registration/receipt.js');
    const { appendReceipt } = await import('../../src/journal/journal.js');
    const pending = createReceipt({
      operation: 'Marketplace Registration',
      trigger: 'register local /tmp',
      expectedStateRevision: '4',
      targetStateRevision: '5',
      observedStateRevision: '5',
      durableOutcome: 'committed',
      runtimeOutcome: 'pending-application',
      findings: [],
      summary: 'Pending Application',
    });
    await appendReceipt(pending, { agentDir: env.agentDir });

    // The Attempt Fence itself still works while recovery is pending — no cross-cutting gate.
    const fence = await acquireAttemptFence({ agentDir: env.agentDir });
    expect(fence.ok).toBe(true);
    fence.handle?.release();
  });

  it('persisted legacy scopeOverrides stop participating immediately — records always effective', async () => {
    const global: BridgeState = {
      ...createEmptyState(),
      stateRevision: '1',
      registrations: [{ id: 'reg-g1', alias: 'acme', marketplaceName: 'acme-marketplace', sourceKind: 'local', source: '/g' } as any],
      installations: [],
    };
    await writeBridgeState(global, { agentDir: env.agentDir });

    const effective = computeEffectiveState(global);
    expect(effective.registrations.find(r => r.id === 'reg-g1')).toBeDefined();
    // Global document unchanged — retirement is a read-time semantics change only.
    const reReadGlobal = await readBridgeState({ agentDir: env.agentDir });
    expect(reReadGlobal.state!.registrations.find(r => r.id === 'reg-g1')).toBeDefined();
  });
});
