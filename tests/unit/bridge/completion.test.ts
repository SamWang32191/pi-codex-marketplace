import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { completeArguments } from '../../../src/bridge/completion.js';
import { HELP_TEXT, runCommand } from '../../../src/bridge/command.js';
import type { MinimalBridgeState } from '../../../src/bridge/state.js';
import { getCacheDir, getCacheEntriesDir } from '../../../src/cache/paths.js';

const ROOT_LABELS = ['add', 'list', 'install', 'update', 'disable', 'enable', 'remove', 'forget', 'help'];

/** Parse the command surface's canonical description per subcommand out of HELP_TEXT. */
function helpDescriptions(): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of HELP_TEXT.split('\n')) {
    const match = line.match(/^ {2}([a-z-]+)(?: .*?)?\s{2,}(.+)$/);
    if (match) map.set(match[1], match[2].trim());
  }
  return map;
}

// ---- #122 fixtures: a local marketplace root + a Bridge State pointing at it ----

function writeCodexCatalog(root: string, name: string, entries: unknown[]): void {
  const path = join(root, '.agents', 'plugins', 'marketplace.json');
  mkdirSync(join(root, '.agents', 'plugins'), { recursive: true });
  writeFileSync(path, JSON.stringify({ name, plugins: entries }));
}

interface StateFixture {
  /** Temp dir holding the marketplace material and the state document. */
  root: string;
  /** Directory that must be removed by the caller in finally. */
  cleanup(): void;
  statePath: string;
  agentDir: string;
}

function makeFixture(): StateFixture {
  const root = mkdtempSync(join(tmpdir(), 'bridge-completion-install-'));
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
    statePath: join(root, 'state.json'),
    agentDir: join(root, 'agent'),
  };
}

interface LocalMarketplaceSpec {
  name: string;
  /** registration id used by installations that target this marketplace. */
  id: string;
  /** local root containing the catalog. */
  root: string;
}

/**
 * Write a canonical local marketplace catalog (an entry `local` with `./path`, `github`
 * entries are structurally unavailable #91) and return a state referencing it.
 */
function makeLocalMarketplace(fixture: StateFixture, spec: LocalMarketplaceSpec, entries: unknown[]): void {
  writeCodexCatalog(spec.root, spec.name, entries);
}

function registration(spec: LocalMarketplaceSpec): MinimalBridgeState['registrations'][number] {
  return {
    id: spec.id,
    marketplaceName: spec.name,
    format: 'codex',
    sourceKind: 'local',
    source: spec.root,
  };
}

function writeState(fixture: StateFixture, state: MinimalBridgeState): void {
  writeFileSync(fixture.statePath, JSON.stringify(state, null, 2), 'utf-8');
}

function emptyState(fixture: StateFixture): MinimalBridgeState {
  return { schemaVersion: 1, registrations: [], installations: [] };
}

function registrationsState(fixture: StateFixture, registrations: MinimalBridgeState['registrations']): MinimalBridgeState {
  return { schemaVersion: 1, registrations, installations: [] };
}

