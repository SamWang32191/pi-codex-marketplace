/**
 * Runtime Skill Exposure — read-time discovery of Projected Skill directories contributed to Pi
 * through the host resource-discovery seam (`resources_discover` → `skillPaths`).
 * See CONTEXT.md: Runtime Skill Exposure, Projected Skill, Projected Plugin, Effective State,
 * Runtime Skill Collision, Source Cache, Skill Availability.
 *
 * Exposure derives entirely from the current Effective State (enabled Installations minus Scope
 * Overrides and Project Trust exclusions) and its collision survivors. It performs passive
 * existence inspection only: no fingerprint recomputation, no Bridge State mutation, and no
 * Attempt Receipt — snapshot-bound validation stays bound to Lifecycle Operations and Runtime
 * Applications. Missing cache entries or unreadable snapshot material are skipped individually;
 * discovery always completes. Exposure never establishes Skill Availability.
 *
 * Path resolution follows the retained Validation Snapshot locations:
 * - Git Registrations resolve inside the Source Cache entry pinned by their recorded base-tree
 *   fingerprint (the same addressing Marketplace Refresh and inspection reuse; both the
 *   Registration's and Installation's snapshots are state-pinned against eviction).
 * - Local Registrations resolve inside their live Marketplace Root at its canonical real path,
 *   mirroring read-time inspection; drift remains a Lifecycle Operation concern, not discovery's.
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

import { parseFrontmatter } from '@earendil-works/pi-coding-agent';

import { getCacheEntriesDir, getCacheDir } from '../cache/paths.js';
import { readBridgeStateSync } from '../bridge-state/store.js';
import type { BridgeState } from '../bridge-state/types.js';
import { parseCatalog, type Catalog } from '../registration/catalog.js';
import { BUDGET } from '../registration/budget.js';
import { resolveContained } from '../registration/contained.js';
import {
  computeEffectiveState,
  type EffectiveInstallation,
  type EffectiveState,
} from './effective-state.js';
import { resolveRuntimeSkillCollisions, type SkillCandidate } from './collision.js';

export interface RuntimeSkillExposureOptions {
  /** Working directory identifying the project scope document. */
  cwd?: string;
  /** Pi agent dir; defaults to getAgentDir(). */
  agentDir?: string;
  /** Pi host-owned Project Trust. Defaults to false: project additions stay excluded. */
  projectTrusted?: boolean;
  /** Exact names already claimed by pre-existing Pi skills (host-owned namespace layer). */
  piSkillNames?: string[];
}

/** One Projected Skill contributed at its original snapshot location (no copy). */
export interface ExposedSkill {
  name: string;
  skillId: string;
  pluginId: string;
  installationId: string;
  sourceScope: 'global' | 'project';
  /** Absolute skill directory containing SKILL.md. */
  skillDir: string;
}

export type SkippedInstallationReason =
  | 'missing-snapshot'
  | 'missing-cache-entry'
  | 'catalog-unreadable'
  | 'entry-not-found'
  | 'no-skills';

export interface SkippedInstallation {
  installationId: string;
  reason: SkippedInstallationReason;
}

export interface ExposureResult {
  /** Deterministically ordered skill directories for `resources_discover` → `skillPaths`. */
  skillPaths: string[];
  exposed: ExposedSkill[];
  skipped: SkippedInstallation[];
}

function safeFingerprint(fp: string | undefined): fp is string {
  return typeof fp === 'string' && /^[0-9a-f]{64}$/.test(fp);
}

function emptyScopeState(): BridgeState {
  return { schemaVersion: 1, stateRevision: '0', registrations: [], installations: [], scopeOverrides: [] };
}

/** Passive closed read: corrupted or incompatible documents contribute nothing and never throw. */
function readScopeOrEmpty(scope: 'global' | 'project', opts: RuntimeSkillExposureOptions): BridgeState {
  const read = readBridgeStateSync(scope, { cwd: opts.cwd, agentDir: opts.agentDir });
  return read.status === 'ok' || read.status === 'missing' ? read.state! : emptyScopeState();
}

