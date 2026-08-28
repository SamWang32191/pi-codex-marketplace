/**
 * Runtime Skill Exposure — read-time discovery of Projected Skill directories contributed to Pi
 * through the host resource-discovery seam (`resources_discover` → `skillPaths`).
 * See CONTEXT.md: Runtime Skill Exposure, Projected Skill, Projected Plugin, Effective State,
 * Runtime Skill Collision, Source Cache, Skill Availability.
 *
 * Exposure derives entirely from the current Effective State (enabled Installations) and its
 * collision survivors. It performs passive
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
import { createEmptyState, type BridgeState, type Installation, type MarketplaceFormat, type Registration } from '../bridge-state/types.js';
import { catalogContractFor } from '../registration/format.js';
import { type Catalog } from '../registration/catalog.js';
import { BUDGET } from '../registration/budget.js';
import { resolveContained } from '../registration/contained.js';
import { computeEffectiveState } from './effective-state.js';
import { resolveRuntimeSkillCollisions, type SkillCandidate } from './collision.js';
import { readMinimalBridgeState } from '../bridge/state.js';

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

/** Passive closed read: corrupted or incompatible documents contribute nothing and never throw. */
function readGlobalOrEmpty(opts: RuntimeSkillExposureOptions): BridgeState {
  const read = readBridgeStateSync({ agentDir: opts.agentDir });
  return read.status === 'ok' || read.status === 'missing' ? read.state! : createEmptyState();
}

/**
 * Locate one Installation's plugin directory inside a snapshot root by resolving its
 * Marketplace Entry ID through the retained catalog, then verify containment.
 */
function resolvePluginDirInSnapshot(
  snapshotRoot: string,
  installation: Installation,
  format: MarketplaceFormat = 'codex',
): string | undefined {
  const contract = catalogContractFor(format);
  const catalogPath = join(snapshotRoot, ...contract.relPath.split('/'));
  try {
    if (!existsSync(catalogPath) || statSync(catalogPath).size > BUDGET.maxCatalogBytes) return undefined;
    const parsed: unknown = JSON.parse(readFileSync(catalogPath, 'utf8'));
    const result = contract.parse(parsed);
    if (!result.catalog) return undefined;
    return resolveEntryPluginDir(snapshotRoot, result.catalog, installation);
  } catch {
    return undefined;
  }
}

