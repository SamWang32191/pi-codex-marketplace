/**
 * Compatibility Profile v1 — closed, skills-only Codex Plugin classification.
 *
 * This is deliberately a pure validation seam: it reads one already-contained Plugin tree and
 * produces an atomic Compatible / Incompatible / Invalid result.  Runtime skill collisions are
 * intentionally outside this module; they do not change whole-Plugin classification.
 */

import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { TextDecoder } from 'node:util';

import { parseFrontmatter } from '@earendil-works/pi-coding-agent';
import { CST, Lexer, isCollection, parseDocument, visit } from 'yaml';

import type { Scope } from '../bridge-state/types.js';
import { readBoundedFileSync } from '../registration/bounded-read.js';
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
  /** Valid manifest identity even when the complete Plugin is Invalid/Incompatible. */
  identity?: string;
  /** Hash of the exact manifest, descriptors, Agent Profiles, and resources used to derive this result. */
  captureFingerprint: string;
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
const AGENT_INTERFACE_STRING_FIELDS = new Set([
  'brand_color',
  'default_prompt',
  'display_name',
  'icon_large',
  'icon_small',
  'short_description',
]);

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

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

class MaterialCapture {
  private readonly hash = createHash('sha256');

  add(kind: string, value: string | Buffer): void {
    this.hash.update(kind);
    this.hash.update('\u001f');
    this.hash.update(value);
    this.hash.update('\u001e');
  }

  fingerprint(): string {
    return this.hash.digest('hex');
  }
}

interface AgentProfileResult {
  invocationPolicy?: InvocationPolicy;
  findings: ValidationFinding[];
}

function agentProfileBudgetExceeded(
  opts: ClassificationOptions,
  pointer: string,
  outcome: string,
): AgentProfileResult {
  return {
    findings: [finding(
      opts,
      CODE.BUDGET_EXCEEDED,
      RULE.BUDGET_EXCEEDED,
      'plugin',
      pointer,
      outcome,
    )],
  };
}

function invalidAgentProfile(opts: ClassificationOptions, pointer: string): AgentProfileResult {
  return {
    findings: [finding(
      opts,
      CODE.SKILL_AGENT_PROFILE_INVALID,
      RULE.SKILL_AGENT_PROFILE_INVALID,
      'skill',
      pointer,
      'Skill Agent Profile must be valid YAML that parses to a mapping',
    )],
  };
}

function agentProfileYamlComplexityViolation(text: string): string | undefined {
  let tokens = 0;
  let flowDepth = 0;
  let inlineBlockDepth = 0;
  let atLineStart = true;
  let indentation = 0;
  const indentationStack: number[] = [];

  for (const lexeme of new Lexer().lex(text)) {
    tokens += 1;
    if (tokens > BUDGET.maxAgentProfileYamlTokens) {
      return `YAML token count exceeds ${BUDGET.maxAgentProfileYamlTokens}`;
    }
    const type = CST.tokenType(lexeme);
    if (type === 'newline') {
      atLineStart = true;
      indentation = 0;
      inlineBlockDepth = 0;
      continue;
    }
    if (atLineStart && type === 'space' && lexeme.startsWith(' ')) {
      indentation += lexeme.length;
      continue;
    }
    if (atLineStart && type === 'comment') continue;
    if (atLineStart) {
      while (
        indentationStack.length > 0
        && indentationStack[indentationStack.length - 1]! >= indentation
      ) {
        indentationStack.pop();
      }
      indentationStack.push(indentation);
      if (indentationStack.length > BUDGET.maxAgentProfileYamlDepth) {
        return `YAML block depth exceeds ${BUDGET.maxAgentProfileYamlDepth}`;
      }
      atLineStart = false;
    }

    if (type === 'flow-map-start' || type === 'flow-seq-start') {
      flowDepth += 1;
      if (flowDepth > BUDGET.maxAgentProfileYamlDepth) {
        return `YAML flow depth exceeds ${BUDGET.maxAgentProfileYamlDepth}`;
      }
    } else if (type === 'flow-map-end' || type === 'flow-seq-end') {
      flowDepth = Math.max(0, flowDepth - 1);
    } else if (
      flowDepth === 0
      && (type === 'seq-item-ind' || type === 'explicit-key-ind' || type === 'map-value-ind')
    ) {
      inlineBlockDepth += 1;
      if (inlineBlockDepth > BUDGET.maxAgentProfileYamlDepth) {
        return `YAML inline block depth exceeds ${BUDGET.maxAgentProfileYamlDepth}`;
      }
    }
  }
  return undefined;
}

