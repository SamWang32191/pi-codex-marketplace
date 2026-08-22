import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SourceCache } from '../../src/cache/source-cache.js';
import { commitBridgeState, readBridgeState } from '../../src/bridge-state/store.js';
import {
  confirmPluginEnable,
  confirmPluginInstallation,
  disablePluginInstallation,
  installationDisclosure,
  preflightPluginEnable,
  preflightPluginInstallation,
} from '../../src/installation/flow.js';
import { inspectMarketplaceEntries } from '../../src/installation/inspection.js';
import { entryChoices } from '../../extensions/pi/installation.js';
import { confirmGitRegistration, preflightGitRegistration } from '../../src/registration/git-flow.js';
import type { GitExecutor } from '../../src/registration/git-acquisition.js';
import { CODE, RULE } from '../../src/registration/findings.js';
import { projectEffectiveState } from '../../src/projection/project.js';

const SHA_A = 'a'.repeat(40);

function makeEnv() {
  const root = mkdtempSync(join(tmpdir(), 'installation-git-integration-'));
  return {
    root,
    agentDir: join(root, 'agent'),
    projectDir: join(root, 'project'),
    fixture: join(root, 'fixture'),
  };
}

function makeFixture(root: string) {
  mkdirSync(join(root, '.agents', 'plugins'), { recursive: true });
  mkdirSync(join(root, 'plugins', 'release-helper', '.codex-plugin'), { recursive: true });
  mkdirSync(join(root, 'plugins', 'release-helper', 'skills', 'release-notes'), { recursive: true });
  writeFileSync(
    join(root, '.agents', 'plugins', 'marketplace.json'),
    JSON.stringify({
      name: 'acme-marketplace',
      plugins: [{ name: 'wrong-entry-name', source: { source: 'local', path: './plugins/release-helper' } }],
    }),
  );
  writeFileSync(
    join(root, 'plugins', 'release-helper', '.codex-plugin', 'plugin.json'),
    JSON.stringify({ name: 'release-helper', skills: './skills/' }),
  );
  writeFileSync(
    join(root, 'plugins', 'release-helper', 'skills', 'release-notes', 'SKILL.md'),
    '---\nname: release-notes\ndescription: Write release notes\n---\n\nWrite release notes.\n',
  );
}

