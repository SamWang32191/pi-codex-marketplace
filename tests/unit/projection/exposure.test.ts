/**
 * Runtime Skill Exposure — read-time discovery of Projected Skill paths for Pi's
 * resource-discovery seam. See CONTEXT.md: Runtime Skill Exposure, Projected Skill,
 * Effective State, Scope Override, Project Trust, Runtime Skill Collision.
 *
 * Only external observable behavior is asserted: which skill directories are contributed,
 * which Installations are skipped and why, that discovery never mutates Bridge State and
 * never writes an Attempt Receipt, and that missing cache material never fails discovery.
 */

import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { discoverProjectedSkillPaths } from '../../../src/projection/exposure.js';
import { commitBridgeState, readBridgeStateSync } from '../../../src/bridge-state/store.js';
import { getReceiptsJournalPath } from '../../../src/bridge-state/paths.js';
import { SourceCache } from '../../../src/cache/source-cache.js';
import type { BridgeState } from '../../../src/bridge-state/types.js';

const GLOBAL_REG = '11111111-1111-4111-8111-111111111111';

function makeEnv() {
  const root = mkdtempSync(join(tmpdir(), 'exposure-unit-'));
  return {
    root,
    agentDir: join(root, 'agent'),
    projectDir: join(root, 'project'),
    marketplace: join(root, 'marketplace'),
  };
}

/** One marketplace root with a single compatible plugin exposing `skillNames`. */
function makeMarketplace(root: string, pluginDirName: string, manifestName: string, skillNames: string[]): void {
  mkdirSync(join(root, '.agents', 'plugins'), { recursive: true });
  writeFileSync(
    join(root, '.agents', 'plugins', 'marketplace.json'),
    JSON.stringify({
      name: 'acme-marketplace',
      plugins: [{ name: manifestName, source: { source: 'local', path: `./plugins/${pluginDirName}` } }],
    }),
  );
  makePluginAt(root, pluginDirName, manifestName, skillNames);
}

function makePluginAt(root: string, pluginDirName: string, manifestName: string, skillNames: string[]): void {
  mkdirSync(join(root, 'plugins', pluginDirName, '.codex-plugin'), { recursive: true });
  writeFileSync(join(root, 'plugins', pluginDirName, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: manifestName, skills: './skills/' }));
  for (const skillName of skillNames) {
    mkdirSync(join(root, 'plugins', pluginDirName, 'skills', skillName), { recursive: true });
    writeFileSync(
      join(root, 'plugins', pluginDirName, 'skills', skillName, 'SKILL.md'),
      `---\nname: ${skillName}\ndescription: ${skillName} skill\n---\n\n${skillName} body.\n`,
    );
  }
}

async function seedGitRegistrationAndCache(env: ReturnType<typeof makeEnv>, opts: { registrationId?: string } = {}): Promise<{ fingerprint: string }> {
  const registrationId = opts.registrationId ?? GLOBAL_REG;
  // Acquire the tree into the Source Cache exactly as Git acquisition would.
  const cache = new SourceCache({ agentDir: env.agentDir });
  const fingerprint = 'a'.repeat(64);
  await cache.storeTree(env.marketplace, fingerprint);
  await commitBridgeState(
    'global',
    (state: BridgeState) => ({
      ...state,
      registrations: [
        ...state.registrations,
        {
          id: registrationId,
          alias: 'acme',
          marketplaceName: 'acme-marketplace',
          sourceKind: 'git' as const,
          source: 'https://github.com/acme/marketplace.git',
          canonicalLocator: 'https://github.com/acme/marketplace.git',
          validationSnapshot: fingerprint,
        },
      ],
      installations: [
        ...state.installations,
        {
          id: `global/${registrationId}/acme-marketplace/release-helper`,
          pluginId: `${registrationId}/acme-marketplace/release-helper`,
          installationState: 'enabled' as const,
          registrationId,
          marketplaceEntryId: `${registrationId}/acme-marketplace/plugins/0`,
          validationSnapshot: `bound-${fingerprint.slice(0, 8)}`,
          manifestName: 'release-helper',
        },
      ],
    }),
    { agentDir: env.agentDir, cwd: env.projectDir },
  );
  return { fingerprint };
}

let envs: ReturnType<typeof makeEnv>[] = [];

function freshEnv(): ReturnType<typeof makeEnv> {
  const env = makeEnv();
  envs.push(env);
  return env;
}

beforeEach(() => {
  envs = [];
});

afterEach(() => {
  while (envs.length > 0) rmSync(envs.pop()!.root, { recursive: true, force: true });
});

