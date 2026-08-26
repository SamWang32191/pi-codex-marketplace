import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildLocalSnapshot } from '../../../src/registration/snapshot.js';
import { localSourceKey } from '../../../src/registration/source-key.js';
import { BUDGET, COMPATIBILITY_PROFILE, VALIDATION_BUDGET, VALIDATION_RULESET } from '../../../src/registration/budget.js';

function makeRoot() {
  const tmp = mkdtempSync(join(tmpdir(), 'snapshot-test-'));
  const root = realpathSync.native(tmp);
  mkdirSync(join(root, 'plugins', 'p1'), { recursive: true });
  writeFileSync(join(root, 'plugins', 'p1', 'plugin.json'), '{"name":"p1"}');
  writeFileSync(join(root, 'plugins', 'p1', 'SKILL.md'), '# hello');
  mkdirSync(join(root, '.agents', 'plugins'), { recursive: true });
  writeFileSync(join(root, '.agents', 'plugins', 'marketplace.json'), JSON.stringify({ name: 'x', plugins: [] }));
  return root;
}

describe('Validation Snapshot', () => {
  let root: string;
  let sourceKey: NonNullable<ReturnType<typeof localSourceKey>['sourceKey']>;
  beforeEach(() => {
    root = makeRoot();
    sourceKey = localSourceKey(root).sourceKey!;
  });
  afterEach(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {}
  });

  it('produces a deterministic fingerprint over ordered entries + binds', () => {
    const a = buildLocalSnapshot(root, sourceKey);
    const b = buildLocalSnapshot(root, sourceKey);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(a.snapshot!.fingerprint).toBe(b.snapshot!.fingerprint);
    expect(a.snapshot!.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('binds Source Key, Profile, Ruleset, Budget into the snapshot', () => {
    const s = buildLocalSnapshot(root, sourceKey).snapshot!;
    expect(s.sourceKey.kind).toBe('local');
    expect(s.sourceKey.key).toBe(`local:${root}`);
    expect(s.profile).toBe(COMPATIBILITY_PROFILE);
    expect(s.ruleset).toBe(VALIDATION_RULESET);
    expect(s.budget).toBe(VALIDATION_BUDGET);
  });

  it('fingerprint changes when content changes (source drift would be detected)', () => {
    const before = buildLocalSnapshot(root, sourceKey).snapshot!.fingerprint;
    writeFileSync(join(root, 'plugins', 'p1', 'SKILL.md'), '# changed');
    const after = buildLocalSnapshot(root, sourceKey).snapshot!.fingerprint;
    expect(after).not.toBe(before);
  });

  it('records ordered paths, types, modes, symlink targets, content hashes', () => {
    const s = buildLocalSnapshot(root, sourceKey).snapshot!;
    const relPaths = s.entries.map((e) => e.relPath);
    expect(relPaths).toContain('.agents/plugins/marketplace.json');
    expect(relPaths).toContain('plugins/p1/plugin.json');
    // ordered
    const sorted = [...relPaths].sort((x, y) => x.localeCompare(y));
    expect(relPaths).toEqual(sorted);
    const file = s.entries.find((e) => e.relPath === 'plugins/p1/plugin.json')!;
    expect(file.type).toBe('file');
    expect(file.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof file.mode).toBe('number');
  });

  it('records symlink targets without following them (no loops)', () => {
    symlinkSync('./plugins', join(root, 'pluglink'));
    const s = buildLocalSnapshot(root, sourceKey).snapshot!;
    const link = s.entries.find((e) => e.relPath === 'pluglink')!;
    expect(link.type).toBe('symlink');
    expect(link.symlinkTarget).toBe('./plugins');
  });

  it('charges a symlinked Skill Agent Profile target to the Validation Budget', () => {
    const skill = join(root, 'plugins', 'p1', 'skills', 'release-notes');
    mkdirSync(join(skill, 'agents'), { recursive: true });
    const target = join(skill, 'profile.yaml');
    writeFileSync(target, '');
    truncateSync(target, BUDGET.maxTotalBytes + 1);
    symlinkSync('../profile.yaml', join(skill, 'agents', 'openai.yaml'));

    const result = buildLocalSnapshot(root, sourceKey);

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'BUDGET_EXCEEDED', classification: 'blocking' }),
    ]));
  });

  it('flags symlinks whose canonical target escapes the root as Blocking', () => {
    const outside = mkdtempSync(join(tmpdir(), 'outside-snapshot-'));
    try {
      symlinkSync(outside, join(root, 'outside-link'));
      const res = buildLocalSnapshot(root, sourceKey);
      expect(res.ok).toBe(false);
      expect(res.findings.some((f) => f.code === 'CONTAINED_SYMLINK_VIOLATION')).toBe(true);
    } finally {
      try {
        rmSync(outside, { recursive: true, force: true });
      } catch {}
    }
  });

  it('flags broken symlinks inside the tree as Blocking (no resolvable canonical target)', () => {
    symlinkSync('./does-not-exist', join(root, 'broken-link'));
    const res = buildLocalSnapshot(root, sourceKey);
    expect(res.ok).toBe(false);
    const symlinkFindings = res.findings.filter((f) => f.code === 'CONTAINED_SYMLINK_VIOLATION');
    expect(symlinkFindings.length).toBeGreaterThan(0);
    expect(symlinkFindings[0].pointer).toBe('broken-link');
  });

  it('flags looping symlinks inside the tree as Blocking', () => {
    symlinkSync('loop-a', join(root, 'loop-a'));
    const res = buildLocalSnapshot(root, sourceKey);
    expect(res.ok).toBe(false);
    expect(res.findings.some((f) => f.code === 'CONTAINED_SYMLINK_VIOLATION')).toBe(true);
  });
});
