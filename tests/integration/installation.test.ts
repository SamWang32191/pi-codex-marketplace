import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { commitBridgeState, readBridgeState } from '../../src/bridge-state/store.js';
import {
  confirmPluginDisable,
  confirmPluginInstallation,
  confirmPluginEnable,
  declinePluginDisable,
  declinePluginInstallation,
  disablePluginInstallation,
  installationDisclosure,
  preflightPluginDisable,
  preflightPluginInstallation,
  preflightPluginEnable,
} from '../../src/installation/flow.js';
import { inspectMarketplaceEntries } from '../../src/installation/inspection.js';
import { readReceiptJournal } from '../../src/journal/journal.js';
import { buildLocalSnapshot, type ValidationSnapshot } from '../../src/registration/snapshot.js';
import { localSourceKey } from '../../src/registration/source-key.js';
import { entryChoices } from '../../extensions/pi/installation.js';

const PINNED_CODEX_PLUGINS_COMMIT = '98e78caf2b658dc5ccfd77720b0849dff9b7e99a';

function legacyValidationFingerprint(snapshot: ValidationSnapshot): string {
  const hash = createHash('sha256');
  for (const entry of snapshot.entries) {
    const parts = [entry.relPath, entry.type, String(entry.mode), String(entry.size)];
    if (entry.type === 'symlink') parts.push(entry.symlinkTarget ?? '');
    if (entry.type === 'file') parts.push(entry.contentHash ?? '');
    hash.update(parts.join('\u001f'));
  }
  hash.update('\u001e');
  for (const binding of [snapshot.sourceKey.key, snapshot.profile, 'ruleset:v1', 'budget:v1']) {
    hash.update(`${binding}\u001f`);
  }
  return hash.digest('hex');
}

