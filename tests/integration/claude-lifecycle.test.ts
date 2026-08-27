import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { commitBridgeState, readBridgeState } from '../../src/bridge-state/store.js';
import type { BridgeState, Registration } from '../../src/bridge-state/types.js';
import {
  preflightPluginInstallation,
  confirmPluginInstallation,
  preflightPluginEnable,
  confirmPluginEnable,
  preflightPluginDisable,
  confirmPluginDisable,
} from '../../src/installation/flow.js';
import { inspectMarketplaceEntries } from '../../src/installation/inspection.js';
import { computeEffectiveState } from '../../src/projection/effective-state.js';
import { discoverProjectedSkillPaths } from '../../src/projection/exposure.js';
import { projectEffectiveState, requestRuntimeApplication } from '../../src/projection/runtime.js';
import { refreshRegistration } from '../../src/lifecycle/refresh.js';
import { buildUpdatePlan } from '../../src/lifecycle/update-plan.js';
import { applyUpdate } from '../../src/lifecycle/update.js';
import {
  preflightRegistrationRemoval,
  confirmRegistrationRemoval,
  preflightInstallationRemoval,
  confirmInstallationRemoval,
} from '../../src/lifecycle/removal.js';

import { localSourceKey } from '../../src/registration/source-key.js';

type Env = { agentDir: string; root: string; marketplace: string };

function makeEnv(): Env {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-lifecycle-')));
  return { agentDir: join(root, 'agent'), root, marketplace: join(root, 'marketplace') };
}

/** Matt Pocock shaped Claude marketplace fixture */
function makeMattPocockMarketplace(root: string, skills: string[] = ['code-review', 'grilling']): void {
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  const pluginRoot = join(root, 'plugins', 'mattpocock-skills');
  mkdirSync(join(pluginRoot, '.claude-plugin'), { recursive: true });

  const skillPaths: string[] = [];
  for (const skill of skills) {
    let relDir: string;
    let desc: string;
    let disableModel = false;
    if (skill === 'code-review') {
      relDir = 'skills/engineering/code-review';
      desc = 'Review code changes';
      disableModel = true;
    } else if (skill === 'grilling') {
      relDir = 'skills/interview/grilling';
      desc = 'Grill the plan';
    } else {
      relDir = `skills/other/${skill}`;
      desc = `Description for ${skill}`;
    }
    skillPaths.push(`./${relDir}`);
    mkdirSync(join(pluginRoot, relDir), { recursive: true });
    writeFileSync(
      join(pluginRoot, relDir, 'SKILL.md'),
      `---\nname: ${skill}\ndescription: ${desc}\n${disableModel ? 'disable-model-invocation: true\n' : ''}---\n\n${skill} body.\n`,
    );
  }

  writeFileSync(
    join(pluginRoot, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'mattpocock-skills', skills: skillPaths }),
  );
  writeFileSync(
    join(root, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      name: 'matt-marketplace',
      owner: { name: 'Matt Pocock' },
      plugins: [
        { name: 'mattpocock-skills', source: './plugins/mattpocock-skills' },
      ],
    }),
  );
}

async function registerClaudeMarketplace(env: Env, registrationId: string): Promise<Registration> {
  const sk = localSourceKey(env.marketplace);
  const inspection = inspectMarketplaceEntries({
    id: registrationId,
    sourceKind: 'local',
    source: env.marketplace,
    format: 'claude',
  });
  expect(inspection.snapshot).toBeDefined();

  const registration: Registration = {
    id: registrationId,
    alias: 'matt-plugins',
    marketplaceName: 'matt-marketplace',
    sourceKind: 'local',
    source: env.marketplace,
    sourceKey: sk.sourceKey,
    format: 'claude',
    validationSnapshot: inspection.treeFingerprint ?? inspection.snapshot!.fingerprint,
  };

  await commitBridgeState(
    (state: BridgeState) => ({
      ...state,
      registrations: [...state.registrations, registration],
    }),
    { agentDir: env.agentDir },
  );
  return registration;
}