describe('Runtime Skill Exposure — contribution', () => {
  it('contributes each surviving skill directory inside the pinned cache entry with provenance', async () => {
    const env = freshEnv();
    makeMarketplace(env.marketplace, 'release-helper', 'release-helper', ['release-notes', 'changelog']);
    const { fingerprint } = await seedGitRegistrationAndCache(env);

    const result = discoverProjectedSkillPaths({ cwd: env.projectDir, agentDir: env.agentDir });

    expect(result.skillPaths).toHaveLength(2);
    expect(result.exposed.map((s) => s.name).sort()).toEqual(['changelog', 'release-notes']);
    expect(result.skipped).toEqual([]);
    for (const exposed of result.exposed) {
      expect(exposed.pluginId).toBe(`${GLOBAL_REG}/acme-marketplace/release-helper`);
      expect(exposed.installationId).toBe(`global/${GLOBAL_REG}/acme-marketplace/release-helper`);
      expect(exposed.skillId).toBe(`${GLOBAL_REG}/acme-marketplace/release-helper/${exposed.name}`);
      expect(exposed.sourceScope).toBe('global');
      expect(realpathSync(exposed.skillDir)).toBe(
        realpathSync(join(new SourceCache({ agentDir: env.agentDir }).entryPath(fingerprint), 'plugins', 'release-helper', 'skills', exposed.name)),
      );
      expect(existsSync(join(exposed.skillDir, 'SKILL.md'))).toBe(true);
    }
  });

  it('is deterministic across repeated discoveries (startup vs reload see identical output)', async () => {
    const env = freshEnv();
    makeMarketplace(env.marketplace, 'release-helper', 'release-helper', ['release-notes']);
    await seedGitRegistrationAndCache(env);

    const first = discoverProjectedSkillPaths({ cwd: env.projectDir, agentDir: env.agentDir });
    const second = discoverProjectedSkillPaths({ cwd: env.projectDir, agentDir: env.agentDir });
    expect(first.skillPaths).toEqual(second.skillPaths);
  });

  it('excludes disabled Installations — only enabled participate', async () => {
    const env = freshEnv();
    makeMarketplace(env.marketplace, 'release-helper', 'release-helper', ['release-notes']);
    const { fingerprint } = await seedGitRegistrationAndCache(env);
    await commitBridgeState(
      'global',
      (state) => ({
        ...state,
        installations: state.installations.map((i) => ({ ...i, installationState: 'disabled' as const })),
      }),
      { agentDir: env.agentDir, cwd: env.projectDir },
    );

    const result = discoverProjectedSkillPaths({ cwd: env.projectDir, agentDir: env.agentDir });
    expect(result.skillPaths).toEqual([]);
    expect(result.exposed).toEqual([]);
    void fingerprint;
  });

  it('legacy persisted Scope Overrides do not suppress Runtime Skill Exposure', async () => {
    const env = freshEnv();
    makeMarketplace(env.marketplace, 'release-helper', 'release-helper', ['release-notes']);
    await seedGitRegistrationAndCache(env);
    // A pre-retirement project document still carrying a suppression entry must be ignored.
    await commitBridgeState('project', (state) => ({ ...state, scopeOverrides: [{ kind: 'registration', targetId: GLOBAL_REG }] }), { agentDir: env.agentDir, cwd: env.projectDir });

    expect(discoverProjectedSkillPaths({ cwd: env.projectDir, agentDir: env.agentDir, projectTrusted: true }).skillPaths).toHaveLength(1);
  });

  it('without Project Trust, project additions do not contribute; global baseline still does', async () => {
    const env = freshEnv();
    makeMarketplace(env.marketplace, 'release-helper', 'release-helper', ['global-skill']);
    await seedGitRegistrationAndCache(env);

    const PROJECT_REG = '22222222-2222-4222-8222-222222222222';
    const projectMarket = join(env.root, 'project-market');
    makeMarketplace(projectMarket, 'beta-tool', 'beta-tool', ['project-skill']);
    const cache = new SourceCache({ agentDir: env.agentDir });
    const projectFp = 'b'.repeat(64);
    await cache.storeTree(projectMarket, projectFp);
    await commitBridgeState(
      'project',
      (state) => ({
        ...state,
        registrations: [
          ...state.registrations,
          {
            id: PROJECT_REG,
            alias: 'beta',
            marketplaceName: 'acme-marketplace',
            sourceKind: 'git' as const,
            source: 'https://github.com/acme/project-market.git',
            validationSnapshot: projectFp,
          },
        ],
        installations: [
          ...state.installations,
          {
            id: `project/${PROJECT_REG}/acme-marketplace/beta-tool`,
            pluginId: `${PROJECT_REG}/acme-marketplace/beta-tool`,
            installationState: 'enabled' as const,
            registrationId: PROJECT_REG,
            marketplaceEntryId: `${PROJECT_REG}/acme-marketplace/plugins/0`,
            validationSnapshot: `bound-${projectFp.slice(0, 8)}`,
            manifestName: 'beta-tool',
          },
        ],
      }),
      { agentDir: env.agentDir, cwd: env.projectDir },
    );

    const untrusted = discoverProjectedSkillPaths({ cwd: env.projectDir, agentDir: env.agentDir, projectTrusted: false });
    expect(untrusted.exposed.map((s) => s.name)).toEqual(['global-skill']);

    const trusted = discoverProjectedSkillPaths({ cwd: env.projectDir, agentDir: env.agentDir, projectTrusted: true });
    expect(trusted.exposed.map((s) => s.name).sort()).toEqual(['global-skill', 'project-skill']);
  });

  it('resolves cross-scope Runtime Skill Collision at skill granularity — only the Project survivor is contributed', async () => {
    const env = freshEnv();
    makeMarketplace(env.marketplace, 'release-helper', 'release-helper', ['shared-name']);
    await seedGitRegistrationAndCache(env);

    const PROJECT_REG = '33333333-3333-4333-8333-333333333333';
    const projectMarket = join(env.root, 'project-market');
    makeMarketplace(projectMarket, 'helper-two', 'helper-two', ['shared-name']);
    const cache = new SourceCache({ agentDir: env.agentDir });
    const projectFp = 'c'.repeat(64);
    await cache.storeTree(projectMarket, projectFp);
    await commitBridgeState(
      'project',
      (state) => ({
        ...state,
        registrations: [
          ...state.registrations,
          { id: PROJECT_REG, alias: 'beta', marketplaceName: 'beta-marketplace', sourceKind: 'git' as const, source: 'https://github.com/acme/beta.git', validationSnapshot: projectFp },
        ],
        installations: [
          ...state.installations,
          {
            id: `project/${PROJECT_REG}/beta-marketplace/helper-two`,
            pluginId: `${PROJECT_REG}/beta-marketplace/helper-two`,
            installationState: 'enabled' as const,
            registrationId: PROJECT_REG,
            marketplaceEntryId: `${PROJECT_REG}/beta-marketplace/plugins/0`,
            validationSnapshot: `bound-${projectFp.slice(0, 8)}`,
            manifestName: 'helper-two',
          },
        ],
      }),
      { agentDir: env.agentDir, cwd: env.projectDir },
    );

    const result = discoverProjectedSkillPaths({ cwd: env.projectDir, agentDir: env.agentDir, projectTrusted: true });
    expect(result.exposed.map((s) => s.sourceScope)).toEqual(['project']);
    expect(result.skillPaths).toHaveLength(1);
    expect(result.skillPaths[0]).toContain(join('plugins', 'helper-two', 'skills', 'shared-name'));
  });

  it('a pre-existing Pi-layer name reserves the name when supplied via piSkillNames', async () => {
    const env = freshEnv();
    makeMarketplace(env.marketplace, 'release-helper', 'release-helper', ['deploy']);
    await seedGitRegistrationAndCache(env);

    const result = discoverProjectedSkillPaths({ cwd: env.projectDir, agentDir: env.agentDir, piSkillNames: ['deploy'] });
    expect(result.skillPaths).toEqual([]);
  });
});

