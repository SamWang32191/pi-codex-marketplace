import { describe, it, expect } from 'vitest';

import { parseClaudeCatalog } from '../../../src/registration/claude-catalog.js';
import { parseCatalog } from '../../../src/registration/catalog.js';

/** Stable Unavailable Entry reasons asserted across the source-form matrix. */
const REASON = {
  bareName: 'bare name source cannot resolve without metadata.pluginRoot, which is unsupported',
  pluginRoot: 'pluginRoot-dependent source resolution is unsupported',
  notLocalPath: 'source must start with ./ to be locally resolvable',
  noSource: 'no source declared',
  unrecognizedForm: 'unrecognized source form',
  unknownKind: 'unknown entry source kind',
  gitFamily: 'external git-family entry sources (github/url/git-subdir) are not supported yet',
  npm: 'npm source entries are not supported',
  archive: 'archive source entries are not supported',
  command: 'command source entries are permanently disqualified',
  strictFalse: 'entry-defined plugin (strict: false) is not supported',
  malformedEntry: 'malformed entry',
} as const;

function validCatalog(overrides: {
  plugins?: unknown[];
  extraTopLevel?: Record<string, unknown>;
} = {}): Record<string, unknown> {
  return {
    name: 'acme-claude',
    owner: { name: 'Acme Team' },
    plugins: overrides.plugins ?? [{ name: 'alpha', source: './plugins/alpha' }],
    ...overrides.extraTopLevel,
  };
}

describe('Claude Marketplace Catalog parsing', () => {
  it('parses a valid claude catalog with snapshot-scoped Entry IDs matching the codex rule', () => {
    const res = parseClaudeCatalog(
      validCatalog({
        plugins: [
          { name: 'alpha', source: './plugins/alpha' },
          { name: 'beta', source: './skills-suite/beta' },
        ],
      }),
    );
    expect(res.ok).toBe(true);
    expect(res.catalog!.name).toBe('acme-claude');
    expect(res.catalog!.entries).toHaveLength(2);
    // Entry ID rule identical to the codex side: canonical JSON Pointer /plugins/<ordinal>
    expect(res.catalog!.entries[0].entryId).toBe('/plugins/0');
    expect(res.catalog!.entries[1].entryId).toBe('/plugins/1');
    expect(res.catalog!.entries[0]).toMatchObject({
      ordinal: 0,
      name: 'alpha',
      type: 'local',
      path: './plugins/alpha',
      available: true,
    });
    expect(res.findings).toEqual([]);
  });

  it('assigns Entry IDs by ordinal even when names are missing or duplicated (codex parity)', () => {
    const res = parseClaudeCatalog(
      validCatalog({ plugins: [{ source: './a' }, {}, { source: './c' }, {}] }),
    );
    expect(res.catalog!.entries.map((e) => e.entryId)).toEqual([
      '/plugins/0',
      '/plugins/1',
      '/plugins/2',
      '/plugins/3',
    ]);
  });

  it('produces the same ordinal-based Entry IDs as the codex parser for an equivalent array', () => {
    const plugins = [
      { name: 'one', source: './one' },
      { name: 'two', path: './two' },
      'malformed',
      { name: 'four', source: './four' },
    ];
    const codex = parseCatalog({ name: 'parity', plugins });
    const claude = parseClaudeCatalog({ name: 'parity', owner: { name: 'x' }, plugins });
    expect(claude.catalog!.entries.map((e) => e.entryId)).toEqual(
      codex.catalog!.entries.map((e) => e.entryId),
    );
    expect(claude.findings.some((f) => f.code === 'CATALOG_ENTRY_MALFORMED')).toBe(true);
    expect(codex.findings.some((f) => f.code === 'CATALOG_ENTRY_MALFORMED')).toBe(true);
  });
});

