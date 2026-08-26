import { mkdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { classifyPlugin, pluginIdentity } from '../../../src/compatibility/profile.js';
import { BUDGET } from '../../../src/registration/budget.js';

const roots: string[] = [];

function pluginRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'compatible-plugin-'));
  roots.push(root);
  mkdirSync(join(root, '.codex-plugin'), { recursive: true });
  mkdirSync(join(root, 'skills', 'release-notes'), { recursive: true });
  writeFileSync(join(root, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'release-helper', skills: './skills/' }));
  writeFileSync(
    join(root, 'skills', 'release-notes', 'SKILL.md'),
    '---\nname: release-notes\ndescription: Draft release notes\n---\n\nWrite concise release notes.\n',
  );
  return root;
}

function claudePluginRoot(
  skills: Array<{
    name: string;
    path: string;
    desc?: string;
    disableModelInvocation?: boolean | string | number;
    body?: string;
    frontmatterExtra?: string;
    hasOpenAiYaml?: boolean;
    openAiYamlContent?: string;
  }> = [
    { name: 'release-notes', path: './skills/release-notes', desc: 'Draft release notes' },
  ],
  manifestOverrides: Record<string, unknown> = {},
): string {
  const root = mkdtempSync(join(tmpdir(), 'claude-plugin-'));
  roots.push(root);
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  const manifest = {
    name: 'release-helper',
    skills: skills.map((s) => s.path),
    ...manifestOverrides,
  };
  writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify(manifest));

  for (const s of skills) {
    const rel = s.path.startsWith('./') ? s.path.slice(2) : s.path;
    const dir = join(root, ...rel.split('/'));
    mkdirSync(dir, { recursive: true });
    let frontmatter = `name: ${s.name}\ndescription: ${s.desc ?? 'A skill'}\n`;
    if (s.disableModelInvocation !== undefined) {
      frontmatter += `disable-model-invocation: ${s.disableModelInvocation}\n`;
    }
    if (s.frontmatterExtra) {
      frontmatter += s.frontmatterExtra;
    }
    writeFileSync(join(dir, 'SKILL.md'), `---\n${frontmatter}---\n\n${s.body ?? 'Skill instructions.'}\n`);
    if (s.hasOpenAiYaml) {
      mkdirSync(join(dir, 'agents'), { recursive: true });
      writeFileSync(
        join(dir, 'agents', 'openai.yaml'),
        s.openAiYamlContent ?? 'policy:\n  allow_implicit_invocation: false\n',
      );
    }
  }
  return root;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('Compatibility Profile v2 — Codex format', () => {
  it('classifies a skills-only Codex Plugin atomically as Compatible and keeps Pi-native invocation policy', () => {
    const root = pluginRoot();

    const result = classifyPlugin(root, {
      marketplaceId: 'reg-1/acme-marketplace',
      marketplaceEntryId: 'reg-1/acme-marketplace/plugins/0',
    });

    expect(result.classification).toBe('compatible');
    expect(result.plugin!.id).toBe('reg-1/acme-marketplace/release-helper');
    expect(result.plugin!.skills).toEqual([
      expect.objectContaining({
        id: 'reg-1/acme-marketplace/release-helper/release-notes',
        name: 'release-notes',
        invocationPolicy: 'implicit',
      }),
    ]);
    expect(result.findings).toEqual([]);
  });

  it('marks an unreadable Skill Descriptor Invalid without projecting a partial Plugin', () => {
    const root = pluginRoot();
    writeFileSync(join(root, 'skills', 'release-notes', 'SKILL.md'), '# no descriptor\n');

    const result = classifyPlugin(root, {
      marketplaceId: 'reg-1/acme-marketplace',
      marketplaceEntryId: 'reg-1/acme-marketplace/plugins/0',
    });

    expect(result.classification).toBe('invalid');
    expect(result.plugin).toBeUndefined();
    expect(result.findings).toEqual([
      expect.objectContaining({ code: 'SKILL_DESCRIPTOR_INVALID', classification: 'blocking' }),
    ]);
  });

  it('marks an unknown Active Component Incompatible while ignored metadata is only a Warning', () => {
    const root = pluginRoot();
    mkdirSync(join(root, 'commands'), { recursive: true });
    writeFileSync(join(root, '.codex-plugin', 'plugin.json'), JSON.stringify({
      name: 'release-helper',
      skills: './skills/',
      description: 'inert presentation metadata',
      author: 'Acme',
    }));

    const result = classifyPlugin(root, {
      marketplaceId: 'reg-1/acme-marketplace',
      marketplaceEntryId: 'reg-1/acme-marketplace/plugins/0',
    });

    expect(result.classification).toBe('incompatible');
    expect(result.plugin).toBeUndefined();
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'UNSUPPORTED_ACTIVE_COMPONENT', classification: 'blocking' }),
      expect.objectContaining({ code: 'INERT_METADATA_IGNORED', classification: 'warning' }),
    ]));
  });

  it('keeps Pi-native YAML parsing and explicit invocation semantics', () => {
    const root = pluginRoot();
    writeFileSync(
      join(root, 'skills', 'release-notes', 'SKILL.md'),
      '---\nname: release-notes\ndescription: |\n  Draft a concise\n  release note\ndisable-model-invocation: true\n---\n\nWrite concise release notes.\n',
    );

    const result = classifyPlugin(root, {
      marketplaceId: 'reg-1/acme-marketplace',
      marketplaceEntryId: 'reg-1/acme-marketplace/plugins/0',
    });

    expect(result.classification).toBe('compatible');
    expect(result.plugin!.skills[0]!.invocationPolicy).toBe('explicit');
  });

  it('returns Invalid rather than throwing when the skills root is not a directory', () => {
    const root = pluginRoot();
    rmSync(join(root, 'skills'), { recursive: true });
    writeFileSync(join(root, 'skills'), 'not a directory');

    const result = classifyPlugin(root, {
      marketplaceId: 'reg-1/acme-marketplace', marketplaceEntryId: 'reg-1/acme-marketplace/plugins/0',
    });

    expect(result.classification).toBe('invalid');
    expect(result.plugin).toBeUndefined();
    expect(result.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'SKILL_DESCRIPTOR_INVALID' })]));
  });

  it('rejects duplicate canonical Skill IDs', () => {
    const root = pluginRoot();
    mkdirSync(join(root, 'skills', 'duplicate'), { recursive: true });
    writeFileSync(join(root, 'skills', 'duplicate', 'SKILL.md'), '---\nname: release-notes\ndescription: Duplicate\n---\n\nDuplicate.\n');

    const result = classifyPlugin(root, {
      marketplaceId: 'reg-1/acme-marketplace', marketplaceEntryId: 'reg-1/acme-marketplace/plugins/0',
    });

    expect(result.classification).toBe('invalid');
    expect(result.plugin).toBeUndefined();
    expect(result.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'SKILL_DESCRIPTOR_INVALID' })]));
  });

  it('does not accept resources the Validation Snapshot deliberately excludes', () => {
    const root = pluginRoot();
    mkdirSync(join(root, 'skills', 'release-notes', 'node_modules', 'ignored'), { recursive: true });
    writeFileSync(join(root, 'skills', 'release-notes', 'node_modules', 'ignored', 'package.js'), 'untrusted');

    const result = classifyPlugin(root, {
      marketplaceId: 'reg-1/acme-marketplace', marketplaceEntryId: 'reg-1/acme-marketplace/plugins/0',
    });

    expect(result.classification).toBe('compatible');
    expect(result.plugin!.skills[0]!.resources).not.toContain('node_modules/ignored/package.js');
  });

  it('accepts a supported Skill Agent Profile and maps disabled implicit invocation to explicit-only', () => {
    const root = pluginRoot();
    mkdirSync(join(root, 'skills', 'release-notes', 'agents'), { recursive: true });
    writeFileSync(
      join(root, 'skills', 'release-notes', 'agents', 'openai.yaml'),
      'interface:\n  display_name: Release notes\n  short_description: Draft a release note\npolicy:\n  allow_implicit_invocation: false\n',
    );

    const result = classifyPlugin(root, {
      marketplaceId: 'reg-1/acme-marketplace', marketplaceEntryId: 'reg-1/acme-marketplace/plugins/0',
    });

    expect(result.classification).toBe('compatible');
    expect(result.plugin!.skills[0]!.invocationPolicy).toBe('explicit');
    expect(result.plugin!.skills[0]!.resources).not.toContain('agents/openai.yaml');
  });

  it('maps allow_implicit_invocation true to implicit invocation', () => {
    const root = pluginRoot();
    mkdirSync(join(root, 'skills', 'release-notes', 'agents'), { recursive: true });
    writeFileSync(
      join(root, 'skills', 'release-notes', 'agents', 'openai.yaml'),
      'policy:\n  allow_implicit_invocation: true\n',
    );

    const result = classifyPlugin(root, {
      marketplaceId: 'reg-1/acme-marketplace', marketplaceEntryId: 'reg-1/acme-marketplace/plugins/0',
    });

    expect(result.classification).toBe('compatible');
    expect(result.plugin!.skills[0]!.invocationPolicy).toBe('implicit');
  });

  it('marks contradictory explicit Invocation Policy declarations Invalid without partial projection', () => {
    const root = pluginRoot();
    writeFileSync(
      join(root, 'skills', 'release-notes', 'SKILL.md'),
      '---\nname: release-notes\ndescription: Draft release notes\ndisable-model-invocation: false\n---\n\nWrite concise release notes.\n',
    );
    mkdirSync(join(root, 'skills', 'release-notes', 'agents'), { recursive: true });
    writeFileSync(
      join(root, 'skills', 'release-notes', 'agents', 'openai.yaml'),
      'policy:\n  allow_implicit_invocation: false\n',
    );

    const result = classifyPlugin(root, {
      marketplaceId: 'reg-1/acme-marketplace', marketplaceEntryId: 'reg-1/acme-marketplace/plugins/0',
    });

    expect(result.classification).toBe('invalid');
    expect(result.plugin).toBeUndefined();
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'SKILL_AGENT_PROFILE_INVALID',
        pointer: 'skills/release-notes/agents/openai.yaml#/policy/allow_implicit_invocation',
      }),
    ]));
  });

  it('marks a non-boolean allow_implicit_invocation declaration Invalid', () => {
    const root = pluginRoot();
    mkdirSync(join(root, 'skills', 'release-notes', 'agents'), { recursive: true });
    writeFileSync(
      join(root, 'skills', 'release-notes', 'agents', 'openai.yaml'),
      'policy:\n  allow_implicit_invocation: "false"\n',
    );

    const result = classifyPlugin(root, {
      marketplaceId: 'reg-1/acme-marketplace', marketplaceEntryId: 'reg-1/acme-marketplace/plugins/0',
    });

    expect(result.classification).toBe('invalid');
    expect(result.plugin).toBeUndefined();
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'SKILL_AGENT_PROFILE_INVALID',
        pointer: 'skills/release-notes/agents/openai.yaml#/policy/allow_implicit_invocation',
      }),
    ]));
  });

  it.each([
    ['dependencies:\n  tools: [git]\n', 'dependencies'],
    ['runtime:\n  network: true\n', 'runtime'],
  ])('marks unsupported Skill Agent Profile top-level declaration %s Incompatible', (profile, key) => {
    const root = pluginRoot();
    mkdirSync(join(root, 'skills', 'release-notes', 'agents'), { recursive: true });
    writeFileSync(join(root, 'skills', 'release-notes', 'agents', 'openai.yaml'), profile);

    const result = classifyPlugin(root, {
      marketplaceId: 'reg-1/acme-marketplace', marketplaceEntryId: 'reg-1/acme-marketplace/plugins/0',
    });

    expect(result.classification).toBe('incompatible');
    expect(result.plugin).toBeUndefined();
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'UNSUPPORTED_ACTIVE_COMPONENT',
        pointer: `skills/release-notes/agents/openai.yaml#/${key}`,
      }),
    ]));
  });

  it('marks an unknown Skill Agent Profile policy key Incompatible', () => {
    const root = pluginRoot();
    mkdirSync(join(root, 'skills', 'release-notes', 'agents'), { recursive: true });
    writeFileSync(
      join(root, 'skills', 'release-notes', 'agents', 'openai.yaml'),
      'policy:\n  allow_implicit_invocation: true\n  tool_restrictions: [git]\n',
    );

    const result = classifyPlugin(root, {
      marketplaceId: 'reg-1/acme-marketplace', marketplaceEntryId: 'reg-1/acme-marketplace/plugins/0',
    });

    expect(result.classification).toBe('incompatible');
    expect(result.plugin).toBeUndefined();
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'UNSUPPORTED_ACTIVE_COMPONENT',
        pointer: 'skills/release-notes/agents/openai.yaml#/policy/tool_restrictions',
      }),
    ]));
  });

  it.each([
    ['policy: [\n', 'skills/release-notes/agents/openai.yaml'],
    ['- policy\n', 'skills/release-notes/agents/openai.yaml'],
    ['policy: true\n', 'skills/release-notes/agents/openai.yaml#/policy'],
  ])('marks malformed Skill Agent Profile structure Invalid', (profile, pointer) => {
    const root = pluginRoot();
    mkdirSync(join(root, 'skills', 'release-notes', 'agents'), { recursive: true });
    writeFileSync(join(root, 'skills', 'release-notes', 'agents', 'openai.yaml'), profile);

    const result = classifyPlugin(root, {
      marketplaceId: 'reg-1/acme-marketplace', marketplaceEntryId: 'reg-1/acme-marketplace/plugins/0',
    });

    expect(result.classification).toBe('invalid');
    expect(result.plugin).toBeUndefined();
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'SKILL_AGENT_PROFILE_INVALID', pointer }),
    ]));
  });

  it('rejects Skill Agent Profile bytes that are not valid UTF-8', () => {
    const root = pluginRoot();
    const profileDirectory = join(root, 'skills', 'release-notes', 'agents');
    mkdirSync(profileDirectory, { recursive: true });
    writeFileSync(
      join(profileDirectory, 'openai.yaml'),
      Buffer.concat([
        Buffer.from('interface:\n  display_name: "'),
        Buffer.from([0xff]),
        Buffer.from('"\n'),
      ]),
    );

    const result = classifyPlugin(root, {
      marketplaceId: 'reg-1/acme-marketplace', marketplaceEntryId: 'reg-1/acme-marketplace/plugins/0',
    });

    expect(result.classification).toBe('invalid');
    expect(result.plugin).toBeUndefined();
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'SKILL_AGENT_PROFILE_INVALID' }),
    ]));
  });

  it('rejects a Skill Agent Profile above its dedicated byte budget before parsing', () => {
    const root = pluginRoot();
    const profileDirectory = join(root, 'skills', 'release-notes', 'agents');
    const profilePath = join(profileDirectory, 'openai.yaml');
    mkdirSync(profileDirectory, { recursive: true });
    writeFileSync(profilePath, '');
    truncateSync(profilePath, BUDGET.maxAgentProfileBytes + 1);
    expect(BUDGET.maxAgentProfileBytes + 1).toBeLessThan(BUDGET.maxTotalBytes);

    const result = classifyPlugin(root, {
      marketplaceId: 'reg-1/acme-marketplace', marketplaceEntryId: 'reg-1/acme-marketplace/plugins/0',
    });

    expect(result.classification).toBe('invalid');
    expect(result.plugin).toBeUndefined();
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'BUDGET_EXCEEDED',
        classification: 'blocking',
        pointer: 'skills/release-notes/agents/openai.yaml',
        target: 'plugin',
      }),
    ]));
  });

  it('rejects a Skill Agent Profile above its YAML node budget', () => {
    const root = pluginRoot();
    const profileDirectory = join(root, 'skills', 'release-notes', 'agents');
    const profile = `interface: [${Array.from(
      { length: BUDGET.maxAgentProfileYamlNodes + 1 },
      () => 'value',
    ).join(',')}]\n`;
    expect(Buffer.byteLength(profile)).toBeLessThan(BUDGET.maxAgentProfileBytes);
    mkdirSync(profileDirectory, { recursive: true });
    writeFileSync(join(profileDirectory, 'openai.yaml'), profile);

    const result = classifyPlugin(root, {
      marketplaceId: 'reg-1/acme-marketplace', marketplaceEntryId: 'reg-1/acme-marketplace/plugins/0',
    });

    expect(result.classification).toBe('invalid');
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'BUDGET_EXCEEDED',
        outcome: expect.stringContaining('YAML node count exceeds'),
      }),
    ]));
  });

  it('rejects a Skill Agent Profile above its YAML depth budget', () => {
    const root = pluginRoot();
    const profileDirectory = join(root, 'skills', 'release-notes', 'agents');
    const nesting = BUDGET.maxAgentProfileYamlDepth + 1;
    const profile = `interface: ${'['.repeat(nesting)}value${']'.repeat(nesting)}\n`;
    expect(Buffer.byteLength(profile)).toBeLessThan(BUDGET.maxAgentProfileBytes);
    mkdirSync(profileDirectory, { recursive: true });
    writeFileSync(join(profileDirectory, 'openai.yaml'), profile);

    const result = classifyPlugin(root, {
      marketplaceId: 'reg-1/acme-marketplace', marketplaceEntryId: 'reg-1/acme-marketplace/plugins/0',
    });

    expect(result.classification).toBe('invalid');
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'BUDGET_EXCEEDED' }),
    ]));
  });

  it('rejects a Skill Agent Profile above its YAML alias expansion budget', () => {
    const root = pluginRoot();
    const profileDirectory = join(root, 'skills', 'release-notes', 'agents');
    const profile = `interface:\n${Array.from(
      { length: BUDGET.maxAgentProfileYamlAliases + 2 },
      (_, index) => index === 0 ? '  field_0: &shared value' : `  field_${index}: *shared`,
    ).join('\n')}\n`;
    expect(Buffer.byteLength(profile)).toBeLessThan(BUDGET.maxAgentProfileBytes);
    mkdirSync(profileDirectory, { recursive: true });
    writeFileSync(join(profileDirectory, 'openai.yaml'), profile);

    const result = classifyPlugin(root, {
      marketplaceId: 'reg-1/acme-marketplace', marketplaceEntryId: 'reg-1/acme-marketplace/plugins/0',
    });

    expect(result.classification).toBe('invalid');
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'BUDGET_EXCEEDED' }),
    ]));
  });

  it('classifies an unresolved Skill Agent Profile alias as invalid YAML rather than a budget failure', () => {
    const root = pluginRoot();
    const profileDirectory = join(root, 'skills', 'release-notes', 'agents');
    mkdirSync(profileDirectory, { recursive: true });
    writeFileSync(join(profileDirectory, 'openai.yaml'), 'policy: *missing\n');

    const result = classifyPlugin(root, {
      marketplaceId: 'reg-1/acme-marketplace', marketplaceEntryId: 'reg-1/acme-marketplace/plugins/0',
    });

    expect(result.classification).toBe('invalid');
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'SKILL_AGENT_PROFILE_INVALID' }),
    ]));
    expect(result.findings).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'BUDGET_EXCEEDED' }),
    ]));
  });

  it('accepts collection nesting at the Skill Agent Profile depth budget', () => {
    const root = pluginRoot();
    const profileDirectory = join(root, 'skills', 'release-notes', 'agents');
    const profile = `${'['.repeat(BUDGET.maxAgentProfileYamlDepth)}value${']'.repeat(BUDGET.maxAgentProfileYamlDepth)}\n`;
    mkdirSync(profileDirectory, { recursive: true });
    writeFileSync(join(profileDirectory, 'openai.yaml'), profile);

    const result = classifyPlugin(root, {
      marketplaceId: 'reg-1/acme-marketplace', marketplaceEntryId: 'reg-1/acme-marketplace/plugins/0',
    });

    expect(result.findings).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'BUDGET_EXCEEDED' }),
    ]));
  });

  it('ignores malformed or unknown Skill Agent Profile presentation members with Warnings', () => {
    const root = pluginRoot();
    mkdirSync(join(root, 'skills', 'release-notes', 'agents'), { recursive: true });
    writeFileSync(
      join(root, 'skills', 'release-notes', 'agents', 'openai.yaml'),
      'interface:\n  display_name: [Release notes]\n  future_badge: true\n',
    );

    const result = classifyPlugin(root, {
      marketplaceId: 'reg-1/acme-marketplace', marketplaceEntryId: 'reg-1/acme-marketplace/plugins/0',
    });

    expect(result.classification).toBe('compatible');
    expect(result.plugin).toBeDefined();
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'INERT_METADATA_IGNORED',
        classification: 'warning',
        pointer: 'skills/release-notes/agents/openai.yaml#/interface/display_name',
      }),
      expect.objectContaining({
        code: 'INERT_METADATA_IGNORED',
        classification: 'warning',
        pointer: 'skills/release-notes/agents/openai.yaml#/interface/future_badge',
      }),
    ]));
  });

  it('changes captured material when Skill Agent Profile content changes', () => {
    const root = pluginRoot();
    const profilePath = join(root, 'skills', 'release-notes', 'agents', 'openai.yaml');
    mkdirSync(join(root, 'skills', 'release-notes', 'agents'), { recursive: true });
    writeFileSync(profilePath, 'policy:\n  allow_implicit_invocation: true\n');
    const options = {
      scope: 'global' as const,
      marketplaceId: 'reg-1/acme-marketplace',
      marketplaceEntryId: 'reg-1/acme-marketplace/plugins/0',
    };

    const before = classifyPlugin(root, options);
    writeFileSync(profilePath, 'policy:\n  allow_implicit_invocation: false\n');
    const after = classifyPlugin(root, options);

    expect(before.classification).toBe('compatible');
    expect(after.classification).toBe('compatible');
    expect(after.captureFingerprint).not.toBe(before.captureFingerprint);
  });

  it('marks a non-file Skill Agent Profile path Invalid', () => {
    const root = pluginRoot();
    mkdirSync(join(root, 'skills', 'release-notes', 'agents', 'openai.yaml'), { recursive: true });

    const result = classifyPlugin(root, {
      marketplaceId: 'reg-1/acme-marketplace', marketplaceEntryId: 'reg-1/acme-marketplace/plugins/0',
    });

    expect(result.classification).toBe('invalid');
    expect(result.plugin).toBeUndefined();
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'SKILL_AGENT_PROFILE_INVALID',
        pointer: 'skills/release-notes/agents/openai.yaml',
      }),
    ]));
  });

  it('accepts a Skill Agent Profile symlink whose target is a regular file', () => {
    const root = pluginRoot();
    const agents = join(root, 'skills', 'release-notes', 'agents');
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, 'profile.yaml'), 'policy:\n  allow_implicit_invocation: false\n');
    symlinkSync('profile.yaml', join(agents, 'openai.yaml'));

    const result = classifyPlugin(root, {
      marketplaceId: 'reg-1/acme-marketplace', marketplaceEntryId: 'reg-1/acme-marketplace/plugins/0',
    });

    expect(result.classification).toBe('compatible');
    expect(result.plugin!.skills[0]!.invocationPolicy).toBe('explicit');
  });

  it('rejects a Skill Agent Profile symlink whose target belongs to another Skill', () => {
    const root = pluginRoot();
    const skills = join(root, 'skills');
    mkdirSync(join(skills, 'other-skill'), { recursive: true });
    writeFileSync(
      join(skills, 'other-skill', 'SKILL.md'),
      '---\nname: other-skill\ndescription: Other skill\n---\n\nDo other work.\n',
    );
    writeFileSync(join(skills, 'other-skill', 'profile.yaml'), 'policy:\n  allow_implicit_invocation: false\n');
    mkdirSync(join(skills, 'release-notes', 'agents'), { recursive: true });
    symlinkSync('../../other-skill/profile.yaml', join(skills, 'release-notes', 'agents', 'openai.yaml'));

    const result = classifyPlugin(root, {
      marketplaceId: 'reg-1/acme-marketplace', marketplaceEntryId: 'reg-1/acme-marketplace/plugins/0',
    });

    expect(result.classification).toBe('invalid');
    expect(result.plugin).toBeUndefined();
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'SKILL_AGENT_PROFILE_INVALID',
        pointer: 'skills/release-notes/agents/openai.yaml',
      }),
    ]));
  });

  it('rejects a symlinked Agent Profile parent that resolves into another Skill', () => {
    const root = pluginRoot();
    const skills = join(root, 'skills');
    mkdirSync(join(skills, 'other-skill', 'agents'), { recursive: true });
    writeFileSync(
      join(skills, 'other-skill', 'SKILL.md'),
      '---\nname: other-skill\ndescription: Other skill\n---\n\nDo other work.\n',
    );
    writeFileSync(join(skills, 'other-skill', 'agents', 'openai.yaml'), 'policy:\n  allow_implicit_invocation: false\n');
    symlinkSync('../other-skill/agents', join(skills, 'release-notes', 'agents'));

    const result = classifyPlugin(root, {
      marketplaceId: 'reg-1/acme-marketplace', marketplaceEntryId: 'reg-1/acme-marketplace/plugins/0',
    });

    expect(result.classification).toBe('invalid');
    expect(result.plugin).toBeUndefined();
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'SKILL_AGENT_PROFILE_INVALID',
        pointer: 'skills/release-notes/agents/openai.yaml',
      }),
    ]));
  });

  it.each(['.git', 'node_modules'])(
    'rejects a Skill Agent Profile symlink whose target is in snapshot-excluded %s',
    (excludedDirectory) => {
      const root = pluginRoot();
      const skill = join(root, 'skills', 'release-notes');
      mkdirSync(join(skill, excludedDirectory), { recursive: true });
      writeFileSync(join(skill, excludedDirectory, 'openai.yaml'), 'policy:\n  allow_implicit_invocation: false\n');
      mkdirSync(join(skill, 'agents'), { recursive: true });
      symlinkSync(`../${excludedDirectory}/openai.yaml`, join(skill, 'agents', 'openai.yaml'));

      const result = classifyPlugin(root, {
        marketplaceId: 'reg-1/acme-marketplace', marketplaceEntryId: 'reg-1/acme-marketplace/plugins/0',
      });

      expect(result.classification).toBe('invalid');
      expect(result.plugin).toBeUndefined();
      expect(result.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: 'SKILL_AGENT_PROFILE_INVALID',
          pointer: 'skills/release-notes/agents/openai.yaml',
        }),
      ]));
    },
  );

  it('marks a broken Skill Agent Profile symlink Invalid', () => {
    const root = pluginRoot();
    const agents = join(root, 'skills', 'release-notes', 'agents');
    mkdirSync(agents, { recursive: true });
    symlinkSync('missing.yaml', join(agents, 'openai.yaml'));

    const result = classifyPlugin(root, {
      marketplaceId: 'reg-1/acme-marketplace', marketplaceEntryId: 'reg-1/acme-marketplace/plugins/0',
    });

    expect(result.classification).toBe('invalid');
    expect(result.plugin).toBeUndefined();
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'SKILL_AGENT_PROFILE_INVALID' }),
    ]));
  });

  it('warns COMP-W02 when an Agent Profile declares an Invocation Policy Pi cannot enforce', () => {
    const root = pluginRoot();
    mkdirSync(join(root, 'skills', 'release-notes', 'agents'), { recursive: true });
    writeFileSync(
      join(root, 'skills', 'release-notes', 'agents', 'openai.yaml'),
      'policy:\n  allow_implicit_invocation: false\n',
    );

    const result = classifyPlugin(root, {
      marketplaceId: 'reg-1/acme-marketplace', marketplaceEntryId: 'reg-1/acme-marketplace/plugins/0',
    });

    // Non-blocking: Registration survives with the advisory warning while the projected
    // Invocation Policy stays `explicit` for Activation Disclosure.
    expect(result.classification).toBe('compatible');
    expect(result.plugin!.skills[0]!.invocationPolicy).toBe('explicit');
    expect(result.findings).toEqual([
      expect.objectContaining({
        code: 'UNENFORCEABLE_INVOCATION_POLICY',
        rule: 'COMP-W02',
        classification: 'warning',
        target: 'skill',
        phase: 'validation',
        pointer: 'skills/release-notes/agents/openai.yaml#/policy/allow_implicit_invocation',
      }),
    ]);
    expect(result.findings[0]!.outcome).toContain('disable-model-invocation');
  });

  it('does not warn COMP-W02 when the Skill Descriptor enforces the explicit policy itself', () => {
    const root = pluginRoot();
    writeFileSync(
      join(root, 'skills', 'release-notes', 'SKILL.md'),
      '---\nname: release-notes\ndescription: Draft release notes\ndisable-model-invocation: true\n---\n\nWrite concise release notes.\n',
    );
    mkdirSync(join(root, 'skills', 'release-notes', 'agents'), { recursive: true });
    writeFileSync(
      join(root, 'skills', 'release-notes', 'agents', 'openai.yaml'),
      'policy:\n  allow_implicit_invocation: false\n',
    );

    const result = classifyPlugin(root, {
      marketplaceId: 'reg-1/acme-marketplace', marketplaceEntryId: 'reg-1/acme-marketplace/plugins/0',
    });

    expect(result.classification).toBe('compatible');
    expect(result.plugin!.skills[0]!.invocationPolicy).toBe('explicit');
    expect(result.findings).toEqual([]);
  });

  it('does not warn COMP-W02 for implicit or absent Invocation Policy declarations', () => {
    const root = pluginRoot();
    const agents = join(root, 'skills', 'release-notes', 'agents');
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, 'openai.yaml'), 'policy:\n  allow_implicit_invocation: true\n');

    const implicit = classifyPlugin(root, {
      marketplaceId: 'reg-1/acme-marketplace', marketplaceEntryId: 'reg-1/acme-marketplace/plugins/0',
    });

    expect(implicit.classification).toBe('compatible');
    expect(implicit.findings).toEqual([]);

    writeFileSync(join(agents, 'openai.yaml'), 'interface:\n  display_name: Release notes\n');
    const absentPolicy = classifyPlugin(root, {
      marketplaceId: 'reg-1/acme-marketplace', marketplaceEntryId: 'reg-1/acme-marketplace/plugins/0',
    });

    expect(absentPolicy.classification).toBe('compatible');
    expect(absentPolicy.findings).toEqual([]);
  });
});