function validateAgentProfile(text: string, pointer: string, opts: ClassificationOptions): AgentProfileResult {
  const findings: ValidationFinding[] = [];
  let document: ReturnType<typeof parseDocument>;
  try {
    const violation = agentProfileYamlComplexityViolation(text);
    if (violation) {
      return agentProfileBudgetExceeded(
        opts,
        pointer,
        `Skill Agent Profile exceeds Validation Budget: ${violation}`,
      );
    }
    document = parseDocument(text, { logLevel: 'silent', prettyErrors: false });
    if (document.errors.length > 0) throw document.errors[0];
  } catch {
    return invalidAgentProfile(opts, pointer);
  }

  let nodeCount = 0;
  let astViolation: string | undefined;
  visit(document, (_key, node, path) => {
    nodeCount += 1;
    if (nodeCount > BUDGET.maxAgentProfileYamlNodes) {
      astViolation = `YAML node count exceeds ${BUDGET.maxAgentProfileYamlNodes}`;
      return visit.BREAK;
    }
    const collectionDepth = path.reduce(
      (depth, ancestor) => depth + (isCollection(ancestor) ? 1 : 0),
      isCollection(node) ? 1 : 0,
    );
    if (collectionDepth > BUDGET.maxAgentProfileYamlDepth) {
      astViolation = `YAML AST depth exceeds ${BUDGET.maxAgentProfileYamlDepth}`;
      return visit.BREAK;
    }
    return undefined;
  });
  if (astViolation) {
    return agentProfileBudgetExceeded(
      opts,
      pointer,
      `Skill Agent Profile exceeds Validation Budget: ${astViolation}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = document.toJS({ maxAliasCount: BUDGET.maxAgentProfileYamlAliases });
  } catch (error) {
    if (
      error instanceof ReferenceError
      && error.message === 'Excessive alias count indicates a resource exhaustion attack'
    ) {
      return agentProfileBudgetExceeded(
        opts,
        pointer,
        `Skill Agent Profile exceeds Validation Budget: YAML alias expansion exceeds ${BUDGET.maxAgentProfileYamlAliases}`,
      );
    }
    return invalidAgentProfile(opts, pointer);
  }
  if (!isMapping(parsed)) {
    return invalidAgentProfile(opts, pointer);
  }
  const profile = parsed;

  for (const key of Object.keys(profile).sort((a, b) => a.localeCompare(b))) {
    if (key === 'interface' || key === 'policy') continue;
    findings.push(finding(
      opts,
      CODE.UNSUPPORTED_ACTIVE_COMPONENT,
      RULE.UNSUPPORTED_ACTIVE_COMPONENT,
      'skill',
      `${pointer}#/${key}`,
      key === 'dependencies'
        ? 'Compatibility Profile v1 does not support Skill Agent Profile dependencies'
        : `Unknown Skill Agent Profile field '${key}' may declare active behaviour and is fail-closed`,
    ));
  }

  const interfaceMetadata = profile.interface;
  if (isMapping(interfaceMetadata)) {
    for (const [key, value] of Object.entries(interfaceMetadata).sort(([a], [b]) => a.localeCompare(b))) {
      if (AGENT_INTERFACE_STRING_FIELDS.has(key) && typeof value === 'string' && value.trim()) continue;
      findings.push(warning({
        code: CODE.INERT_METADATA_IGNORED,
        rule: 'COMP-W01',
        target: 'skill',
        pointer: `${pointer}#/interface/${key}`,
        outcome: `Ignored malformed or unknown Skill Agent Profile presentation member '${key}'`,
        scope: opts.scope,
        phase: 'validation',
      }));
    }
  } else if (Object.hasOwn(profile, 'interface')) {
    findings.push(warning({
      code: CODE.INERT_METADATA_IGNORED,
      rule: 'COMP-W01',
      target: 'skill',
      pointer: `${pointer}#/interface`,
      outcome: 'Ignored malformed Skill Agent Profile interface metadata',
      scope: opts.scope,
      phase: 'validation',
    }));
  }

  const policy = profile.policy;
  if (!isMapping(policy)) {
    if (Object.hasOwn(profile, 'policy')) {
      findings.push(finding(
        opts,
        CODE.SKILL_AGENT_PROFILE_INVALID,
        RULE.SKILL_AGENT_PROFILE_INVALID,
        'skill',
        `${pointer}#/policy`,
        'Skill Agent Profile policy must be a mapping when declared',
      ));
    }
    return { findings };
  }

  for (const key of Object.keys(policy).sort((a, b) => a.localeCompare(b))) {
    if (key === 'allow_implicit_invocation') continue;
    findings.push(finding(
      opts,
      CODE.UNSUPPORTED_ACTIVE_COMPONENT,
      RULE.UNSUPPORTED_ACTIVE_COMPONENT,
      'skill',
      `${pointer}#/policy/${key}`,
      `Unknown Skill Agent Profile policy '${key}' may declare active behaviour and is fail-closed`,
    ));
  }
  const allowImplicit = policy.allow_implicit_invocation;
  if (typeof allowImplicit === 'boolean') {
    return { invocationPolicy: allowImplicit ? 'implicit' : 'explicit', findings };
  }
  if (Object.hasOwn(policy, 'allow_implicit_invocation')) {
    findings.push(finding(
      opts,
      CODE.SKILL_AGENT_PROFILE_INVALID,
      RULE.SKILL_AGENT_PROFILE_INVALID,
      'skill',
      `${pointer}#/policy/allow_implicit_invocation`,
      'allow_implicit_invocation must be a boolean when declared',
    ));
  }
  return { findings };
}

