/**
 * Integration: Effective State → projection seam.
 * See issue #20 — 碰撞與投影的可觀察行為，以 Effective State 計算與投影接縫覆蓋。
 * Global-only (#61): Effective State is computed directly from the single Global document and
 * Runtime Skill Collision resolves in `Pi → Global` two layers.
 *
 * External observable behavior only: durable documents, receipts, projected skills at their
 * original snapshot paths, and closed diagnostic outcomes. No internal implementation details.
 */

import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { commitBridgeState, readBridgeState, readBridgeStateSync } from '../../src/bridge-state/store.js';
import { acquireLockSync, releaseLock } from '../../src/bridge-state/atomic.js';
import { getReceiptsJournalPath } from '../../src/bridge-state/paths.js';
import type { BridgeState } from '../../src/bridge-state/types.js';
import { computeEffectiveState } from '../../src/projection/effective-state.js';
import { projectEffectiveState, requestRuntimeApplication } from '../../src/projection/runtime.js';

function makeEnv() {
  const root = mkdtempSync(join(tmpdir(), 'projection-integration-'));
  return {
    root,
    agentDir: join(root, 'agent'),
    globalMarketplace: join(root, 'marketplace-global'),
  };
}

/** One marketplace with a single compatible plugin exposing `skillNames`. */
function makePluginMarketplace(root: string, marketplaceName: string, pluginDirName: string, manifestName: string, skillNames: string[]): void {
  mkdirSync(join(root, '.agents', 'plugins'), { recursive: true });
  mkdirSync(join(root, 'plugins', pluginDirName, '.codex-plugin'), { recursive: true });
  writeFileSync(
    join(root, '.agents', 'plugins', 'marketplace.json'),
    JSON.stringify({
      name: marketplaceName,
      plugins: [{ name: manifestName, source: { source: 'local', path: `./plugins/${pluginDirName}` } }],
    }),
  );
  writeFileSync(join(root, 'plugins', pluginDirName, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: manifestName, skills: './skills/' }));
  for (const skillName of skillNames) {
    mkdirSync(join(root, 'plugins', pluginDirName, 'skills', skillName), { recursive: true });
    writeFileSync(
      join(root, 'plugins', pluginDirName, 'skills', skillName, 'SKILL.md'),
      `---\nname: ${skillName}\ndescription: ${skillName} skill\n---\n\n${skillName} body.\n`,
    );
  }
}

async function registerLocal(id: string, source: string, env: { agentDir: string }): Promise<void> {
  await commitBridgeState(
    (state: BridgeState) => ({
      ...state,
      registrations: [
        ...state.registrations,
        { id, alias: `alias-${id.slice(0, 6)}`, marketplaceName: 'marketplace-name', sourceKind: 'local' as const, source },
      ],
    }),
    { agentDir: env.agentDir },
  );
}