describe('Compatibility Profile v2 — Claude format', () => {
  it('classifies a mattpocock-shaped Claude plugin tree as Compatible with complete nested skill list', () => {
    const root = claudePluginRoot(
      [
        { name: 'code-review', path: './skills/code-review', desc: 'Review code changes', disableModelInvocation: true },
        { name: 'codebase-design', path: './skills/nested/category/codebase-design', desc: 'Design deep modules' },
        { name: 'diagnosing-bugs', path: './skills/diagnostics/diagnosing-bugs', desc: 'Diagnose hard bugs' },
        { name: 'domain-modeling', path: './skills/domain-modeling', desc: 'Build domain model' },
        { name: 'grilling', path: './skills/interview/grilling', desc: 'Grill user on plan' },
        {
          name: 'implement',
          path: './skills/implement',
          desc: 'Implement work from tickets',
          hasOpenAiYaml: true,
          openAiYamlContent: 'policy:\n  allow_implicit_invocation: false\ninterface:\n  display_name: Implement\n',
        },
      ],
      {
        name: 'mattpocock-skills',
        version: '1.0.0',
        description: 'Matt Pocock skill collection',
        author: 'Matt Pocock',
        displayName: 'Matt Pocock Skills',
      },
    );

    const result = classifyPlugin(root, {
      marketplaceId: 'reg-1/matt-marketplace',
      marketplaceEntryId: 'reg-1/matt-marketplace/plugins/0',
    });

    expect(result.classification).toBe('compatible');
    expect(result.plugin).toBeDefined();
    expect(result.plugin!.id).toBe('reg-1/matt-marketplace/mattpocock-skills');
    expect(result.plugin!.manifestName).toBe('mattpocock-skills');
    expect(result.plugin!.skills).toHaveLength(6);

    const skillNames = result.plugin!.skills.map((s) => s.name);
    expect(skillNames).toEqual([
      'code-review',
      'codebase-design',
      'diagnosing-bugs',
      'domain-modeling',
      'grilling',
      'implement',
    ]);

    // Invocation policy derived from frontmatter
    const codeReview = result.plugin!.skills.find((s) => s.name === 'code-review')!;
    expect(codeReview.invocationPolicy).toBe('explicit');

    const codebaseDesign = result.plugin!.skills.find((s) => s.name === 'codebase-design')!;
    expect(codebaseDesign.invocationPolicy).toBe('implicit');

    // In Claude format, openai.yaml is treated as an opaque Skill Resource and does NOT affect policy
    const implementSkill = result.plugin!.skills.find((s) => s.name === 'implement')!;
    expect(implementSkill.invocationPolicy).toBe('implicit'); // frontmatter had no disable-model-invocation
    expect(implementSkill.resources).toContain('agents/openai.yaml');

    // Inert metadata fields produce non-blocking warnings and do not alter classification
    expect(result.findings.every((f) => f.classification === 'warning')).toBe(true);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'INERT_METADATA_IGNORED', pointer: '.claude-plugin/plugin.json#/author' }),
      expect.objectContaining({ code: 'INERT_METADATA_IGNORED', pointer: '.claude-plugin/plugin.json#/description' }),
      expect.objectContaining({ code: 'INERT_METADATA_IGNORED', pointer: '.claude-plugin/plugin.json#/displayName' }),
      expect.objectContaining({ code: 'INERT_METADATA_IGNORED', pointer: '.claude-plugin/plugin.json#/version' }),
    ]));
  });

  it('marks a Claude plugin without manifest Invalid', () => {
    const root = mkdtempSync(join(tmpdir(), 'no-manifest-'));
    roots.push(root);
    mkdirSync(join(root, 'skills', 'foo'), { recursive: true });
    writeFileSync(join(root, 'skills', 'foo', 'SKILL.md'), '---\nname: foo\ndescription: Foo\n---\n\nBody\n');

    const result = classifyPlugin(root, {
      marketplaceId: 'reg-1/marketplace',
      marketplaceEntryId: 'reg-1/marketplace/plugins/0',
      format: 'claude',
    });

    expect(result.classification).toBe('invalid');
    expect(result.plugin).toBeUndefined();
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'PLUGIN_MANIFEST_INVALID', pointer: '.claude-plugin/plugin.json' }),
    ]));
  });

  it.each([
    ['MyPlugin', 'camelCase'],
    ['my_plugin', 'snake_case'],
    ['my.plugin', 'dot-separated'],
    ['', 'empty string'],
    ['my--plugin', 'consecutive hyphens'],
    ['-my-plugin', 'leading hyphen'],
    ['my-plugin-', 'trailing hyphen'],
  ])('marks non-kebab manifest name %s (%s) Invalid', (name) => {
    const root = claudePluginRoot([{ name: 'test-skill', path: './skills/test' }], { name });
    const result = classifyPlugin(root, {
      marketplaceId: 'reg-1/marketplace',
      marketplaceEntryId: 'reg-1/marketplace/plugins/0',
    });
    expect(result.classification).toBe('invalid');
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'PLUGIN_MANIFEST_INVALID' }),
    ]));
  });

  it('marks non-array skills declaration in Claude manifest Invalid', () => {
    const root = claudePluginRoot([], { name: 'valid-name', skills: './skills/' });
    const result = classifyPlugin(root, {
      marketplaceId: 'reg-1/marketplace',
      marketplaceEntryId: 'reg-1/marketplace/plugins/0',
    });
    expect(result.classification).toBe('invalid');
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'PLUGIN_MANIFEST_INVALID', pointer: '.claude-plugin/plugin.json#/skills' }),
    ]));
  });

  it('marks empty skills array in Claude manifest Invalid', () => {
    const root = claudePluginRoot([], { name: 'valid-name', skills: [] });
    const result = classifyPlugin(root, {
      marketplaceId: 'reg-1/marketplace',
      marketplaceEntryId: 'reg-1/marketplace/plugins/0',
    });
    expect(result.classification).toBe('invalid');
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'SKILL_DESCRIPTOR_INVALID' }),
    ]));
  });

  it('marks skills array pointing to non-existent directory Invalid', () => {
    const root = claudePluginRoot([], { name: 'valid-name', skills: ['./skills/does-not-exist'] });
    const result = classifyPlugin(root, {
      marketplaceId: 'reg-1/marketplace',
      marketplaceEntryId: 'reg-1/marketplace/plugins/0',
    });
    expect(result.classification).toBe('invalid');
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'SKILL_DESCRIPTOR_INVALID', pointer: './skills/does-not-exist' }),
    ]));
  });

  it('marks skills array pointing to directory without SKILL.md Invalid', () => {
    const root = claudePluginRoot([], { name: 'valid-name', skills: ['./skills/no-skill-md'] });
    mkdirSync(join(root, 'skills', 'no-skill-md'), { recursive: true });
    writeFileSync(join(root, 'skills', 'no-skill-md', 'README.md'), 'not a skill');

    const result = classifyPlugin(root, {
      marketplaceId: 'reg-1/marketplace',
      marketplaceEntryId: 'reg-1/marketplace/plugins/0',
    });
    expect(result.classification).toBe('invalid');
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'SKILL_DESCRIPTOR_INVALID' }),
    ]));
  });

  it('marks duplicate skill names across different skill paths Invalid', () => {
    const root = claudePluginRoot([
      { name: 'duplicate-skill', path: './skills/cat-a/duplicate-skill', desc: 'First' },
      { name: 'duplicate-skill', path: './skills/cat-b/duplicate-skill', desc: 'Second' },
    ]);
    const result = classifyPlugin(root, {
      marketplaceId: 'reg-1/marketplace',
      marketplaceEntryId: 'reg-1/marketplace/plugins/0',
    });
    expect(result.classification).toBe('invalid');
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'SKILL_DESCRIPTOR_INVALID',
        pointer: 'reg-1/marketplace/release-helper/duplicate-skill',
      }),
    ]));
  });

  it('marks unknown manifest fields and active components Incompatible with Blocking findings', () => {
    const root = claudePluginRoot(
      [{ name: 'valid-skill', path: './skills/valid-skill' }],
      {
        commands: ['./commands/run.sh'],
        mcpServers: { myServer: { command: 'node' } },
        lspServers: { myLsp: { command: 'lsp' } },
        agents: ['./agents/agent.json'],
        hooks: ['./hooks/pre-commit'],
        unknownField: 'unexpected',
      },
    );

    const result = classifyPlugin(root, {
      marketplaceId: 'reg-1/marketplace',
      marketplaceEntryId: 'reg-1/marketplace/plugins/0',
    });

    expect(result.classification).toBe('incompatible');
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'UNSUPPORTED_ACTIVE_COMPONENT', pointer: '.claude-plugin/plugin.json#/commands', classification: 'blocking' }),
      expect.objectContaining({ code: 'UNSUPPORTED_ACTIVE_COMPONENT', pointer: '.claude-plugin/plugin.json#/mcpServers', classification: 'blocking' }),
      expect.objectContaining({ code: 'UNSUPPORTED_ACTIVE_COMPONENT', pointer: '.claude-plugin/plugin.json#/lspServers', classification: 'blocking' }),
      expect.objectContaining({ code: 'UNSUPPORTED_ACTIVE_COMPONENT', pointer: '.claude-plugin/plugin.json#/agents', classification: 'blocking' }),
      expect.objectContaining({ code: 'UNSUPPORTED_ACTIVE_COMPONENT', pointer: '.claude-plugin/plugin.json#/hooks', classification: 'blocking' }),
      expect.objectContaining({ code: 'UNSUPPORTED_ACTIVE_COMPONENT', pointer: '.claude-plugin/plugin.json#/unknownField', classification: 'blocking' }),
    ]));
  });

  it('marks unknown frontmatter fields Incompatible with Blocking findings', () => {
    const root = claudePluginRoot([
      {
        name: 'test-skill',
        path: './skills/test-skill',
        frontmatterExtra: 'author: Someone\nversion: 2.0.0\ncustom-active-key: true\n',
      },
    ]);

    const result = classifyPlugin(root, {
      marketplaceId: 'reg-1/marketplace',
      marketplaceEntryId: 'reg-1/marketplace/plugins/0',
    });

    expect(result.classification).toBe('incompatible');
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'UNSUPPORTED_ACTIVE_COMPONENT', pointer: 'skills/test-skill/SKILL.md#/author' }),
      expect.objectContaining({ code: 'UNSUPPORTED_ACTIVE_COMPONENT', pointer: 'skills/test-skill/SKILL.md#/version' }),
      expect.objectContaining({ code: 'UNSUPPORTED_ACTIVE_COMPONENT', pointer: 'skills/test-skill/SKILL.md#/custom-active-key' }),
    ]));
  });

  it('marks non-boolean disable-model-invocation Invalid', () => {
    const root = claudePluginRoot([
      {
        name: 'test-skill',
        path: './skills/test-skill',
        frontmatterExtra: 'disable-model-invocation: "true"\n',
      },
    ]);

    const result = classifyPlugin(root, {
      marketplaceId: 'reg-1/marketplace',
      marketplaceEntryId: 'reg-1/marketplace/plugins/0',
    });

    expect(result.classification).toBe('invalid');
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'SKILL_DESCRIPTOR_INVALID',
        pointer: 'skills/test-skill/SKILL.md#/disable-model-invocation',
      }),
    ]));
  });

  it('treats openai.yaml as an opaque Skill Resource in Claude format without evaluating policy or emitting warnings', () => {
    const root = claudePluginRoot([
      {
        name: 'test-skill',
        path: './skills/test-skill',
        hasOpenAiYaml: true,
        openAiYamlContent: 'dependencies:\n  tools: [arbitrary]\npolicy:\n  allow_implicit_invocation: false\ninterface:\n  invalid_field: [1, 2]\n',
      },
    ]);

    const result = classifyPlugin(root, {
      marketplaceId: 'reg-1/marketplace',
      marketplaceEntryId: 'reg-1/marketplace/plugins/0',
    });

    expect(result.classification).toBe('compatible');
    expect(result.plugin!.skills[0]!.invocationPolicy).toBe('implicit');
    expect(result.plugin!.skills[0]!.resources).toContain('agents/openai.yaml');
    expect(result.findings.some((f) => f.code === 'UNENFORCEABLE_INVOCATION_POLICY')).toBe(false);
  });

  it('changes captureFingerprint when opaque resource content in Claude plugin changes', () => {
    const root = claudePluginRoot([
      {
        name: 'test-skill',
        path: './skills/test-skill',
        hasOpenAiYaml: true,
        openAiYamlContent: 'version: 1\n',
      },
    ]);

    const opts = {
      marketplaceId: 'reg-1/marketplace',
      marketplaceEntryId: 'reg-1/marketplace/plugins/0',
    };

    const before = classifyPlugin(root, opts);
    writeFileSync(join(root, 'skills', 'test-skill', 'agents', 'openai.yaml'), 'version: 2\n');
    const after = classifyPlugin(root, opts);

    expect(before.classification).toBe('compatible');
    expect(after.classification).toBe('compatible');
    expect(after.captureFingerprint).not.toBe(before.captureFingerprint);
  });
});

