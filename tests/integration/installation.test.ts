import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { commitBridgeState, readBridgeState } from '../../src/bridge-state/store.js';
import {
  confirmPluginInstallation,
  confirmPluginEnable,
  disablePluginInstallation,
  installationDisclosure,
  preflightPluginInstallation,
  preflightPluginEnable,
} from '../../src/installation/flow.js';
import { inspectMarketplaceEntries } from '../../src/installation/inspection.js';
import { entryChoices } from '../../extensions/pi/installation.js';

function makeEnv() {
  const root = mkdtempSync(join(tmpdir(), 'installation-integration-'));
  return { root, agentDir: join(root, 'agent'), projectDir: join(root, 'project'), marketplace: join(root, 'marketplace') };
}

function makeMarketplace(root: string) {
  mkdirSync(join(root, '.agents', 'plugins'), { recursive: true });
  mkdirSync(join(root, 'plugins', 'release-helper', '.codex-plugin'), { recursive: true });
  mkdirSync(join(root, 'plugins', 'release-helper', 'skills', 'release-notes'), { recursive: true });
  writeFileSync(
    join(root, '.agents', 'plugins', 'marketplace.json'),
    JSON.stringify({ name: 'acme-marketplace', plugins: [{ name: 'wrong-entry-name', source: { source: 'local', path: './plugins/release-helper' } }] }),
  );
  writeFileSync(join(root, 'plugins', 'release-helper', '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'release-helper', skills: './skills/' }));
  writeFileSync(
    join(root, 'plugins', 'release-helper', 'skills', 'release-notes', 'SKILL.md'),
    '---\nname: release-notes\ndescription: Write release notes\n---\n\nWrite release notes.\n',
  );
}

describe('Plugin Installation lifecycle', () => {
  let env: ReturnType<typeof makeEnv>;
  const registrationId = '11111111-1111-4111-8111-111111111111';

  beforeEach(async () => {
    env = makeEnv();
    makeMarketplace(env.marketplace);
    await commitBridgeState(
      'global',
      (state) => ({
        ...state,
        registrations: [{
          id: registrationId,
          marketplaceName: 'acme-marketplace',
          sourceKind: 'local',
          source: env.marketplace,
        }],
      }),
      { agentDir: env.agentDir, cwd: env.projectDir },
    );
  });

  afterEach(() => rmSync(env.root, { recursive: true, force: true }));

  it('commits Install Disabled without Activation Confirmation and persists scope + Plugin identity provenance', async () => {
    const opts = { agentDir: env.agentDir, cwd: env.projectDir };
    const preflight = await preflightPluginInstallation('global', registrationId, '/plugins/0', opts);
    expect(preflight.ok).toBe(true);
    if (!preflight.ok) return;
    expect(preflight.preflight.disclosure.plugin.id).toBe(`${registrationId}/acme-marketplace/release-helper`);

    const outcome = await confirmPluginInstallation(preflight.preflight, 'disabled', opts);
    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') return;
    expect(outcome.installation.installationState).toBe('disabled');
    expect(outcome.receipt.summary).toBe('Completed');

    const state = await readBridgeState('global', opts);
    expect(state.state!.installations).toEqual([
      expect.objectContaining({
        id: `global/${registrationId}/acme-marketplace/release-helper`,
        pluginId: `${registrationId}/acme-marketplace/release-helper`,
        installationState: 'disabled',
        registrationId,
        marketplaceEntryId: `${registrationId}/acme-marketplace/plugins/0`,
      }),
    ]);
  });

  it('requires a distinct Activation Confirmation for Install and Enable, then revalidates before re-enable', async () => {
    const opts = { agentDir: env.agentDir, cwd: env.projectDir };
    const first = await preflightPluginInstallation('global', registrationId, '/plugins/0', opts);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const declined = await confirmPluginInstallation(first.preflight, 'enabled', false, opts);
    expect(declined.status).toBe('declined');
    if (declined.status === 'declined') expect(declined.receipt.operation).toBe('Plugin Installation');

    const second = await preflightPluginInstallation('global', registrationId, '/plugins/0', opts);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const installed = await confirmPluginInstallation(second.preflight, 'enabled', true, opts);
    expect(installed.status).toBe('completed');
    if (installed.status !== 'completed') return;

    const disabled = await disablePluginInstallation('global', installed.installation.id, opts);
    expect(disabled.status).toBe('completed');
    if (disabled.status === 'completed') expect(disabled.receipt.operation).toBe('Plugin Disablement');

    const enablePreflight = await preflightPluginEnable('global', installed.installation.id, opts);
    expect(enablePreflight.ok).toBe(true);
    if (!enablePreflight.ok) return;
    const enabled = await confirmPluginEnable(enablePreflight.preflight, true, opts);
    expect(enabled.status).toBe('completed');
    if (enabled.status !== 'completed') return;
    expect(enabled.installation.id).toBe(installed.installation.id);
    expect(enabled.installation.installationState).toBe('enabled');
    expect(enabled.receipt.operation).toBe('Plugin Enablement');
  });

  it('rejects a source change after preflight as stale before it can commit the disclosed Plugin', async () => {
    const opts = { agentDir: env.agentDir, cwd: env.projectDir };
    const preflight = await preflightPluginInstallation('global', registrationId, '/plugins/0', opts);
    expect(preflight.ok).toBe(true);
    if (!preflight.ok) return;

    writeFileSync(
      join(env.marketplace, 'plugins', 'release-helper', 'skills', 'release-notes', 'SKILL.md'),
      '---\nname: release-notes\ndescription: Changed after disclosure\n---\n\nDifferent body.\n',
    );

    const outcome = await confirmPluginInstallation(preflight.preflight, 'disabled', opts);
    expect(outcome.status).toBe('rejected-as-stale');
  });

  it('escapes Marketplace-controlled resource names in the Activation Disclosure', async () => {
    writeFileSync(join(env.marketplace, 'plugins', 'release-helper', 'skills', 'release-notes', 'resource\nforged.txt'), 'opaque');
    const preflight = await preflightPluginInstallation('global', registrationId, '/plugins/0', { agentDir: env.agentDir, cwd: env.projectDir });
    expect(preflight.ok).toBe(true);
    if (!preflight.ok) return;

    const disclosure = installationDisclosure(preflight.preflight);
    expect(disclosure).toContain('"resource\\nforged.txt"');
    expect(disclosure).not.toContain('resources: resource\nforged.txt');
    preflight.preflight.fence.release();
  });

  it('fails closed when a Skill Resource symlink targets snapshot-excluded content', () => {
    const skill = join(env.marketplace, 'plugins', 'release-helper', 'skills', 'release-notes');
    mkdirSync(join(skill, 'node_modules'), { recursive: true });
    writeFileSync(join(skill, 'node_modules', 'untracked.js'), 'untracked');
    symlinkSync('node_modules/untracked.js', join(skill, 'linked-resource.js'));

    const inspected = inspectMarketplaceEntries({ id: registrationId, sourceKind: 'local', source: env.marketplace }, 'global');
    const entry = inspected.entries[0]!;
    expect(entry.plugin).toBeUndefined();
    expect(entry.unavailableReason).toBeDefined();
    expect(entry.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'SKILL_DESCRIPTOR_INVALID' })]));
  });

  it('records the requested enablement or disablement operation even when it is blocked', async () => {
    const opts = { agentDir: env.agentDir, cwd: env.projectDir };
    const enable = await preflightPluginEnable('global', 'global/missing-plugin', opts);
    expect(enable.ok).toBe(false);
    if (!enable.ok) expect(enable.outcome.receipt.operation).toBe('Plugin Enablement');

    const disable = await disablePluginInstallation('global', 'global/missing-plugin', opts);
    expect(disable.status).toBe('blocked');
    if (disable.status === 'blocked') expect(disable.receipt.operation).toBe('Plugin Disablement');
  });

  it('rejects disablement as stale when the State Revision advances after fence admission', async () => {
    const opts = { agentDir: env.agentDir, cwd: env.projectDir };
    const preflight = await preflightPluginInstallation('global', registrationId, '/plugins/0', opts);
    expect(preflight.ok).toBe(true);
    if (!preflight.ok) return;
    const installed = await confirmPluginInstallation(preflight.preflight, 'enabled', true, opts);
    expect(installed.status).toBe('completed');
    if (installed.status !== 'completed') return;

    const outcome = await disablePluginInstallation('global', installed.installation.id, {
      ...opts,
      beforeDisableCommit: async () => {
        await commitBridgeState('global', (state) => ({ ...state }), opts);
      },
    });
    expect(outcome.status).toBe('rejected-as-stale');
    if (outcome.status === 'rejected-as-stale') expect(outcome.receipt.summary).toBe('Rejected as Stale');

    const state = await readBridgeState('global', opts);
    expect(state.state!.installations.find((item) => item.id === installed.installation.id)!.installationState).toBe('enabled');
  });

  it('fails closed when another Marketplace Entry has the same authoritative Plugin ID', async () => {
    const duplicate = join(env.marketplace, 'plugins', 'release-helper-copy');
    mkdirSync(join(duplicate, '.codex-plugin'), { recursive: true });
    mkdirSync(join(duplicate, 'skills', 'release-notes-copy'), { recursive: true });
    writeFileSync(join(duplicate, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'release-helper', skills: './skills/' }));
    writeFileSync(join(duplicate, 'skills', 'release-notes-copy', 'SKILL.md'), '---\nname: release-notes-copy\ndescription: Another compatible skill\n---\n\nAnother body.\n');
    writeFileSync(
      join(env.marketplace, '.agents', 'plugins', 'marketplace.json'),
      JSON.stringify({ name: 'acme-marketplace', plugins: [
        { name: 'one', source: { source: 'local', path: './plugins/release-helper' } },
        { name: 'two', source: { source: 'local', path: './plugins/release-helper-copy' } },
      ] }),
    );

    const result = await preflightPluginInstallation('global', registrationId, '/plugins/0', { agentDir: env.agentDir, cwd: env.projectDir });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.outcome.status).toBe('blocked');
    if (result.outcome.status !== 'blocked') return;
    expect(result.outcome.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'PLUGIN_ID_COLLISION', classification: 'blocking' }),
    ]));
  });

  it('fails closed when an incompatible Entry collides with a compatible Plugin ID', async () => {
    const duplicate = join(env.marketplace, 'plugins', 'release-helper-incompatible');
    mkdirSync(join(duplicate, '.codex-plugin'), { recursive: true });
    mkdirSync(join(duplicate, 'skills', 'notes'), { recursive: true });
    mkdirSync(join(duplicate, 'commands'), { recursive: true });
    writeFileSync(join(duplicate, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'release-helper', skills: './skills/' }));
    writeFileSync(join(duplicate, 'skills', 'notes', 'SKILL.md'), '---\nname: notes\ndescription: Incompatible plugin\n---\n\nBody.\n');
    writeFileSync(join(env.marketplace, '.agents', 'plugins', 'marketplace.json'), JSON.stringify({ name: 'acme-marketplace', plugins: [
      { source: { source: 'local', path: './plugins/release-helper' } },
      { source: { source: 'local', path: './plugins/release-helper-incompatible' } },
    ] }));

    const result = await preflightPluginInstallation('global', registrationId, '/plugins/0', { agentDir: env.agentDir, cwd: env.projectDir });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.outcome.status).toBe('blocked');
    if (result.outcome.status !== 'blocked') return;
    expect(result.outcome.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'PLUGIN_ID_COLLISION' })]));
  });

  it('shows all compatible Entries as installable through the TUI browse seam without acquiring a lifecycle fence', async () => {
    const alternate = join(env.marketplace, 'plugins', 'alternate-helper');
    mkdirSync(join(alternate, '.codex-plugin'), { recursive: true });
    mkdirSync(join(alternate, 'skills', 'alternate-notes'), { recursive: true });
    writeFileSync(join(alternate, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'alternate-helper', skills: './skills/' }));
    writeFileSync(join(alternate, 'skills', 'alternate-notes', 'SKILL.md'), '---\nname: alternate-notes\ndescription: Alternate notes\n---\n\nBody.\n');
    writeFileSync(join(env.marketplace, '.agents', 'plugins', 'marketplace.json'), JSON.stringify({ name: 'acme-marketplace', plugins: [
      { source: { source: 'local', path: './plugins/release-helper' } },
      { source: { source: 'local', path: './plugins/alternate-helper' } },
    ] }));

    const inspected = inspectMarketplaceEntries({ id: registrationId, sourceKind: 'local', source: env.marketplace }, 'global');
    expect(inspected.entries).toHaveLength(2);
    expect(inspected.entries.every((entry) => entry.unavailableReason === undefined)).toBe(true);
    const choices = await entryChoices({ id: registrationId, sourceKind: 'local', source: env.marketplace }, 'global', { cwd: env.projectDir });
    expect(choices).toHaveLength(2);
    expect(choices.map((choice) => choice.pointer)).toEqual(['/plugins/0', '/plugins/1']);
  });
});