describe('Projection onto the Pi resource-discovery seam', () => {
  const GLOBAL_REG = 'dddddddd-1111-4111-8111-111111111111';
  let env: ReturnType<typeof makeEnv>;

  beforeEach(async () => {
    env = makeEnv();
    makePluginMarketplace(env.globalMarketplace, 'acme-marketplace', 'release-helper', 'release-helper', ['release-notes']);
    await registerLocal(GLOBAL_REG, env.globalMarketplace, env);
  });

  afterEach(() => rmSync(env.root, { recursive: true, force: true }));

  /** Install the first entry of the registration as enabled, binding the inspected fingerprint. */
  async function installFirstEntry(registrationId: string): Promise<void> {
    const opts = { agentDir: env.agentDir };
    const { inspectMarketplaceEntries } = await import('../../src/installation/inspection.js');
    const state = (await readBridgeState(opts)).state!;
    const registration = state.registrations.find((r) => r.id === registrationId)!;
    const inspection = inspectMarketplaceEntries(registration);
    expect(inspection.snapshot).toBeDefined();
    await commitBridgeState(
      (current) => ({
        ...current,
        registrations: current.registrations.map((r) =>
          r.id === registrationId ? { ...r, validationSnapshot: inspection.treeFingerprint ?? inspection.snapshot!.fingerprint } : r,
        ),
        installations: [
          ...current.installations,
          {
            // Canonical Installation ID is the Plugin ID itself (Global-only).
            id: `${inspection.marketplaceId}/release-helper`,
            pluginId: `${inspection.marketplaceId}/release-helper`,
            installationState: 'enabled' as const,
            registrationId,
            marketplaceEntryId: `${inspection.marketplaceId}${inspection.entries[0]!.entry.entryId}`,
            validationSnapshot: inspection.snapshot!.fingerprint,
          },
        ],
      }),
      opts,
    );
  }

  it('projects a Compatible Plugin skill through Pi discovery at its original snapshot path, with Bridge-held provenance', async () => {
    await installFirstEntry(GLOBAL_REG);
    const state = (await readBridgeState({ agentDir: env.agentDir })).state!;
    const projection = projectEffectiveState(state, { agentDir: env.agentDir });

    expect(projection.plugins).toHaveLength(1);
    const plugin = projection.plugins[0]!;
    expect(plugin.registrationId).toBe(GLOBAL_REG); // provenance held by the Bridge
    expect(plugin.skills).toHaveLength(1);
    const skill = plugin.skills[0]!;
    expect(skill.name).toBe('release-notes');
    // Pi discovery may canonicalize symlinked tmp roots; compare resolved locations.
    expect(realpathSync(skill.discoveryPath!)).toBe(realpathSync(join(env.globalMarketplace, 'plugins', 'release-helper', 'skills', 'release-notes', 'SKILL.md')));
    expect(existsSync(skill.discoveryPath!)).toBe(true); // exposed at the original tree location, not a copy
    expect(skill.availability).toBe('snapshot-eligible'); // Available requires independent host evidence
    expect(projection.findings).toEqual([]);
  });

  it('establishes Available only from independent host evidence', async () => {
    await installFirstEntry(GLOBAL_REG);
    const state = (await readBridgeState({ agentDir: env.agentDir })).state!;
    const projection = projectEffectiveState(state, {
      agentDir: env.agentDir,
      hostAvailabilityEvidence: (name: string) => name === 'release-notes',
    });
    expect(projection.plugins[0]!.skills[0]!.availability).toBe('available');
  });

  it('denies the whole Plugin when Source Drift invalidates the recorded snapshot, leaving Bridge State unchanged', async () => {
    await installFirstEntry(GLOBAL_REG);
    // External tamper outside Marketplace Refresh:
    writeFileSync(join(env.globalMarketplace, 'plugins', 'release-helper', 'skills', 'release-notes', 'SKILL.md'), '---\nname: release-notes\ndescription: changed\n---\n\ndrifted.\n');
    const revisionBefore = (await readBridgeState({ agentDir: env.agentDir })).state!.stateRevision;

    const state = (await readBridgeState({ agentDir: env.agentDir })).state!;
    const projection = projectEffectiveState(state, { agentDir: env.agentDir });

    expect(projection.plugins).toHaveLength(0); // affected Installation cannot become a Projected Plugin
    expect(projection.denied).toHaveLength(1);
    expect(projection.denied[0]?.reason.code).toBe('SOURCE_DRIFT');
    expect(projection.denied[0]?.reason.rule).toBe('DRIFT-01');
    expect((await readBridgeState({ agentDir: env.agentDir })).state!.stateRevision).toBe(revisionBefore); // Bridge State unchanged
  });

  it('resolves Runtime Skill Collision against the Pi layer at skill granularity: Pi reserves the name, Plugins stay projected', async () => {
    // Two Global plugins expose the same exact Skill Descriptor name; a pre-existing Pi skill
    // claims it. Both Plugins remain projected; both Bridge skills are denied at skill granularity.
    makePluginMarketplace(env.root + '/marketplace-two', 'beta-marketplace', 'helper-two', 'helper-two', ['release-notes']);
    const SECOND_REG = 'eeeeeeee-2222-4222-8222-222222222222';
    await installFirstEntry(GLOBAL_REG);
    await registerLocal(SECOND_REG, join(env.root, 'marketplace-two'), env);
    await installFirstEntry(SECOND_REG);

    const state = (await readBridgeState({ agentDir: env.agentDir })).state!;
    const projection = projectEffectiveState(state, { agentDir: env.agentDir, piSkillNames: ['release-notes'] });

    expect(projection.plugins).toHaveLength(2);
    const unavailable = projection.plugins.flatMap((p) => p.skills.filter((s) => s.status === 'unavailable-collision').map((s) => s.skillId));
    expect(unavailable).toHaveLength(2); // both Bridge candidates denied by the Pi claim
    // skill-granular findings only — never whole-Plugin denials
    expect(projection.denied).toHaveLength(0);
    expect(projection.findings.length).toBeGreaterThanOrEqual(1);
    for (const finding of projection.findings) {
      expect(finding.code).toBe('RUNTIME_SKILL_COLLISION');
      expect(finding.classification).toBe('blocking');
      expect(finding.target).toBe('skill');
    }
  });

  it('denies the whole Plugin when its entry is Unavailable while other Plugins still project', async () => {
    await installFirstEntry(GLOBAL_REG);
    const opts = { agentDir: env.agentDir };

    // Forge an enabled Installation whose Marketplace Entry points at a nonexistent entry of the
    // same registration — the entry cannot be resolved to an activatable Plugin.
    const current = (await readBridgeState(opts)).state!;
    const registration = current.registrations.find((r) => r.id === GLOBAL_REG)!;
    const { inspectMarketplaceEntries } = await import('../../src/installation/inspection.js');
    const inspection = inspectMarketplaceEntries(registration);
    const marketplaceId = inspection.marketplaceId!;
    await commitBridgeState((c) => ({
        ...c,
        installations: [
          ...c.installations,
          { id: `${marketplaceId}/ghost`, pluginId: `${marketplaceId}/ghost`, installationState: 'enabled' as const, registrationId: GLOBAL_REG, marketplaceEntryId: `${marketplaceId}/plugins/99` },
        ],
      }),
      opts,
    );

    const after = (await readBridgeState(opts)).state!;
    const projection = projectEffectiveState(after, opts);
    // Whole-Plugin Blocking Finding denies only that Plugin; the healthy one stays projected.
    expect(projection.plugins.map((p) => p.pluginId)).toEqual([`${marketplaceId}/release-helper`]);
    expect(projection.denied).toHaveLength(1);
    expect(projection.denied[0]?.installationId).toContain('ghost');
  });

  it('reports Pending Application unless host-verifiable reload succeeds at the expected State Revision', async () => {
    await installFirstEntry(GLOBAL_REG);
    const input = {
      stateRevision: '7',
      validationSnapshot: 'snapshot-runtime-7',
    };
    const pending = await requestRuntimeApplication(async () => false, input);
    expect(pending.outcome).toBe('pending-application');
    expect(pending.receipt.expectedStateRevision).toBe('7');
    expect(pending.receipt.validationSnapshot).toBe('snapshot-runtime-7');
    const applied = await requestRuntimeApplication(async () => true, input);
    expect(applied.outcome).toBe('applied');
    expect(applied.receipt.summary).toBe('Completed');
    expect(applied.receipt.validationSnapshot).toBe('snapshot-runtime-7');
    expect(pending.receipt.summary).toBe('Pending Application');
  });

  it('never reports Applied while a whole-Plugin Blocking Finding stands, even with successful reload', async () => {
    const blockingFinding = {
      code: 'SOURCE_DRIFT', classification: 'blocking' as const, phase: 'validation' as const,
      target: 'registration' as const, pointer: '', rule: 'DRIFT-01', outcome: 'Source Drift denies whole-Plugin activation',
    };
    const result = await requestRuntimeApplication(async () => true, {
      stateRevision: '9',
      wholePluginFindings: [blockingFinding],
    });
    expect(result.outcome).toBe('pending-application'); // reload alone is insufficient
    expect(result.receipt.summary).toBe('Pending Application');
    expect(result.receipt.findings).toHaveLength(1);
  });
});