/**
 * Locate one Installation's plugin directory inside a snapshot root by resolving its
 * Marketplace Entry ID through the retained catalog, then verify containment.
 */
function resolvePluginDirInSnapshot(snapshotRoot: string, installation: EffectiveInstallation, scope: 'global' | 'project'): string | undefined {
  const catalogPath = join(snapshotRoot, '.agents', 'plugins', 'marketplace.json');
  try {
    if (!existsSync(catalogPath) || statSync(catalogPath).size > BUDGET.maxCatalogBytes) return undefined;
    const parsed: unknown = JSON.parse(readFileSync(catalogPath, 'utf8'));
    const result = parseCatalog(parsed, { scope });
    if (!result.catalog) return undefined;
    return resolveEntryPluginDir(snapshotRoot, result.catalog, installation);
  } catch {
    return undefined;
  }
}

function resolveEntryPluginDir(snapshotRoot: string, catalog: Catalog, installation: EffectiveInstallation): string | undefined {
  // A malformed Marketplace Entry ID without the "/plugins/" marker yields an undefined pointer
  // so resolution falls back to manifestName instead of degrading to a bogus tail slice.
  const markerIndex = installation.marketplaceEntryId?.indexOf('/plugins/') ?? -1;
  const pointer = installation.marketplaceEntryId && markerIndex >= 0
    ? installation.marketplaceEntryId.slice(markerIndex)
    : undefined;
  let entry = pointer !== undefined
    ? catalog.entries.find((item) => item.entryId === pointer && item.type === 'local' && item.available && item.path)
    : undefined;
  if (!entry && installation.manifestName) {
    entry = catalog.entries.find((item) => item.name === installation.manifestName && item.type === 'local' && item.available && item.path);
  }
  if (!entry) return undefined;
  const contained = resolveContained(snapshotRoot, entry.path!, 'directory');
  return contained.outcome.kind === 'ok' ? contained.outcome.canonicalPath : undefined;
}

/** Read each skills/<dir>/SKILL.md descriptor name exactly as Pi resolves it (frontmatter name, else directory name). */
function skillCandidates(pluginDir: string): Array<{ name: string; skillDir: string }> {
  const skillsDir = join(pluginDir, 'skills');
  if (!existsSync(skillsDir) || !statSync(skillsDir).isDirectory()) return [];
  const found: Array<{ name: string; skillDir: string }> = [];
  let entries;
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillDir = join(skillsDir, entry.name);
    const descriptor = join(skillDir, 'SKILL.md');
    if (!existsSync(descriptor)) continue;
    const name = descriptorSkillName(skillDir, descriptor);
    if (name) found.push({ name, skillDir });
  }
  return found;
}

function descriptorSkillName(skillDir: string, descriptorPath: string): string | undefined {
  try {
    // Pi drops skills whose descriptor cannot be parsed or lacks a description; mirror that here.
    const text = readFileSync(descriptorPath, 'utf-8');
    const { frontmatter } = parseFrontmatter<Record<string, unknown>>(text);
    const description = frontmatter?.description;
    if (typeof description !== 'string' || description.trim().length === 0) return undefined;
    const declared = frontmatter?.name;
    return typeof declared === 'string' && declared.trim().length > 0 ? declared.trim() : basename(skillDir);
  } catch {
    return undefined;
  }
}

/**
 * Compute the Runtime Skill Exposure for the current Effective State. Pure read-time behavior:
 * never mutates either Bridge State document, never writes an Attempt Receipt, never throws on
 * missing material.
 */
