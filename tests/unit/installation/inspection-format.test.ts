import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { commitBridgeState, readBridgeState } from '../../../src/bridge-state/store.js';
import type { Registration } from '../../../src/bridge-state/types.js';
import { inspectMarketplaceEntries } from '../../../src/installation/inspection.js';

type Env = { agentDir: string; root: string };

function makeEnv(): Env {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'inspection-format-')));
  return { agentDir: join(root, 'agent'), root };
}

/** mattpocock-shaped claude marketplace: nested skill categories under declared skills paths. */
function makeClaudeRoot(root: string): void {
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  const pluginRoot = join(root, 'plugins', 'mattpocock-skills');
  mkdirSync(join(pluginRoot, '.claude-plugin'), { recursive: true });
  mkdirSync(join(pluginRoot, 'skills', 'engineering', 'code-review'), { recursive: true });
  writeFileSync(
    join(pluginRoot, 'skills', 'engineering', 'code-review', 'SKILL.md'),
    '---\nname: code-review\ndescription: Review code changes\ndisable-model-invocation: true\n---\n\nReview code.\n',
  );
  mkdirSync(join(pluginRoot, 'skills', 'interview', 'grilling'), { recursive: true });
  writeFileSync(
    join(pluginRoot, 'skills', 'interview', 'grilling', 'SKILL.md'),
    '---\nname: grilling\ndescription: Grill the plan\n---\n\nGrill.\n',
  );
  writeFileSync(
    join(pluginRoot, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'mattpocock-skills', skills: ['./skills/engineering/code-review', './skills/interview/grilling'] }),
  );
  writeFileSync(
    join(root, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      name: 'matt-marketplace',
      owner: { name: 'Matt Pocock' },
      plugins: [
        { name: 'mattpocock-skills', source: './plugins/mattpocock-skills' },
        // bare name entry → Unavailable with its stable reason
        { name: 'external-tool', source: 'external-tool' },
      ],
    }),
  );
}

async function registerLocal(env: Env, format?: 'codex' | 'claude', validationSnapshot?: string): Promise<Registration> {
  const registration: Registration = {
    id: '22222222-2222-4222-8222-222222222222',
    marketplaceName: 'matt-marketplace',
    sourceKind: 'local',
    source: env.root,
    ...(format ? { format } : {}),
    ...(validationSnapshot ? { validationSnapshot } : {}),
  };
  await commitBridgeState(
    (current) => ({ ...current, registrations: [...current.registrations, registration] }),
    { agentDir: env.agentDir },
  );
  return registration;
}

describe('Marketplace Entry inspection — format-bound browse (#47)', () => {
  let env: Env;

  beforeEach(() => {
    env = makeEnv();
    makeClaudeRoot(env.root);
  });
  afterEach(() => {
    try { rmSync(env.root, { recursive: true, force: true }); } catch {}
  });

  it('browses a registered claude marketplace: Compatible entry lists the plugin and every nested skill', async () => {
    const registration = await registerLocal(env, 'claude');
    const inspection = inspectMarketplaceEntries(registration);

    expect(inspection.marketplaceId).toBe(`${registration.id}/matt-marketplace`);
    const compatible = inspection.entries.filter((item) => item.classification === 'compatible');
    expect(compatible).toHaveLength(1);
    expect(compatible[0]!.plugin!.manifestName).toBe('mattpocock-skills');
    const skillNames = compatible[0]!.plugin!.skills.map((skill) => skill.name);
    expect(skillNames).toEqual(['code-review', 'grilling']);
    // Invocation Policy derives solely from the Skill Descriptor frontmatter in claude format
    expect(compatible[0]!.plugin!.skills.find((skill) => skill.name === 'code-review')!.invocationPolicy).toBe('explicit');
    expect(compatible[0]!.plugin!.skills.find((skill) => skill.name === 'grilling')!.invocationPolicy).toBe('implicit');
  });

  it('discloses why an unqualified claude entry is an Unavailable Entry', async () => {
    const registration = await registerLocal(env, 'claude');
    const inspection = inspectMarketplaceEntries(registration);

    const unavailable = inspection.entries.find((item) => item.entry.name === 'external-tool');
    expect(unavailable?.classification).toBeUndefined();
    expect(unavailable?.unavailableReason).toMatch(/bare name source/);
  });

  it('reads a codex-registered root through codex only — an upstream flip is never adopted implicitly', async () => {
    // Registration was created as codex (both catalogs used to coexist; codex won).
    mkdirSync(join(env.root, '.agents', 'plugins'), { recursive: true });
    writeFileSync(
      join(env.root, '.agents', 'plugins', 'marketplace.json'),
      JSON.stringify({ name: 'matt-marketplace', plugins: [{ name: 'legacy', path: './plugins/mattpocock-skills' }] }),
    );
    const registration = await registerLocal(env, 'codex', 'c'.repeat(64));

    // Upstream removes the codex catalog — browse stays bound to the registered format.
    rmSync(join(env.root, '.agents'), { recursive: true, force: true });

    const inspection = inspectMarketplaceEntries(registration);
    expect(inspection.entries).toEqual([]);
    // fail-closed: the registered format cannot read its catalog, and nothing claude-shaped appears
    expect(inspection.findings.some((finding) => finding.code === 'CATALOG_MISSING')).toBe(true);
    expect(inspection.entries.some((item) => item.plugin)).toBe(false);
  });

  it('legacy registrations without a persisted format keep reading codex', async () => {
    mkdirSync(join(env.root, '.agents', 'plugins'), { recursive: true });
    mkdirSync(join(env.root, 'plugins', 'release-helper'), { recursive: true });
    writeFileSync(join(env.root, 'plugins', 'release-helper', 'plugin.json'), JSON.stringify({ name: 'release-helper' }));
    writeFileSync(join(env.root, 'plugins', 'release-helper', 'SKILL.md'), '# release-helper');
    writeFileSync(
      join(env.root, '.agents', 'plugins', 'marketplace.json'),
      JSON.stringify({ name: 'matt-marketplace', plugins: [{ name: 'release-helper', path: './plugins/release-helper' }] }),
    );

    // v2→v3 migration backfills 'codex'; an absent attribute must behave identically.
    const registration = await registerLocal(env);
    const inspection = inspectMarketplaceEntries(registration);
    expect(inspection.entries).toHaveLength(1);
    expect(inspection.marketplaceId).toBe(`${registration.id}/matt-marketplace`);
  });
});
