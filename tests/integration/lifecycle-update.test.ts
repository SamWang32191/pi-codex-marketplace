import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readBridgeState } from '../../src/bridge-state/store.js';
import { disablePluginInstallation, preflightPluginInstallation, confirmPluginInstallation } from '../../src/installation/flow.js';
import { applyUpdate } from '../../src/lifecycle/update.js';
import { refreshRegistration } from '../../src/lifecycle/refresh.js';
import { buildUpdatePlan } from '../../src/lifecycle/update-plan.js';
import { confirmLocalRegistration, preflightLocalRegistration } from '../../src/registration/flow.js';

function makeEnv() {
  const root = mkdtempSync(join(tmpdir(), 'lifecycle-update-'));
  return {
    root,
    agentDir: join(root, 'agent'),
    projectDir: join(root, 'project'),
    marketplace: join(root, 'marketplace'),
  };
}

function writePlugin(root: string, name: string, skill: string, skillDescription: string) {
  mkdirSync(join(root, 'plugins', name, '.codex-plugin'), { recursive: true });
  mkdirSync(join(root, 'plugins', name, 'skills', skill), { recursive: true });
  writeFileSync(join(root, 'plugins', name, '.codex-plugin', 'plugin.json'), JSON.stringify({ name, skills: './skills/' }));
  writeFileSync(
    join(root, 'plugins', name, 'skills', skill, 'SKILL.md'),
    `---\nname: ${skill}\ndescription: ${skillDescription}\n---\n\n${skillDescription}.\n`,
  );
}

function makeMarketplace(root: string) {
  mkdirSync(join(root, '.agents', 'plugins'), { recursive: true });
  writeFileSync(
    join(root, '.agents', 'plugins', 'marketplace.json'),
    JSON.stringify({
      name: 'acme-marketplace',
      plugins: [
        { name: 'release-helper', source: { source: 'local', path: './plugins/release-helper' } },
        { name: 'deploy-helper', source: { source: 'local', path: './plugins/deploy-helper' } },
      ],
    }),
  );
  writePlugin(root, 'release-helper', 'release-notes', 'Write release notes');
  writePlugin(root, 'deploy-helper', 'deploy-notes', 'Write deploy notes');
}

interface Fixture {
  registrationId: string;
  opts: { agentDir: string; cwd: string };
}

async function seedEnabledAndDisabled(env: ReturnType<typeof makeEnv>): Promise<Fixture> {
  const opts = { agentDir: env.agentDir, cwd: env.projectDir };
  const preflight = await preflightLocalRegistration('global', env.marketplace, opts);
  expect(preflight.ok).toBe(true);
  if (!preflight.ok) throw new Error('preflight failed');
  const confirmed = await confirmLocalRegistration(preflight.preflight, true, opts);
  expect(confirmed.status).toBe('completed');
  if (confirmed.status !== 'completed') throw new Error('confirm failed');
  const registrationId = confirmed.registration.id;

  // Entry 0 installed disabled, entry 1 installed and enabled (with its own Activation Confirmation).
  for (const [pointer, target] of [['/plugins/0', 'disabled'] as const, ['/plugins/1', 'enabled'] as const]) {
    const pf = await preflightPluginInstallation('global', registrationId, pointer, opts);
    expect(pf.ok).toBe(true);
    if (!pf.ok) throw new Error('install preflight failed');
    const done = await confirmPluginInstallation(pf.preflight, target, true, opts);
    expect(done.status).toBe('completed');
    if (done.status !== 'completed') throw new Error('install confirm failed');
  }
  return { registrationId, opts };
}

async function driftSource(env: ReturnType<typeof makeEnv>) {
  mkdirSync(join(env.marketplace, 'plugins', 'release-helper', 'skills', 'changelog'), { recursive: true });
  writeFileSync(
    join(env.marketplace, 'plugins', 'release-helper', 'skills', 'changelog', 'SKILL.md'),
    '---\nname: changelog\ndescription: Maintain changelog\n---\n\nMaintain the changelog.\n',
  );
}

