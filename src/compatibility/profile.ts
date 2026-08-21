/**
 * Compatibility Profile v1 — closed, skills-only Codex Plugin classification.
 *
 * This is deliberately a pure validation seam: it reads one already-contained Plugin tree and
 * produces an atomic Compatible / Incompatible / Invalid result.  Runtime skill collisions are
 * intentionally outside this module; they do not change whole-Plugin classification.
 */

import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseFrontmatter } from '@earendil-works/pi-coding-agent';

import type { Scope } from '../bridge-state/types.js';
import { BUDGET } from '../registration/budget.js';
import { CODE, RULE, blocking, sortFindings, warning, type ValidationFinding } from '../registration/findings.js';

export type PluginClassification = 'compatible' | 'incompatible' | 'invalid';
export type InvocationPolicy = 'implicit' | 'explicit';

export interface CompatibleSkill {
  id: string;
  name: string;
  path: string;
  resources: string[];
  invocationPolicy: InvocationPolicy;
}

export interface CompatiblePlugin {
  id: string;
  manifestName: string;
  marketplaceEntryId: string;
  skills: CompatibleSkill[];
}

export interface ClassificationResult {
  classification: PluginClassification;
  plugin?: CompatiblePlugin;
  findings: ValidationFinding[];
}

export interface ClassificationOptions {
  scope: Scope;
  marketplaceId: string;
  marketplaceEntryId: string;
}

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UNSUPPORTED_COMPONENTS = new Set(['apps', 'commands', 'hooks', 'mcp', 'mcpServers', 'servers', 'extensions']);
const INERT_MANIFEST_FIELDS = new Set(['version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'interface']);

function finding(
  opts: ClassificationOptions,
  code: string,
  rule: string,
  target: 'plugin' | 'skill',
  pointer: string,
  outcome: string,
): ValidationFinding {
  return blocking({ code, rule, target, pointer, outcome, scope: opts.scope, phase: 'validation' });
}

function parseDescriptor(text: string): { frontmatter?: Record<string, unknown>; body?: string } {
  // Compatibility Profile v1 requires an explicit, closed descriptor, but all accepted YAML and
  // whitespace semantics must stay Pi-native.  Reuse Pi 0.84.2's parser rather than a lookalike.
  if (!/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u.test(text)) return {};
  try {
    const parsed = parseFrontmatter<Record<string, unknown>>(text);
    return { frontmatter: parsed.frontmatter, body: parsed.body };
  } catch {
    return {};
  }
}

/** Read the authoritative manifest identity without projecting a Compatible Plugin. */
export function pluginIdentity(root: string, marketplaceId: string): string | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(root, '.codex-plugin', 'plugin.json'), 'utf8'));
    const name = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>).name : undefined;
    return typeof name === 'string' && KEBAB.test(name) ? `${marketplaceId}/${name}` : undefined;
  } catch {
    return undefined;
  }
}

function resourcesIn(skillDirectory: string): { resources: string[]; error?: string } {
  const resources: string[] = [];
  let files = 0;
  let bytes = 0;
  const walk = (directory: string, relative = '', depth = 1): void => {
    if (depth > BUDGET.maxTreeDepth) throw new Error(`Skill Resource depth exceeds Validation Budget (${BUDGET.maxTreeDepth})`);
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (relative === '' && entry.name === 'SKILL.md') continue;
      // These trees are deliberately excluded from the Validation Snapshot.  They must never be
      // accepted as projected Skill Resources, otherwise disclosure could outlive its snapshot.
      if (entry.isDirectory() && (entry.name === '.git' || entry.name === 'node_modules')) continue;
      const next = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(join(directory, entry.name), next, depth + 1);
      else {
        const stat = lstatSync(join(directory, entry.name));
        files += 1;
        bytes += stat.size;
        if (files > BUDGET.maxFiles || bytes > BUDGET.maxTotalBytes) {
          throw new Error('Skill Resources exceed Validation Budget');
        }
        resources.push(next);
      }
    }
  };
  try {
    walk(skillDirectory);
    return { resources };
  } catch (error) {
    return { resources: [], error: error instanceof Error ? error.message : String(error) };
  }
}

