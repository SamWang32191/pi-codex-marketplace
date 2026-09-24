/**
 * Skill discovery — the command surface's read of the skills one Installed Plugin's current
 * projection material offers (live local Marketplace Root, or the pinned Git Source Cache
 * entry). Shared by the Skill Exclusion operations (which must confirm a name before excluding
 * it or keeping only it), the status presentation, and the completion surface, so all three
 * agree on what "the source currently offers".
 *
 * Read-only by construction: this module never writes Bridge State or marketplace material, and
 * every failure is reported as "cannot confirm" (undefined or an empty list) rather than thrown.
 * Runtime Skill Exposure has its own scan: it is the projection authority over the final
 * `skillPaths`, while these reads describe and validate the Plugin's skills.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

import { parseFrontmatter } from '@earendil-works/pi-coding-agent';

import {
  readMarketplaceCatalog,
  resolveMarketplaceRoot,
  type MarketplaceCatalogReadResult,
} from './plugin-query.js';
import { KEBAB_NAME_RE, findEntryByManifestName } from '../registration/catalog.js';
import { resolveContained } from '../registration/contained.js';
import type { MinimalBridgeState, MinimalInstallation, MinimalRegistration } from './state.js';

/** The read options these helpers need: the agent dir locating the Source Cache for git sources. */
export interface SkillReadOptions {
  agentDir?: string;
}

/**
 * A Skill Descriptor name, rejected when it is not lowercase alphanumeric with single hyphens.
 * This is the Agent Skills name rule Pi itself enforces when it loads a skill (and the same
 * rule `KEBAB_NAME_RE` applies to Marketplace and Plugin names), so a name filtered out here is
 * a name Pi would drop: listing or excluding it would present something the host never loads.
 */
export function descriptorSkillName(skillDir: string, descriptorPath: string): string | undefined {
  try {
    const text = readFileSync(descriptorPath, 'utf-8');
    const { frontmatter } = parseFrontmatter<Record<string, unknown>>(text);
    const description = frontmatter?.description;
    if (typeof description !== 'string' || description.trim().length === 0) return undefined;
    const declared = frontmatter?.name;
    const name = typeof declared === 'string' && declared.trim().length > 0 ? declared.trim() : basename(skillDir);
    if (!KEBAB_NAME_RE.test(name)) return undefined;
    return name;
  } catch {
    return undefined;
  }
}

export function collectSkillNames(pluginDir: string, format: 'codex' | 'claude' = 'codex'): string[] {
  if (format === 'claude') {
    // For claude, manifest declares skills array; fallback to directory scan if needed
    const manifestPath = join(pluginDir, '.claude-plugin', 'plugin.json');
    if (existsSync(manifestPath)) {
      try {
        const raw = readFileSync(manifestPath, 'utf-8');
        const manifest = JSON.parse(raw) as Record<string, unknown>;
        if (Array.isArray(manifest.skills)) {
          const names: string[] = [];
          for (const decl of manifest.skills) {
            if (typeof decl !== 'string') continue;
            const resolved = resolveContained(pluginDir, decl, 'directory');
            if (resolved.outcome.kind !== 'ok') continue;
            const skillDir = resolved.outcome.canonicalPath;
            const descriptor = join(skillDir, 'SKILL.md');
            if (!existsSync(descriptor)) continue;
            const name = descriptorSkillName(skillDir, descriptor);
            if (name) names.push(name);
          }
          // If manifest skills yielded something, return sorted
          if (names.length > 0) return names.sort((a, b) => a.localeCompare(b));
        }
      } catch {
        // fall through to directory scan
      }
    }
    // fallback: scan skills dir like codex
  }

  const skillsDir = join(pluginDir, 'skills');
  if (!existsSync(skillsDir)) return [];
  try {
    if (!statSync(skillsDir).isDirectory()) return [];
  } catch {
    return [];
  }
  let entries;
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillDir = join(skillsDir, entry.name);
    const descriptor = join(skillDir, 'SKILL.md');
    if (!existsSync(descriptor)) continue;
    const name = descriptorSkillName(skillDir, descriptor);
    if (name) found.push(name);
  }
  return found.sort((a, b) => a.localeCompare(b));
}

/**
 * Best-effort reread of one Registration's Plugin skills: mirrors install Step1-3
 * (Marketplace Root -> readCatalog -> entry -> resolveContained -> collectSkillNames).
 * Returns undefined on any missing cache/catalog/entry/path — callers fall back to recorded
 * skills or refuse the operation. Pure-logic branches (find/entry.path/resolveContained
 * outcome) do not throw; only I/O (readMarketplaceCatalog/collectSkillNames) is try/catch guarded.
 */
export function tryRereadSkills(
  registration: MinimalRegistration,
  installation: MinimalInstallation,
  opts: SkillReadOptions = {},
): string[] | undefined {
  const marketplaceRoot = resolveMarketplaceRoot(registration, opts);
  if (!marketplaceRoot) return undefined;
  let read: MarketplaceCatalogReadResult | undefined;
  try {
    read = readMarketplaceCatalog(marketplaceRoot, registration.format ?? 'codex');
  } catch {
    // best-effort: catalog 讀取/解析失敗（cache 缺失或損毀）則沿用舊 skills
    return undefined;
  }
  if (read.error || !read.catalog) return undefined;
  const entry = findEntryByManifestName(read.catalog, installation.manifestName);
  if (!entry?.path) return undefined;
  const contained = resolveContained(marketplaceRoot, entry.path, 'directory');
  if (contained.outcome.kind !== 'ok') return undefined;
  try {
    return collectSkillNames(contained.outcome.canonicalPath, (registration.format ?? 'codex') as 'codex' | 'claude');
  } catch {
    // best-effort: 目錄掃描失敗則沿用舊 skills
    return undefined;
  }
}

/**
 * The source confirmation every exclusion change that adds a name needs, and the source truth
 * for status presentation: the names discovered from the currently confirmable source (live
 * local root / pinned Git Source Cache material). Undefined means the source cannot be read, so
 * an exclusion change must be refused and no current count may be claimed.
 */
export function rereadConfirmableSkills(
  state: MinimalBridgeState,
  installation: MinimalInstallation,
  opts: SkillReadOptions = {},
): string[] | undefined {
  const registration = state.registrations.find((r) => r.id === installation.registrationId);
  return registration ? tryRereadSkills(registration, installation, opts) : undefined;
}

/** The one wording for an Installation whose projection material cannot confirm its skills. */
export const SOURCE_UNCONFIRMED_REASON = '來源不可讀或 plugin 目錄不存在';

/** The one command-surface error for a source that cannot confirm its skills. */
export function unconfirmedSourceMessage(displayName: string): string {
  return `錯誤：無法確認 plugin "${displayName}" 的來源 skills（${SOURCE_UNCONFIRMED_REASON}），未變更`;
}