function loadAgentProfile(
  pluginRoot: string,
  skillDirectory: string,
  skillName: string,
  opts: ClassificationOptions,
  capture: MaterialCapture,
): AgentProfileResult {
  const pointer = `skills/${skillName}/agents/openai.yaml`;
  const profilePath = join(skillDirectory, 'agents', 'openai.yaml');
  try {
    lstatSync(profilePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { findings: [] };
    capture.add(`agent-profile-error:${skillName}`, pointer);
    return {
      findings: [finding(
        opts,
        CODE.SKILL_AGENT_PROFILE_INVALID,
        RULE.SKILL_AGENT_PROFILE_INVALID,
        'skill',
        pointer,
        'Skill Agent Profile cannot be inspected safely',
      )],
    };
  }

  try {
    const canonicalPluginRoot = realpathSync.native(pluginRoot);
    const canonicalSkillDirectory = realpathSync.native(skillDirectory);
    const canonicalProfilePath = realpathSync.native(profilePath);
    if (
      !isWithin(canonicalSkillDirectory, canonicalProfilePath)
      || isSnapshotExcluded(canonicalPluginRoot, canonicalProfilePath)
    ) {
      throw new TypeError('not a snapshot-covered regular file owned by the Skill');
    }
    const read = readBoundedFileSync(canonicalProfilePath, BUDGET.maxAgentProfileBytes);
    if (!read.ok) {
      capture.add(`agent-profile-budget:${skillName}`, `${pointer}:${read.observedBytes}`);
      return agentProfileBudgetExceeded(
        opts,
        pointer,
        `Skill Agent Profile exceeds Validation Budget: ${read.observedBytes} bytes > ${BUDGET.maxAgentProfileBytes}`,
      );
    }
    capture.add(`agent-profile:${skillName}`, read.bytes);
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(read.bytes);
    } catch {
      return invalidAgentProfile(opts, pointer);
    }
    return validateAgentProfile(text, pointer, opts);
  } catch {
    capture.add(`agent-profile-error:${skillName}`, pointer);
    return {
      findings: [finding(
        opts,
        CODE.SKILL_AGENT_PROFILE_INVALID,
        RULE.SKILL_AGENT_PROFILE_INVALID,
        'skill',
        pointer,
        'Skill Agent Profile must resolve within its owning Skill to a readable regular file covered by the Validation Snapshot',
      )],
    };
  }
}

function descriptorInvocationPolicy(value: unknown): InvocationPolicy | undefined {
  return typeof value === 'boolean' ? (value ? 'explicit' : 'implicit') : undefined;
}

function isWithin(root: string, target: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);
}

function isSnapshotExcluded(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel.split(sep).some((part) => part === '.git' || part === 'node_modules');
}