describe('Claude catalog required fields fail closed (Blocking)', () => {
  const cases: Array<{ label: string; catalog: unknown; code: string; pointer: string }> = [
    { label: 'non-object catalog', catalog: [1], code: 'CATALOG_MALFORMED', pointer: '/' },
    { label: 'missing name', catalog: { owner: { name: 'o' }, plugins: [] }, code: 'CATALOG_NAME_INVALID', pointer: '/name' },
    { label: 'non-kebab-case name', catalog: validCatalog({ extraTopLevel: {} }), code: 'CATALOG_NAME_INVALID', pointer: '/name' },
    { label: 'missing owner', catalog: { name: 'ok-name', plugins: [] }, code: 'CATALOG_OWNER_INVALID', pointer: '/owner' },
    { label: 'non-object owner', catalog: { name: 'ok-name', owner: 'Acme', plugins: [] }, code: 'CATALOG_OWNER_INVALID', pointer: '/owner' },
    { label: 'owner without name member', catalog: { name: 'ok-name', owner: { email: 'a@b.c' }, plugins: [] }, code: 'CATALOG_OWNER_INVALID', pointer: '/owner/name' },
    { label: 'owner with empty name', catalog: { name: 'ok-name', owner: { name: '  ' }, plugins: [] }, code: 'CATALOG_OWNER_INVALID', pointer: '/owner/name' },
    { label: 'missing plugins', catalog: { name: 'ok-name', owner: { name: 'o' } }, code: 'CATALOG_MALFORMED', pointer: '/plugins' },
    { label: 'plugins not an array', catalog: { name: 'ok-name', owner: { name: 'o' }, plugins: {} }, code: 'CATALOG_MALFORMED', pointer: '/plugins' },
  ];

  for (const c of cases) {
    it(`blocks: ${c.label}`, () => {
      const input = c.label === 'non-kebab-case name'
        ? { ...validCatalog(), name: 'My Marketplace' }
        : c.catalog;
      const res = parseClaudeCatalog(input);
      expect(res.ok).toBe(false);
      expect(res.findings.some((f) => f.classification === 'blocking' && f.code === c.code && f.pointer === c.pointer)).toBe(true);
    });
  }
});

describe('Unknown catalog fields are fail-closed Blocking', () => {
  it('blocks unknown top-level fields (including documented-but-unreviewed lifecycle features)', () => {
    for (const field of ['renames', 'allowCrossMarketplaceDependenciesOn', 'totally-unknown']) {
      const res = parseClaudeCatalog(validCatalog({ extraTopLevel: { [field]: {} } }));
      expect(res.ok).toBe(false);
      expect(res.findings).toEqual([
        expect.objectContaining({
          code: 'CATALOG_UNKNOWN_FIELD',
          classification: 'blocking',
          phase: 'validation',
          target: 'catalog',
          pointer: `/${field}`,
          rule: 'CAT-05',
        }),
      ]);
    }
  });

  it('blocks unknown members inside the structural metadata object', () => {
    const res = parseClaudeCatalog(
      validCatalog({ extraTopLevel: { metadata: { pluginRoot: './plugins', rogue: true } } }),
    );
    expect(res.ok).toBe(false);
    expect(res.findings).toEqual([
      expect.objectContaining({
        code: 'CATALOG_UNKNOWN_FIELD',
        classification: 'blocking',
        pointer: '/metadata/rogue',
      }),
    ]);
  });

  it('blocks unknown members inside the owner object', () => {
    const res = parseClaudeCatalog({
      name: 'acme-claude',
      owner: { name: 'Acme', sponsorLink: 'https://example.test' },
      plugins: [],
    });
    expect(res.ok).toBe(false);
    expect(res.findings).toEqual([
      expect.objectContaining({
        code: 'CATALOG_UNKNOWN_FIELD',
        classification: 'blocking',
        pointer: '/owner/sponsorLink',
      }),
    ]);
  });

  it('blocks unknown entry-level fields', () => {
    const res = parseClaudeCatalog(
      validCatalog({ plugins: [{ name: 'alpha', source: './a', defaultBranch: 'main' }] }),
    );
    expect(res.ok).toBe(false);
    expect(res.findings).toEqual([
      expect.objectContaining({
        code: 'CATALOG_UNKNOWN_FIELD',
        classification: 'blocking',
        target: 'entry',
        pointer: '/plugins/0/defaultBranch',
      }),
    ]);
  });
});