function makeEnv() {
  const root = mkdtempSync(join(tmpdir(), 'installation-integration-'));
  return { root, agentDir: join(root, 'agent'), marketplace: join(root, 'marketplace') };
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

function materializePinnedMarketplace(root: string): void {
  const fixture = JSON.parse(readFileSync(
    join(import.meta.dirname, '..', 'fixtures', 'pinned', 'codex-plugins-98e78caf.json'),
    'utf8',
  )) as { commit: string; encoding: string; files: Record<string, string[]> };
  if (fixture.commit !== PINNED_CODEX_PLUGINS_COMMIT || fixture.encoding !== 'base64') {
    throw new Error('Pinned codex-plugins fixture metadata does not match its immutable source');
  }
  for (const [relativePath, chunks] of Object.entries(fixture.files)) {
    const path = join(root, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(chunks.join(''), 'base64'));
  }
}

describe('Plugin Installation lifecycle', () => {
  let env: ReturnType<typeof makeEnv>;
  const registrationId = '11111111-1111-4111-8111-111111111111';

  beforeEach(async () => {
    env = makeEnv();
    makeMarketplace(env.marketplace);
    await commitBridgeState((state) => ({
        ...state,
        registrations: [{
          id: registrationId,
          marketplaceName: 'acme-marketplace',
          sourceKind: 'local',
          source: env.marketplace,
        }],
      }),
      { agentDir: env.agentDir },
    );
  });

  afterEach(() => rmSync(env.root, { recursive: true, force: true }));

  it('commits Install Disabled without Activation Confirmation and persists Plugin identity provenance', async () => {
    const opts = { agentDir: env.agentDir };
    const preflight = await preflightPluginInstallation(registrationId, '/plugins/0', opts);
    expect(preflight.ok).toBe(true);
    if (!preflight.ok) return;
    expect(preflight.preflight.disclosure.plugin.id).toBe(`${registrationId}/acme-marketplace/release-helper`);

    const outcome = await confirmPluginInstallation(preflight.preflight, 'disabled', opts);
    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') return;
    expect(outcome.installation.installationState).toBe('disabled');
    expect(outcome.receipt.summary).toBe('Completed');

    const state = await readBridgeState(opts);
    expect(state.state!.installations).toEqual([
      expect.objectContaining({
        id: `${registrationId}/acme-marketplace/release-helper`,
        pluginId: `${registrationId}/acme-marketplace/release-helper`,
        installationState: 'disabled',
        registrationId,
        marketplaceEntryId: `${registrationId}/acme-marketplace/plugins/0`,
      }),
    ]);
  });

  it('recognizes and manages a legacy persisted Installation whose ID carries the retired scope prefix', async () => {
    const legacyPluginId = `${registrationId}/acme-marketplace/release-helper`;
    const legacyId = `global/${legacyPluginId}`;
    // The Installation binds the activation-bound snapshot (catalog captures folded in), not
    // the bare tree fingerprint.
    const boundFingerprint = inspectMarketplaceEntries({ id: registrationId, sourceKind: 'local', source: env.marketplace }).snapshot!.fingerprint;
    await commitBridgeState((state) => ({
      ...state,
      installations: [{
        id: legacyId,
        pluginId: legacyPluginId,
        installationState: 'disabled',
        registrationId,
        marketplaceEntryId: `${registrationId}/acme-marketplace/plugins/0`,
        validationSnapshot: boundFingerprint,
      }],
    }), { agentDir: env.agentDir, expectedStateRevision: '1' });

    // The legacy record is recognizable by exact persisted ID.
    const enableByLegacyId = await preflightPluginEnable(legacyId, { agentDir: env.agentDir });
    expect(enableByLegacyId.ok).toBe(true);
    if (!enableByLegacyId.ok) return;

    // Re-enabling preserves the persisted legacy ID rather than rewriting identity.
    const enabled = await confirmPluginEnable(enableByLegacyId.preflight, true, { agentDir: env.agentDir });
    expect(enabled.status).toBe('completed');
    if (enabled.status === 'completed') {
      expect(enabled.installation.id).toBe(legacyId);
      expect(enabled.installation.installationState).toBe('enabled');
    }

    // Disablement by bare Plugin ID also resolves the same legacy record.
    const disabled = await disablePluginInstallation(legacyPluginId, { agentDir: env.agentDir });
    expect(disabled.status).toBe('completed');
    if (disabled.status === 'completed') expect(disabled.installation.id).toBe(legacyId);
  });

  it('requires a distinct Activation Confirmation for Install and Enable, then revalidates before re-enable', async () => {
    const opts = { agentDir: env.agentDir };
    const first = await preflightPluginInstallation(registrationId, '/plugins/0', opts);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const declined = await confirmPluginInstallation(first.preflight, 'enabled', false, opts);
    expect(declined.status).toBe('declined');
    if (declined.status === 'declined') expect(declined.receipt.operation).toBe('Plugin Installation');

    const second = await preflightPluginInstallation(registrationId, '/plugins/0', opts);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const installed = await confirmPluginInstallation(second.preflight, 'enabled', true, opts);
    expect(installed.status).toBe('completed');
    if (installed.status !== 'completed') return;

    const disabled = await disablePluginInstallation(installed.installation.id, opts);
    expect(disabled.status).toBe('completed');
    if (disabled.status === 'completed') expect(disabled.receipt.operation).toBe('Plugin Disablement');

    const enablePreflight = await preflightPluginEnable(installed.installation.id, opts);
    expect(enablePreflight.ok).toBe(true);
    if (!enablePreflight.ok) return;
    const enabled = await confirmPluginEnable(enablePreflight.preflight, true, opts);
    expect(enabled.status).toBe('completed');
    if (enabled.status !== 'completed') return;
    expect(enabled.installation.id).toBe(installed.installation.id);
    expect(enabled.installation.installationState).toBe('enabled');
    expect(enabled.receipt.operation).toBe('Plugin Enablement');
  });

  it('rejects enablement as stale when fresh inspection differs from the Installation Validation Snapshot', async () => {
    const opts = { agentDir: env.agentDir };
    const preflight = await preflightPluginInstallation(registrationId, '/plugins/0', opts);
    expect(preflight.ok).toBe(true);
    if (!preflight.ok) return;
    const installed = await confirmPluginInstallation(preflight.preflight, 'disabled', opts);
    expect(installed.status).toBe('completed');
    if (installed.status !== 'completed') return;
    const boundSnapshot = installed.installation.validationSnapshot;

    writeFileSync(
      join(env.marketplace, 'plugins', 'release-helper', 'skills', 'release-notes', 'SKILL.md'),
      '---\nname: release-notes\ndescription: Changed before enablement\n---\n\nDifferent body.\n',
    );

    const enable = await preflightPluginEnable(installed.installation.id, opts);
    if (enable.ok) enable.preflight.fence.release();
    expect(enable.ok).toBe(false);
    if (enable.ok) return;
    expect(enable.outcome).toEqual(expect.objectContaining({
      status: 'rejected-as-stale',
      receipt: expect.objectContaining({
        summary: 'Rejected as Stale',
        expectedStateRevision: installed.newRevision,
        observedStateRevision: installed.newRevision,
        validationSnapshot: boundSnapshot,
      }),
    }));

    const state = await readBridgeState(opts);
    expect(state.state!.stateRevision).toBe(installed.newRevision);
    expect(state.state!.installations).toEqual([
      expect.objectContaining({
        id: installed.installation.id,
        installationState: 'disabled',
        validationSnapshot: boundSnapshot,
      }),
    ]);
  });

  it('rejects a source change after preflight as stale before it can commit the disclosed Plugin', async () => {
    const opts = { agentDir: env.agentDir };
    const preflight = await preflightPluginInstallation(registrationId, '/plugins/0', opts);
    expect(preflight.ok).toBe(true);
    if (!preflight.ok) return;

    writeFileSync(
      join(env.marketplace, 'plugins', 'release-helper', 'skills', 'release-notes', 'SKILL.md'),
      '---\nname: release-notes\ndescription: Changed after disclosure\n---\n\nDifferent body.\n',
    );

    const outcome = await confirmPluginInstallation(preflight.preflight, 'disabled', opts);
    expect(outcome.status).toBe('rejected-as-stale');
  });

  it('rejects a Skill Agent Profile change after preflight as stale', async () => {
    const profileDirectory = join(env.marketplace, 'plugins', 'release-helper', 'skills', 'release-notes', 'agents');
    const profilePath = join(profileDirectory, 'openai.yaml');
    mkdirSync(profileDirectory, { recursive: true });
    writeFileSync(profilePath, 'policy:\n  allow_implicit_invocation: true\n');
    const opts = { agentDir: env.agentDir };
    const preflight = await preflightPluginInstallation(registrationId, '/plugins/0', opts);
    expect(preflight.ok).toBe(true);
    if (!preflight.ok) return;

    writeFileSync(profilePath, 'policy:\n  allow_implicit_invocation: false\n');

    const outcome = await confirmPluginInstallation(preflight.preflight, 'disabled', opts);
    expect(outcome.status).toBe('rejected-as-stale');
  });

  it('requires Marketplace Refresh for a persisted ruleset:v1 Validation Snapshot', () => {
    const sourceKey = localSourceKey(env.marketplace).sourceKey!;
    const currentSnapshot = buildLocalSnapshot(env.marketplace, sourceKey).snapshot!;
    const legacyFingerprint = legacyValidationFingerprint(currentSnapshot);
    expect(currentSnapshot.ruleset).toBe('ruleset:v2');
    expect(currentSnapshot.budget).toBe('budget:v2');
    expect(legacyFingerprint).not.toBe(currentSnapshot.fingerprint);

    const inspected = inspectMarketplaceEntries({
      id: registrationId,
      sourceKind: 'local',
      source: env.marketplace,
      validationSnapshot: legacyFingerprint,
    });

    expect(inspected.entries[0]!.unavailableReason).toContain('Marketplace Refresh');
    expect(inspected.entries[0]!.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'REJECTED_AS_STALE', classification: 'blocking' }),
    ]));
  });

  it('rejects installation as stale when State Revision advances after confirmation', async () => {
    const opts = { agentDir: env.agentDir };
    const preflight = await preflightPluginInstallation(registrationId, '/plugins/0', opts);
    expect(preflight.ok).toBe(true);
    if (!preflight.ok) return;
    const outcome = await confirmPluginInstallation(preflight.preflight, 'disabled', {
      ...opts,
      beforeInstallationCommit: async () => { await commitBridgeState((state) => ({ ...state }), opts); },
    });
    expect(outcome.status).toBe('rejected-as-stale');
    if (outcome.status === 'rejected-as-stale') {
      expect(outcome.receipt.observedStateRevision).toBe('2');
    }
    expect((await readBridgeState(opts)).state!.installations).toEqual([]);
  });

  it('records the observed State Revision when the confirmation read is stale', async () => {
    const opts = { agentDir: env.agentDir };
    const preflight = await preflightPluginInstallation(registrationId, '/plugins/0', opts);
    expect(preflight.ok).toBe(true);
    if (!preflight.ok) return;
    await commitBridgeState((state) => ({ ...state }), opts);

    const outcome = await confirmPluginInstallation(preflight.preflight, 'disabled', opts);
    expect(outcome.status).toBe('rejected-as-stale');
    if (outcome.status !== 'rejected-as-stale') return;
    expect(outcome.receipt).toEqual(expect.objectContaining({
      expectedStateRevision: '1',
      observedStateRevision: '2',
      summary: 'Rejected as Stale',
    }));
    expect((await readBridgeState(opts)).state!.installations).toEqual([]);
  });

  it('rejects a Ledger-bound installation preflight when its selected State Revision is stale', async () => {
    const result = await preflightPluginInstallation(registrationId, '/plugins/0', {
      agentDir: env.agentDir,
      expectedStateRevision: '0',
      expectedMarketplaceEntryId: `${registrationId}/acme-marketplace/plugins/0`,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.outcome).toEqual(expect.objectContaining({
      status: 'rejected-as-stale',
      receipt: expect.objectContaining({
        summary: 'Rejected as Stale',
        expectedStateRevision: '0',
        observedStateRevision: '1',
      }),
    }));
    expect((await readBridgeState({ agentDir: env.agentDir })).state?.installations).toEqual([]);
  });

  it('rejects a Ledger-bound installation preflight when the complete Marketplace Entry identity changed', async () => {
    const result = await preflightPluginInstallation(registrationId, '/plugins/0', {
      agentDir: env.agentDir,
      expectedStateRevision: '1',
      expectedMarketplaceEntryId: `${registrationId}/previous-marketplace/plugins/0`,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.outcome).toEqual(expect.objectContaining({
      status: 'rejected-as-stale',
      receipt: expect.objectContaining({
        summary: 'Rejected as Stale',
        expectedStateRevision: '1',
        observedStateRevision: '1',
      }),
    }));
  });

  it('blocks a Ledger-bound installation preflight with an exact finding when its Entry pointer disappeared', async () => {
    writeFileSync(
      join(env.marketplace, '.agents', 'plugins', 'marketplace.json'),
      JSON.stringify({ name: 'acme-marketplace', plugins: [] }),
    );

    const result = await preflightPluginInstallation(registrationId, '/plugins/0', {
      agentDir: env.agentDir,
      expectedStateRevision: '1',
      expectedMarketplaceEntryId: `${registrationId}/acme-marketplace/plugins/0`,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.outcome).toEqual(expect.objectContaining({
      status: 'blocked',
      receipt: expect.objectContaining({
        summary: 'Blocked',
        expectedStateRevision: '1',
      }),
      findings: expect.arrayContaining([
        expect.objectContaining({
          code: 'INSTALLATION_NOT_FOUND',
          target: 'entry',
          outcome: "Marketplace Entry '/plugins/0' is Unavailable",
        }),
      ]),
    }));
  });

  it('escapes Marketplace-controlled resource names in the Activation Disclosure', async () => {
    writeFileSync(join(env.marketplace, 'plugins', 'release-helper', 'skills', 'release-notes', 'resource\nforged.txt'), 'opaque');
    const preflight = await preflightPluginInstallation(registrationId, '/plugins/0', { agentDir: env.agentDir });
    expect(preflight.ok).toBe(true);
    if (!preflight.ok) return;

    const disclosure = installationDisclosure(preflight.preflight);
    expect(disclosure).toContain('"resource\\nforged.txt"');
    expect(disclosure).not.toContain('resources: resource\nforged.txt');
    preflight.preflight.fence.release();
  });

  it('escapes Marketplace-controlled identities in TUI entry choices', async () => {
    writeFileSync(
      join(env.marketplace, '.agents', 'plugins', 'marketplace.json'),
      JSON.stringify({
        name: 'acme\nFORGED-MARKET',
        plugins: [{ source: { source: 'local', path: './plugins/release-helper' } }],
      }),
    );

    const choices = await entryChoices(
      { id: registrationId, sourceKind: 'local', source: env.marketplace },
      {},
    );

    expect(choices[0]?.label).toContain('acme\\nFORGED-MARKET');
    expect(choices[0]?.label).not.toContain('acme\nFORGED-MARKET');
  });

  it('fails closed when a Skill Resource symlink targets snapshot-excluded content', () => {
    const skill = join(env.marketplace, 'plugins', 'release-helper', 'skills', 'release-notes');
    mkdirSync(join(skill, 'node_modules'), { recursive: true });
    writeFileSync(join(skill, 'node_modules', 'untracked.js'), 'untracked');
    symlinkSync('node_modules/untracked.js', join(skill, 'linked-resource.js'));

    const inspected = inspectMarketplaceEntries({ id: registrationId, sourceKind: 'local', source: env.marketplace });
    const entry = inspected.entries[0]!;
    expect(entry.plugin).toBeUndefined();
    expect(entry.unavailableReason).toBeDefined();
    expect(entry.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'SKILL_DESCRIPTOR_INVALID' })]));
  });

  it('records the requested enablement or disablement operation even when it is blocked', async () => {
    const opts = { agentDir: env.agentDir };
    const enable = await preflightPluginEnable('global/missing-plugin', opts);
    expect(enable.ok).toBe(false);
    if (!enable.ok) expect(enable.outcome.receipt.operation).toBe('Plugin Enablement');

    const disable = await disablePluginInstallation('global/missing-plugin', opts);
    expect(disable.status).toBe('blocked');
    if (disable.status === 'blocked') expect(disable.receipt.operation).toBe('Plugin Disablement');
  });

  it('holds the Attempt Fence from Plugin Disablement preflight until decline', async () => {
    const opts = { agentDir: env.agentDir };
    const install = await preflightPluginInstallation(registrationId, '/plugins/0', opts);
    expect(install.ok).toBe(true);
    if (!install.ok) return;
    const installed = await confirmPluginInstallation(install.preflight, 'enabled', true, opts);
    expect(installed.status).toBe('completed');
    if (installed.status !== 'completed') return;

    const first = await preflightPluginDisable(installed.installation.id, opts);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const competing = await preflightPluginDisable(installed.installation.id, {
      ...opts,
      fenceTimeoutMs: 5,
    });
    expect(competing.ok).toBe(false);
    if (!competing.ok && competing.outcome.status === 'blocked') {
      expect(competing.outcome.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'ATTEMPT_IN_PROGRESS' }),
      ]));
    }

    const declined = await declinePluginDisable(first.preflight, opts);
    expect(declined.status).toBe('declined');
    const admittedAgain = await preflightPluginDisable(installed.installation.id, opts);
    expect(admittedAgain.ok).toBe(true);
    if (admittedAgain.ok) await declinePluginDisable(admittedAgain.preflight, opts);
  });

  it('journals Plugin Disablement hook failure and releases its Attempt Fence', async () => {
    const opts = { agentDir: env.agentDir };
    const install = await preflightPluginInstallation(registrationId, '/plugins/0', opts);
    expect(install.ok).toBe(true);
    if (!install.ok) return;
    const installed = await confirmPluginInstallation(install.preflight, 'enabled', true, opts);
    expect(installed.status).toBe('completed');
    if (installed.status !== 'completed') return;

    const disable = await preflightPluginDisable(installed.installation.id, opts);
    expect(disable.ok).toBe(true);
    if (!disable.ok) return;
    const hookError = new Error('disable hook failed');
    await expect(confirmPluginDisable(disable.preflight, {
      ...opts,
      beforeDisableCommit: () => {
        throw hookError;
      },
    })).rejects.toBe(hookError);

    expect((await readReceiptJournal(opts)).receipts.at(-1)).toEqual(
      expect.objectContaining({
        operation: 'Plugin Disablement',
        summary: 'Persistence Failed',
        durableOutcome: 'failed',
        expectedStateRevision: disable.preflight.stateRevision,
        observedStateRevision: disable.preflight.stateRevision,
        findings: expect.arrayContaining([
          expect.objectContaining({
            code: 'PERSISTENCE_FAILED',
            outcome: 'disable hook failed',
          }),
        ]),
      }),
    );

    const admittedAgain = await preflightPluginDisable(installed.installation.id, opts);
    expect(admittedAgain.ok).toBe(true);
    if (admittedAgain.ok) await declinePluginDisable(admittedAgain.preflight, opts);
  });

  it('journals Plugin Installation hook failure and releases its Attempt Fence', async () => {
    const opts = { agentDir: env.agentDir };
    const first = await preflightPluginInstallation(registrationId, '/plugins/0', opts);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const hookError = new Error('installation hook failed');
    await expect(confirmPluginInstallation(first.preflight, 'disabled', {
      ...opts,
      beforeInstallationCommit: () => {
        throw hookError;
      },
    })).rejects.toBe(hookError);

    expect((await readReceiptJournal(opts)).receipts.at(-1)).toEqual(
      expect.objectContaining({
        operation: 'Plugin Installation',
        summary: 'Persistence Failed',
        durableOutcome: 'failed',
        expectedStateRevision: first.preflight.stateRevision,
        observedStateRevision: first.preflight.stateRevision,
        findings: expect.arrayContaining([
          expect.objectContaining({
            code: 'PERSISTENCE_FAILED',
            outcome: 'installation hook failed',
          }),
        ]),
      }),
    );

    const admittedAgain = await preflightPluginInstallation(registrationId, '/plugins/0', opts);
    expect(admittedAgain.ok).toBe(true);
    if (admittedAgain.ok) await declinePluginInstallation(admittedAgain.preflight, opts);
  });

  it('rejects disablement as stale when the State Revision advances after fence admission', async () => {
    const opts = { agentDir: env.agentDir };
    const preflight = await preflightPluginInstallation(registrationId, '/plugins/0', opts);
    expect(preflight.ok).toBe(true);
    if (!preflight.ok) return;
    const installed = await confirmPluginInstallation(preflight.preflight, 'enabled', true, opts);
    expect(installed.status).toBe('completed');
    if (installed.status !== 'completed') return;

    const outcome = await disablePluginInstallation(installed.installation.id, {
      ...opts,
      beforeDisableCommit: async () => {
        await commitBridgeState((state) => ({ ...state }), opts);
      },
    });
    expect(outcome.status).toBe('rejected-as-stale');
    if (outcome.status === 'rejected-as-stale') expect(outcome.receipt.summary).toBe('Rejected as Stale');

    const state = await readBridgeState(opts);
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

    const result = await preflightPluginInstallation(registrationId, '/plugins/0', { agentDir: env.agentDir });
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

    const result = await preflightPluginInstallation(registrationId, '/plugins/0', { agentDir: env.agentDir });
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

    const inspected = inspectMarketplaceEntries({ id: registrationId, sourceKind: 'local', source: env.marketplace });
    expect(inspected.entries).toHaveLength(2);
    expect(inspected.entries.every((entry) => entry.unavailableReason === undefined)).toBe(true);
    const choices = await entryChoices({ id: registrationId, sourceKind: 'local', source: env.marketplace }, {});
    expect(choices).toHaveLength(2);
    expect(choices.map((choice) => choice.pointer)).toEqual(['/plugins/0', '/plugins/1']);
  });

  it('keeps both codex-plugins@98e78caf Marketplace Entries installable from the pinned fixture', async () => {
    const pinnedMarketplace = join(env.root, 'pinned-marketplace');
    materializePinnedMarketplace(pinnedMarketplace);
    const registration = { id: registrationId, sourceKind: 'local' as const, source: pinnedMarketplace };

    const inspected = inspectMarketplaceEntries(registration);
    expect(inspected.entries.map((entry) => entry.plugin?.manifestName)).toEqual(['cmd', 'dev']);
    expect(inspected.entries.every((entry) => entry.unavailableReason === undefined)).toBe(true);
    expect(inspected.entries.map((entry) => entry.plugin?.skills.length)).toEqual([8, 1]);
    expect(inspected.entries[0]!.plugin!.skills.every((skill) => skill.invocationPolicy === 'explicit')).toBe(true);
    expect(inspected.entries[1]!.plugin!.skills[0]!.invocationPolicy).toBe('implicit');
    const choices = await entryChoices(registration, {});
    expect(choices.map((choice) => choice.pointer)).toEqual(['/plugins/0', '/plugins/1']);
  });

  it('keeps a valid Entry installable when a sibling Entry is malformed', () => {
    writeFileSync(join(env.marketplace, '.agents', 'plugins', 'marketplace.json'), JSON.stringify({
      name: 'acme-marketplace',
      plugins: [{ source: { source: 'local', path: './plugins/release-helper' } }, 'malformed'],
    }));
    const inspected = inspectMarketplaceEntries({ id: registrationId, sourceKind: 'local', source: env.marketplace });
    expect(inspected.entries[0]!.unavailableReason).toBeUndefined();
    expect(inspected.entries[0]!.plugin).toBeDefined();
    expect(inspected.entries[1]!.unavailableReason).toBeDefined();
  });
});