function resolveEntryPluginDir(snapshotRoot: string, catalog: Catalog, installation: Installation): string | undefined {
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
 * Compute the Runtime Skill Exposure for the current Effective State. Pure read-time behavior:
 * never mutates either Bridge State document, never writes an Attempt Receipt, never throws on
 * missing material.
 */
export function discoverProjectedSkillPaths(opts: RuntimeSkillExposureOptions = {}): ExposureResult {
  const globalState = readGlobalOrEmpty(opts);
  const effective = computeEffectiveState(globalState);

  const registrationsById = new Map(effective.registrations.map((registration) => [registration.id, registration]));
  const entriesRoot = getCacheEntriesDir(getCacheDir(opts.agentDir));

  interface Candidate extends SkillCandidate {
    installationId: string;
    skillDir: string;
  }
  const candidates: Candidate[] = [];
  const skipped: SkippedInstallation[] = [];

  for (const installation of effective.installations) {
    const registration: Registration | undefined = registrationsById.get(installation.registrationId ?? '');
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

    const format = registration.format ?? 'codex';
    const pluginDir = resolvePluginDirInSnapshot(snapshotRoot, installation, format);
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

  // ---- Minimal Bridge State (極簡) augmentation (#90) ----
  // Merge enabled installations from MinimalBridgeState (schemaVersion 1, Global-only) into the same
  // collision domain so that local-codex installs via runCommand are visible to resources_discover.
  // This keeps the legacy BridgeState path untouched while making minimal installs e2e-visible.
  try {
    const minimalRead = readMinimalBridgeState({ agentDir: opts.agentDir });
    const minimal = minimalRead.state;
    // Build quick lookup to avoid duplicating installations already covered by the legacy effective state
    const legacyIds = new Set(effective.installations.map((i) => i.id));
    // Also dedupe by manifestName+registrationId for minimal vs legacy overlap (e.g., same plugin installed via both paths in tests)
    const legacyKeys = new Set(effective.installations.map((i) => `${i.registrationId ?? ''}:${i.manifestName ?? i.pluginId}`));
    for (const inst of minimal.installations) {
      const isEnabled = (inst as any).enabled !== false && (inst as any).installationState !== 'disabled';
      if (!isEnabled) continue;
      if (legacyIds.has(inst.id)) continue;
      const key = `${inst.registrationId ?? ''}:${(inst as any).manifestName ?? inst.pluginId}`;
      if (legacyKeys.has(key)) continue;
      const reg: any = minimal.registrations.find((r: any) => r.id === inst.registrationId);
      if (!reg || !reg.source || !existsSync(reg.source)) {
        skipped.push({ installationId: inst.id, reason: 'entry-not-found' });
        continue;
      }
      let snapshotRoot: string | undefined;
      try {
        snapshotRoot = realpathSync.native(reg.source);
      } catch {
        snapshotRoot = reg.source;
      }
      if (!snapshotRoot || !existsSync(snapshotRoot)) {
        skipped.push({ installationId: inst.id, reason: 'catalog-unreadable' });
        continue;
      }
      const format: MarketplaceFormat = (reg.format ?? 'codex') as MarketplaceFormat;
      // Resolve plugin dir via catalog entry matching manifestName
      const contract = catalogContractFor(format);
      const catalogPath = join(snapshotRoot, ...contract.relPath.split('/'));
      let catalog: Catalog | undefined;
      try {
        if (!existsSync(catalogPath) || statSync(catalogPath).size > BUDGET.maxCatalogBytes) {
          skipped.push({ installationId: inst.id, reason: 'catalog-unreadable' });
          continue;
        }
        const parsed: unknown = JSON.parse(readFileSync(catalogPath, 'utf8'));
        const res = contract.parse(parsed);
        if (!res.catalog) {
          skipped.push({ installationId: inst.id, reason: 'catalog-unreadable' });
          continue;
        }
        catalog = res.catalog;
      } catch {
        skipped.push({ installationId: inst.id, reason: 'catalog-unreadable' });
        continue;
      }
      const manifestName = (inst as any).manifestName ?? inst.pluginId;
      let entry = catalog.entries.find((e) => e.name === manifestName && e.type === 'local' && e.available && e.path);
      if (!entry && manifestName) {
        entry = catalog.entries.find((e) => e.name === manifestName && e.type === 'local' && e.path);
      }
      if (!entry && manifestName) {
        entry = catalog.entries.find((e) => e.path && basename(e.path) === manifestName && e.type === 'local');
      }
      if (!entry || !entry.path) {
        skipped.push({ installationId: inst.id, reason: 'entry-not-found' });
        continue;
      }
      const contained = resolveContained(snapshotRoot, entry.path, 'directory');
      if (contained.outcome.kind !== 'ok') {
        skipped.push({ installationId: inst.id, reason: 'entry-not-found' });
        continue;
      }
      const pluginDir = contained.outcome.canonicalPath;
      const skills = skillCandidates(pluginDir, format);
      if (skills.length === 0) {
        skipped.push({ installationId: inst.id, reason: 'no-skills' });
        continue;
      }
      for (const skill of skills) {
        candidates.push({
          layer: 'global',
          name: skill.name,
          skillId: `${inst.pluginId}/${skill.name}`,
          pluginId: inst.pluginId,
          installationId: inst.id,
          skillDir: skill.skillDir,
        });
      }
    }
  } catch {
    // Minimal augmentation is best-effort; never fails the host's resource pass
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
