import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readBridgeState } from '../../src/bridge-state/store.js';
import { confirmPluginInstallation, preflightPluginInstallation } from '../../src/installation/flow.js';
import { applyUpdate } from '../../src/lifecycle/update.js';
import { buildUpdatePlan } from '../../src/lifecycle/update-plan.js';
import { preflightRebind } from '../../src/lifecycle/rebind.js';
import { confirmLocalRegistration, preflightLocalRegistration } from '../../src/registration/flow.js';

function makeEnv() {
  const root = mkdtempSync(join(tmpdir(), 'lifecycle-rebind-'));
  return {
    root,
    agentDir: join(root, 'agent'),
    projectDir: join(root, 'project'),
    marketV1: join(root, 'market-v1'),
    marketV2: join(root, 'market-v2'),
    marketBroken: join(root, 'market-broken'),
  };
}

function writeMarketplace(root: string, opts: { name?: string; extraSkill?: boolean } = {}) {
  mkdirSync(join(root, '.agents', 'plugins'), { recursive: true });
  mkdirSync(join(root, 'plugins', 'release-helper', '.codex-plugin'), { recursive: true });
  mkdirSync(join(root, 'plugins', 'release-helper', 'skills', 'release-notes'), { recursive: true });
  writeFileSync(
    join(root, '.agents', 'plugins', 'marketplace.json'),
    JSON.stringify({ name: opts.name ?? 'acme-marketplace', plugins: [{ name: 'release-helper', source: { source: 'local', path: './plugins/release-helper' } }] }),
  );
  writeFileSync(join(root, 'plugins', 'release-helper', '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'release-helper', skills: './skills/' }));
  writeFileSync(
    join(root, 'plugins', 'release-helper', 'skills', 'release-notes', 'SKILL.md'),
    '---\nname: release-notes\ndescription: Write release notes\n---\n\nWrite release notes.\n',
  );
  if (opts.extraSkill) {
    mkdirSync(join(root, 'plugins', 'release-helper', 'skills', 'changelog'), { recursive: true });
    writeFileSync(
      join(root, 'plugins', 'release-helper', 'skills', 'changelog', 'SKILL.md'),
      '---\nname: changelog\ndescription: Maintain changelog\n---\n\nMaintain the changelog.\n',
    );
  }
}

describe('Registration Rebind — new source under the preserved Registration ID', () => {
  let env: ReturnType<typeof makeEnv>;
  let registrationId: string;
  let opts: { agentDir: string; cwd: string };

  beforeEach(async () => {
    env = makeEnv();
    writeMarketplace(env.marketV1);
    writeMarketplace(env.marketV2, { extraSkill: true });
    mkdirSync(env.marketBroken, { recursive: true }); // no catalog
    opts = { agentDir: env.agentDir, cwd: env.projectDir };

    const preflight = await preflightLocalRegistration('global', env.marketV1, opts);
    expect(preflight.ok).toBe(true);
    if (!preflight.ok) throw new Error('seed preflight failed');
    const confirmed = await confirmLocalRegistration(preflight.preflight, true, opts);
    expect(confirmed.status).toBe('completed');
    if (confirmed.status !== 'completed') throw new Error('seed confirm failed');
    registrationId = confirmed.registration.id;

    // One enabled installation whose activation consent belongs to the OLD source.
    const installPf = await preflightPluginInstallation('global', registrationId, '/plugins/0', opts);
    expect(installPf.ok).toBe(true);
    if (!installPf.ok) throw new Error('install preflight failed');
    const installed = await confirmPluginInstallation(installPf.preflight, 'enabled', true, opts);
    expect(installed.status).toBe('completed');
  });

  afterEach(() => rmSync(env.root, { recursive: true, force: true }));

  it('preserves the Registration ID while replacing locator and snapshot after fresh validation and consents', async () => {
    const before = await readBridgeState('global', opts);
    const installationBefore = before.state!.installations[0];

    const pf = await preflightRebind('global', registrationId, { kind: 'local', rootPath: env.marketV2 }, opts);
    expect(pf.ok).toBe(true);
    if (!pf.ok) throw new Error(`rebind preflight failed: ${pf.outcome.findings.map((f) => f.outcome).join('; ')}`);

    // Prior activation consent never carries over: the plan needs a fresh Activation Confirmation.
    const withoutConsent = buildUpdatePlan(pf.preflight.candidate, before.state!.installations, pf.preflight.stateRevision, {
      registrationConfirmed: true,
      kind: 'rebind',
      rebindSource: pf.preflight.rebindSource,
      choices: { [installationBefore.id]: 'update' },
      activationConfirmations: {},
    });
    expect(withoutConsent.ok).toBe(false);

    const plan = buildUpdatePlan(pf.preflight.candidate, before.state!.installations, pf.preflight.stateRevision, {
      registrationConfirmed: true,
      kind: 'rebind',
      rebindSource: pf.preflight.rebindSource,
      choices: { [installationBefore.id]: 'update' },
      activationConfirmations: { [installationBefore.id]: true },
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error(`plan problems: ${plan.problems.map((p) => p.outcome).join('; ')}`);

    const outcome = await applyUpdate(plan.plan, opts);
    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') return;

    const after = await readBridgeState('global', opts);
    const rebinded = after.state!.registrations.find((r) => r.id === registrationId)!;
    expect(rebinded).toBeDefined(); // Registration ID preserved across the rebind
    expect(rebinded.source).toBe(realpathSync.native(env.marketV2));
    expect(rebinded.validationSnapshot).not.toBe(before.state!.registrations[0].validationSnapshot);

    const inst = after.state!.installations[0];
    expect(inst.id).toBe(installationBefore.id); // Installation ID stable
    expect(inst.installationState).toBe('enabled'); // remained enabled under fresh consent
    expect(inst.validationSnapshot).not.toBe(installationBefore.validationSnapshot);
    expect(BigInt(after.state!.stateRevision)).toBe(BigInt(before.state!.stateRevision) + 1n);
  });

  it('blocks when the replacement source cannot be validated (no Marketplace Catalog)', async () => {
    const pf = await preflightRebind('global', registrationId, { kind: 'local', rootPath: env.marketBroken }, opts);
    expect(pf.ok).toBe(false);
    if (pf.ok) return;
    expect(pf.outcome.status).toBe('blocked');
    if (pf.outcome.status !== 'blocked') return;
    expect(pf.outcome.findings.some((f) => f.code === 'CATALOG_MISSING')).toBe(true);

    // Bridge State untouched by the failed rebind attempt.
    const after = await readBridgeState('global', opts);
    expect(after.state!.registrations[0].source).toBe(realpathSync.native(env.marketV1));
  });

  it('blocks as duplicate when the replacement Source Key equals another Registration in the same scope', async () => {
    // Register market-v2 as its own registration first.
    const dupPreflight = await preflightLocalRegistration('global', env.marketV2, opts);
    expect(dupPreflight.ok).toBe(true);
    if (!dupPreflight.ok) return;
    const dupConfirm = await confirmLocalRegistration(dupPreflight.preflight, true, opts);
    expect(dupConfirm.status).toBe('completed');

    const pf = await preflightRebind('global', registrationId, { kind: 'local', rootPath: env.marketV2 }, opts);
    expect(pf.ok).toBe(false);
    if (pf.ok) return;
    expect(pf.outcome.status).toBe('blocked');
    if (pf.outcome.status !== 'blocked') return;
    expect(pf.outcome.findings.some((f) => f.code === 'DUPLICATE_SOURCE_KEY')).toBe(true);
  });
});