describe('Compatibility Profile v2 — Format Detection and Identity', () => {
  it('prioritizes Codex format when both manifests exist and format option is omitted', () => {
    const root = pluginRoot();
    mkdirSync(join(root, '.claude-plugin'), { recursive: true });
    writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'claude-name', skills: ['./skills/release-notes'] }));

    const result = classifyPlugin(root, {
      marketplaceId: 'reg-1/marketplace',
      marketplaceEntryId: 'reg-1/marketplace/plugins/0',
    });

    expect(result.classification).toBe('compatible');
    expect(result.plugin!.manifestName).toBe('release-helper');
  });

  it('honours explicit format option even when another manifest exists', () => {
    const root = pluginRoot();
    mkdirSync(join(root, '.claude-plugin'), { recursive: true });
    writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'claude-name', skills: ['./skills/release-notes'] }));

    const result = classifyPlugin(root, {
      marketplaceId: 'reg-1/marketplace',
      marketplaceEntryId: 'reg-1/marketplace/plugins/0',
      format: 'claude',
    });

    expect(result.classification).toBe('compatible');
    expect(result.plugin!.manifestName).toBe('claude-name');
  });

  it('pluginIdentity resolves authoritative identity for both formats', () => {
    const codexRoot = pluginRoot();
    const claudeRoot = claudePluginRoot([], { name: 'claude-plugin' });

    expect(pluginIdentity(codexRoot, 'reg-1')).toBe('reg-1/release-helper');
    expect(pluginIdentity(claudeRoot, 'reg-1')).toBe('reg-1/claude-plugin');
  });
});

