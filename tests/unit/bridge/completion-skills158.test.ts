/**
 * `skills` autocomplete surface (#158).
 *
 * The Bridge autocomplete must make the Skill Exclusion operations discoverable without
 * owning anything else: the Installation second level, the four operations, and the skill-name
 * argument are Bridge-owned syntax; anything deeper stays with Pi. Reads are passive — a
 * damaged Bridge State document contributes no candidates and is never written or reset.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { completeArguments } from '../../../src/bridge/completion.js';

describe('`skills` completion surface (#158)', () => {
  let root: string;
  let statePath: string;

  /** A canonical local codex marketplace: the projection material the command reads. */
  function makeCodexMarketplace(name: string, plugins: { name: string; skills?: string[] }[]): void {
    mkdirSync(join(root, '.agents', 'plugins'), { recursive: true });
    writeFileSync(
      join(root, '.agents', 'plugins', 'marketplace.json'),
      JSON.stringify({
        name,
        plugins: plugins.map((p) => ({ name: p.name, source: { source: 'local', path: `./plugins/${p.name}` } })),
      }),
    );
    for (const plugin of plugins) {
      const pluginDir = join(root, 'plugins', plugin.name);
      mkdirSync(join(pluginDir, '.codex-plugin'), { recursive: true });
      writeFileSync(join(pluginDir, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: plugin.name }));
      for (const skill of plugin.skills ?? []) {
        const skillDir = join(pluginDir, 'skills', skill);
        mkdirSync(skillDir, { recursive: true });
        writeFileSync(join(skillDir, 'SKILL.md'), `---\nname: ${skill}\ndescription: Desc for ${skill}\n---\n\nBody\n`);
      }
    }
  }

  function writeState(installations: unknown[]): void {
    writeFileSync(
      statePath,
      JSON.stringify(
        {
          schemaVersion: 1,
          registrations: [
            { id: 'reg-a', marketplaceName: 'alpha-market', format: 'codex', sourceKind: 'local', source: root },
          ],
          installations,
        },
        null,
        2,
      ),
    );
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'bridge-completion-skills158-'));
    statePath = join(root, 'state.json');
    // The source offers `upstream-new`, which no install has recorded yet.
    makeCodexMarketplace('alpha-market', [{ name: 'engineering', skills: ['changelog', 'scratch', 'upstream-new'] }]);
    writeState([
      {
        id: 'inst-eng',
        pluginId: 'engineering',
        enabled: true,
        installationState: 'enabled',
        registrationId: 'reg-a',
        manifestName: 'engineering',
        skills: ['changelog', 'scratch'],
        skillExclusions: ['scratch'],
      },
      {
        id: 'inst-paused',
        pluginId: 'paused',
        enabled: false,
        installationState: 'disabled',
        registrationId: 'reg-a',
        manifestName: 'paused',
        skills: ['keep-me'],
      },
    ]);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('lists every Installed Plugin with provenance and state for `skills <query>`', () => {
    const items = completeArguments('skills ', { statePath })!;

    expect(items.map((item) => item.label)).toEqual(['engineering', 'paused']);
    expect(items.map((item) => item.value)).toEqual(['skills engineering', 'skills paused']);
    expect(items[0]!.description).toBe('[alpha-market] 已裝啟用');
    expect(items[1]!.description).toBe('[alpha-market] 已裝停用');
  });

  it('fuzzy-filters the Installation candidates by the typed query', () => {
    expect(completeArguments('skills eng', { statePath })!.map((item) => item.label)).toEqual(['engineering']);
    expect(completeArguments('skills zzz', { statePath })).toEqual([]);
  });

  it('offers the four operations with their meanings, reload, and the all-exclusion guard', () => {
    const items = completeArguments('skills engineering ', { statePath })!;

    expect(items.map((item) => item.label)).toEqual(['exclude', 'include', 'only', 'reset']);
    expect(items.map((item) => item.value)).toEqual([
      'skills engineering exclude',
      'skills engineering include',
      'skills engineering only',
      'skills engineering reset',
    ]);
    expect(items.map((item) => item.description)).toEqual([
      '排除單一 skill（不再投影；變更後 Pi 自動 reload）',
      '恢復已排除的 skill（逐項；變更後 Pi 自動 reload）',
      '只保留目前指定的 skills（未給名稱不會排除全部；變更後 Pi 自動 reload）',
      '清除全部排除（含已消失名稱；變更後 Pi 自動 reload）',
    ]);
  });

  it('offers only the names exclude/only can currently act on, and include the excluded ones', () => {
    // `exclude` may only name a skill the current source confirms and that is not already
    // excluded; a name the source gained since the last install is included, and a stale
    // record cannot hide it (the command validates against the same read).
    expect(completeArguments('skills engineering exclude ', { statePath })!.map((item) => item.label)).toEqual([
      'changelog',
      'upstream-new',
    ]);
    expect(completeArguments('skills engineering only up', { statePath })!.map((item) => item.label)).toEqual([
      'upstream-new',
    ]);
    // `only` keeps any currently confirmable name, including one currently excluded.
    expect(completeArguments('skills engineering only ', { statePath })!.map((item) => item.label)).toEqual([
      'changelog',
      'scratch',
      'upstream-new',
    ]);
    // `include` restores from the record and needs no source read.
    expect(completeArguments('skills engineering include ', { statePath })!.map((item) => item.label)).toEqual([
      'scratch',
    ]);
    expect(completeArguments('skills engineering exclude ', { statePath })![0]!.value).toBe(
      'skills engineering exclude changelog',
    );
  });

  it('offers no exclude/only candidate while the source cannot be confirmed, and still restores', () => {
    rmSync(join(root, 'plugins', 'engineering'), { recursive: true, force: true });
    writeState([
      {
        id: 'inst-eng',
        pluginId: 'engineering',
        enabled: true,
        installationState: 'enabled',
        registrationId: 'reg-a',
        manifestName: 'engineering',
        skills: ['changelog', 'scratch'],
        skillExclusions: ['scratch'],
      },
    ]);

    // Adding an exclusion needs a confirmable name; restoring one does not.
    expect(completeArguments('skills engineering exclude ', { statePath })).toEqual([]);
    expect(completeArguments('skills engineering only ', { statePath })).toEqual([]);
    expect(completeArguments('skills engineering include ', { statePath })!.map((item) => item.label)).toEqual([
      'scratch',
    ]);
  });

  it('offers no candidate for a name-ambiguous Installation the command would reject', () => {
    const ambiguous = JSON.parse(readFileSync(statePath, 'utf-8'));
    ambiguous.installations.push({
      id: 'inst-eng-2',
      pluginId: 'engineering',
      enabled: true,
      installationState: 'enabled',
      registrationId: 'reg-a',
      manifestName: 'engineering',
      skills: ['other'],
    });
    writeFileSync(statePath, JSON.stringify(ambiguous, null, 2));

    // The ambiguous name contributes no candidate at either level; the unique sibling stays.
    expect(completeArguments('skills ', { statePath })!.map((item) => item.label)).toEqual(['paused']);
    expect(completeArguments('skills engineering ', { statePath })).toEqual([]);
  });

  it('stays passive: a damaged document yields no candidates and is never written or reset', () => {
    const damaged = 'INVALID JSON CONTENT';
    writeFileSync(statePath, damaged, 'utf-8');

    expect(completeArguments('skills ', { statePath })).toEqual([]);
    expect(completeArguments('skills engineering ', { statePath })).toEqual([]);
    expect(completeArguments('skills engineering exclude ', { statePath })).toEqual([]);
    expect(readFileSync(statePath, 'utf-8')).toBe(damaged);
  });

  it('leaves prefixes beyond the owned grammar to Pi', () => {
    expect(completeArguments('skills engineering exclude a b', { statePath })).toBeNull();
    expect(completeArguments('skills engineering only changelog scratch', { statePath })).toBeNull();
  });
});
