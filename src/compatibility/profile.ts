/**
 * Compatibility Profile v1 — closed, skills-only Codex Plugin classification.
 *
 * This is deliberately a pure validation seam: it reads one already-contained Plugin tree and
 * produces an atomic Compatible / Incompatible / Invalid result.  Runtime skill collisions are
 * intentionally outside this module; they do not change whole-Plugin classification.
 */

import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseFrontmatter } from '@earendil-works/pi-coding-agent';

import type { Scope } from '../bridge-state/types.js';
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

function resourcesIn(skillDirectory: string): string[] {
  const resources: string[] = [];
  const walk = (directory: string, relative = ''): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (relative === '' && entry.name === 'SKILL.md') continue;
      const next = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(join(directory, entry.name), next);
      else resources.push(next);
    }
  };
  walk(skillDirectory);
  return resources;
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
      if (key === 'name') continue;
      if (key === 'skills' && typeof manifest.skills === 'string' && manifest.skills === './skills/') continue;
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

  for (const name of readdirSync(root, { withFileTypes: true }).map((entry) => entry.name).sort((a, b) => a.localeCompare(b))) {
    if (UNSUPPORTED_COMPONENTS.has(name)) {
      findings.push(finding(opts, CODE.UNSUPPORTED_ACTIVE_COMPONENT, RULE.UNSUPPORTED_ACTIVE_COMPONENT, 'plugin', name, `Compatibility Profile v1 does not support Active Component '${name}'`));
    }
  }

  const skills: CompatibleSkill[] = [];
  const skillsDirectory = join(root, 'skills');
  if (!existsSync(skillsDirectory)) {
    findings.push(finding(opts, CODE.SKILL_DESCRIPTOR_INVALID, RULE.SKILL_DESCRIPTOR_INVALID, 'plugin', 'skills', 'Compatibility Profile v1 requires at least one skills/<directory>/SKILL.md descriptor'));
  } else {
    for (const entry of readdirSync(skillsDirectory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
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
      skills.push({
        id: `${pluginId}/${name}`,
        name,
        path: skillDirectory,
        resources: resourcesIn(skillDirectory),
        invocationPolicy: disabled ? 'explicit' : 'implicit',
      });
    }
  }

  if (skills.length === 0 && !findings.some((item) => item.code === CODE.SKILL_DESCRIPTOR_INVALID)) {
    findings.push(finding(opts, CODE.SKILL_DESCRIPTOR_INVALID, RULE.SKILL_DESCRIPTOR_INVALID, 'plugin', 'skills', 'Compatibility Profile v1 requires at least one Skill Descriptor'));
  }

  const sorted = sortFindings(findings);
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