describe('Claude plugin full lifecycle & acceptance scenarios (#48)', () => {
  let env: Env;
  const REG_ID = 'cccccccc-3333-4333-8333-333333333333';

  beforeEach(() => {
    env = makeEnv();
    makeMattPocockMarketplace(env.marketplace);
  });

  afterEach(() => {
    try { rmSync(env.root, { recursive: true, force: true }); } catch {}
  });

  it('Install Disabled creates disabled state; enabling requires fresh validation + Activation Confirmation', async () => {
    await registerClaudeMarketplace(env, REG_ID);

    // 1. Preflight Plugin Installation
    const preflight = await preflightPluginInstallation(REG_ID, '/plugins/0', { agentDir: env.agentDir });
    expect(preflight.ok).toBe(true);
    if (!preflight.ok) return;

    expect(preflight.preflight.plugin.manifestName).toBe('mattpocock-skills');
    expect(preflight.preflight.plugin.skills.map((s) => s.name)).toEqual(['code-review', 'grilling']);

    // 2. Install Disabled commits atomically without Activation Confirmation
    const outcome = await confirmPluginInstallation(preflight.preflight, 'disabled', false, { agentDir: env.agentDir });
    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') return;

    expect(outcome.installation.installationState).toBe('disabled');
    expect(outcome.installation.manifestName).toBe('mattpocock-skills');

    // Verify Bridge State and Effective State
    const read = await readBridgeState({ agentDir: env.agentDir });
    expect(read.state?.installations).toHaveLength(1);
    expect(read.state?.installations[0]?.installationState).toBe('disabled');

    const effective = computeEffectiveState(read.state!);
    expect(effective.installations).toHaveLength(0);

    const exposure = discoverProjectedSkillPaths({ agentDir: env.agentDir });
    expect(exposure.skillPaths).toEqual([]);
    expect(exposure.exposed).toEqual([]);

    // 3. Preflight Enable
    const enablePreflight = await preflightPluginEnable(outcome.installation.id, { agentDir: env.agentDir });
    expect(enablePreflight.ok).toBe(true);
    if (!enablePreflight.ok) return;
    expect(enablePreflight.preflight.operation).toBe('enable');

    // Confirm Enable with activationConfirmed = false -> Declined (activation confirmation required)
    const declined = await confirmPluginEnable(enablePreflight.preflight, false, { agentDir: env.agentDir });
    expect(declined.status).toBe('declined');
    expect(declined.receipt.summary).toBe('Declined');
    expect(declined.receipt.findings.some((f) => f.code === 'ACTIVATION_CONFIRMATION_REQUIRED')).toBe(true);

    // Re-verify still disabled
    const afterDecline = await readBridgeState({ agentDir: env.agentDir });
    expect(afterDecline.state?.installations[0]?.installationState).toBe('disabled');

    // 4. Preflight and Confirm Enable with activationConfirmed = true
    const reenablePreflight = await preflightPluginEnable(outcome.installation.id, { agentDir: env.agentDir });
    expect(reenablePreflight.ok).toBe(true);
    if (!reenablePreflight.ok) return;

    const enabledOutcome = await confirmPluginEnable(reenablePreflight.preflight, true, { agentDir: env.agentDir });
    expect(enabledOutcome.status).toBe('completed');
    if (enabledOutcome.status !== 'completed') return;

    expect(enabledOutcome.installation.installationState).toBe('enabled');

    // Verify Effective State and Skill Exposure now include both Claude skills
    const afterEnable = await readBridgeState({ agentDir: env.agentDir });
    const effectiveAfter = computeEffectiveState(afterEnable.state!);
    expect(effectiveAfter.installations).toHaveLength(1);

    const exposureAfter = discoverProjectedSkillPaths({ agentDir: env.agentDir });
    expect(exposureAfter.exposed.map((s) => s.name).sort()).toEqual(['code-review', 'grilling']);
    expect(exposureAfter.skillPaths).toHaveLength(2);
    for (const p of exposureAfter.skillPaths) {
      expect(existsSync(join(p, 'SKILL.md'))).toBe(true);
    }
  });

  it('completes Runtime Application and projects skills with Pi → Global precedence', async () => {
    await registerClaudeMarketplace(env, REG_ID);
    const preflight = await preflightPluginInstallation(REG_ID, '/plugins/0', { agentDir: env.agentDir });
    expect(preflight.ok).toBe(true);
    if (!preflight.ok) return;

    // Install and Enable atomically
    const outcome = await confirmPluginInstallation(preflight.preflight, 'enabled', true, { agentDir: env.agentDir });
    expect(outcome.status).toBe('completed');

    const state = (await readBridgeState({ agentDir: env.agentDir })).state!;
    const projection = projectEffectiveState(state, { agentDir: env.agentDir });

    expect(projection.plugins).toHaveLength(1);
    const plugin = projection.plugins[0]!;
    expect(plugin.manifestName).toBe('mattpocock-skills');
    expect(plugin.skills).toHaveLength(2);

    const codeReview = plugin.skills.find((s) => s.name === 'code-review')!;
    expect(codeReview.status).toBe('projected');
    expect(codeReview.availability).toBe('snapshot-eligible');
    expect(codeReview.discoveryPath).toBeDefined();
    expect(existsSync(codeReview.discoveryPath!)).toBe(true);

    const grilling = plugin.skills.find((s) => s.name === 'grilling')!;
    expect(grilling.status).toBe('projected');
    expect(grilling.availability).toBe('snapshot-eligible');

    // Runtime application transitions
    const pending = await requestRuntimeApplication(async () => false, {
      stateRevision: state.stateRevision,
      validationSnapshot: outcome.status === 'completed' ? outcome.installation.validationSnapshot : undefined,
    });
    expect(pending.outcome).toBe('pending-application');
    expect(pending.receipt.summary).toBe('Pending Application');

    const applied = await requestRuntimeApplication(async () => true, {
      stateRevision: state.stateRevision,
      validationSnapshot: outcome.status === 'completed' ? outcome.installation.validationSnapshot : undefined,
    });
    expect(applied.outcome).toBe('applied');
    expect(applied.receipt.summary).toBe('Completed');
  });

  it('resolves Runtime Skill Collision against Pi skills: colliding candidate is unavailable, non-colliding remains projected, plugin classification unaffected', async () => {
    await registerClaudeMarketplace(env, REG_ID);
    const preflight = await preflightPluginInstallation(REG_ID, '/plugins/0', { agentDir: env.agentDir });
    expect(preflight.ok).toBe(true);
    if (!preflight.ok) return;
    await confirmPluginInstallation(preflight.preflight, 'enabled', true, { agentDir: env.agentDir });

    const state = (await readBridgeState({ agentDir: env.agentDir })).state!;

    // Pi layer claims 'code-review'
    const projection = projectEffectiveState(state, {
      agentDir: env.agentDir,
      piSkillNames: ['code-review'],
    });

    expect(projection.plugins).toHaveLength(1); // Plugin remains Compatible and Projected!
    expect(projection.denied).toHaveLength(0);

    const plugin = projection.plugins[0]!;
    const codeReview = plugin.skills.find((s) => s.name === 'code-review')!;
    expect(codeReview.status).toBe('unavailable-collision');
    expect(codeReview.availability).toBe('unavailable');

    const grilling = plugin.skills.find((s) => s.name === 'grilling')!;
    expect(grilling.status).toBe('projected');
    expect(grilling.availability).toBe('snapshot-eligible');

    expect(projection.findings.some((f) => f.code === 'RUNTIME_SKILL_COLLISION' && f.pointer.includes('code-review'))).toBe(true);

    // Exposure only returns the surviving skill
    const exposure = discoverProjectedSkillPaths({ agentDir: env.agentDir, piSkillNames: ['code-review'] });
    expect(exposure.exposed.map((s) => s.name)).toEqual(['grilling']);
    expect(exposure.skillPaths).toHaveLength(1);
    expect(exposure.skillPaths[0]).toContain('grilling');
  });

  it('resolves Runtime Skill Collision between two Bridge plugins: both same-layer colliders are unavailable', async () => {
    await registerClaudeMarketplace(env, REG_ID);
    const preflight = await preflightPluginInstallation(REG_ID, '/plugins/0', { agentDir: env.agentDir });
    expect(preflight.ok).toBe(true);
    if (!preflight.ok) return;
    await confirmPluginInstallation(preflight.preflight, 'enabled', true, { agentDir: env.agentDir });

    // Create a second marketplace (e.g. Codex or Claude) that also defines 'grilling'
    const SECOND_REG = 'dddddddd-4444-4444-8444-444444444444';
    const secondMarketplace = join(env.root, 'marketplace-second');
    mkdirSync(join(secondMarketplace, '.agents', 'plugins'), { recursive: true });
    mkdirSync(join(secondMarketplace, 'plugins', 'interview-tools', '.codex-plugin'), { recursive: true });
    mkdirSync(join(secondMarketplace, 'plugins', 'interview-tools', 'skills', 'grilling'), { recursive: true });
    writeFileSync(
      join(secondMarketplace, '.agents', 'plugins', 'marketplace.json'),
      JSON.stringify({ name: 'interview-marketplace', plugins: [{ name: 'interview-tools', path: './plugins/interview-tools' }] }),
    );
    writeFileSync(
      join(secondMarketplace, 'plugins', 'interview-tools', '.codex-plugin', 'plugin.json'),
      JSON.stringify({ name: 'interview-tools', skills: './skills/' }),
    );
    writeFileSync(
      join(secondMarketplace, 'plugins', 'interview-tools', 'skills', 'grilling', 'SKILL.md'),
      '---\nname: grilling\ndescription: Another grilling skill\n---\n\nAnother grill.\n',
    );

    const inspection2 = inspectMarketplaceEntries({
      id: SECOND_REG,
      sourceKind: 'local',
      source: secondMarketplace,
      format: 'codex',
    });
    await commitBridgeState((s) => ({
      ...s,
      registrations: [...s.registrations, {
        id: SECOND_REG,
        alias: 'interview-mp',
        marketplaceName: 'interview-marketplace',
        sourceKind: 'local',
        source: secondMarketplace,
        format: 'codex',
        validationSnapshot: inspection2.treeFingerprint ?? inspection2.snapshot!.fingerprint,
      }],
      installations: [...s.installations, {
        id: `${SECOND_REG}/interview-marketplace/interview-tools`,
        pluginId: `${SECOND_REG}/interview-marketplace/interview-tools`,
        installationState: 'enabled',
        registrationId: SECOND_REG,
        marketplaceEntryId: `${SECOND_REG}/interview-marketplace/plugins/0`,
        validationSnapshot: inspection2.snapshot!.fingerprint,
        manifestName: 'interview-tools',
      }],
    }), { agentDir: env.agentDir });

    const state = (await readBridgeState({ agentDir: env.agentDir })).state!;
    const projection = projectEffectiveState(state, { agentDir: env.agentDir });

    // Both plugins are ProjectedPlugins!
    expect(projection.plugins).toHaveLength(2);
    expect(projection.denied).toHaveLength(0);

    // Both 'grilling' candidates collide in Global layer and become unavailable
    for (const plugin of projection.plugins) {
      const g = plugin.skills.find((s) => s.name === 'grilling');
      expect(g?.status).toBe('unavailable-collision');
    }

    // 'code-review' does not collide and survives
    const mattPlugin = projection.plugins.find((p) => p.manifestName === 'mattpocock-skills')!;
    const cr = mattPlugin.skills.find((s) => s.name === 'code-review')!;
    expect(cr.status).toBe('projected');

    const exposure = discoverProjectedSkillPaths({ agentDir: env.agentDir });
    expect(exposure.exposed.map((s) => s.name)).toEqual(['code-review']);
  });

  it('Refresh on upstream change produces Update Candidate; Apply Update executes Update Plan with all-or-nothing semantics', async () => {
    await registerClaudeMarketplace(env, REG_ID);
    const preflight = await preflightPluginInstallation(REG_ID, '/plugins/0', { agentDir: env.agentDir });
    expect(preflight.ok).toBe(true);
    if (!preflight.ok) return;
    const installOutcome = await confirmPluginInstallation(preflight.preflight, 'enabled', true, { agentDir: env.agentDir });
    expect(installOutcome.status).toBe('completed');
    if (installOutcome.status !== 'completed') return;

    // Upstream adds a new skill: 'prompt-craft'
    makeMattPocockMarketplace(env.marketplace, ['code-review', 'grilling', 'prompt-craft']);

    // Marketplace Refresh
    const refreshOutcome = await refreshRegistration(REG_ID, { agentDir: env.agentDir });
    expect(refreshOutcome.status).toBe('update-candidate');
    if (refreshOutcome.status !== 'update-candidate') return;

    expect(refreshOutcome.candidate.format).toBe('claude');
    expect(refreshOutcome.candidate.marketplaceName).toBe('matt-marketplace');

    const state = (await readBridgeState({ agentDir: env.agentDir })).state!;

    // Build Update Plan without registration confirmation -> rejected
    const planNoConsent = buildUpdatePlan(refreshOutcome.candidate, state.installations, state.stateRevision, {
      registrationConfirmed: false,
      choices: { [installOutcome.installation.id]: 'update' },
      activationConfirmations: { [installOutcome.installation.id]: true },
    });
    expect(planNoConsent.ok).toBe(false);

    // Build Update Plan without activation confirmation for enabled plugin -> rejected
    const planNoAct = buildUpdatePlan(refreshOutcome.candidate, state.installations, state.stateRevision, {
      registrationConfirmed: true,
      choices: { [installOutcome.installation.id]: 'update' },
      activationConfirmations: { [installOutcome.installation.id]: false },
    });
    expect(planNoAct.ok).toBe(false);

    // Complete Update Plan
    const planResult = buildUpdatePlan(refreshOutcome.candidate, state.installations, state.stateRevision, {
      registrationConfirmed: true,
      choices: { [installOutcome.installation.id]: 'update' },
      activationConfirmations: { [installOutcome.installation.id]: true },
    });
    expect(planResult.ok).toBe(true);
    if (!planResult.ok) return;

    // Apply Update
    const updateOutcome = await applyUpdate(planResult.plan, { agentDir: env.agentDir });
    expect(updateOutcome.status).toBe('completed');
    expect(updateOutcome.receipt.summary).toBe('Completed');

    // All 3 skills are now exposed
    const exposure = discoverProjectedSkillPaths({ agentDir: env.agentDir });
    expect(exposure.exposed.map((s) => s.name).sort()).toEqual(['code-review', 'grilling', 'prompt-craft']);
  });

  it('Registration Removal cascades to all associated Claude Installations', async () => {
    await registerClaudeMarketplace(env, REG_ID);
    const preflight = await preflightPluginInstallation(REG_ID, '/plugins/0', { agentDir: env.agentDir });
    expect(preflight.ok).toBe(true);
    if (!preflight.ok) return;
    await confirmPluginInstallation(preflight.preflight, 'enabled', true, { agentDir: env.agentDir });

    const stateBefore = (await readBridgeState({ agentDir: env.agentDir })).state!;
    expect(stateBefore.registrations).toHaveLength(1);
    expect(stateBefore.installations).toHaveLength(1);

    // Preflight Registration Removal
    const removalPreflight = await preflightRegistrationRemoval(REG_ID, { agentDir: env.agentDir });
    expect(removalPreflight.ok).toBe(true);
    if (!removalPreflight.ok) return;

    expect(removalPreflight.preflight.affectedInstallations).toHaveLength(1);

    // Confirm Removal
    const remOutcome = await confirmRegistrationRemoval(removalPreflight.preflight, true, { agentDir: env.agentDir });
    expect(remOutcome.status).toBe('completed');

    const stateAfter = (await readBridgeState({ agentDir: env.agentDir })).state!;
    expect(stateAfter.registrations).toHaveLength(0);
    expect(stateAfter.installations).toHaveLength(0);

    const exposure = discoverProjectedSkillPaths({ agentDir: env.agentDir });
    expect(exposure.exposed).toEqual([]);
    expect(exposure.skillPaths).toEqual([]);
  });

  it('supports Plugin Disablement and Installation Removal for Claude plugins', async () => {
    await registerClaudeMarketplace(env, REG_ID);
    const preflight = await preflightPluginInstallation(REG_ID, '/plugins/0', { agentDir: env.agentDir });
    expect(preflight.ok).toBe(true);
    if (!preflight.ok) return;
    const installOutcome = await confirmPluginInstallation(preflight.preflight, 'enabled', true, { agentDir: env.agentDir });
    expect(installOutcome.status).toBe('completed');
    if (installOutcome.status !== 'completed') return;

    const instId = installOutcome.installation.id;

    // Disablement
    const disablePreflight = await preflightPluginDisable(instId, { agentDir: env.agentDir });
    expect(disablePreflight.ok).toBe(true);
    if (!disablePreflight.ok) return;
    const disOutcome = await confirmPluginDisable(disablePreflight.preflight, { agentDir: env.agentDir });
    expect(disOutcome.status).toBe('completed');

    const stateDisabled = (await readBridgeState({ agentDir: env.agentDir })).state!;
    expect(stateDisabled.installations[0]?.installationState).toBe('disabled');
    expect(discoverProjectedSkillPaths({ agentDir: env.agentDir }).skillPaths).toEqual([]);

    // Installation Removal
    const instRemovalPreflight = await preflightInstallationRemoval(instId, { agentDir: env.agentDir });
    expect(instRemovalPreflight.ok).toBe(true);
    if (!instRemovalPreflight.ok) return;
    const remInstOutcome = await confirmInstallationRemoval(instRemovalPreflight.preflight, true, { agentDir: env.agentDir });
    expect(remInstOutcome.status).toBe('completed');

    const stateClean = (await readBridgeState({ agentDir: env.agentDir })).state!;
    expect(stateClean.registrations).toHaveLength(1); // registration retained
    expect(stateClean.installations).toHaveLength(0); // installation removed
  });
});
