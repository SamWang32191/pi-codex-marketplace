/**
 * Runtime Skill Exposure — read-time discovery of Projected Skill directories contributed to Pi
 * through the host resource-discovery seam (`resources_discover` → `skillPaths`).
 * See CONTEXT.md: Runtime Skill Exposure, Projected Skill, Projected Plugin, Effective State,
 * Runtime Skill Collision, Source Cache.
 *
 * Exposure derives entirely from the current Minimal Bridge State (enabled Installations) and its
 * collision survivors. It performs passive existence inspection only: no fingerprint
 * recomputation and no Bridge State mutation. Missing cache entries or unreadable snapshot
 * material are skipped individually; discovery always completes. Exposure never establishes
 * Skill Availability.
 *
 * Path resolution follows the retained snapshot locations:
 * - Git Registrations resolve inside the Source Cache entry pinned by their recorded base-tree
 *   fingerprint (the cache entry is the projection runtime material — projection reads it
 *   directly, so the fingerprint addressing must never be replaced by another identity).
 * - Local Registrations resolve inside their live Marketplace Root at its canonical real path.
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

import { parseFrontmatter } from '@earendil-works/pi-coding-agent';

import { getCacheEntriesDir, getCacheDir } from '../cache/paths.js';
import { readMinimalBridgeState, type MarketplaceFormat, type MinimalBridgeState } from '../bridge/state.js';
import { catalogContractFor } from '../registration/format.js';
import { type Catalog } from '../registration/catalog.js';
import { BUDGET } from '../registration/budget.js';
import { resolveContained } from '../registration/contained.js';
import { resolveRuntimeSkillCollisions, type SkillCandidate } from './collision.js';

export interface RuntimeSkillExposureOptions {
  /** Pi agent dir; defaults to getAgentDir(). */
  agentDir?: string;
  /** Exact names already claimed by pre-existing Pi skills (host-owned namespace layer). */
  piSkillNames?: string[];
}

/** One Projected Skill contributed at its original snapshot location (no copy). */
export interface ExposedSkill {
  name: string;
  skillId: string;
  pluginId: string;
  installationId: string;
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

/** Passive fail-reset read allowed by the fail-reset contract: corrupted state contributes nothing. */
function readGlobalOrEmpty(opts: RuntimeSkillExposureOptions): MinimalBridgeState {
  try {
    return readMinimalBridgeState({ agentDir: opts.agentDir }).state;
  } catch {
    return { schemaVersion: 1, registrations: [], installations: [] };
  }
}

/**
 * Locate one Installation's plugin directory inside a snapshot root by resolving its
 * catalog entry (authoritative manifest name first, then entry path basename), then
 * verify containment.
 */
function resolvePluginDirInSnapshot(
  snapshotRoot: string,
  manifestName: string,
  format: MarketplaceFormat = 'codex',
): string | undefined {
  const contract = catalogContractFor(format);
  const catalogPath = join(snapshotRoot, ...contract.relPath.split('/'));
  try {
    if (!existsSync(catalogPath) || statSync(catalogPath).size > BUDGET.maxCatalogBytes) return undefined;
    const parsed: unknown = JSON.parse(readFileSync(catalogPath, 'utf8'));
    const result = contract.parse(parsed);
    if (!result.catalog) return undefined;
    return resolveEntryPluginDir(snapshotRoot, result.catalog, manifestName);
  } catch {
    return undefined;
  }
}

function resolveEntryPluginDir(snapshotRoot: string, catalog: Catalog, manifestName: string): string | undefined {
  let entry = manifestName
    ? catalog.entries.find((item) => item.name === manifestName && item.type === 'local' && item.available && item.path)
    : undefined;
  if (!entry && manifestName) {
    entry = catalog.entries.find((item) => item.name === manifestName && item.type === 'local' && item.path);
  }
  if (!entry && manifestName) {
    entry = catalog.entries.find((item) => item.path && basename(item.path) === manifestName && item.type === 'local');
  }
  if (!entry) return undefined;
  const contained = resolveContained(snapshotRoot, entry.path!, 'directory');
  return contained.outcome.kind === 'ok' ? contained.outcome.canonicalPath : undefined;
}

/** Read each skills/<dir>/SKILL.md descriptor name exactly as Pi resolves it (frontmatter name, else directory name). */
function skillCandidates(pluginDir: string, format: MarketplaceFormat = 'codex'): Array<{ name: string; skillDir: string }> {
  if (format === 'claude') {
    // Declared manifest paths win; when absent or yielding nothing, fall through to the shared
    // skills/ directory scan so convention-structured claude plugins project too (#91).
    const manifestPath = join(pluginDir, '.claude-plugin', 'plugin.json');
    if (existsSync(manifestPath) && statSync(manifestPath).isFile()) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
        if (Array.isArray(manifest.skills)) {
          const found: Array<{ name: string; skillDir: string }> = [];
          for (const skillDecl of manifest.skills) {
            if (typeof skillDecl !== 'string') continue;
            const resolved = resolveContained(pluginDir, skillDecl, 'directory');
            if (resolved.outcome.kind !== 'ok') continue;
            const skillDir = resolved.outcome.canonicalPath;
            const descriptor = join(skillDir, 'SKILL.md');
            if (!existsSync(descriptor)) continue;
            const name = descriptorSkillName(skillDir, descriptor);
            if (name) found.push({ name, skillDir });
          }
          if (found.length > 0) return found;
        }
      } catch {
        // fall through to directory scan
      }
    }
  }

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
 * Compute the Runtime Skill Exposure for the current Effective State (enabled Installations in
 * Minimal Bridge State). Pure read-time behavior: never mutates Bridge State and never throws
 * on missing material.
 */
