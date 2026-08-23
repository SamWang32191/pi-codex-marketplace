/**
 * Integration: Scope Override lifecycle + Effective State → projection seam.
 * See issue #20 — 覆蓋、優先、碰撞的可觀察行為，以 Effective State 計算與投影接縫覆蓋。
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
import { getReceiptsJournalPath, getStatePath } from '../../src/bridge-state/paths.js';
import type { BridgeState } from '../../src/bridge-state/types.js';
import {
  createScopeOverride,
  removeScopeOverride,
} from '../../src/projection/overrides.js';
import { computeEffectiveState } from '../../src/projection/effective-state.js';
import { projectEffectiveState, requestRuntimeApplication } from '../../src/projection/project.js';

function makeEnv() {
  const root = mkdtempSync(join(tmpdir(), 'projection-integration-'));
  return {
    root,
    agentDir: join(root, 'agent'),
    projectDir: join(root, 'project'),
    globalMarketplace: join(root, 'marketplace-global'),
    projectMarketplace: join(root, 'marketplace-project'),
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

async function registerLocal(scope: 'global' | 'project', id: string, source: string, env: { agentDir: string; projectDir: string }): Promise<void> {
  await commitBridgeState(
    scope,
    (state: BridgeState) => ({
      ...state,
      registrations: [
        ...state.registrations,
        { id, alias: `alias-${id.slice(0, 6)}`, marketplaceName: 'marketplace-name', sourceKind: 'local' as const, source },
      ],
    }),
    { agentDir: env.agentDir, cwd: env.projectDir },
  );
}

describe('Scope Override lifecycle', () => {
  const GLOBAL_REG = 'cccccccc-1111-4111-8111-111111111111';
  let env: ReturnType<typeof makeEnv>;

  beforeEach(async () => {
    env = makeEnv();
    makePluginMarketplace(env.globalMarketplace, 'acme-marketplace', 'release-helper', 'release-helper', ['release-notes']);
    await registerLocal('global', GLOBAL_REG, env.globalMarketplace, env);
    // Enabled global installation created directly (lifecycle covered by ticket 04 tests).
    await commitBridgeState(
      'global',
      (state) => ({
        ...state,
        installations: [
          ...state.installations,
          {
            id: `global/acme-marketplace-${GLOBAL_REG}/release-helper`,
            pluginId: `acme-marketplace-${GLOBAL_REG}/release-helper`,
            installationState: 'enabled' as const,
            registrationId: GLOBAL_REG,
          },
        ],
      }),
      { agentDir: env.agentDir, cwd: env.projectDir },
    );
  });

  afterEach(() => rmSync(env.root, { recursive: true, force: true }));

  async function globalSnapshot(): Promise<{ state: BridgeState }> {
    const read = await readBridgeState('global', { agentDir: env.agentDir, cwd: env.projectDir });
    return { state: read.state! };
  }

  it('creates an override in the project document without rewriting the global document', async () => {
    const before = await globalSnapshot();
    const outcome = await createScopeOverride('registration', GLOBAL_REG, {
      agentDir: env.agentDir,
      cwd: env.projectDir,
      projectTrusted: true,
    });
    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') return;
    expect(outcome.receipt.summary).toBe('Completed');

    const after = await globalSnapshot();
    expect(after.state.stateRevision).toBe(before.state.stateRevision); // global document untouched

    const project = await readBridgeState('project', { agentDir: env.agentDir, cwd: env.projectDir });
    expect(project.state!.scopeOverrides).toEqual([{ kind: 'registration', targetId: GLOBAL_REG }]);
  });

  it('reports journal persistence failure when create commits State but cannot append its Receipt', async () => {
    const opts = { agentDir: env.agentDir, cwd: env.projectDir, projectTrusted: true };
    const journalPath = getReceiptsJournalPath('project', opts);
    const lockPath = `${journalPath}.lock`;
    const lockFd = acquireLockSync(lockPath);

    try {
      const outcome = await createScopeOverride('registration', GLOBAL_REG, {
        ...opts,
        journalLockTimeoutMs: 1,
      });

      expect(outcome).toEqual(expect.objectContaining({
        status: 'journal-persistence-failed',
        receiptPersisted: false,
        stateCommitted: true,
        isIndeterminate: true,
        newRevision: '1',
        error: expect.stringContaining('Failed to acquire lock'),
      }));
      expect(outcome.receipt).toEqual(expect.objectContaining({
        summary: 'Completed',
        durableOutcome: 'committed',
        stateChanged: true,
        observedStateRevision: '1',
        findings: expect.arrayContaining([
          expect.objectContaining({
            code: 'RECEIPT_PERSISTENCE_FAILED',
            rule: 'JOURNAL-01',
          }),
        ]),
      }));
      expect(Object.isFrozen(outcome.receipt)).toBe(true);
      expect((await readBridgeState('project', opts)).state!.scopeOverrides).toEqual([
        { kind: 'registration', targetId: GLOBAL_REG },
      ]);
    } finally {
      releaseLock(lockFd, lockPath);
    }
  });

  it('suppresses the inherited subtree immediately and restores inheritance immediately after removal', async () => {
    const opts = { agentDir: env.agentDir, cwd: env.projectDir, projectTrusted: true };
    await createScopeOverride('registration', GLOBAL_REG, opts);

    const suppressed = computeEffectiveState(
      (await readBridgeState('global', opts)).state!,
      (await readBridgeState('project', opts)).state!,
      { projectTrusted: true },
    );
    expect(suppressed.registrations).toEqual([]);
    expect(suppressed.installations).toEqual([]);

    const removed = await removeScopeOverride('registration', GLOBAL_REG, opts);
    expect(removed.status).toBe('completed');
    if (removed.status !== 'completed') return;
    expect(removed.receipt.summary).toBe('Completed');

    const restored = computeEffectiveState(
      (await readBridgeState('global', opts)).state!,
      (await readBridgeState('project', opts)).state!,
      { projectTrusted: true },
    );
    expect(restored.registrations.map((r) => r.id)).toEqual([GLOBAL_REG]);
    expect(restored.installations.map((i) => i.installationState)).toEqual(['enabled']);
    expect(restored.suppressed).toEqual([]);
  });

  it('reports journal persistence failure when remove commits State but cannot append its Receipt', async () => {
    const opts = { agentDir: env.agentDir, cwd: env.projectDir, projectTrusted: true };
    const created = await createScopeOverride('registration', GLOBAL_REG, opts);
    expect(created.status).toBe('completed');
    const journalPath = getReceiptsJournalPath('project', opts);
    const lockPath = `${journalPath}.lock`;
    const lockFd = acquireLockSync(lockPath);

    try {
      const outcome = await removeScopeOverride('registration', GLOBAL_REG, {
        ...opts,
        journalLockTimeoutMs: 1,
      });

      expect(outcome).toEqual(expect.objectContaining({
        status: 'journal-persistence-failed',
        receiptPersisted: false,
        stateCommitted: true,
        isIndeterminate: true,
        newRevision: '2',
      }));
      expect(outcome.receipt).toEqual(expect.objectContaining({
        operation: 'Registration Override Removal',
        summary: 'Completed',
        durableOutcome: 'committed',
        observedStateRevision: '2',
        findings: expect.arrayContaining([
          expect.objectContaining({ code: 'RECEIPT_PERSISTENCE_FAILED' }),
        ]),
      }));
      expect((await readBridgeState('project', opts)).state!.scopeOverrides).toEqual([]);
    } finally {
      releaseLock(lockFd, lockPath);
    }
  });

  it('blocks suppressing a target that does not exist in the inherited Global Scope', async () => {
    const outcome = await createScopeOverride('installation', 'global/nowhere/missing', {
      agentDir: env.agentDir,
      cwd: env.projectDir,
      projectTrusted: true,
    });
    expect(outcome.status).toBe('blocked');
    if (outcome.status !== 'blocked') return;
    expect(outcome.receipt.summary).toBe('Blocked');
    expect(outcome.findings[0]?.code).toBe('SCOPE_OVERRIDE_TARGET_NOT_FOUND');
  });

  it('blocks a duplicate override instead of writing it twice', async () => {
    const opts = { agentDir: env.agentDir, cwd: env.projectDir, projectTrusted: true };
    await createScopeOverride('registration', GLOBAL_REG, opts);
    const again = await createScopeOverride('registration', GLOBAL_REG, opts);
    expect(again.status).toBe('blocked');
    if (again.status !== 'blocked') return;
    expect(again.findings[0]?.code).toBe('SCOPE_OVERRIDE_ALREADY_PRESENT');
  });

  it('blocks all Project Scope mutations when Project Trust is not granted', async () => {
    const outcome = await createScopeOverride('registration', GLOBAL_REG, {
      agentDir: env.agentDir,
      cwd: env.projectDir,
      projectTrusted: false,
    });
    expect(outcome.status).toBe('blocked');
    if (outcome.status !== 'blocked') return;
    expect(outcome.findings[0]?.code).toBe('PROJECT_TRUST_DENIED');
  });

  it('reports journal persistence failure when a pre-commit Blocked Receipt cannot be appended', async () => {
    const opts = { agentDir: env.agentDir, cwd: env.projectDir, projectTrusted: false };
    const journalPath = getReceiptsJournalPath('project', opts);
    const lockPath = `${journalPath}.lock`;
    const lockFd = acquireLockSync(lockPath);

    try {
      const outcome = await createScopeOverride('registration', GLOBAL_REG, {
        ...opts,
        journalLockTimeoutMs: 1,
      });

      expect(outcome).toEqual(expect.objectContaining({
        status: 'journal-persistence-failed',
        receiptPersisted: false,
        stateCommitted: false,
        isIndeterminate: false,
        error: expect.stringContaining('Failed to acquire lock'),
      }));
      expect(outcome.receipt).toEqual(expect.objectContaining({
        summary: 'Blocked',
        durableOutcome: 'unchanged',
        stateChanged: false,
        findings: expect.arrayContaining([
          expect.objectContaining({ code: 'PROJECT_TRUST_DENIED' }),
          expect.objectContaining({ code: 'RECEIPT_PERSISTENCE_FAILED' }),
        ]),
      }));
      expect((await readBridgeState('project', opts)).state!.scopeOverrides).toEqual([]);
    } finally {
      releaseLock(lockFd, lockPath);
    }
  });

  it('rejects the sheet-bound revision when Project state already moved before domain admission', async () => {
    const opts = { agentDir: env.agentDir, cwd: env.projectDir, projectTrusted: true };
    const presentedRevision = (await readBridgeState('project', opts)).state!.stateRevision;
    await commitBridgeState('project', (state) => ({ ...state }), opts);

    const outcome = await createScopeOverride('registration', GLOBAL_REG, {
      ...opts,
      expectedStateRevision: presentedRevision,
    });

    expect(outcome.status).toBe('rejected-as-stale');
    expect(outcome.receipt).toEqual(expect.objectContaining({
      expectedStateRevision: presentedRevision,
      observedStateRevision: '1',
      summary: 'Rejected as Stale',
    }));
    expect((await readBridgeState('project', opts)).state!.scopeOverrides).toEqual([]);
  });

  it('reports journal persistence failure when a pre-commit Stale Receipt cannot be appended', async () => {
    const opts = { agentDir: env.agentDir, cwd: env.projectDir, projectTrusted: true };
    const presentedRevision = (await readBridgeState('project', opts)).state!.stateRevision;
    await commitBridgeState('project', (state) => ({ ...state }), opts);
    const journalPath = getReceiptsJournalPath('project', opts);
    const lockPath = `${journalPath}.lock`;
    const lockFd = acquireLockSync(lockPath);

    try {
      const outcome = await createScopeOverride('registration', GLOBAL_REG, {
        ...opts,
        expectedStateRevision: presentedRevision,
        journalLockTimeoutMs: 1,
      });

      expect(outcome).toEqual(expect.objectContaining({
        status: 'journal-persistence-failed',
        receiptPersisted: false,
        stateCommitted: false,
        isIndeterminate: false,
      }));
      expect(outcome.receipt).toEqual(expect.objectContaining({
        summary: 'Rejected as Stale',
        durableOutcome: 'unchanged',
        expectedStateRevision: presentedRevision,
        observedStateRevision: '1',
        findings: expect.arrayContaining([
          expect.objectContaining({ code: 'REJECTED_AS_STALE' }),
          expect.objectContaining({ code: 'RECEIPT_PERSISTENCE_FAILED' }),
        ]),
      }));
      expect((await readBridgeState('project', opts)).state!.scopeOverrides).toEqual([]);
    } finally {
      releaseLock(lockFd, lockPath);
    }
  });

  it('preserves State indeterminacy when its Persistence Receipt also cannot be appended', async () => {
    const opts = { agentDir: env.agentDir, cwd: env.projectDir, projectTrusted: true };
    await commitBridgeState('project', (state) => ({ ...state }), opts);
    writeFileSync(getStatePath('project', opts), '{ corrupted Project State', 'utf-8');
    const journalPath = getReceiptsJournalPath('project', opts);
    const lockPath = `${journalPath}.lock`;
    const lockFd = acquireLockSync(lockPath);

    try {
      const outcome = await createScopeOverride('registration', GLOBAL_REG, {
        ...opts,
        expectedStateRevision: '1',
        journalLockTimeoutMs: 1,
      });

      expect(outcome).toEqual(expect.objectContaining({
        status: 'journal-persistence-failed',
        receiptPersisted: false,
        stateCommitted: false,
        isIndeterminate: true,
      }));
      expect(outcome.receipt).toEqual(expect.objectContaining({
        summary: 'Persistence Indeterminate',
        durableOutcome: 'indeterminate',
        expectedStateRevision: '1',
        findings: expect.arrayContaining([
          expect.objectContaining({ code: 'PERSISTENCE_INDETERMINATE' }),
          expect.objectContaining({ code: 'RECEIPT_PERSISTENCE_FAILED' }),
        ]),
      }));
    } finally {
      releaseLock(lockFd, lockPath);
    }
  });

  it('rejects as stale when the project State Revision moves between admission and commit', async () => {
    const opts = { agentDir: env.agentDir, cwd: env.projectDir, projectTrusted: true };
    const outcome = await createScopeOverride('registration', GLOBAL_REG, {
      ...opts,
      // Integration synchronization seam: mutate Bridge State after read, before commit.
      beforeCommit: async () => {
        await commitBridgeState('project', (state) => ({ ...state }), opts);
      },
    });
    expect(outcome.status).toBe('rejected-as-stale');
  });
});

describe('Projection onto the Pi resource-discovery seam', () => {
  const GLOBAL_REG = 'dddddddd-1111-4111-8111-111111111111';
  let env: ReturnType<typeof makeEnv>;

  beforeEach(async () => {
    env = makeEnv();
    makePluginMarketplace(env.globalMarketplace, 'acme-marketplace', 'release-helper', 'release-helper', ['release-notes']);
    await registerLocal('global', GLOBAL_REG, env.globalMarketplace, env);
  });

  afterEach(() => rmSync(env.root, { recursive: true, force: true }));

  /** Install the first entry of the registration as enabled, binding the inspected fingerprint. */
  async function installFirstEntry(scope: 'global' | 'project', registrationId: string): Promise<void> {
    const opts = { agentDir: env.agentDir, cwd: env.projectDir };
    const { inspectMarketplaceEntries } = await import('../../src/installation/inspection.js');
    const state = (await readBridgeState(scope, opts)).state!;
    const registration = state.registrations.find((r) => r.id === registrationId)!;
    const inspection = inspectMarketplaceEntries(registration, scope);
    expect(inspection.snapshot).toBeDefined();
    await commitBridgeState(
      scope,
      (current) => ({
        ...current,
        registrations: current.registrations.map((r) =>
          r.id === registrationId ? { ...r, validationSnapshot: inspection.treeFingerprint ?? inspection.snapshot!.fingerprint } : r,
        ),
        installations: [
          ...current.installations,
          {
            id: `${scope}/${inspection.marketplaceId}/release-helper`,
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
    await installFirstEntry('global', GLOBAL_REG);
    const opts = { agentDir: env.agentDir, cwd: env.projectDir, projectTrusted: true };

    const global = (await readBridgeState('global', opts)).state!;
    const project = (await readBridgeState('project', opts)).state!;
    const projection = projectEffectiveState(global, project, opts);

    expect(projection.plugins).toHaveLength(1);
    const plugin = projection.plugins[0]!;
    expect(plugin.sourceScope).toBe('global');
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
    await installFirstEntry('global', GLOBAL_REG);
    const opts = {
      agentDir: env.agentDir,
      cwd: env.projectDir,
      projectTrusted: true,
      hostAvailabilityEvidence: (name: string) => name === 'release-notes',
    };
    const global = (await readBridgeState('global', opts)).state!;
    const project = (await readBridgeState('project', opts)).state!;
    const projection = projectEffectiveState(global, project, opts);
    expect(projection.plugins[0]!.skills[0]!.availability).toBe('available');
  });

  it('denies the whole Plugin when Source Drift invalidates the recorded snapshot, leaving Bridge State unchanged', async () => {
    await installFirstEntry('global', GLOBAL_REG);
    // External tamper outside Marketplace Refresh:
    writeFileSync(join(env.globalMarketplace, 'plugins', 'release-helper', 'skills', 'release-notes', 'SKILL.md'), '---\nname: release-notes\ndescription: changed\n---\n\ndrifted.\n');
    const revisionBefore = (await readBridgeState('global', { agentDir: env.agentDir, cwd: env.projectDir })).state!.stateRevision;

    const opts = { agentDir: env.agentDir, cwd: env.projectDir, projectTrusted: true };
    const global = (await readBridgeState('global', opts)).state!;
    const project = (await readBridgeState('project', opts)).state!;
    const projection = projectEffectiveState(global, project, opts);

    expect(projection.plugins).toHaveLength(0); // affected Installation cannot become a Projected Plugin
    expect(projection.denied).toHaveLength(1);
    expect(projection.denied[0]?.reason.code).toBe('SOURCE_DRIFT');
    expect(projection.denied[0]?.reason.rule).toBe('DRIFT-01');
    expect((await readBridgeState('global', opts)).state!.stateRevision).toBe(revisionBefore); // Bridge State unchanged
  });

  it('resolves cross-scope Runtime Skill Collision at skill granularity: Project reserves the name, Plugin stays projected', async () => {
    const PROJECT_REG = 'eeeeeeee-2222-4222-8222-222222222222';
    makePluginMarketplace(env.projectMarketplace, 'beta-marketplace', 'helper-two', 'helper-two', ['release-notes']);
    await installFirstEntry('global', GLOBAL_REG);
    await registerLocal('project', PROJECT_REG, env.projectMarketplace, env);
    await commitBridgeState(
      'project',
      (state) => ({ ...state, registrations: state.registrations.map((r) => (r.id === PROJECT_REG ? { ...r, validationSnapshot: undefined } : r)) }),
      { agentDir: env.agentDir, cwd: env.projectDir },
    );
    await installFirstEntry('project', PROJECT_REG);

    const opts = { agentDir: env.agentDir, cwd: env.projectDir, projectTrusted: true };
    const global = (await readBridgeState('global', opts)).state!;
    const project = (await readBridgeState('project', opts)).state!;
    const projection = projectEffectiveState(global, project, opts);

    // Both Plugins remain Projected — collision never changes Projected Plugin determination.
    expect(projection.plugins).toHaveLength(2);
    const projected = projection.plugins.flatMap((p) => p.skills.filter((s) => s.status === 'projected').map((s) => s.pluginId));
    const unavailable = projection.plugins.flatMap((p) => p.skills.filter((s) => s.status === 'unavailable-collision').map((s) => s.pluginId));
    expect(projected).toHaveLength(1); // project survivor reserves the name
    expect(unavailable).toHaveLength(1); // global candidate unavailable
    const winner = projection.plugins.find((p) => p.skills.some((s) => s.status === 'projected'))!;
    expect(winner.sourceScope).toBe('project');
    // skill-granular finding only
    expect(projection.findings).toHaveLength(1);
    expect(projection.findings[0]?.code).toBe('RUNTIME_SKILL_COLLISION');
    expect(projection.findings[0]?.classification).toBe('blocking');
    expect(projection.findings[0]?.target).toBe('skill');
  });

  it('denies the whole Plugin when its entry is Unavailable while other Plugins still project', async () => {
    await installFirstEntry('global', GLOBAL_REG);
    const opts = { agentDir: env.agentDir, cwd: env.projectDir, projectTrusted: true };

    // Forge an enabled Installation whose Marketplace Entry points at a nonexistent entry of the
    // same registration — the entry cannot be resolved to an activatable Plugin.
    const global = (await readBridgeState('global', opts)).state!;
    const registration = global.registrations.find((r) => r.id === GLOBAL_REG)!;
    const { inspectMarketplaceEntries } = await import('../../src/installation/inspection.js');
    const inspection = inspectMarketplaceEntries(registration, 'global');
    const marketplaceId = inspection.marketplaceId!;
    await commitBridgeState(
      'global',
      (current) => ({
        ...current,
        installations: [
          ...current.installations,
          { id: `${marketplaceId}/ghost`, pluginId: `${marketplaceId}/ghost`, installationState: 'enabled' as const, registrationId: GLOBAL_REG, marketplaceEntryId: `${marketplaceId}/plugins/99` },
        ],
      }),
      opts,
    );

    const after = (await readBridgeState('global', opts)).state!;
    const projection = projectEffectiveState(after, (await readBridgeState('project', opts)).state!, opts);
    // Whole-Plugin Blocking Finding denies only that Plugin; the healthy one stays projected.
    expect(projection.plugins.map((p) => p.pluginId)).toEqual([`${marketplaceId}/release-helper`]);
    expect(projection.denied).toHaveLength(1);
    expect(projection.denied[0]?.installationId).toContain('ghost');
  });

  it('reports Pending Application unless host-verifiable reload succeeds at the expected State Revision', async () => {
    await installFirstEntry('global', GLOBAL_REG);
    const input = {
      stateRevision: '7',
      validationSnapshot: 'snapshot-runtime-7',
      scope: 'global' as const,
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
      target: 'registration' as const, scope: 'global' as const, pointer: '', rule: 'DRIFT-01', outcome: 'Source Drift denies whole-Plugin activation',
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
