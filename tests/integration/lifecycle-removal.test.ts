import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { commitBridgeState, readBridgeState } from '../../src/bridge-state/store.js';
import {
  confirmInstallationRemoval,
  confirmRegistrationRemoval,
  installationRemovalDisclosure,
  preflightInstallationRemoval,
  preflightRegistrationRemoval,
  registrationRemovalDisclosure,
} from '../../src/lifecycle/removal.js';
import { confirmPluginInstallation, preflightPluginInstallation } from '../../src/installation/flow.js';
import { confirmLocalRegistration, preflightLocalRegistration } from '../../src/registration/flow.js';

function makeEnv() {
  const root = mkdtempSync(join(tmpdir(), 'lifecycle-removal-'));
  return {
    root,
    agentDir: join(root, 'agent'),
    projectDir: join(root, 'project'),
    marketGlobal: join(root, 'market-global'),
    marketProject: join(root, 'market-project'),
  };
}

function writeMarketplace(root: string) {
  mkdirSync(join(root, '.agents', 'plugins'), { recursive: true });
  mkdirSync(join(root, 'plugins', 'release-helper', '.codex-plugin'), { recursive: true });
  mkdirSync(join(root, 'plugins', 'release-helper', 'skills', 'release-notes'), { recursive: true });
  writeFileSync(
    join(root, '.agents', 'plugins', 'marketplace.json'),
    JSON.stringify({ name: 'acme-marketplace', plugins: [{ name: 'release-helper', source: { source: 'local', path: './plugins/release-helper' } }] }),
  );
  writeFileSync(join(root, 'plugins', 'release-helper', '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'release-helper', skills: './skills/' }));
  writeFileSync(
    join(root, 'plugins', 'release-helper', 'skills', 'release-notes', 'SKILL.md'),
    '---\nname: release-notes\ndescription: Write release notes\n---\n\nWrite release notes.\n',
  );
}

interface Seed {
  registrationId: string;
  pluginId: string;
}

async function registerAndInstall(scope: 'global' | 'project', marketplace: string, env: ReturnType<typeof makeEnv>, target: 'enabled' | 'disabled'): Promise<Seed> {
  const opts = { agentDir: env.agentDir, cwd: env.projectDir, projectTrusted: true };
  const preflight = await preflightLocalRegistration(scope, marketplace, opts);
  expect(preflight.ok).toBe(true);
  if (!preflight.ok) throw new Error('seed preflight failed');
  const confirmed = await confirmLocalRegistration(preflight.preflight, true, opts);
  expect(confirmed.status).toBe('completed');
  if (confirmed.status !== 'completed') throw new Error('seed confirm failed');
  const installPf = await preflightPluginInstallation(scope, confirmed.registration.id, '/plugins/0', opts);
  expect(installPf.ok).toBe(true);
  if (!installPf.ok) throw new Error('install preflight failed');
  const installed = await confirmPluginInstallation(installPf.preflight, target, target === 'enabled', opts);
  expect(installed.status).toBe('completed');
  if (installed.status !== 'completed') throw new Error('install confirm failed');
  return { registrationId: confirmed.registration.id, pluginId: installed.installation.pluginId };
}

describe('Registration Removal — atomic cascade over same-scope Installations', () => {
  let env: ReturnType<typeof makeEnv>;

  beforeEach(async () => {
    env = makeEnv();
    writeMarketplace(env.marketGlobal);
    writeMarketplace(env.marketProject);
  });

  afterEach(() => rmSync(env.root, { recursive: true, force: true }));

  it('discloses every same-scope Installation and removes them with the Registration in a single commit', async () => {
    const victim = await registerAndInstall('project', env.marketProject, env, 'enabled');
    // A second, unrelated registration that must survive.
    await registerAndInstall('global', env.marketGlobal, env, 'disabled');

    const opts = { agentDir: env.agentDir, cwd: env.projectDir, projectTrusted: true };
    const before = await readBridgeState('project', opts);

    const pf = await preflightRegistrationRemoval('project', victim.registrationId, opts);
    expect(pf.ok).toBe(true);
    if (!pf.ok) return;
    expect(pf.preflight.affectedInstallations.map((i) => i.id)).toEqual([`${'project'}/${victim.pluginId}`]);

    const disclosure = registrationRemovalDisclosure(pf.preflight);
    expect(disclosure).toContain(victim.registrationId.slice(0, 8));
    expect(disclosure).toContain(victim.pluginId);

    // Default No: declining mutates nothing.
    const declined = await confirmRegistrationRemoval(pf.preflight, false, opts);
    expect(declined.status).toBe('declined');
    const afterDecline = await readBridgeState('project', opts);
    expect(afterDecline.state!.registrations).toHaveLength(1);

    // Fresh preflight, then explicit yes — exactly one revision bump.
    const pf2 = await preflightRegistrationRemoval('project', victim.registrationId, opts);
    expect(pf2.ok).toBe(true);
    if (!pf2.ok) return;
    const done = await confirmRegistrationRemoval(pf2.preflight, true, opts);
    expect(done.status).toBe('completed');
    if (done.status !== 'completed') return;
    expect(BigInt(done.newRevision)).toBe(BigInt(before.state!.stateRevision) + 1n);

    const after = await readBridgeState('project', opts);
    expect(after.state!.registrations.find((r) => r.id === victim.registrationId)).toBeUndefined();
    expect(after.state!.installations.filter((i) => i.registrationId === victim.registrationId)).toHaveLength(0);
    // Global document untouched by the Project Scope removal.
    const global = await readBridgeState('global', opts);
    expect(global.state!.registrations).toHaveLength(1);
  });

  it('blocks when the Registration is unknown or Project Trust is missing', async () => {
    await registerAndInstall('project', env.marketProject, env, 'enabled');
    const noTrust = await preflightRegistrationRemoval('project', 'whatever', { agentDir: env.agentDir, cwd: env.projectDir });
    expect(noTrust.ok).toBe(false);
    const unknown = await preflightRegistrationRemoval('project', '99999999-9999-4999-8999-999999999999', {
      agentDir: env.agentDir,
      cwd: env.projectDir,
      projectTrusted: true,
    });
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    if (unknown.outcome.status !== 'blocked') throw new Error('expected blocked');
    expect(unknown.outcome.findings.some((f) => f.code === 'REGISTRATION_NOT_FOUND')).toBe(true);
  });
});

describe('Installation Removal — retains the Registration and discloses inherited resumption', () => {
  let env: ReturnType<typeof makeEnv>;

  beforeEach(() => {
    env = makeEnv();
    writeMarketplace(env.marketGlobal);
  });

  afterEach(() => rmSync(env.root, { recursive: true, force: true }));

  it('removes only the chosen Installation and discloses the inherited Global Installation that becomes effective', async () => {
    const g = await registerAndInstall('global', env.marketGlobal, env, 'enabled');
    const opts = { agentDir: env.agentDir, cwd: env.projectDir, projectTrusted: true };

    // A Project Installation created from the INHERITED Global registration shares its Plugin ID.
    await commitBridgeState('project', (state) => ({
      ...state,
      installations: [{
        id: `project/${g.pluginId}`,
        pluginId: g.pluginId,
        installationState: 'enabled',
        registrationId: g.registrationId,
        validationSnapshot: undefined,
        manifestName: g.pluginId.slice(g.pluginId.lastIndexOf('/') + 1),
      }],
    }), opts);

    const pf = await preflightInstallationRemoval('project', `project/${g.pluginId}`, opts);
    expect(pf.ok).toBe(true);
    if (!pf.ok) return;
    // Disclosure identifies the inherited Global Installation that resumes afterward.
    expect(pf.preflight.resumingInheritedInstallations.map((i) => i.id)).toEqual([`global/${g.pluginId}`]);
    expect(installationRemovalDisclosure(pf.preflight)).toContain('global');

    const before = await readBridgeState('project', opts);
    const done = await confirmInstallationRemoval(pf.preflight, true, opts);
    expect(done.status).toBe('completed');
    if (done.status !== 'completed') return;

    const after = await readBridgeState('project', opts);
    expect(after.state!.installations).toHaveLength(0);
    expect(after.state!.registrations).toHaveLength(0);
    expect(BigInt(after.state!.stateRevision)).toBe(BigInt(before.state!.stateRevision) + 1n);
    // Global side untouched.
    const global = await readBridgeState('global', opts);
    expect(global.state!.installations).toHaveLength(1);
    void realpathSync;
  });

  it('declines by default and rejects stale submissions after the State Revision moved', async () => {
    await registerAndInstall('global', env.marketGlobal, env, 'disabled');
    const opts = { agentDir: env.agentDir, cwd: env.projectDir };

    const state = await readBridgeState('global', opts);
    const inst = state.state!.installations[0];

    const pfOk = await preflightInstallationRemoval('global', inst.id, opts);
    expect(pfOk.ok).toBe(true);
    if (!pfOk.ok) return;

    const declined = await confirmInstallationRemoval(pfOk.preflight, false, opts);
    expect(declined.status).toBe('declined');

    // Second attempt, but another lifecycle op moves the revision first.
    const pf2 = await preflightInstallationRemoval('global', inst.id, opts);
    expect(pf2.ok).toBe(true);
    if (!pf2.ok) return;
    await commitBridgeState('global', (current) => ({
      ...current,
      installations: current.installations.map((i) => i.id === inst.id ? { ...i, manifestName: `${i.manifestName ?? 'x'}-touched` } : i),
    }), opts);
    const stale = await confirmInstallationRemoval(pf2.preflight, true, opts);
    expect(stale.status).toBe('rejected-as-stale');
  });
});