describe('Compatibility Profile v2 — Table-driven Rule Matrix', () => {
  describe('Manifest name validity matrix', () => {
    it.each([
      ['valid-kebab', true],
      ['plugin123', true],
      ['a', true],
      ['foo-bar-baz-qux', true],
      ['123-456', true],
      ['InvalidCamel', false],
      ['invalid_snake', false],
      ['invalid.dot', false],
      ['', false],
      ['-leading-hyphen', false],
      ['trailing-hyphen-', false],
      ['double--hyphen', false],
      ['with space', false],
    ])('evaluates manifest name "%s" as valid=%s', (name, isValid) => {
      const root = claudePluginRoot([{ name: 'my-skill', path: './skills/my-skill' }], { name });
      const result = classifyPlugin(root, {
        marketplaceId: 'reg-1/test-marketplace',
        marketplaceEntryId: 'reg-1/test-marketplace/plugins/0',
      });
      if (isValid) {
        expect(result.classification).toBe('compatible');
        expect(result.plugin!.manifestName).toBe(name);
      } else {
        expect(result.classification).toBe('invalid');
        expect(result.findings).toEqual(expect.arrayContaining([
          expect.objectContaining({ code: 'PLUGIN_MANIFEST_INVALID' }),
        ]));
      }
    });
  });

  describe('Manifest field tripartite classification matrix', () => {
    it.each([
      ['version', '1.0.0', 'warning', 'compatible', 'INERT_METADATA_IGNORED'],
      ['description', 'A description', 'warning', 'compatible', 'INERT_METADATA_IGNORED'],
      ['author', 'Author Name', 'warning', 'compatible', 'INERT_METADATA_IGNORED'],
      ['homepage', 'https://example.com', 'warning', 'compatible', 'INERT_METADATA_IGNORED'],
      ['repository', 'https://github.com/org/repo', 'warning', 'compatible', 'INERT_METADATA_IGNORED'],
      ['license', 'MIT', 'warning', 'compatible', 'INERT_METADATA_IGNORED'],
      ['keywords', ['tag1', 'tag2'], 'warning', 'compatible', 'INERT_METADATA_IGNORED'],
      ['category', 'tools', 'warning', 'compatible', 'INERT_METADATA_IGNORED'],
      ['categories', ['tools'], 'warning', 'compatible', 'INERT_METADATA_IGNORED'],
      ['tags', ['tag1'], 'warning', 'compatible', 'INERT_METADATA_IGNORED'],
      ['displayName', 'Display Name', 'warning', 'compatible', 'INERT_METADATA_IGNORED'],
      ['display_name', 'Display Name', 'warning', 'compatible', 'INERT_METADATA_IGNORED'],
      ['interface', { icon_small: 'icon.png' }, 'warning', 'compatible', 'INERT_METADATA_IGNORED'],
      ['icon', 'icon.png', 'warning', 'compatible', 'INERT_METADATA_IGNORED'],
      ['readme', 'README.md', 'warning', 'compatible', 'INERT_METADATA_IGNORED'],
      ['bugs', 'https://bugs.example.com', 'warning', 'compatible', 'INERT_METADATA_IGNORED'],
      ['funding', 'https://sponsor.example.com', 'warning', 'compatible', 'INERT_METADATA_IGNORED'],
      ['commands', ['./cmd.sh'], 'blocking', 'incompatible', 'UNSUPPORTED_ACTIVE_COMPONENT'],
      ['agents', ['./agent.json'], 'blocking', 'incompatible', 'UNSUPPORTED_ACTIVE_COMPONENT'],
      ['hooks', ['./hook.sh'], 'blocking', 'incompatible', 'UNSUPPORTED_ACTIVE_COMPONENT'],
      ['mcp', ['server'], 'blocking', 'incompatible', 'UNSUPPORTED_ACTIVE_COMPONENT'],
      ['mcpServers', { s1: {} }, 'blocking', 'incompatible', 'UNSUPPORTED_ACTIVE_COMPONENT'],
      ['servers', ['s1'], 'blocking', 'incompatible', 'UNSUPPORTED_ACTIVE_COMPONENT'],
      ['extensions', ['ext1'], 'blocking', 'incompatible', 'UNSUPPORTED_ACTIVE_COMPONENT'],
      ['lspServers', { l1: {} }, 'blocking', 'incompatible', 'UNSUPPORTED_ACTIVE_COMPONENT'],
      ['lsp', { l1: {} }, 'blocking', 'incompatible', 'UNSUPPORTED_ACTIVE_COMPONENT'],
      ['tools', ['tool1'], 'blocking', 'incompatible', 'UNSUPPORTED_ACTIVE_COMPONENT'],
      ['apps', ['app1'], 'blocking', 'incompatible', 'UNSUPPORTED_ACTIVE_COMPONENT'],
      ['arbitraryCustomField', 'customValue', 'blocking', 'incompatible', 'UNSUPPORTED_ACTIVE_COMPONENT'],
      ['extraActiveField', 42, 'blocking', 'incompatible', 'UNSUPPORTED_ACTIVE_COMPONENT'],
    ])('classifies manifest field "%s" as finding=%s, outcome=%s, code=%s', (field, value, expectedClass, expectedClassification, expectedCode) => {
      const root = claudePluginRoot([{ name: 'my-skill', path: './skills/my-skill' }], { [field]: value });
      const result = classifyPlugin(root, {
        marketplaceId: 'reg-1/test-marketplace',
        marketplaceEntryId: 'reg-1/test-marketplace/plugins/0',
      });
      expect(result.classification).toBe(expectedClassification);
      expect(result.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: expectedCode,
          classification: expectedClass,
          pointer: `.claude-plugin/plugin.json#/${field}`,
        }),
      ]));
    });
  });

  describe('Skill frontmatter whitelist matrix', () => {
    it.each([
      ['name', 'name: my-skill\ndescription: A valid skill\n', 'compatible', undefined],
      ['description', 'name: my-skill\ndescription: Multi-line\n  description\n', 'compatible', undefined],
      ['disable-model-invocation: true', 'name: my-skill\ndescription: Desc\ndisable-model-invocation: true\n', 'compatible', undefined],
      ['disable-model-invocation: false', 'name: my-skill\ndescription: Desc\ndisable-model-invocation: false\n', 'compatible', undefined],
      ['author (unknown)', 'name: my-skill\ndescription: Desc\nauthor: Someone\n', 'incompatible', 'UNSUPPORTED_ACTIVE_COMPONENT'],
      ['version (unknown)', 'name: my-skill\ndescription: Desc\nversion: 1.0.0\n', 'incompatible', 'UNSUPPORTED_ACTIVE_COMPONENT'],
      ['tags (unknown)', 'name: my-skill\ndescription: Desc\ntags: [a, b]\n', 'incompatible', 'UNSUPPORTED_ACTIVE_COMPONENT'],
      ['license (unknown)', 'name: my-skill\ndescription: Desc\nlicense: MIT\n', 'incompatible', 'UNSUPPORTED_ACTIVE_COMPONENT'],
      ['tools (unknown)', 'name: my-skill\ndescription: Desc\ntools: [git]\n', 'incompatible', 'UNSUPPORTED_ACTIVE_COMPONENT'],
      ['customField (unknown)', 'name: my-skill\ndescription: Desc\ncustomField: value\n', 'incompatible', 'UNSUPPORTED_ACTIVE_COMPONENT'],
    ])('evaluates frontmatter containing %s', (_label, frontmatterContent, expectedClassification, expectedCode) => {
      const root = mkdtempSync(join(tmpdir(), 'fm-matrix-'));
      roots.push(root);
      mkdirSync(join(root, '.claude-plugin'), { recursive: true });
      writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'test-plugin', skills: ['./skills/s1'] }));
      mkdirSync(join(root, 'skills', 's1'), { recursive: true });
      writeFileSync(join(root, 'skills', 's1', 'SKILL.md'), `---\n${frontmatterContent}---\n\nBody content\n`);

      const result = classifyPlugin(root, {
        marketplaceId: 'reg-1/test-marketplace',
        marketplaceEntryId: 'reg-1/test-marketplace/plugins/0',
      });
      expect(result.classification).toBe(expectedClassification);
      if (expectedCode) {
        expect(result.findings).toEqual(expect.arrayContaining([
          expect.objectContaining({ code: expectedCode }),
        ]));
      }
    });
  });

  describe('Skill path containment and resolution matrix', () => {
    it.each([
      ['./skills/s1', true, 'valid immediate path'],
      ['./skills/nested/s1', true, 'valid nested path'],
      ['./skills/deep/nested/category/s1', true, 'valid deeply nested path'],
      ['../escaped', false, 'escapes root via parent'],
      ['./skills/../../escaped', false, 'escapes root via dot-dot'],
      ['/absolute/path', false, 'absolute path'],
      ['skills/s1', false, 'missing ./ prefix'],
      ['./skills/s1\\backslash', false, 'contains backslash'],
    ])('evaluates skill path %s (%s) as valid=%s', (path, isValid) => {
      const root = mkdtempSync(join(tmpdir(), 'path-matrix-'));
      roots.push(root);
      mkdirSync(join(root, '.claude-plugin'), { recursive: true });
      writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'test-plugin', skills: [path] }));

      if (isValid) {
        const dir = join(root, ...path.slice(2).split('/'));
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'SKILL.md'), '---\nname: my-skill\ndescription: Desc\n---\n\nBody\n');
      }

      const result = classifyPlugin(root, {
        marketplaceId: 'reg-1/test-marketplace',
        marketplaceEntryId: 'reg-1/test-marketplace/plugins/0',
      });

      if (isValid) {
        expect(result.classification).toBe('compatible');
      } else {
        expect(result.classification).toBe('invalid');
        expect(result.findings).toEqual(expect.arrayContaining([
          expect.objectContaining({ code: 'SKILL_DESCRIPTOR_INVALID' }),
        ]));
      }
    });
  });
});