/** Classify the complete Plugin tree as one indivisible unit under Compatibility Profile v1. */
export function classifyPlugin(root: string, opts: ClassificationOptions): ClassificationResult {
  const findings: ValidationFinding[] = [];
  const manifestPath = join(root, '.codex-plugin', 'plugin.json');
  let manifest: Record<string, unknown> | undefined;

  try {
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) manifest = parsed as Record<string, unknown>;
  } catch {
    // classified below with one stable, safely-presentable finding
  }

  if (!manifest || typeof manifest.name !== 'string' || !KEBAB.test(manifest.name)) {
    findings.push(finding(opts, CODE.PLUGIN_MANIFEST_INVALID, RULE.PLUGIN_MANIFEST_INVALID, 'plugin', '.codex-plugin/plugin.json', 'Plugin manifest must be an object with authoritative lowercase kebab-case name'));
  }
  if (!manifest || manifest.skills !== './skills/') {
    findings.push(finding(opts, CODE.PLUGIN_MANIFEST_INVALID, RULE.PLUGIN_MANIFEST_INVALID, 'plugin', '.codex-plugin/plugin.json#/skills', 'Compatibility Profile v1 requires the closed skills declaration "./skills/"'));
  }

  if (manifest) {
    for (const key of Object.keys(manifest).sort((a, b) => a.localeCompare(b))) {
      if (key === 'name' || key === 'skills') continue;
      if (UNSUPPORTED_COMPONENTS.has(key)) {
        findings.push(finding(opts, CODE.UNSUPPORTED_ACTIVE_COMPONENT, RULE.UNSUPPORTED_ACTIVE_COMPONENT, 'plugin', `.codex-plugin/plugin.json#/${key}`, `Compatibility Profile v1 does not support active manifest component '${key}'`));
      } else if (INERT_MANIFEST_FIELDS.has(key)) {
        findings.push(warning({
          code: CODE.INERT_METADATA_IGNORED,
          rule: 'COMP-W01',
          target: 'plugin',
          pointer: `.codex-plugin/plugin.json#/${key}`,
          outcome: `Ignored Inert Metadata '${key}' does not change Plugin classification`,
          scope: opts.scope,
          phase: 'validation',
        }));
      } else {
        findings.push(finding(opts, CODE.UNSUPPORTED_ACTIVE_COMPONENT, RULE.UNSUPPORTED_ACTIVE_COMPONENT, 'plugin', `.codex-plugin/plugin.json#/${key}`, `Unknown manifest field '${key}' may declare active behaviour and is fail-closed`));
      }
    }
  }

  let rootEntries: string[] = [];
  try {
    if (!lstatSync(root).isDirectory()) throw new Error('Plugin root is not a directory');
    rootEntries = readdirSync(root, { withFileTypes: true }).map((entry) => entry.name).sort((a, b) => a.localeCompare(b));
  } catch (error) {
    findings.push(finding(opts, CODE.PLUGIN_MANIFEST_INVALID, RULE.PLUGIN_MANIFEST_INVALID, 'plugin', '', `Plugin root cannot be read: ${error instanceof Error ? error.message : String(error)}`));
  }
  for (const name of rootEntries) {
    if (UNSUPPORTED_COMPONENTS.has(name)) {
      findings.push(finding(opts, CODE.UNSUPPORTED_ACTIVE_COMPONENT, RULE.UNSUPPORTED_ACTIVE_COMPONENT, 'plugin', name, `Compatibility Profile v1 does not support Active Component '${name}'`));
    }
  }

  const skills: CompatibleSkill[] = [];
  const skillsDirectory = join(root, 'skills');
  let skillEntries: import('node:fs').Dirent[] = [];
  let skillsReadable = true;
  try {
    if (!lstatSync(skillsDirectory).isDirectory()) throw new Error('skills is not a directory');
    skillEntries = readdirSync(skillsDirectory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    skillsReadable = false;
    findings.push(finding(opts, CODE.SKILL_DESCRIPTOR_INVALID, RULE.SKILL_DESCRIPTOR_INVALID, 'plugin', 'skills', 'Compatibility Profile v1 requires at least one skills/<directory>/SKILL.md descriptor'));
  }
  if (skillsReadable) {
    for (const entry of skillEntries) {
      if (!entry.isDirectory()) {
        findings.push(finding(opts, CODE.SKILL_DESCRIPTOR_INVALID, RULE.SKILL_DESCRIPTOR_INVALID, 'skill', `skills/${entry.name}`, 'A skill must be a directory containing SKILL.md'));
        continue;
      }
      const skillDirectory = join(skillsDirectory, entry.name);
      const skillPath = join(skillDirectory, 'SKILL.md');
      let descriptor: ReturnType<typeof parseDescriptor> = {};
      try {
        if (!lstatSync(skillPath).isFile()) throw new Error('not a file');
        descriptor = parseDescriptor(readFileSync(skillPath, 'utf8'));
      } catch {
        // reported by shared condition below
      }
      const name = descriptor.frontmatter?.name;
      const description = descriptor.frontmatter?.description;
      if (typeof name !== 'string' || !KEBAB.test(name) || typeof description !== 'string' || !description.trim() || !descriptor.body?.trim()) {
        findings.push(finding(opts, CODE.SKILL_DESCRIPTOR_INVALID, RULE.SKILL_DESCRIPTOR_INVALID, 'skill', `skills/${entry.name}/SKILL.md`, 'Skill Descriptor requires lowercase kebab-case name, non-empty description, closed Pi-native YAML frontmatter, and non-empty Skill Body'));
        continue;
      }
      for (const key of Object.keys(descriptor.frontmatter!).sort((a, b) => a.localeCompare(b))) {
        if (!['name', 'description', 'disable-model-invocation'].includes(key)) {
          findings.push(finding(opts, CODE.UNSUPPORTED_ACTIVE_COMPONENT, RULE.UNSUPPORTED_ACTIVE_COMPONENT, 'skill', `skills/${entry.name}/SKILL.md#/${key}`, `Unknown Skill Descriptor field '${key}' is fail-closed under Compatibility Profile v1`));
        }
      }
      if (descriptor.frontmatter?.['disable-model-invocation'] !== undefined && typeof descriptor.frontmatter['disable-model-invocation'] !== 'boolean') {
        findings.push(finding(opts, CODE.SKILL_DESCRIPTOR_INVALID, RULE.SKILL_DESCRIPTOR_INVALID, 'skill', `skills/${entry.name}/SKILL.md#/disable-model-invocation`, 'disable-model-invocation must be a boolean when declared'));
      }
      const disabled = descriptor.frontmatter?.['disable-model-invocation'] === true;
      const pluginId = manifest && typeof manifest.name === 'string' ? `${opts.marketplaceId}/${manifest.name}` : '';
      const resourceResult = resourcesIn(skillDirectory);
      if (resourceResult.error) {
        findings.push(finding(opts, CODE.SKILL_DESCRIPTOR_INVALID, RULE.SKILL_DESCRIPTOR_INVALID, 'skill', `skills/${entry.name}`, `Skill Resources cannot be scanned safely: ${resourceResult.error}`));
        continue;
      }
      skills.push({
        id: `${pluginId}/${name}`,
        name,
        path: skillDirectory,
        resources: resourceResult.resources,
        invocationPolicy: disabled ? 'explicit' : 'implicit',
      });
    }
  }

  const duplicateSkills = new Set<string>();
  const seenSkills = new Set<string>();
  for (const skill of skills) {
    if (seenSkills.has(skill.id)) duplicateSkills.add(skill.id);
    seenSkills.add(skill.id);
  }
  for (const id of [...duplicateSkills].sort((a, b) => a.localeCompare(b))) {
    findings.push(finding(opts, CODE.SKILL_DESCRIPTOR_INVALID, RULE.SKILL_DESCRIPTOR_INVALID, 'skill', id, `Skill ID '${id}' is declared by more than one Skill Descriptor`));
  }

  if (skills.length === 0 && !findings.some((item) => item.code === CODE.SKILL_DESCRIPTOR_INVALID)) {
    findings.push(finding(opts, CODE.SKILL_DESCRIPTOR_INVALID, RULE.SKILL_DESCRIPTOR_INVALID, 'plugin', 'skills', 'Compatibility Profile v1 requires at least one Skill Descriptor'));
  }

  const sorted = sortFindings(findings);
  if (sorted.some((item) => item.code === CODE.PLUGIN_MANIFEST_INVALID || item.code === CODE.SKILL_DESCRIPTOR_INVALID)) {
    return { classification: 'invalid', findings: sorted };
  }
  if (sorted.some((item) => item.code === CODE.UNSUPPORTED_ACTIVE_COMPONENT && item.classification === 'blocking')) {
    return { classification: 'incompatible', findings: sorted };
  }
  if (sorted.some((item) => item.classification === 'blocking')) return { classification: 'invalid', findings: sorted };
  const manifestName = manifest!.name as string;
  return {
    classification: 'compatible',
    plugin: {
      id: `${opts.marketplaceId}/${manifestName}`,
      manifestName,
      marketplaceEntryId: opts.marketplaceEntryId,
      skills,
    },
    findings: sorted,
  };
}
