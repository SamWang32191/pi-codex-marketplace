/**
 * Integration — Marketplace Format flip semantics (#47).
 *
 * A Registration's Marketplace Format is fixed at confirmation. When the upstream source later
 * flips (e.g. the codex catalog disappears and only the claude catalog remains), the change may
 * surface only as an Update Candidate produced by an explicit Marketplace Refresh, and lands on
 * the Registration only through an explicit Apply Update. Browse never adopts the flip silently.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readBridgeState } from '../../src/bridge-state/store.js';
import { inspectMarketplaceEntries } from '../../src/installation/inspection.js';
import { refreshRegistration } from '../../src/lifecycle/refresh.js';
import { buildUpdatePlan } from '../../src/lifecycle/update-plan.js';
import { applyUpdate } from '../../src/lifecycle/update.js';
import {
  confirmLocalRegistration,
  preflightLocalRegistration,
} from '../../src/registration/flow.js';

function makeEnv() {
  const root = mkdtempSync(join(tmpdir(), 'format-flip-'));
  return {
    root,
    agentDir: join(root, 'agent'),
    marketplace: join(root, 'marketplace'),
  };
}

/** Both catalogs coexist; codex must win detection without any extra question. */
function makeDualCatalogRoot(root: string): void {
  mkdirSync(join(root, '.agents', 'plugins'), { recursive: true });
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });

  mkdirSync(join(root, 'plugins', 'release-helper', '.codex-plugin'), { recursive: true });
  mkdirSync(join(root, 'plugins', 'release-helper', 'skills', 'release-notes'), { recursive: true });
  writeFileSync(
    join(root, '.agents', 'plugins', 'marketplace.json'),
    JSON.stringify({
      name: 'acme-marketplace',
      plugins: [{ name: 'release-helper', source: { source: 'local', path: './plugins/release-helper' } }],
    }),
  );
  writeFileSync(join(root, 'plugins', 'release-helper', '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'release-helper', skills: './skills/' }));
  writeFileSync(
    join(root, 'plugins', 'release-helper', 'skills', 'release-notes', 'SKILL.md'),
    '---\nname: release-notes\ndescription: Write release notes\n---\n\nWrite release notes.\n',
  );

  mkdirSync(join(root, 'claude-plugin-src', '.claude-plugin'), { recursive: true });
  writeFileSync(join(root, 'claude-plugin-src', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'mattpocock-skills', skills: ['./skills/code-review'] }));
  mkdirSync(join(root, 'claude-plugin-src', 'skills', 'code-review'), { recursive: true });
  writeFileSync(
    join(root, 'claude-plugin-src', 'skills', 'code-review', 'SKILL.md'),
    '---\nname: code-review\ndescription: Review code changes\n---\n\nReview code.\n',
  );
  writeFileSync(
    join(root, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      name: 'matt-marketplace',
      owner: { name: 'Matt Pocock' },
      plugins: [{ name: 'mattpocock-skills', source: './claude-plugin-src' }],
    }),
  );
}

/** The flip: upstream removes the codex catalog entirely. */
function flipToClaudeOnly(root: string): void {
  rmSync(join(root, '.agents'), { recursive: true, force: true });
}

describe('Marketplace Format flip — Refresh → Update Candidate → explicit Apply Update', () => {
  let env: ReturnType<typeof makeEnv>;
  let registrationId: string;

  beforeEach(async () => {
    env = makeEnv();
    makeDualCatalogRoot(env.marketplace);
    const preflight = await preflightLocalRegistration(env.marketplace, { agentDir: env.agentDir });
    expect(preflight.ok).toBe(true);
    if (!preflight.ok) return;
    // codex wins while both catalogs coexist
    expect(preflight.preflight.format).toBe('codex');
    const confirmed = await confirmLocalRegistration(preflight.preflight, true, { agentDir: env.agentDir });
    expect(confirmed.status).toBe('completed');
    if (confirmed.status !== 'completed') return;
    registrationId = confirmed.registration.id;
  });

  afterEach(() => rmSync(env.root, { recursive: true, force: true }));

  it('surfacing the flip requires a Refresh; applying it requires an explicit Apply Update', async () => {
    flipToClaudeOnly(env.marketplace);

    // Browse stays bound to the registered codex format — no silent adoption.
    const stateBefore = await readBridgeState({ agentDir: env.agentDir });
    const registered = stateBefore.state!.registrations.find((item) => item.id === registrationId)!;
    expect(registered.format).toBe('codex');
    const browse = inspectMarketplaceEntries(registered);
    expect(browse.entries.some((item) => item.plugin)).toBe(false);
    expect(browse.findings.some((finding) => finding.code === 'CATALOG_MISSING')).toBe(true);

    // Explicit Marketplace Refresh validates the flipped tree under its detected claude format.
    const refreshed = await refreshRegistration(registrationId, { agentDir: env.agentDir });
    expect(refreshed.status).toBe('update-candidate');
    if (refreshed.status !== 'update-candidate') return;
    expect(refreshed.candidate.format).toBe('claude');
    expect(refreshed.candidate.inspection.marketplaceId).toBe(`${registrationId}/matt-marketplace`);

    // Bridge State is still unchanged before Apply Update.
    const stateMid = await readBridgeState({ agentDir: env.agentDir });
    expect(stateMid.state!.registrations.find((item) => item.id === registrationId)!.format).toBe('codex');

    const plan = buildUpdatePlan(refreshed.candidate, [], refreshed.candidate.stateRevision, {
      kind: 'apply-update',
      registrationConfirmed: true,
      choices: {},
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const applied = await applyUpdate(plan.plan, { agentDir: env.agentDir });
    expect(applied.status).toBe('completed');

    const stateAfter = await readBridgeState({ agentDir: env.agentDir });
    const flipped = stateAfter.state!.registrations.find((item) => item.id === registrationId)!;
    expect(flipped.format).toBe('claude');

    // And now browse reads the claude catalog.
    const browseAfter = inspectMarketplaceEntries(flipped);
    expect(browseAfter.marketplaceId).toBe(`${registrationId}/matt-marketplace`);
    expect(browseAfter.entries.filter((item) => item.classification === 'compatible')).toHaveLength(1);
  });
});