describe('Known Inert Metadata produces Validation Warnings only', () => {
  it('warns on inert top-level presentation fields and stays non-blocking', () => {
    const res = parseClaudeCatalog(
      validCatalog({
        extraTopLevel: {
          $schema: 'https://example.test/schema.json',
          description: 'demo',
          version: '1.0.0',
        },
      }),
    );
    expect(res.ok).toBe(true);
    expect(res.findings.map((f) => f.code)).toEqual(['INERT_METADATA_IGNORED', 'INERT_METADATA_IGNORED', 'INERT_METADATA_IGNORED']);
    expect(res.findings.every((f) => f.classification === 'warning')).toBe(true);
  });

  it('warns on inert entry fields (including free-form entry metadata) and stays non-blocking', () => {
    const res = parseClaudeCatalog(
      validCatalog({
        plugins: [
          {
            name: 'alpha',
            source: './a',
            displayName: 'Alpha!',
            description: 'd',
            version: '1.0.0',
            author: { name: 'A' },
            homepage: 'https://example.test',
            repository: 'https://example.test/r',
            license: 'MIT',
            keywords: ['x'],
            category: 'dev',
            tags: ['y'],
            relevance: {},
            metadata: { anything: 'goes', freeForm: 42 },
          },
        ],
      }),
    );
    expect(res.ok).toBe(true);
    expect(res.findings.length).toBeGreaterThan(0);
    expect(res.findings.every((f) => f.code === 'INERT_METADATA_IGNORED' && f.classification === 'warning')).toBe(true);
    expect(res.catalog!.entries[0].available).toBe(true);
  });

  it('does not warn when a claude catalog carries only required fields', () => {
    const res = parseClaudeCatalog(validCatalog());
    expect(res.ok).toBe(true);
    expect(res.findings).toEqual([]);
  });
});

describe('Entry active-component declarations are Unsupported Blocking Findings', () => {
  const components = ['commands', 'agents', 'hooks', 'mcpServers', 'lspServers', 'skills', 'headers', 'headersHelper', 'defaultEnabled'];

  for (const component of components) {
    it(`blocks entry component '${component}'`, () => {
      const res = parseClaudeCatalog(
        validCatalog({ plugins: [{ name: 'alpha', source: './a', [component]: ['./x'] }] }),
      );
      expect(res.ok).toBe(false);
      expect(res.findings).toEqual([
        expect.objectContaining({
          code: 'UNSUPPORTED_ACTIVE_COMPONENT',
          classification: 'blocking',
          target: 'entry',
          pointer: `/plugins/0/${component}`,
          rule: 'COMP-03',
        }),
      ]);
    });
  }
});

