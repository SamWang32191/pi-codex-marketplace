import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
});
