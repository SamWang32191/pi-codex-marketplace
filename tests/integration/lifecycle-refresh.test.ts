import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readBridgeState } from '../../src/bridge-state/store.js';
import { refreshRegistration } from '../../src/lifecycle/refresh.js';
import {
  confirmLocalRegistration,
  preflightLocalRegistration,
} from '../../src/registration/flow.js';

function makeEnv() {
  const root = mkdtempSync(join(tmpdir(), 'lifecycle-refresh-'));
  return {
    root,
    agentDir: join(root, 'agent'),
    marketplace: join(root, 'marketplace'),
  };
}

function makeMarketplace(root: string) {
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

describe('Marketplace Refresh — non-mutating Update Candidate production', () => {
  let env: ReturnType<typeof makeEnv>;
  let registrationId: string;

  beforeEach(async () => {
    env = makeEnv();
    makeMarketplace(env.marketplace);
    // Register through the real lifecycle seam so the recorded Validation Snapshot is exact.
    const preflight = await preflightLocalRegistration(env.marketplace, {
      agentDir: env.agentDir,
    });
    expect(preflight.ok).toBe(true);
    if (!preflight.ok) return;
    const confirmed = await confirmLocalRegistration(preflight.preflight, true, {
      agentDir: env.agentDir,
    });
    expect(confirmed.status).toBe('completed');
    if (confirmed.status !== 'completed') return;
    registrationId = confirmed.registration.id;
  });

  afterEach(() => rmSync(env.root, { recursive: true, force: true }));

  it('explicitly reports no change when the live tree still matches the recorded Validation Snapshot', async () => {
    const before = await readBridgeState({ agentDir: env.agentDir });

    const outcome = await refreshRegistration(registrationId, {
      agentDir: env.agentDir,
    });

    expect(outcome.status).toBe('no-change');
    if (outcome.status !== 'no-change') return;
    expect(outcome.receipt.operation).toBe('Marketplace Refresh');
    expect(outcome.receipt.summary).toBe('Completed');
    expect(outcome.receipt.stateChanged).toBe(false);

    const after = await readBridgeState({ agentDir: env.agentDir });
    expect(after.state!.stateRevision).toBe(before.state!.stateRevision);
  });

  it('produces an Update Candidate on source drift without mutating Bridge State', async () => {
    const before = await readBridgeState({ agentDir: env.agentDir });
    const recorded = before.state!.registrations[0].validationSnapshot;

    // External change outside Marketplace Refresh: a new skill joins the Plugin.
    mkdirSync(join(env.marketplace, 'plugins', 'release-helper', 'skills', 'changelog'), { recursive: true });
    writeFileSync(
      join(env.marketplace, 'plugins', 'release-helper', 'skills', 'changelog', 'SKILL.md'),
      '---\nname: changelog\ndescription: Maintain changelog\n---\n\nMaintain the changelog.\n',
    );

    const outcome = await refreshRegistration(registrationId, {
      agentDir: env.agentDir,
    });

    expect(outcome.status).toBe('update-candidate');
    if (outcome.status !== 'update-candidate') return;
    expect(outcome.candidate.registrationId).toBe(registrationId);
    expect(outcome.candidate.recordedFingerprint).toBe(recorded);
    expect(outcome.candidate.snapshot.fingerprint).not.toBe(recorded);
    expect(outcome.candidate.snapshot.entries.length).toBeGreaterThan(0);
    expect(outcome.receipt.summary).toBe('Completed');
    expect(outcome.receipt.stateChanged).toBe(false);

    // Refresh never writes: revision and recorded snapshot stay exact.
    const after = await readBridgeState({ agentDir: env.agentDir });
    expect(after.state!.stateRevision).toBe(before.state!.stateRevision);
    expect(after.state!.registrations[0].validationSnapshot).toBe(recorded);
  });

  it('blocks with a stable finding when the Registration is not in Bridge State', async () => {
    const outcome = await refreshRegistration('99999999-9999-4999-8999-999999999999', {
      agentDir: env.agentDir,
    });
    expect(outcome.status).toBe('blocked');
    if (outcome.status !== 'blocked') return;
    expect(outcome.findings[0].code).toBe('REGISTRATION_NOT_FOUND');
    expect(outcome.receipt.summary).toBe('Blocked');
  });
});