describe('Entry source-form dispatch marks non-local forms as Unavailable Entries', () => {
  const matrix: Array<{
    label: string;
    plugin: Record<string, unknown>;
    expected: { type: 'local' | 'git' | 'unsupported'; available: boolean; reason?: string };
  }> = [
    {
      label: './ relative path is locally resolvable',
      plugin: { name: 'local', source: './plugins/local' },
      expected: { type: 'local', available: true },
    },
    {
      label: 'github object is Unavailable (phase 2 acquisition)',
      plugin: { name: 'gh', source: { source: 'github', repo: 'owner/repo' } },
      expected: { type: 'git', available: false, reason: REASON.gitFamily },
    },
    {
      label: 'url object is Unavailable (phase 2 acquisition)',
      plugin: { name: 'url', source: { source: 'url', url: 'https://example.test/r.git' } },
      expected: { type: 'git', available: false, reason: REASON.gitFamily },
    },
    {
      label: 'git-subdir object is Unavailable (phase 2 acquisition)',
      plugin: { name: 'sub', source: { source: 'git-subdir', url: 'https://example.test/r.git', path: 'pkg' } },
      expected: { type: 'git', available: false, reason: REASON.gitFamily },
    },
    {
      label: 'npm object is Unavailable',
      plugin: { name: 'npm-one', source: { source: 'npm', package: '@scope/pkg' } },
      expected: { type: 'unsupported', available: false, reason: REASON.npm },
    },
    {
      label: 'archive object is Unavailable',
      plugin: { name: 'arch', source: { source: 'archive', url: 'https://example.test/a.zip' } },
      expected: { type: 'unsupported', available: false, reason: REASON.archive },
    },
    {
      label: 'command object is permanently disqualified',
      plugin: { name: 'cmd', source: { source: 'command', command: 'make plugin' } },
      expected: { type: 'unsupported', available: false, reason: REASON.command },
    },
    {
      label: 'object with unknown source discriminator is Unavailable',
      plugin: { name: 'weird', source: { source: 'carrier-pigeon' } },
      expected: { type: 'unsupported', available: false, reason: REASON.unknownKind },
    },
    {
      label: 'object without source discriminator is Unavailable',
      plugin: { name: 'nodisc', source: { repo: 'owner/repo' } },
      expected: { type: 'unsupported', available: false, reason: REASON.unknownKind },
    },
    {
      label: 'bare name without pluginRoot is Unavailable',
      plugin: { name: 'bare', source: 'formatter' },
      expected: { type: 'unsupported', available: false, reason: REASON.bareName },
    },
    {
      label: 'bare name with declared pluginRoot is Unavailable',
      plugin: { name: 'bare-rooted', source: 'formatter' },
      expected: { type: 'unsupported', available: false, reason: REASON.pluginRoot },
    },
    {
      label: 'slash-bearing string without ./ prefix is Unavailable',
      plugin: { name: 'slashed', source: 'team-a/formatter' },
      expected: { type: 'unsupported', available: false, reason: REASON.notLocalPath },
    },
    {
      label: 'parent-escaping string is Unavailable before any filesystem touch',
      plugin: { name: 'escape', source: '../outside' },
      expected: { type: 'unsupported', available: false, reason: REASON.notLocalPath },
    },
    {
      label: 'empty source string behaves as missing source',
      plugin: { name: 'empty', source: '' },
      expected: { type: 'unsupported', available: false, reason: REASON.noSource },
    },
    {
      label: 'missing source is Unavailable, not Blocking',
      plugin: { name: 'nosource' },
      expected: { type: 'unsupported', available: false, reason: REASON.noSource },
    },
    {
      label: 'non-string non-object source is Unavailable',
      plugin: { name: 'numeric', source: 42 },
      expected: { type: 'unsupported', available: false, reason: REASON.unrecognizedForm },
    },
  ];

  for (const c of matrix) {
    it(`dispatches: ${c.label}`, () => {
      const topLevel = c.expected.reason === REASON.pluginRoot
        ? { metadata: { pluginRoot: './plugins' } }
        : undefined;
      const res = parseClaudeCatalog(
        validCatalog({ plugins: [c.plugin], ...(topLevel ? { extraTopLevel: topLevel } : {}) }),
      );
      // Source-shape unavailability is disclosed, never a finding.
      expect(res.ok).toBe(true);
      expect(res.findings.filter((f) => f.classification !== 'warning')).toEqual([]);
      const entry = res.catalog!.entries[0];
      expect(entry.available).toBe(c.expected.available);
      expect(entry.type).toBe(c.expected.type);
      if (c.expected.reason) expect(entry.unavailableReason).toBe(c.expected.reason);
      else expect(entry.unavailableReason).toBeUndefined();
    });
  }

  it('ignores pluginRoot for ./ sources (claude semantics) while bare names stay Unavailable', () => {
    const res = parseClaudeCatalog(
      validCatalog({
        plugins: [
          { name: 'direct', source: './plugins/direct' },
          { name: 'rooted', source: 'direct' },
        ],
        extraTopLevel: { metadata: { pluginRoot: './plugins' } },
      }),
    );
    expect(res.ok).toBe(true);
    expect(res.catalog!.entries[0]).toMatchObject({ available: true, type: 'local', path: './plugins/direct' });
    expect(res.catalog!.entries[1]).toMatchObject({ available: false, unavailableReason: REASON.pluginRoot });
  });
});