export function discoverProjectedSkillPaths(opts: RuntimeSkillExposureOptions = {}): ExposureResult {
  const globalState = readScopeOrEmpty('global', opts);
  const projectState = readScopeOrEmpty('project', opts);
  const effective: EffectiveState = computeEffectiveState(globalState, projectState, { projectTrusted: opts.projectTrusted === true });

  const registrationsById = new Map(effective.registrations.map((registration) => [`${registration.sourceScope}:${registration.id}`, registration]));
  const entriesRoot = getCacheEntriesDir(getCacheDir(opts.agentDir));

  interface Candidate extends SkillCandidate {
    sourceScope: 'global' | 'project';
    installationId: string;
    skillDir: string;
  }
  const candidates: Candidate[] = [];
  const skipped: SkippedInstallation[] = [];

  for (const installation of effective.installations) {
    const registration = registrationsById.get(`${installation.sourceScope}:${installation.registrationId}`);
    if (!registration || !installation.marketplaceEntryId) {
      skipped.push({ installationId: installation.id, reason: 'entry-not-found' });
      continue;
    }

    let snapshotRoot: string | undefined;
    if (registration.sourceKind === 'local') {
      // Live registered Marketplace Root at its canonical real path (mirrors inspection).
      try {
        snapshotRoot = registration.source && existsSync(registration.source)
          ? realpathSync.native(registration.source)
          : undefined;
      } catch {
        snapshotRoot = undefined;
      }
    } else if (registration.sourceKind === 'git') {
      if (!safeFingerprint(registration.validationSnapshot)) {
        skipped.push({ installationId: installation.id, reason: 'missing-snapshot' });
        continue;
      }
      // Source Cache addressing matches inspection reuse: the Registration's retained
      // base-tree fingerprint pins the entry against eviction.
      const entryDir = join(entriesRoot, registration.validationSnapshot);
      if (!existsSync(entryDir)) {
        skipped.push({ installationId: installation.id, reason: 'missing-cache-entry' });
        continue;
      }
      snapshotRoot = entryDir;
    } else {
      skipped.push({ installationId: installation.id, reason: 'missing-snapshot' });
      continue;
    }
    if (!snapshotRoot) {
      skipped.push({ installationId: installation.id, reason: 'catalog-unreadable' });
      continue;
    }

    const pluginDir = resolvePluginDirInSnapshot(snapshotRoot, installation, installation.sourceScope);
    if (!pluginDir) {
      skipped.push({
        installationId: installation.id,
        reason: existsSync(join(snapshotRoot, '.agents', 'plugins', 'marketplace.json')) ? 'entry-not-found' : 'catalog-unreadable',
      });
      continue;
    }
    const skills = skillCandidates(pluginDir);
    if (skills.length === 0) {
      skipped.push({ installationId: installation.id, reason: 'no-skills' });
      continue;
    }
    for (const skill of skills) {
      candidates.push({
        layer: installation.sourceScope,
        name: skill.name,
        skillId: `${installation.pluginId}/${skill.name}`,
        pluginId: installation.pluginId,
        sourceScope: installation.sourceScope,
        installationId: installation.id,
        skillDir: skill.skillDir,
      });
    }
  }

  // Only collision survivors are contributed; layering is Pi → Project Scope → Global Scope.
  const bridgeCandidates: SkillCandidate[] = opts.piSkillNames?.length
    ? [
        ...opts.piSkillNames.map((name): SkillCandidate => ({ layer: 'pi', name, skillId: `pi/${name}`, pluginId: '(pi)' })),
        ...candidates.map(({ layer, name, skillId, pluginId }) => ({ layer, name, skillId, pluginId })),
      ]
    : candidates.map(({ layer, name, skillId, pluginId }) => ({ layer, name, skillId, pluginId }));
  const survivors = new Set(resolveRuntimeSkillCollisions(bridgeCandidates).survivors.map((s) => s.skillId));

  const exposed = candidates
    .filter((candidate) => survivors.has(candidate.skillId))
    .sort((a, b) => a.skillDir.localeCompare(b.skillDir))
    .map((candidate): ExposedSkill => ({
      name: candidate.name,
      skillId: candidate.skillId,
      pluginId: candidate.pluginId,
      installationId: candidate.installationId,
      sourceScope: candidate.sourceScope,
      skillDir: candidate.skillDir,
    }));

  return { skillPaths: exposed.map((skill) => skill.skillDir), exposed, skipped };
}