describe('Apply Update — one atomic Lifecycle Operation over the whole Update Plan', () => {
  let env: ReturnType<typeof makeEnv>;
  let fixture: Fixture;

  beforeEach(async () => {
    env = makeEnv();
    makeMarketplace(env.marketplace);
    fixture = await seedEnabledAndDisabled(env);
    await driftSource(env);
  });

  afterEach(() => rmSync(env.root, { recursive: true, force: true }));

  async function planFromRefresh() {
    const refreshed = await refreshRegistration('global', fixture.registrationId, fixture.opts);
    expect(refreshed.status).toBe('update-candidate');
    if (refreshed.status !== 'update-candidate') throw new Error('expected candidate');
    const state = await readBridgeState('global', fixture.opts);
    const installations = state.state!.installations;
    const plan = buildUpdatePlan(refreshed.candidate, installations, state.state!.stateRevision, {
      registrationConfirmed: true,
      choices: Object.fromEntries(installations.map((i) => [i.id, i.installationState === 'enabled' ? 'update' as const : 'update' as const])),
      activationConfirmations: Object.fromEntries(installations.filter((i) => i.installationState === 'enabled').map((i) => [i.id, true])),
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error(`plan problems: ${plan.problems.map((p) => p.outcome).join('; ')}`);
    return plan.plan;
  }

  it('replaces the Registration snapshot and every disclosed consequence in a single revision bump', async () => {
    const before = await readBridgeState('global', fixture.opts);
    const recorded = before.state!.registrations[0].validationSnapshot;
    const plan = await planFromRefresh();

    const outcome = await applyUpdate(plan, fixture.opts);

    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') return;
    expect(outcome.receipt.operation).toBe('Apply Update');
    expect(BigInt(outcome.newRevision)).toBe(BigInt(before.state!.stateRevision) + 1n);

    const after = await readBridgeState('global', fixture.opts);
    const reg = after.state!.registrations.find((r) => r.id === fixture.registrationId)!;
    expect(reg.validationSnapshot).not.toBe(recorded);
    expect(plan.entries).toHaveLength(2);

    // Updated installations carry their new activation-bound snapshot; each keeps its own state.
    const keptEnabled = after.state!.installations.find((i) => i.pluginId.endsWith('/deploy-helper'))!;
    expect(keptEnabled.installationState).toBe('enabled');
    expect(keptEnabled.validationSnapshot).toBeDefined();
    expect(keptEnabled.validationSnapshot).not.toBe(recorded);

    const keptDisabled = after.state!.installations.find((i) => i.pluginId.endsWith('/release-helper'))!;
    expect(keptDisabled.installationState).toBe('disabled');

    const stillThere = after.state!.installations.filter((i) => i.registrationId === fixture.registrationId);
    expect(stillThere).toHaveLength(2);
  });

  it('rejects a Stale Snapshot submission when the State Revision moved after the plan was built', async () => {
    const plan = await planFromRefresh();

    // Any unrelated same-scope mutation invalidates the bound State Revision.
    const stateBefore = await readBridgeState('global', fixture.opts);
    const victim = stateBefore.state!.installations.find((i) => i.pluginId.endsWith('/deploy-helper'))!;
    await disablePluginInstallation('global', victim.id, fixture.opts);

    const outcome = await applyUpdate(plan, fixture.opts);
    expect(outcome.status).toBe('rejected-as-stale');
    if (outcome.status !== 'rejected-as-stale') return;
    expect(outcome.receipt.summary).toBe('Rejected as Stale');
    expect(outcome.receipt.stateChanged).toBe(false);

    // Nothing mixed in: the recorded snapshot is untouched.
    const after = await readBridgeState('global', fixture.opts);
    expect(after.state!.registrations[0].validationSnapshot).toBe(stateBefore.state!.registrations[0].validationSnapshot);
    expect(after.state!.installations.some((i) => i.pluginId.endsWith('/release-helper'))).toBe(true);
  });

  it('rejects Apply Update when the live source drifted between Refresh and Apply (fingerprint no longer matches)', async () => {
    const plan = await planFromRefresh();

    // Drift AFTER the candidate was produced but BEFORE the commit.
    mkdirSync(join(env.marketplace, 'plugins', 'deploy-helper', 'skills', 'rollback'), { recursive: true });
    writeFileSync(
      join(env.marketplace, 'plugins', 'deploy-helper', 'skills', 'rollback', 'SKILL.md'),
      '---\nname: rollback\ndescription: Roll back deploys\n---\n\nRoll back.\n',
    );

    const outcome = await applyUpdate(plan, fixture.opts);
    expect(outcome.status).toBe('rejected-as-stale');

    const after = await readBridgeState('global', fixture.opts);
    expect(after.state!.stateRevision).toBe(plan.stateRevision);
  });

  it('blocks when the Registration disappeared between planning and applying', async () => {
    const plan = await planFromRefresh();
    // Remove the registration directly (simulating another actor's committed removal).
    await import('../../src/bridge-state/store.js').then(async ({ commitBridgeState }) => {
      await commitBridgeState('global', (current) => ({
        ...current,
        registrations: current.registrations.filter((r) => r.id !== fixture.registrationId),
        installations: [],
      }), fixture.opts);
    });

    const outcome = await applyUpdate(plan, fixture.opts);
    expect(outcome.status).toBe('blocked');
    if (outcome.status !== 'blocked') return;
    expect(outcome.findings[0].code).toBe('REGISTRATION_NOT_FOUND');
  });
});