describe('Bridge completion seam (#121)', () => {
  it('returns all nine root candidates with descriptions for an empty argument prefix', () => {
    const result = completeArguments('');

    expect(result).not.toBeNull();
    expect(result!.map((item) => item.label)).toEqual(ROOT_LABELS);
    expect(result!.every((item) => typeof item.description === 'string' && item.description.length > 0)).toBe(true);
  });

  it('narrows the list with case-insensitive fuzzy matching', () => {
    const mixedCase = completeArguments('INSTL');
    expect(mixedCase!.map((item) => item.label)).toEqual(['install']);

    const lower = completeArguments('dis');
    expect(lower!.map((item) => item.label)).toEqual(['disable']);
  });

  it('narrows the list with non-contiguous fuzzy matching', () => {
    const result = completeArguments('istl');
    expect(result!.map((item) => item.label)).toEqual(['install']);
  });

  it('keeps a trailing space in the insertion value of argument-taking subcommands', () => {
    const result = completeArguments('add');
    expect(result![0].value).toBe('add ');

    const all = completeArguments('');
    const argTaking = all!.filter((item) => ['add', 'list', 'install', 'disable', 'enable', 'remove', 'forget'].includes(item.label));
    for (const item of argTaking) {
      expect(item.value.endsWith(' ')).toBe(true);
      expect(item.value).toBe(item.label + ' ');
    }
  });

  it('inserts no trailing space for update and help', () => {
    const update = completeArguments('upd');
    expect(update![0].value).toBe('update');

    const help = completeArguments('he');
    expect(help![0].value).toBe('help');
  });

  it('returns an empty list when no subcommand fuzzy-matches', () => {
    expect(completeArguments('zzz')).toEqual([]);
  });

  it('keeps a bare `install` at the root level so the trailing-space candidate can apply first', () => {
    // `install` without a trailing space is first-level syntax (#122): applying it inserts
    // `install ` and the next Tab then composes the second-level candidates.
    const result = completeArguments('install');
    expect(result!.map((item) => item.label)).toEqual(['install']);
    expect(result![0].value).toBe('install ');
  });

  it('returns null when the argument prefix is not Bridge-owned syntax', () => {
    // Non-lifecycle second-level argument text is not Bridge-owned (#121–#123) — the module
    // must not own it, and callers fall through to Pi's own completion. `forget` stays unowned:
    // its registration candidates belong to #124, not the Installation lifecycle (#123).
    expect(completeArguments('list ')).toBeNull();
    expect(completeArguments('add some/path')).toBeNull();
    expect(completeArguments('forget my-market')).toBeNull();
  });

  it('mirrors the command surface description vocabulary without drift', () => {
    const canonical = helpDescriptions();
    expect([...canonical.keys()].sort()).toEqual([...ROOT_LABELS].sort());

    for (const item of completeArguments('')!) {
      expect(canonical.get(item.label)).toBe(item.description);
    }
  });

  it('is passive: composing root candidates never writes or resets a damaged Bridge State document', () => {
    const fixture = makeFixture();
    try {
      const damaged = 'INVALID JSON CONTENT';
      writeFileSync(fixture.statePath, damaged, 'utf-8');

      const result = completeArguments('', { statePath: fixture.statePath });

      expect(result).not.toBeNull();
      // The damaged document must survive untouched — autocomplete is read-only (#119 22–23).
      expect(readFileSync(fixture.statePath, 'utf-8')).toBe(damaged);
    } finally {
      fixture.cleanup();
    }
  });
});