export function discoverProjectedSkillPaths(opts: RuntimeSkillExposureOptions = {}): ExposureResult {
  const globalState = readGlobalOrEmpty(opts);
  const installations = globalState.installations.filter(
    (inst) => (inst as { enabled?: boolean }).enabled !== false && inst.installationState !== 'disabled',
  );
  const registrationsById = new Map(globalState.registrations.map((registration) => [registration.id, registration]));
  const entriesRoot = getCacheEntriesDir(getCacheDir(opts.agentDir));

  interface Candidate extends SkillCandidate {
    installationId: string;
    skillDir: string;
  }
  const candidates: Candidate[] = [];
  const skipped: SkippedInstallation[] = [];

  for (const installation of installations) {
    const registration = registrationsById.get(installation.registrationId ?? '');
    const manifestName = installation.manifestName || installation.pluginId;
    if (!registration || !manifestName) {
      skipped.push({ installationId: installation.id, reason: 'entry-not-found' });
      continue;
    }

    let snapshotRoot: string | undefined;
    if (registration.sourceKind === 'local') {
      // Live registered Marketplace Root at its canonical real path.
      try {
        snapshotRoot = registration.source && existsSync(registration.source)
          ? realpathSync.native(registration.source)
          : undefined;
      } catch {
        snapshotRoot = undefined;
      }
    } else if (registration.sourceKind === 'git') {
      const fingerprint = registration.snapshot ?? installation.snapshot;
      if (!safeFingerprint(fingerprint)) {
        skipped.push({ installationId: installation.id, reason: 'missing-snapshot' });
        continue;
      }
      // Source Cache addressing: projection reads the registered base-tree fingerprint
      // directly; the entry directory is the projection runtime material.
      const entryDir = join(entriesRoot, fingerprint);
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

    const format = (registration.format ?? 'codex') as MarketplaceFormat;
    const pluginDir = resolvePluginDirInSnapshot(snapshotRoot, manifestName, format);
    if (!pluginDir) {
      const contract = catalogContractFor(format);
      skipped.push({
        installationId: installation.id,
        reason: existsSync(join(snapshotRoot, ...contract.relPath.split('/'))) ? 'entry-not-found' : 'catalog-unreadable',
      });
      continue;
    }
    const skills = skillCandidates(pluginDir, format);
    if (skills.length === 0) {
      skipped.push({ installationId: installation.id, reason: 'no-skills' });
      continue;
    }
    for (const skill of skills) {
      candidates.push({
        layer: 'global',
        name: skill.name,
        skillId: `${installation.pluginId}/${skill.name}`,
        pluginId: installation.pluginId,
        installationId: installation.id,
        skillDir: skill.skillDir,
      });
    }
  }

  // Only collision survivors are contributed; layering is Pi → Global.
  const bridgeCandidates: SkillCandidate[] = opts.piSkillNames?.length
    ? [
        ...opts.piSkillNames.map((name): SkillCandidate => ({ layer: 'pi', name, skillId: `pi/${name}`, pluginId: '(pi)' })),
        ...candidates.map(({ name, skillId, pluginId }): SkillCandidate => ({ layer: 'global', name, skillId, pluginId })),
      ]
    : candidates.map(({ name, skillId, pluginId }): SkillCandidate => ({ layer: 'global', name, skillId, pluginId }));
  const survivors = new Set(resolveRuntimeSkillCollisions(bridgeCandidates).survivors.map((s) => s.skillId));

  const exposed = candidates
    .filter((candidate) => survivors.has(candidate.skillId))
    .sort((a, b) => a.skillDir.localeCompare(b.skillDir))
    .map((candidate): ExposedSkill => ({
      name: candidate.name,
      skillId: candidate.skillId,
      pluginId: candidate.pluginId,
      installationId: candidate.installationId,
      skillDir: candidate.skillDir,
    }));

  return { skillPaths: exposed.map((skill) => skill.skillDir), exposed, skipped };
}