describe('Runtime Skill Exposure — passive inspection only', () => {
  it('skips a deleted cache entry without failing, without mutating State, and without writing an Attempt Receipt', async () => {
    const env = freshEnv();
    makeMarketplace(env.marketplace, 'release-helper', 'release-helper', ['release-notes']);
    const { fingerprint } = await seedGitRegistrationAndCache(env);
    const revisionBefore = readBridgeStateSync('global', { agentDir: env.agentDir, cwd: env.projectDir }).state!.stateRevision;

    // External deletion outside any lifecycle operation.
    const cache = new SourceCache({ agentDir: env.agentDir });
    rmSync(cache.entryPath(fingerprint), { recursive: true, force: true });
    rmSync(cache.metaPath(fingerprint), { force: true });

    const result = discoverProjectedSkillPaths({ cwd: env.projectDir, agentDir: env.agentDir });
    expect(result.skillPaths).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toBe('missing-cache-entry');

    // Passive: no receipt journal materialized in either scope, State Revision untouched.
    expect(readBridgeStateSync('global', { agentDir: env.agentDir, cwd: env.projectDir }).state!.stateRevision).toBe(revisionBefore);
    expect(existsSync(getReceiptsJournalPath('global', { agentDir: env.agentDir, cwd: env.projectDir }))).toBe(false);
    expect(existsSync(getReceiptsJournalPath('project', { agentDir: env.agentDir, cwd: env.projectDir }))).toBe(false);
  });

  it('skips an Installation whose cached catalog cannot be read', async () => {
    const env = freshEnv();
    makeMarketplace(env.marketplace, 'release-helper', 'release-helper', ['release-notes']);
    const { fingerprint } = await seedGitRegistrationAndCache(env);

    const cache = new SourceCache({ agentDir: env.agentDir });
    rmSync(join(cache.entryPath(fingerprint), '.agents', 'plugins', 'marketplace.json'));

    const result = discoverProjectedSkillPaths({ cwd: env.projectDir, agentDir: env.agentDir });
    expect(result.skillPaths).toEqual([]);
    expect(result.skipped[0]?.reason).toBe('catalog-unreadable');
  });

  it('skips an Installation whose Marketplace Entry cannot be resolved in the snapshot', async () => {
    const env = freshEnv();
    makeMarketplace(env.marketplace, 'release-helper', 'release-helper', ['release-notes']);
    await seedGitRegistrationAndCache(env);
    await commitBridgeState(
      'global',
      (state) => ({
        ...state,
        installations: [
          ...state.installations,
          {
            id: `${GLOBAL_REG}/acme-marketplace/ghost`,
            pluginId: `${GLOBAL_REG}/acme-marketplace/ghost`,
            installationState: 'enabled' as const,
            registrationId: GLOBAL_REG,
            marketplaceEntryId: `${GLOBAL_REG}/acme-marketplace/plugins/99`,
            validationSnapshot: 'bound-ghost',
            manifestName: 'ghost',
          },
        ],
      }),
      { agentDir: env.agentDir, cwd: env.projectDir },
    );

    const result = discoverProjectedSkillPaths({ cwd: env.projectDir, agentDir: env.agentDir });
    expect(result.exposed.map((s) => s.name)).toEqual(['release-notes']); // healthy one stays
    const ghost = result.skipped.find((s) => s.installationId.endsWith('/ghost'));
    expect(ghost?.reason).toBe('entry-not-found');
  });

  it('treats a malformed Marketplace Entry ID as no pointer and falls back to manifestName instead of a tail slice', async () => {
    const env = freshEnv();
    makeMarketplace(env.marketplace, 'release-helper', 'release-helper', ['release-notes']);
    await seedGitRegistrationAndCache(env);
    // Overwrite the Installation's marketplaceEntryId with an ID lacking the "/plugins/" marker.
    await commitBridgeState(
      'global',
      (state) => ({
        ...state,
        installations: state.installations.map((installation) =>
          installation.manifestName === 'release-helper' ? { ...installation, marketplaceEntryId: 'not-a-pointer' } : installation,
        ),
      }),
      { agentDir: env.agentDir, cwd: env.projectDir },
    );

    const result = discoverProjectedSkillPaths({ cwd: env.projectDir, agentDir: env.agentDir });
    // The retained manifestName still resolves the entry; the malformed ID must not produce a bogus pointer.
    expect(result.exposed.map((s) => s.name)).toEqual(['release-notes']);
    expect(result.skipped).toEqual([]);
  });

  it('treats corrupted or incompatible scope documents as empty instead of failing', async () => {
    const env = freshEnv();
    mkdirSync(join(env.agentDir, 'codex-marketplace'), { recursive: true });
    writeFileSync(join(env.agentDir, 'codex-marketplace', 'state.json'), '{ corrupted', 'utf-8');

    const result = discoverProjectedSkillPaths({ cwd: env.projectDir, agentDir: env.agentDir });
    expect(result.skillPaths).toEqual([]);
    expect(result.exposed).toEqual([]);
  });

  it('local Registrations expose skills from their live Marketplace Root without a cache round-trip', async () => {
    const env = freshEnv();
    makeMarketplace(env.marketplace, 'release-helper', 'release-helper', ['local-skill']);
    await commitBridgeState(
      'global',
      (state) => ({
        ...state,
        registrations: [
          ...state.registrations,
          { id: GLOBAL_REG, alias: 'acme-local', marketplaceName: 'acme-marketplace', sourceKind: 'local' as const, source: env.marketplace },
        ],
        installations: [
          ...state.installations,
          {
            id: `global/${GLOBAL_REG}/acme-marketplace/release-helper`,
            pluginId: `${GLOBAL_REG}/acme-marketplace/release-helper`,
            installationState: 'enabled' as const,
            registrationId: GLOBAL_REG,
            marketplaceEntryId: `${GLOBAL_REG}/acme-marketplace/plugins/0`,
            validationSnapshot: 'local-bound-snapshot',
            manifestName: 'release-helper',
          },
        ],
      }),
      { agentDir: env.agentDir, cwd: env.projectDir },
    );

    const result = discoverProjectedSkillPaths({ cwd: env.projectDir, agentDir: env.agentDir });
    expect(result.exposed.map((s) => s.name)).toEqual(['local-skill']);
    expect(realpathSync(result.skillPaths[0]!)).toBe(realpathSync(join(env.marketplace, 'plugins', 'release-helper', 'skills', 'local-skill')));
  });
});
