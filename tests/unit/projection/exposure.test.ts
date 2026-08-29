/**
 * Runtime Skill Exposure — read-time discovery of Projected Skill paths for Pi's
 * resource-discovery seam. See CONTEXT.md: Runtime Skill Exposure, Projected Skill,
 * Effective State, Runtime Skill Collision.
 *
 * Global-only (#61, 極簡 #87): discovery reads the single Minimal Bridge State document only.
 * Only external observable behavior is asserted: which skill directories are contributed,
 * which Installations are skipped and why, that discovery never mutates Bridge State, and
 * that missing cache material never fails discovery.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { discoverProjectedSkillPaths } from '../../../src/projection/exposure.js';
import { readMinimalBridgeState, writeMinimalBridgeState, type MinimalBridgeState } from '../../../src/bridge/state.js';
import { SourceCache } from '../../../src/cache/source-cache.js';

const GLOBAL_REG = '11111111-1111-4111-8111-111111111111';

function makeEnv() {
  const root = mkdtempSync(join(tmpdir(), 'exposure-unit-'));
  return {
    root,
    agentDir: join(root, 'agent'),
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
  writeMinimalBridgeState({
    schemaVersion: 1,
    registrations: [
      {
        id: registrationId,
        alias: 'acme',
        marketplaceName: 'acme-marketplace',
        format: 'codex',
        sourceKind: 'git',
        source: 'https://github.com/acme/marketplace.git',
        snapshot: fingerprint,
      },
    ],
    installations: [
      {
        id: 'release-helper',
        pluginId: 'release-helper',
        enabled: true,
        installationState: 'enabled',
        registrationId,
        manifestName: 'release-helper',
        sourceKind: 'git',
        source: 'https://github.com/acme/marketplace.git',
        snapshot: `bound-${fingerprint.slice(0, 8)}`,
        skills: ['release-notes', 'changelog'],
      },
    ],
  }, { agentDir: env.agentDir });
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

    const result = discoverProjectedSkillPaths({ agentDir: env.agentDir });

    expect(result.skillPaths).toHaveLength(2);
    expect(result.exposed.map((s) => s.name).sort()).toEqual(['changelog', 'release-notes']);
    expect(result.skipped).toEqual([]);
    for (const exposed of result.exposed) {
      expect(exposed.pluginId).toBe('release-helper');
      expect(exposed.installationId).toBe('release-helper');
      expect(exposed.skillId).toBe(`release-helper/${exposed.name}`);
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

    const first = discoverProjectedSkillPaths({ agentDir: env.agentDir });
    const second = discoverProjectedSkillPaths({ agentDir: env.agentDir });
    expect(first.skillPaths).toEqual(second.skillPaths);
  });

  it('excludes disabled Installations — only enabled participate', async () => {
    const env = freshEnv();
    makeMarketplace(env.marketplace, 'release-helper', 'release-helper', ['release-notes']);
    await seedGitRegistrationAndCache(env);
    writeMinimalBridgeState({
      ...readMinimalBridgeState({ agentDir: env.agentDir }).state,
      installations: readMinimalBridgeState({ agentDir: env.agentDir }).state.installations.map((i) => ({
        ...i,
        enabled: false,
        installationState: 'disabled' as const,
      })),
    }, { agentDir: env.agentDir });

    const result = discoverProjectedSkillPaths({ agentDir: env.agentDir });
    expect(result.skillPaths).toEqual([]);
    expect(result.exposed).toEqual([]);
  });

  it('a pre-existing Pi-layer name reserves the name when supplied via piSkillNames', async () => {
    const env = freshEnv();
    makeMarketplace(env.marketplace, 'release-helper', 'release-helper', ['deploy']);
    await seedGitRegistrationAndCache(env);

    const result = discoverProjectedSkillPaths({ agentDir: env.agentDir, piSkillNames: ['deploy'] });
    expect(result.skillPaths).toEqual([]);
  });
});

describe('Runtime Skill Exposure — passive inspection only', () => {
  it('skips a deleted cache entry without failing and without mutating State', async () => {
    const env = freshEnv();
    makeMarketplace(env.marketplace, 'release-helper', 'release-helper', ['release-notes']);
    const { fingerprint } = await seedGitRegistrationAndCache(env);

    // External deletion outside any lifecycle operation.
    const cache = new SourceCache({ agentDir: env.agentDir });
    rmSync(cache.entryPath(fingerprint), { recursive: true, force: true });
    rmSync(cache.metaPath(fingerprint), { force: true });

    const result = discoverProjectedSkillPaths({ agentDir: env.agentDir });
    expect(result.skillPaths).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toBe('missing-cache-entry');

    // Passive: Bridge State untouched.
    expect(readMinimalBridgeState({ agentDir: env.agentDir }).state.installations).toHaveLength(1);
  });

  it('skips an Installation whose cached catalog cannot be read', async () => {
    const env = freshEnv();
    makeMarketplace(env.marketplace, 'release-helper', 'release-helper', ['release-notes']);
    const { fingerprint } = await seedGitRegistrationAndCache(env);

    const cache = new SourceCache({ agentDir: env.agentDir });
    rmSync(join(cache.entryPath(fingerprint), '.agents', 'plugins', 'marketplace.json'));

    const result = discoverProjectedSkillPaths({ agentDir: env.agentDir });
    expect(result.skillPaths).toEqual([]);
    expect(result.skipped[0]?.reason).toBe('catalog-unreadable');
  });

  it('skips an Installation whose Marketplace Entry cannot be resolved in the snapshot', async () => {
    const env = freshEnv();
    makeMarketplace(env.marketplace, 'release-helper', 'release-helper', ['release-notes']);
    await seedGitRegistrationAndCache(env);
    writeMinimalBridgeState({
      ...readMinimalBridgeState({ agentDir: env.agentDir }).state,
      installations: [
        ...readMinimalBridgeState({ agentDir: env.agentDir }).state.installations,
        {
          id: 'ghost',
          pluginId: 'ghost',
          enabled: true,
          installationState: 'enabled',
          registrationId: GLOBAL_REG,
          manifestName: 'ghost',
          sourceKind: 'git',
          source: 'https://github.com/acme/marketplace.git',
        },
      ],
    }, { agentDir: env.agentDir });

    const result = discoverProjectedSkillPaths({ agentDir: env.agentDir });
    expect(result.exposed.map((s) => s.name)).toEqual(['release-notes']); // healthy one stays
    const ghost = result.skipped.find((s) => s.installationId === 'ghost');
    expect(ghost?.reason).toBe('entry-not-found');
  });

  it('treats a corrupted document as empty instead of failing — and never rewrites it (passive)', async () => {
    const env = freshEnv();
    mkdirSync(join(env.agentDir, 'codex-marketplace'), { recursive: true });
    const statePath = join(env.agentDir, 'codex-marketplace', 'state.json');
    writeFileSync(statePath, '{ corrupted', 'utf-8');

    const result = discoverProjectedSkillPaths({ agentDir: env.agentDir });
    expect(result.skillPaths).toEqual([]);
    expect(result.exposed).toEqual([]);
    // Passive discovery contributes nothing and never mutates: the corrupted document stays
    // untouched (the reset contract belongs to the command surface, which announces it).
    expect(readFileSync(statePath, 'utf-8')).toBe('{ corrupted');
  });

  it('local Registrations expose skills from their live Marketplace Root without a cache round-trip', async () => {
    const env = freshEnv();
    makeMarketplace(env.marketplace, 'release-helper', 'release-helper', ['local-skill']);
    writeMinimalBridgeState({
      schemaVersion: 1,
      registrations: [
        { id: GLOBAL_REG, alias: 'acme-local', marketplaceName: 'acme-marketplace', format: 'codex', sourceKind: 'local', source: env.marketplace },
      ],
      installations: [
        {
          id: 'release-helper',
          pluginId: 'release-helper',
          enabled: true,
          installationState: 'enabled',
          registrationId: GLOBAL_REG,
          manifestName: 'release-helper',
          sourceKind: 'local',
          source: env.marketplace,
          skills: ['local-skill'],
        },
      ],
    }, { agentDir: env.agentDir });

    const result = discoverProjectedSkillPaths({ agentDir: env.agentDir });
    expect(result.exposed.map((s) => s.name)).toEqual(['local-skill']);
    expect(realpathSync(result.skillPaths[0]!)).toBe(realpathSync(join(env.marketplace, 'plugins', 'release-helper', 'skills', 'local-skill')));
  });

  it('exposes skills from Claude format registrations using declared skills array paths', async () => {
    const env = freshEnv();
    mkdirSync(join(env.marketplace, '.claude-plugin'), { recursive: true });
    const pluginDir = join(env.marketplace, 'plugins', 'mattpocock-skills');
    mkdirSync(join(pluginDir, '.claude-plugin'), { recursive: true });
    mkdirSync(join(pluginDir, 'skills', 'engineering', 'code-review'), { recursive: true });
    writeFileSync(
      join(pluginDir, 'skills', 'engineering', 'code-review', 'SKILL.md'),
      '---\nname: code-review\ndescription: Review code\n---\n\nReview.\n',
    );
    mkdirSync(join(pluginDir, 'skills', 'interview', 'grilling'), { recursive: true });
    writeFileSync(
      join(pluginDir, 'skills', 'interview', 'grilling', 'SKILL.md'),
      '---\nname: grilling\ndescription: Grill plan\n---\n\nGrill.\n',
    );
    writeFileSync(
      join(pluginDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'mattpocock-skills', skills: ['./skills/engineering/code-review', './skills/interview/grilling'] }),
    );
    writeFileSync(
      join(env.marketplace, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'matt-marketplace',
        plugins: [{ name: 'mattpocock-skills', source: './plugins/mattpocock-skills' }],
      }),
    );

    writeMinimalBridgeState({
      schemaVersion: 1,
      registrations: [
        {
          id: GLOBAL_REG,
          alias: 'matt-local',
          marketplaceName: 'matt-marketplace',
          format: 'claude',
          sourceKind: 'local',
          source: env.marketplace,
        },
      ],
      installations: [
        {
          id: 'mattpocock-skills',
          pluginId: 'mattpocock-skills',
          enabled: true,
          installationState: 'enabled',
          registrationId: GLOBAL_REG,
          manifestName: 'mattpocock-skills',
          sourceKind: 'local',
          source: env.marketplace,
          skills: ['code-review', 'grilling'],
        },
      ],
    }, { agentDir: env.agentDir });

    const result = discoverProjectedSkillPaths({ agentDir: env.agentDir });
    expect(result.exposed.map((s) => s.name).sort()).toEqual(['code-review', 'grilling']);
    expect(result.skillPaths).toHaveLength(2);
    expect(realpathSync(result.skillPaths.find((p) => p.includes('code-review'))!)).toBe(
      realpathSync(join(pluginDir, 'skills', 'engineering', 'code-review')),
    );
    expect(realpathSync(result.skillPaths.find((p) => p.includes('grilling'))!)).toBe(
      realpathSync(join(pluginDir, 'skills', 'interview', 'grilling')),
    );
  });
});