function resourcesIn(root: string, skillDirectory: string, capture: MaterialCapture): { resources: string[]; error?: string } {
  const resources: string[] = [];
  const chargedTargets = new Set<string>();
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
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path, next, depth + 1);
      else {
        if (next === 'agents/openai.yaml') continue;
        const stat = lstatSync(path);
        let chargeSize = stat.size;
        if (stat.isSymbolicLink()) {
          const target = realpathSync.native(path);
          if (!isWithin(skillDirectory, target) || isSnapshotExcluded(root, target)) {
            throw new Error(`Skill Resource symlink '${next}' resolves outside snapshot-covered content`);
          }
          const targetStat = statSync(path);
          if (!targetStat.isFile()) throw new Error(`Skill Resource symlink '${next}' does not resolve to a regular file`);
          chargeSize = chargedTargets.has(target) ? 0 : targetStat.size;
          chargedTargets.add(target);
        } else if (!stat.isFile()) {
          throw new Error(`Skill Resource '${next}' is not a regular file`);
        }
        files += 1;
        bytes += chargeSize;
        if (files > BUDGET.maxFiles || bytes > BUDGET.maxTotalBytes) {
          throw new Error('Skill Resources exceed Validation Budget');
        }
        capture.add(`resource:${next}`, readFileSync(path));
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
  const capture = new MaterialCapture();
  const manifestPath = join(root, '.codex-plugin', 'plugin.json');
  let manifest: Record<string, unknown> | undefined;

  try {
    const raw = readFileSync(manifestPath, 'utf8');
    capture.add('manifest', raw);
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) manifest = parsed as Record<string, unknown>;
  } catch {
    capture.add('manifest-error', manifestPath);
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
        const raw = readFileSync(skillPath, 'utf8');
        capture.add(`descriptor:${entry.name}`, raw);
        descriptor = parseDescriptor(raw);
      } catch {
        capture.add(`descriptor-error:${entry.name}`, skillPath);
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
      const agentProfile = loadAgentProfile(root, skillDirectory, entry.name, opts, capture);
      findings.push(...agentProfile.findings);
      const descriptorPolicy = descriptorInvocationPolicy(descriptor.frontmatter?.['disable-model-invocation']);
      if (descriptorPolicy && agentProfile.invocationPolicy && descriptorPolicy !== agentProfile.invocationPolicy) {
        findings.push(finding(
          opts,
          CODE.SKILL_AGENT_PROFILE_INVALID,
          RULE.SKILL_AGENT_PROFILE_INVALID,
          'skill',
          `skills/${entry.name}/agents/openai.yaml#/policy/allow_implicit_invocation`,
          'Skill Descriptor and Skill Agent Profile declare contradictory Invocation Policies',
        ));
      }
      const invocationPolicy = descriptorPolicy ?? agentProfile.invocationPolicy ?? 'implicit';
      const pluginId = manifest && typeof manifest.name === 'string' ? `${opts.marketplaceId}/${manifest.name}` : '';
      const resourceResult = resourcesIn(root, skillDirectory, capture);
      if (resourceResult.error) {
        findings.push(finding(opts, CODE.SKILL_DESCRIPTOR_INVALID, RULE.SKILL_DESCRIPTOR_INVALID, 'skill', `skills/${entry.name}`, `Skill Resources cannot be scanned safely: ${resourceResult.error}`));
        continue;
      }
      skills.push({
        id: `${pluginId}/${name}`,
        name,
        path: skillDirectory,
        resources: resourceResult.resources,
        invocationPolicy,
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
  const identity = manifest && typeof manifest.name === 'string' && KEBAB.test(manifest.name)
    ? `${opts.marketplaceId}/${manifest.name}`
    : undefined;
  if (sorted.some((item) => item.code === CODE.PLUGIN_MANIFEST_INVALID || item.code === CODE.SKILL_DESCRIPTOR_INVALID || item.code === CODE.SKILL_AGENT_PROFILE_INVALID)) {
    return { classification: 'invalid', identity, captureFingerprint: capture.fingerprint(), findings: sorted };
  }
  if (sorted.some((item) => item.code === CODE.UNSUPPORTED_ACTIVE_COMPONENT && item.classification === 'blocking')) {
    return { classification: 'incompatible', identity, captureFingerprint: capture.fingerprint(), findings: sorted };
  }
  if (sorted.some((item) => item.classification === 'blocking')) return { classification: 'invalid', identity, captureFingerprint: capture.fingerprint(), findings: sorted };
  const manifestName = manifest!.name as string;
  return {
    classification: 'compatible',
    plugin: {
      id: `${opts.marketplaceId}/${manifestName}`,
      manifestName,
      marketplaceEntryId: opts.marketplaceEntryId,
      skills,
    },
    identity: `${opts.marketplaceId}/${manifestName}`,
    captureFingerprint: capture.fingerprint(),
    findings: sorted,
  };
}