function makeExecutor(fixtureRoot: string, sha: string): GitExecutor {
  return async (args) => {
    if (args.includes('ls-remote')) {
      const ref = args[args.length - 1];
      return { exitCode: 0, stdout: `${sha}\t${ref}\n`, stderr: '' };
    }
    if (args.includes('clone')) {
      const dest = args[args.length - 1];
      cpSync(fixtureRoot, dest, { recursive: true });
      mkdirSync(join(dest, '.git'), { recursive: true });
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
}

describe('Git Marketplace Plugin Inspection & Installation lifecycle (#34)', () => {
  let env: ReturnType<typeof makeEnv>;
  let registrationId: string;

  beforeEach(async () => {
    env = makeEnv();
    makeFixture(env.fixture);

    const opts = {
      agentDir: env.agentDir,
      cwd: env.projectDir,
      executor: makeExecutor(env.fixture, SHA_A),
    };
    const preflight = await preflightGitRegistration(
      'global',
      'https://github.com/acme/marketplace.git',
      { kind: 'branch', value: 'main' },
      opts,
    );
    expect(preflight.ok).toBe(true);
    if (!preflight.ok) throw new Error('git registration preflight failed');

    const confirmed = await confirmGitRegistration(preflight.preflight, true, opts);
    expect(confirmed.status).toBe('completed');
    if (confirmed.status !== 'completed') throw new Error('git registration confirm failed');
    registrationId = confirmed.registration.id;
  });

  afterEach(() => rmSync(env.root, { recursive: true, force: true }));

  it('inspectMarketplaceEntries reads cached Git tree and returns available Plugin entries', async () => {
    const opts = { agentDir: env.agentDir, cwd: env.projectDir };
    const state = (await readBridgeState('global', opts)).state!;
    const registration = state.registrations.find((r) => r.id === registrationId)!;

    const inspection = inspectMarketplaceEntries(registration, 'global', opts);
    expect(inspection.findings.filter((f) => f.classification === 'blocking')).toHaveLength(0);
    expect(inspection.marketplaceId).toBe(`${registrationId}/acme-marketplace`);
    expect(inspection.entries).toHaveLength(1);
    expect(inspection.entries[0]?.entry.name).toBe('wrong-entry-name');
    expect(inspection.entries[0]?.plugin?.manifestName).toBe('release-helper');
    expect(inspection.entries[0]?.unavailableReason).toBeUndefined();
    expect(inspection.snapshot).toBeDefined();
  });

  it('entryChoices formats Git Marketplace plugins as 可安裝 in TUI', async () => {
    const opts = { agentDir: env.agentDir, cwd: env.projectDir };
    const state = (await readBridgeState('global', opts)).state!;
    const registration = state.registrations.find((r) => r.id === registrationId)!;

    const choices = await entryChoices(registration, 'global', opts);
    expect(choices).toHaveLength(1);
    expect(choices[0]?.pointer).toBe('/plugins/0');
    expect(choices[0]?.label).toContain('可安裝');
  });

  it('returns SOURCE_REACQUISITION_REQUIRED when cache entry is missing', async () => {
    const opts = { agentDir: env.agentDir, cwd: env.projectDir };
    const state = (await readBridgeState('global', opts)).state!;
    const registration = state.registrations.find((r) => r.id === registrationId)!;

    // Clear cache entries
    const cache = new SourceCache({ agentDir: env.agentDir });
    rmSync(cache.entryPath(registration.validationSnapshot!), { recursive: true, force: true });
    rmSync(cache.metaPath(registration.validationSnapshot!), { force: true });

    const inspection = inspectMarketplaceEntries(registration, 'global', opts);
    expect(inspection.entries).toHaveLength(0);
    expect(inspection.findings.some((f) => f.code === CODE.SOURCE_REACQUISITION_REQUIRED)).toBe(true);

    const preflight = await preflightPluginInstallation('global', registrationId, '/plugins/0', opts);
    expect(preflight.ok).toBe(false);
    if (!preflight.ok && preflight.outcome.status === 'blocked') {
      expect(preflight.outcome.findings.some((f) => f.code === CODE.SOURCE_REACQUISITION_REQUIRED)).toBe(true);
    }
  });

  it('returns SOURCE_DRIFT when cached tree has been tampered with', async () => {
    const opts = { agentDir: env.agentDir, cwd: env.projectDir };
    const state = (await readBridgeState('global', opts)).state!;
    const registration = state.registrations.find((r) => r.id === registrationId)!;

    // Tamper with the cached tree
    const cache = new SourceCache({ agentDir: env.agentDir });
    writeFileSync(join(cache.entryPath(registration.validationSnapshot!), 'tampered.txt'), 'tampered');

    const inspection = inspectMarketplaceEntries(registration, 'global', opts);
    expect(inspection.entries).toHaveLength(0);
    expect(inspection.findings.some((f) => f.code === CODE.SOURCE_DRIFT)).toBe(true);

    const preflight = await preflightPluginInstallation('global', registrationId, '/plugins/0', opts);
    expect(preflight.ok).toBe(false);
    if (!preflight.ok && preflight.outcome.status === 'blocked') {
      expect(preflight.outcome.findings.some((f) => f.code === CODE.SOURCE_DRIFT)).toBe(true);
    }
  });

  it('completes Install Disabled lifecycle for Git Marketplace Plugin', async () => {
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
        manifestName: 'release-helper',
      }),
    ]);
  });

  it('completes Install and Enable lifecycle and enables disabled installation for Git Plugin', async () => {
    const opts = { agentDir: env.agentDir, cwd: env.projectDir };
    const preflight = await preflightPluginInstallation('global', registrationId, '/plugins/0', opts);
    expect(preflight.ok).toBe(true);
    if (!preflight.ok) return;

    // Declined without activation confirmation
    const declined = await confirmPluginInstallation(preflight.preflight, 'enabled', false, opts);
    expect(declined.status).toBe('declined');

    // Confirm with activation confirmation
    const preflight2 = await preflightPluginInstallation('global', registrationId, '/plugins/0', opts);
    expect(preflight2.ok).toBe(true);
    if (!preflight2.ok) return;

    const outcome = await confirmPluginInstallation(preflight2.preflight, 'enabled', true, opts);
    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') return;

    expect(outcome.installation.installationState).toBe('enabled');

    // Verify projection works with the Git-installed plugin
    const state = (await readBridgeState('global', opts)).state!;
    const projectState = (await readBridgeState('project', opts)).state!;
    const projection = projectEffectiveState(state, projectState, { ...opts, projectTrusted: true });
    expect(projection.plugins.map((p) => p.pluginId)).toEqual([`${registrationId}/acme-marketplace/release-helper`]);
    expect(projection.plugins[0]?.skills).toHaveLength(1);
    expect(projection.plugins[0]?.skills[0]?.name).toBe('release-notes');

    // Disable plugin
    const disabled = await disablePluginInstallation('global', outcome.installation.id, opts);
    expect(disabled.status).toBe('completed');
    if (disabled.status !== 'completed') return;
    expect(disabled.installation.installationState).toBe('disabled');

    // Re-enable plugin via preflightPluginEnable + confirmPluginEnable
    const enablePreflight = await preflightPluginEnable('global', outcome.installation.id, opts);
    expect(enablePreflight.ok).toBe(true);
    if (!enablePreflight.ok) return;

    const enabled = await confirmPluginEnable(enablePreflight.preflight, true, opts);
    expect(enabled.status).toBe('completed');
    if (enabled.status !== 'completed') return;
    expect(enabled.installation.installationState).toBe('enabled');
  });
});