describe('state-aware install completion (#122)', () => {
  it('lists every installable plugin (install and reinstall) for an empty `install ` prefix', () => {
    const fixture = makeFixture();
    try {
      const mktRoot = join(fixture.root, 'mkt-a');
      mkdirSync(mktRoot, { recursive: true });
      const spec: LocalMarketplaceSpec = { name: 'alpha-market', id: 'reg-a', root: mktRoot };
      makeLocalMarketplace(fixture, spec, [
        { name: 'ready', source: { source: 'local', path: './plugins/ready' } },
        { name: 'reinstall-me', source: { source: 'local', path: './plugins/reinstall-me' } },
      ]);
      // An unavailable (github) entry occupies a number but is never a candidate (#91).
      const state: MinimalBridgeState = registrationsState(fixture, [registration(spec)]);
      state.installations.push(
        { id: 'inst-1', pluginId: 'reinstall-me', enabled: true, installationState: 'enabled', registrationId: 'reg-a', manifestName: 'reinstall-me', sourceKind: 'local', source: mktRoot, skills: [] },
      );
      writeState(fixture, state);

      const result = completeArguments('install ', { statePath: fixture.statePath });

      expect(result!.map((item) => item.label)).toEqual(['ready', 'reinstall-me']);
      for (const item of result!) {
        expect(item.value).toBe(`install ${item.label}`);
        expect(item.description).toContain('[alpha-market]');
      }
      expect(result!.some((item) => item.description!.includes('可安裝'))).toBe(true);
      expect(result!.some((item) => item.description!.includes('已裝啟用'))).toBe(true);
      expect(result!.every((item) => item.label !== 'unavailable-entry')).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it('includes installed-disabled plugins so reinstalling them is selectable', () => {
    const fixture = makeFixture();
    try {
      const mktRoot = join(fixture.root, 'mkt-a');
      mkdirSync(mktRoot, { recursive: true });
      const spec: LocalMarketplaceSpec = { name: 'alpha-market', id: 'reg-a', root: mktRoot };
      makeLocalMarketplace(fixture, spec, [
        { name: 'paused', source: { source: 'local', path: './plugins/paused' } },
      ]);
      const state = registrationsState(fixture, [registration(spec)]);
      state.installations.push(
        { id: 'inst-1', pluginId: 'paused', enabled: false, installationState: 'disabled', registrationId: 'reg-a', manifestName: 'paused', sourceKind: 'local', source: mktRoot, skills: [] },
      );
      writeState(fixture, state);

      const result = completeArguments('install ', { statePath: fixture.statePath });

      expect(result!.map((item) => item.label)).toEqual(['paused']);
      expect(result![0].value).toBe('install paused');
      expect(result![0].description).toContain('已裝停用');
    } finally {
      fixture.cleanup();
    }
  });

  it('never offers Unavailable Entries (git / missing-local / invalid) as candidates', () => {
    const fixture = makeFixture();
    try {
      const mktRoot = join(fixture.root, 'mkt-a');
      mkdirSync(mktRoot, { recursive: true });
      const spec: LocalMarketplaceSpec = { name: 'alpha-market', id: 'reg-a', root: mktRoot };
      makeLocalMarketplace(fixture, spec, [
        { name: 'git-plugin', source: { source: 'github', repo: 'acme/git-plugin' } },
        { name: 'no-path', source: { source: 'local' } },
        { name: 'good', source: { source: 'local', path: './plugins/good' } },
      ]);
      writeState(fixture, registrationsState(fixture, [registration(spec)]));

      const result = completeArguments('install ', { statePath: fixture.statePath });

      expect(result!.map((item) => item.label)).toEqual(['good']);
    } finally {
      fixture.cleanup();
    }
  });

  it('inserts the unique name and uses per-marketplace numbers for same-named plugins, matching the full list enumeration', async () => {
    const fixture = makeFixture();
    try {
      const rootA = join(fixture.root, 'mkt-a');
      const rootB = join(fixture.root, 'mkt-b');
      mkdirSync(rootA, { recursive: true });
      mkdirSync(rootB, { recursive: true });
      const specA: LocalMarketplaceSpec = { name: 'alpha-market', id: 'reg-a', root: rootA };
      const specB: LocalMarketplaceSpec = { name: 'beta-market', id: 'reg-b', root: rootB };
      // Full enumeration order: 1=shared(A), 2=unique(A), 3=edge(B, unavailable), 4=shared(B).
      makeLocalMarketplace(fixture, specA, [
        { name: 'shared', source: { source: 'local', path: './plugins/shared-a' } },
        { name: 'unique', source: { source: 'local', path: './plugins/unique-a' } },
      ]);
      makeLocalMarketplace(fixture, specB, [
        { name: 'edge', source: { source: 'github', repo: 'acme/edge' } },
        { name: 'shared', source: { source: 'local', path: './plugins/shared-b' } },
      ]);
      writeState(fixture, registrationsState(fixture, [registration(specA), registration(specB)]));

      const result = completeArguments('install ', { statePath: fixture.statePath })!;

      // Same-named `shared` plugins insert their current enumeration numbers (1 and 4 — the
      // full enumeration counts the unavailable `edge` entry at 3 in between, exactly like
      // `list` and `install <編號>`), each showing its Marketplace provenance and a label that
      // identifies which plugin the number selects.
      const shared = result.filter((item) => item.label === 'shared');
      expect(shared).toHaveLength(0); // numbers are inserted instead of the ambiguous name
      const sharedByValue = result.filter((item) => item.value === 'install 1' || item.value === 'install 4');
      expect(sharedByValue.map((item) => item.label)).toEqual(['shared (#1)', 'shared (#4)']);
      for (const item of sharedByValue) {
        expect(item.description).toMatch(/\[(alpha-market|beta-market)\]/);
      }
      // The unique name keeps the name form; the unavailable edge entry is never a candidate.
      const unique = result.find((item) => item.label === 'unique');
      expect(unique!.value).toBe('install unique');
      expect(result.some((item) => item.label === 'edge')).toBe(false);

      // Cross-check: the insertion numbers are identical to the `list` display numbering.
      const list = await runCommand(['list'], { statePath: fixture.statePath });
      expect(list.output).toMatch(/1\s+shared\s+\[alpha-market\]/);
      expect(list.output).toMatch(/3\s+edge\s+\[beta-market\].*unavailable/);
      expect(list.output).toMatch(/4\s+shared\s+\[beta-market\]/);
    } finally {
      fixture.cleanup();
    }
  });

  it('never inserts a name the command surface could not resolve (canonical integer or whitespace names use the enumeration number)', () => {
    const fixture = makeFixture();
    try {
      const mktRoot = join(fixture.root, 'mkt-a');
      mkdirSync(mktRoot, { recursive: true });
      const spec: LocalMarketplaceSpec = { name: 'alpha-market', id: 'reg-a', root: mktRoot };
      // Names are unique and structurally installable, but the command surface would
      // misparse them when applied as INSERT <name>: "42" is read as enumeration number 42,
      // and "my plugin" is split into two tokens.
      makeLocalMarketplace(fixture, spec, [
        { name: 'fine', source: { source: 'local', path: './plugins/fine' } },
        { name: '42', source: { source: 'local', path: './plugins/forty-two' } },
        { name: 'my plugin', source: { source: 'local', path: './plugins/my-plugin' } },
      ]);
      writeState(fixture, registrationsState(fixture, [registration(spec)]));

      const result = completeArguments('install ', { statePath: fixture.statePath })!;

      // Enumeration order: 1=fine(name-insertable), 2=42, 3=my plugin (both number-form).
      expect(result.map((item) => item.label)).toEqual(['fine', '42 (#2)', 'my plugin (#3)']);
      expect(result[0].value).toBe('install fine');
      const numericName = result.find((item) => item.label === '42 (#2)')!;
      expect(numericName.value).toBe('install 2');
      expect(numericName.description).toContain('[alpha-market]');
      const whitespaceName = result.find((item) => item.label === 'my plugin (#3)')!;
      expect(whitespaceName.value).toBe('install 3');
      expect(result.some((item) => item.value === 'install 42')).toBe(false);
      expect(result.some((item) => item.value === 'install my plugin')).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  it('falls back to the number when a same-named sibling is unavailable (name resolution would be ambiguous)', () => {
    const fixture = makeFixture();
    try {
      const rootA = join(fixture.root, 'mkt-a');
      const rootB = join(fixture.root, 'mkt-b');
      mkdirSync(rootA, { recursive: true });
      mkdirSync(rootB, { recursive: true });
      const specA: LocalMarketplaceSpec = { name: 'alpha-market', id: 'reg-a', root: rootA };
      const specB: LocalMarketplaceSpec = { name: 'beta-market', id: 'reg-b', root: rootB };
      // 1=shared(A installable), 2=shared(B git unavailable), 3=other installable.
      makeLocalMarketplace(fixture, specA, [
        { name: 'shared', source: { source: 'local', path: './plugins/shared-a' } },
      ]);
      makeLocalMarketplace(fixture, specB, [
        { name: 'shared', source: { source: 'github', repo: 'acme/shared-b' } },
        { name: 'other', source: { source: 'local', path: './plugins/other' } },
      ]);
      writeState(fixture, registrationsState(fixture, [registration(specA), registration(specB)]));

      const result = completeArguments('install ', { statePath: fixture.statePath })!;

      // `install shared` would match both entries (the unavailable one included) and be
      // rejected as ambiguous, so the installable candidate must insert its enumeration number.
      expect(result.find((item) => item.label === 'shared')).toBeUndefined();
      const shared = result.find((item) => item.value === 'install 1');
      expect(shared!.label).toBe('shared (#1)');
      expect(shared!.description).toContain('[alpha-market]');
      expect(result.find((item) => item.value === 'install shared')).toBeUndefined();
      expect(result.find((item) => item.label === 'other')!.value).toBe('install other');
    } finally {
      fixture.cleanup();
    }
  });

  it('filters by case-insensitive fuzzy match over plugin name and marketplace provenance', () => {
    const fixture = makeFixture();
    try {
      const rootA = join(fixture.root, 'mkt-a');
      const rootB = join(fixture.root, 'mkt-b');
      mkdirSync(rootA, { recursive: true });
      mkdirSync(rootB, { recursive: true });
      const specA: LocalMarketplaceSpec = { name: 'alpha-market', id: 'reg-a', root: rootA };
      const specB: LocalMarketplaceSpec = { name: 'beta-market', id: 'reg-b', root: rootB };
      makeLocalMarketplace(fixture, specA, [
        { name: 'my-plugin', source: { source: 'local', path: './plugins/my-plugin' } },
      ]);
      makeLocalMarketplace(fixture, specB, [
        { name: 'alpha-tool', source: { source: 'local', path: './plugins/alpha-tool' } },
      ]);
      writeState(fixture, registrationsState(fixture, [registration(specA), registration(specB)]));

      // Mixed-case partial over the plugin name.
      const byName = completeArguments('install MyPln', { statePath: fixture.statePath })!;
      expect(byName.map((item) => item.label)).toEqual(['my-plugin']);

      // Fuzzy partial over the marketplace provenance.
      const byMarket = completeArguments('install bta', { statePath: fixture.statePath })!;
      expect(byMarket.map((item) => item.label)).toEqual(['alpha-tool']);

      // Non-contiguous query over the combined name＋provenance search text.
      const nonContig = completeArguments('install mlp', { statePath: fixture.statePath })!;
      expect(nonContig.map((item) => item.label)).toEqual(['my-plugin']);

      expect(completeArguments('install zzz', { statePath: fixture.statePath })).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  it('returns an empty set when there are no registrations, entries, or candidates', () => {
    const fixture = makeFixture();
    try {
      writeState(fixture, emptyState(fixture));
      expect(completeArguments('install ', { statePath: fixture.statePath })).toEqual([]);
      expect(completeArguments('install some-name', { statePath: fixture.statePath })).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  it('contributes no candidates for a registration whose catalog errors, but keeps others enumerable', () => {
    const fixture = makeFixture();
    try {
      const brokenRoot = join(fixture.root, 'mkt-broken');
      const okRoot = join(fixture.root, 'mkt-ok');
      mkdirSync(brokenRoot, { recursive: true });
      mkdirSync(okRoot, { recursive: true });
      // Broken catalog: file exists but is not valid JSON.
      mkdirSync(join(brokenRoot, '.agents', 'plugins'), { recursive: true });
      writeFileSync(join(brokenRoot, '.agents', 'plugins', 'marketplace.json'), 'not json {', 'utf-8');
      const specBroken: LocalMarketplaceSpec = { name: 'broken-market', id: 'reg-broken', root: brokenRoot };
      const specOk: LocalMarketplaceSpec = { name: 'ok-market', id: 'reg-ok', root: okRoot };
      makeLocalMarketplace(fixture, specOk, [
        { name: 'fine', source: { source: 'local', path: './plugins/fine' } },
      ]);
      writeState(fixture, registrationsState(fixture, [registration(specBroken), registration(specOk)]));

      const result = completeArguments('install ', { statePath: fixture.statePath })!;

      expect(result.map((item) => item.label)).toEqual(['fine']);
      // The broken registration is skipped entirely (no numbered gaps), matching `list`.
      expect(result[0].value).toBe('install fine');
    } finally {
      fixture.cleanup();
    }
  });

  it('contributes no candidates when a git registration lacks its cache material', () => {
    const fixture = makeFixture();
    try {
      const SNAPSHOT = 'a'.repeat(64);
      const gitRoot = join(getCacheEntriesDir(getCacheDir(fixture.agentDir)), SNAPSHOT);
      mkdirSync(gitRoot, { recursive: true });
      // Catalog exists under the cache entry but the registration has no usable snapshot
      // pointer → resolveMarketplaceRoot cannot resolve it.
      makeLocalMarketplace(fixture, { name: 'git-market', id: 'reg-git', root: gitRoot }, [
        { name: 'cached-plugin', source: { source: 'local', path: './plugins/cached-plugin' } },
      ]);
      const state = registrationsState(fixture, [
        { id: 'reg-git', marketplaceName: 'git-market', format: 'claude', sourceKind: 'git', source: 'https://github.com/acme/skills', snapshot: undefined },
      ]);
      writeState(fixture, state);

      expect(completeArguments('install ', { statePath: fixture.statePath, agentDir: fixture.agentDir })).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  it('is passive for damaged Bridge State: no candidates and the file content is untouched', () => {
    const fixture = makeFixture();
    try {
      const damaged = 'INVALID JSON CONTENT';
      writeFileSync(fixture.statePath, damaged, 'utf-8');

      const result = completeArguments('install ', { statePath: fixture.statePath });

      expect(result).toEqual([]);
      // Malformed Bridge State must be byte-identical before and after completion (#122).
      expect(readFileSync(fixture.statePath, 'utf-8')).toBe(damaged);
    } finally {
      fixture.cleanup();
    }
  });

  it('returns null for a second token after the plugin query (not Bridge-owned)', () => {
    expect(completeArguments('install foo bar')).toBeNull();
    expect(completeArguments('install   baz qux')).toBeNull();
  });
});

describe('state-aware Installation lifecycle completion (#123)', () => {
  function lifecycleReg(id: string, name: string): MinimalBridgeState['registrations'][number] {
    return { id, marketplaceName: name, format: 'codex', sourceKind: 'local', source: `/tmp/${id}` };
  }

  function installation(
    fields: Partial<MinimalBridgeState['installations'][number]>,
  ): MinimalBridgeState['installations'][number] {
    return {
      id: 'inst-x',
      pluginId: 'plugin-x',
      enabled: true,
      installationState: 'enabled',
      registrationId: 'reg-a',
      manifestName: 'plugin-x',
      sourceKind: 'local',
      source: '/tmp/plugin-x',
      skills: [],
      ...fields,
    };
  }

  function lifecycleState(
    fixture: StateFixture,
    regs: MinimalBridgeState['registrations'],
    insts: MinimalBridgeState['installations'],
  ): void {
    writeState(fixture, { schemaVersion: 1, registrations: regs, installations: insts });
  }

  it('`enable ` lists only disabled Installations and `disable ` only enabled ones', () => {
    const fixture = makeFixture();
    try {
      lifecycleState(
        fixture,
        [lifecycleReg('reg-a', 'alpha-market'), lifecycleReg('reg-b', 'beta-market')],
        [
          installation({ id: 'inst-a', pluginId: 'alpha-plugin', manifestName: 'alpha-plugin', registrationId: 'reg-a' }),
          installation({ id: 'inst-b', pluginId: 'beta-plugin', manifestName: 'beta-plugin', registrationId: 'reg-b', enabled: false, installationState: 'disabled' }),
        ],
      );

      const enable = completeArguments('enable ', { statePath: fixture.statePath })!;
      expect(enable.map((item) => item.value)).toEqual(['enable beta-plugin']);
      expect(enable.map((item) => item.label)).toEqual(['beta-plugin']);
      for (const item of enable) {
        expect(item.description).toContain('[beta-market]');
      }

      const disable = completeArguments('disable ', { statePath: fixture.statePath })!;
      expect(disable.map((item) => item.value)).toEqual(['disable alpha-plugin']);
      for (const item of disable) {
        expect(item.description).toContain('[alpha-market]');
      }
    } finally {
      fixture.cleanup();
    }
  });

  it('`remove ` lists every Installed Plugin regardless of state, with provenance in the description', () => {
    const fixture = makeFixture();
    try {
      lifecycleState(
        fixture,
        [lifecycleReg('reg-a', 'alpha-market'), lifecycleReg('reg-b', 'beta-market')],
        [
          installation({ id: 'inst-a', pluginId: 'alpha-plugin', manifestName: 'alpha-plugin', registrationId: 'reg-a' }),
          installation({ id: 'inst-b', pluginId: 'beta-plugin', manifestName: 'beta-plugin', registrationId: 'reg-b', enabled: false, installationState: 'disabled' }),
        ],
      );

      const remove = completeArguments('remove ', { statePath: fixture.statePath })!;
      expect(remove.map((item) => item.value)).toEqual(['remove alpha-plugin', 'remove beta-plugin']);
      expect(remove[0].description).toContain('[alpha-market]');
      expect(remove[0].description).toContain('已裝啟用');
      expect(remove[1].description).toContain('[beta-market]');
      expect(remove[1].description).toContain('已裝停用');
    } finally {
      fixture.cleanup();
    }
  });

  it('omits cross-Marketplace same-named Installations that a name command cannot resolve uniquely', () => {
    const fixture = makeFixture();
    try {
      lifecycleState(
        fixture,
        [lifecycleReg('reg-a', 'alpha-market'), lifecycleReg('reg-b', 'beta-market')],
        [
          installation({ id: 'inst-a', pluginId: 'shared', manifestName: 'shared', registrationId: 'reg-a' }),
          installation({ id: 'inst-b', pluginId: 'shared', manifestName: 'shared', registrationId: 'reg-b', enabled: false, installationState: 'disabled' }),
          installation({ id: 'inst-c', pluginId: 'other', manifestName: 'other', registrationId: 'reg-b' }),
        ],
      );

      // `disable shared` would match both Installations and be rejected as ambiguous (#93),
      // so neither same-named record may be offered as a candidate on any lifecycle action.
      expect(completeArguments('disable ', { statePath: fixture.statePath })!.map((i) => i.value)).toEqual(['disable other']);
      expect(completeArguments('enable ', { statePath: fixture.statePath })!.map((i) => i.value)).toEqual([]);
      expect(completeArguments('remove ', { statePath: fixture.statePath })!.map((i) => i.value)).toEqual(['remove other']);
    } finally {
      fixture.cleanup();
    }
  });

  it('applies the ambiguity rule across every identity field the command resolves on', () => {
    const fixture = makeFixture();
    try {
      // A resolves by manifestName `x`; B carries the same token as its pluginId. A name-typed
      // `disable x` matches both records (manifestName OR pluginId OR id, #93), so A is
      // ambiguous and omitted, while B stays selectable through its own unique manifestName.
      lifecycleState(
        fixture,
        [lifecycleReg('reg-a', 'alpha-market')],
        [
          installation({ id: 'inst-a', pluginId: 'a', manifestName: 'x', registrationId: 'reg-a' }),
          installation({ id: 'inst-b', pluginId: 'x', manifestName: 'b', registrationId: 'reg-a' }),
        ],
      );

      expect(completeArguments('disable ', { statePath: fixture.statePath })!.map((i) => i.value)).toEqual(['disable b']);
    } finally {
      fixture.cleanup();
    }
  });

  it('keeps candidates when the registration record is gone, showing registrationId as provenance', () => {
    const fixture = makeFixture();
    try {
      lifecycleState(
        fixture,
        [],
        [installation({ id: 'inst-a', pluginId: 'orphan', manifestName: 'orphan', registrationId: 'reg-gone', enabled: false, installationState: 'disabled' })],
      );

      const enable = completeArguments('enable ', { statePath: fixture.statePath })!;
      expect(enable.map((item) => item.value)).toEqual(['enable orphan']);
      expect(enable[0].description).toContain('[reg-gone]');
    } finally {
      fixture.cleanup();
    }
  });

  it('filters by case-insensitive fuzzy match over plugin name and Marketplace provenance', () => {
    const fixture = makeFixture();
    try {
      lifecycleState(
        fixture,
        [lifecycleReg('reg-a', 'alpha-market'), lifecycleReg('reg-b', 'beta-market')],
        [
          installation({ id: 'inst-a', pluginId: 'my-plugin', manifestName: 'my-plugin', registrationId: 'reg-a' }),
          installation({ id: 'inst-b', pluginId: 'alpha-tool', manifestName: 'alpha-tool', registrationId: 'reg-b', enabled: false, installationState: 'disabled' }),
        ],
      );

      // Mixed-case partial over the plugin name.
      const byName = completeArguments('remove MyPln', { statePath: fixture.statePath })!;
      expect(byName.map((item) => item.label)).toEqual(['my-plugin']);

      // Fuzzy partial over the Marketplace provenance.
      const byMarket = completeArguments('remove bta', { statePath: fixture.statePath })!;
      expect(byMarket.map((item) => item.label)).toEqual(['alpha-tool']);

      // Non-contiguous query over the combined name＋provenance search text.
      const nonContig = completeArguments('remove mlp', { statePath: fixture.statePath })!;
      expect(nonContig.map((item) => item.label)).toEqual(['my-plugin']);

      // A query that matches only the enabled candidate is still within the remove action.
      const removeAll = completeArguments('remove ', { statePath: fixture.statePath })!;
      expect(removeAll.map((item) => item.label)).toEqual(['my-plugin', 'alpha-tool']);

      expect(completeArguments('remove zzz', { statePath: fixture.statePath })).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  it('returns no candidates for an empty actionable set or an empty state', () => {
    const fixture = makeFixture();
    try {
      lifecycleState(fixture, [lifecycleReg('reg-a', 'alpha-market')], [
        installation({ id: 'inst-a', pluginId: 'only', manifestName: 'only', registrationId: 'reg-a' }),
      ]);
      // The only Installation is enabled: `enable ` has nothing actionable.
      expect(completeArguments('enable ', { statePath: fixture.statePath })).toEqual([]);
      expect(completeArguments('enable only', { statePath: fixture.statePath })).toEqual([]);

      lifecycleState(fixture, [lifecycleReg('reg-a', 'alpha-market')], [
        installation({ id: 'inst-a', pluginId: 'only', manifestName: 'only', registrationId: 'reg-a', enabled: false, installationState: 'disabled' }),
      ]);
      expect(completeArguments('disable ', { statePath: fixture.statePath })).toEqual([]);

      lifecycleState(fixture, [], []);
      expect(completeArguments('enable ', { statePath: fixture.statePath })).toEqual([]);
      expect(completeArguments('disable ', { statePath: fixture.statePath })).toEqual([]);
      expect(completeArguments('remove ', { statePath: fixture.statePath })).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  it('reflects the latest Installation State on every completion request', () => {
    const fixture = makeFixture();
    try {
      const regs = [lifecycleReg('reg-a', 'alpha-market')];
      lifecycleState(fixture, regs, [
        installation({ id: 'inst-a', pluginId: 'toggle', manifestName: 'toggle', registrationId: 'reg-a' }),
      ]);
      expect(completeArguments('disable ', { statePath: fixture.statePath })!.map((i) => i.value)).toEqual(['disable toggle']);
      expect(completeArguments('enable ', { statePath: fixture.statePath })).toEqual([]);

      // Simulate the user running `disable` between requests: the next completion reflects it.
      lifecycleState(fixture, regs, [
        installation({ id: 'inst-a', pluginId: 'toggle', manifestName: 'toggle', registrationId: 'reg-a', enabled: false, installationState: 'disabled' }),
      ]);
      expect(completeArguments('disable ', { statePath: fixture.statePath })).toEqual([]);
      expect(completeArguments('enable ', { statePath: fixture.statePath })!.map((i) => i.value)).toEqual(['enable toggle']);
    } finally {
      fixture.cleanup();
    }
  });

  it('is passive for damaged Bridge State: no candidates and the file content is untouched', () => {
    const fixture = makeFixture();
    try {
      const damaged = 'INVALID JSON CONTENT';
      writeFileSync(fixture.statePath, damaged, 'utf-8');

      for (const prefix of ['enable ', 'disable ', 'remove ']) {
        expect(completeArguments(prefix, { statePath: fixture.statePath })).toEqual([]);
        // Malformed Bridge State must be byte-identical before and after completion (#123).
        expect(readFileSync(fixture.statePath, 'utf-8')).toBe(damaged);
      }
    } finally {
      fixture.cleanup();
    }
  });

  it('keeps a bare `enable` / `disable` / `remove` at the root level so the trailing-space candidate can apply first', () => {
    const fixture = makeFixture();
    try {
      for (const label of ['enable', 'disable', 'remove']) {
        const result = completeArguments(label, { statePath: fixture.statePath })!;
        expect(result.map((item) => item.label)).toEqual([label]);
        expect(result[0].value).toBe(`${label} `);
      }
    } finally {
      fixture.cleanup();
    }
  });

  it('never offers an Installation whose name the whitespace-splitting command cannot resolve', () => {
    const fixture = makeFixture();
    try {
      lifecycleState(
        fixture,
        [lifecycleReg('reg-a', 'alpha-market')],
        [
          installation({ id: 'inst-a', pluginId: 'good', manifestName: 'good', registrationId: 'reg-a', enabled: false, installationState: 'disabled' }),
          installation({ id: 'inst-b', pluginId: 'my plugin', manifestName: 'my plugin', registrationId: 'reg-a' }),
        ],
      );

      // `remove my plugin` splits into two tokens and never resolves an Installation; the
      // candidate must not be offered.
      expect(completeArguments('remove ', { statePath: fixture.statePath })!.map((i) => i.value)).toEqual(['remove good']);
    } finally {
      fixture.cleanup();
    }
  });

  it('returns null for a third token and for unowned second-level syntax', () => {
    const fixture = makeFixture();
    try {
      lifecycleState(fixture, [], []);
      // A single-token argument query is Bridge-owned; a second token is not.
      expect(completeArguments('remove foo bar', { statePath: fixture.statePath })).toBeNull();
      expect(completeArguments('disable   baz qux', { statePath: fixture.statePath })).toBeNull();
      // `forget` and `list` second-level arguments are not owned by #123.
      expect(completeArguments('forget mkt', { statePath: fixture.statePath })).toBeNull();
      expect(completeArguments('list ', { statePath: fixture.statePath })).toBeNull();
    } finally {
      fixture.cleanup();
    }
  });
});