describe('strict:false entry-defined plugins are Unavailable', () => {
  it('marks strict:false local entries Unavailable with the stable reason', () => {
    const res = parseClaudeCatalog(
      validCatalog({
        plugins: [
          { name: 'defined-here', source: './p', strict: false },
          { name: 'manifest-backed', source: './q', strict: true },
          { name: 'default-strict', source: './r' },
        ],
      }),
    );
    expect(res.ok).toBe(true);
    expect(res.catalog!.entries[0]).toMatchObject({ available: false, unavailableReason: REASON.strictFalse });
    expect(res.catalog!.entries[1].available).toBe(true);
    expect(res.catalog!.entries[2].available).toBe(true);
  });

  it('keeps the more fundamental source reason when a remote-source entry also declares strict:false', () => {
    const res = parseClaudeCatalog(
      validCatalog({
        plugins: [{ name: 'remote-defined', source: { source: 'npm', package: 'x' }, strict: false }],
      }),
    );
    expect(res.ok).toBe(true);
    expect(res.catalog!.entries[0]).toMatchObject({ available: false, unavailableReason: REASON.npm });
  });
});

describe('Structural boundaries stay consistent with the codex parser', () => {
  it('flags non-object entries as Blocking at the entry boundary while preserving Entry IDs', () => {
    const res = parseClaudeCatalog(validCatalog({ plugins: [{ source: './a' }, 'garbage'] }));
    expect(res.ok).toBe(false);
    expect(res.findings).toEqual([
      expect.objectContaining({
        code: 'CATALOG_ENTRY_MALFORMED',
        classification: 'blocking',
        target: 'entry',
        pointer: '/plugins/1',
        rule: 'CAT-04',
      }),
    ]);
    expect(res.catalog!.entries[1]).toMatchObject({ entryId: '/plugins/1', available: false, unavailableReason: REASON.malformedEntry });
  });

  it('enforces the Entry Validation Budget before enumeration', () => {
    const over = parseClaudeCatalog(
      validCatalog({ plugins: Array.from({ length: 1025 }, () => ({ source: './p' })) }),
    );
    expect(over.ok).toBe(false);
    expect(over.catalog).toBeUndefined();
    expect(over.findings).toEqual([expect.objectContaining({ code: 'BUDGET_EXCEEDED', pointer: '/plugins' })]);

    const within = parseClaudeCatalog(
      validCatalog({ plugins: Array.from({ length: 1024 }, () => ({ source: './p' })) }),
    );
    expect(within.ok).toBe(true);
  });

  it('rejects a non-object metadata declaration as malformed', () => {
    const res = parseClaudeCatalog(validCatalog({ extraTopLevel: { metadata: './plugins' } }));
    expect(res.ok).toBe(false);
    expect(res.findings.some((f) => f.code === 'CATALOG_MALFORMED' && f.pointer === '/metadata')).toBe(true);
  });

  it('treats metadata.description/version as known inert backward-compat members', () => {
    const res = parseClaudeCatalog(
      validCatalog({ extraTopLevel: { metadata: { description: 'd', version: '2.0.0' } } }),
    );
    expect(res.ok).toBe(true);
    expect(res.findings.every((f) => f.code === 'INERT_METADATA_IGNORED')).toBe(true);
  });
});
