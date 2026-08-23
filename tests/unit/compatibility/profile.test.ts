import { mkdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { classifyPlugin } from '../../../src/compatibility/profile.js';
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

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('Compatibility Profile v1', () => {
  it('classifies a skills-only Codex Plugin atomically as Compatible and keeps Pi-native invocation policy', () => {
    const root = pluginRoot();

    const result = classifyPlugin(root, {
      scope: 'global',
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
      scope: 'global',
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
      scope: 'global',
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
      scope: 'global',
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
      scope: 'global', marketplaceId: 'reg-1/acme-marketplace', marketplaceEntryId: 'reg-1/acme-marketplace/plugins/0',
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
      scope: 'global', marketplaceId: 'reg-1/acme-marketplace', marketplaceEntryId: 'reg-1/acme-marketplace/plugins/0',
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
      scope: 'global', marketplaceId: 'reg-1/acme-marketplace', marketplaceEntryId: 'reg-1/acme-marketplace/plugins/0',
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
      scope: 'global', marketplaceId: 'reg-1/acme-marketplace', marketplaceEntryId: 'reg-1/acme-marketplace/plugins/0',
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
      scope: 'global', marketplaceId: 'reg-1/acme-marketplace', marketplaceEntryId: 'reg-1/acme-marketplace/plugins/0',
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
      scope: 'global', marketplaceId: 'reg-1/acme-marketplace', marketplaceEntryId: 'reg-1/acme-marketplace/plugins/0',
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
      scope: 'global', marketplaceId: 'reg-1/acme-marketplace', marketplaceEntryId: 'reg-1/acme-marketplace/plugins/0',
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
      scope: 'global', marketplaceId: 'reg-1/acme-marketplace', marketplaceEntryId: 'reg-1/acme-marketplace/plugins/0',
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
      scope: 'global', marketplaceId: 'reg-1/acme-marketplace', marketplaceEntryId: 'reg-1/acme-marketplace/plugins/0',
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
      scope: 'global', marketplaceId: 'reg-1/acme-marketplace', marketplaceEntryId: 'reg-1/acme-marketplace/plugins/0',
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
      scope: 'global', marketplaceId: 'reg-1/acme-marketplace', marketplaceEntryId: 'reg-1/acme-marketplace/plugins/0',
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
      scope: 'global', marketplaceId: 'reg-1/acme-marketplace', marketplaceEntryId: 'reg-1/acme-marketplace/plugins/0',
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
      scope: 'global', marketplaceId: 'reg-1/acme-marketplace', marketplaceEntryId: 'reg-1/acme-marketplace/plugins/0',
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
      scope: 'global', marketplaceId: 'reg-1/acme-marketplace', marketplaceEntryId: 'reg-1/acme-marketplace/plugins/0',
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
      scope: 'global', marketplaceId: 'reg-1/acme-marketplace', marketplaceEntryId: 'reg-1/acme-marketplace/plugins/0',
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
      scope: 'global', marketplaceId: 'reg-1/acme-marketplace', marketplaceEntryId: 'reg-1/acme-marketplace/plugins/0',
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
      scope: 'global', marketplaceId: 'reg-1/acme-marketplace', marketplaceEntryId: 'reg-1/acme-marketplace/plugins/0',
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
      scope: 'global', marketplaceId: 'reg-1/acme-marketplace', marketplaceEntryId: 'reg-1/acme-marketplace/plugins/0',
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
      scope: 'global', marketplaceId: 'reg-1/acme-marketplace', marketplaceEntryId: 'reg-1/acme-marketplace/plugins/0',
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
      scope: 'global', marketplaceId: 'reg-1/acme-marketplace', marketplaceEntryId: 'reg-1/acme-marketplace/plugins/0',
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
      scope: 'global', marketplaceId: 'reg-1/acme-marketplace', marketplaceEntryId: 'reg-1/acme-marketplace/plugins/0',
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
      scope: 'global', marketplaceId: 'reg-1/acme-marketplace', marketplaceEntryId: 'reg-1/acme-marketplace/plugins/0',
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
        scope: 'global', marketplaceId: 'reg-1/acme-marketplace', marketplaceEntryId: 'reg-1/acme-marketplace/plugins/0',
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
      scope: 'global', marketplaceId: 'reg-1/acme-marketplace', marketplaceEntryId: 'reg-1/acme-marketplace/plugins/0',
    });

    expect(result.classification).toBe('invalid');
    expect(result.plugin).toBeUndefined();
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'SKILL_AGENT_PROFILE_INVALID' }),
    ]));
  });
});
