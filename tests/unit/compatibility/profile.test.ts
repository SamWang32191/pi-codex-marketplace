import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { classifyPlugin } from '../../../src/compatibility/profile.js';

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
