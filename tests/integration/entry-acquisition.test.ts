import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  acquireGitEntry,
  acquireGitEntries,
  parseGitEntrySpec,
  checkEntryDrift,
} from '../../src/registration/entry-acquisition.js';
import type { GitExecutor } from '../../src/registration/git-acquisition.js';
import { SourceCache } from '../../src/cache/source-cache.js';
import { CODE } from '../../src/registration/findings.js';
import { BUDGET } from '../../src/registration/budget.js';

function createMultiRepoFixtures(baseDir: string) {
  // Repo A: standard plugin
  const repoADir = join(baseDir, 'repoA');
  mkdirSync(join(repoADir, 'skills', 'skill-a'), { recursive: true });
  mkdirSync(join(repoADir, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(repoADir, 'skills', 'skill-a', 'SKILL.md'),
    '---\nname: skill-a\ndescription: Skill A\n---\nPrompt A',
  );
  writeFileSync(
    join(repoADir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'plugin-a', skills: ['./skills/skill-a'] }),
  );

  // Repo B: monorepo with multiple subplugins
  const repoBDir = join(baseDir, 'repoB');
  mkdirSync(join(repoBDir, 'packages', 'plugin-b1', 'skills', 'skill-b1'), { recursive: true });
  writeFileSync(
    join(repoBDir, 'packages', 'plugin-b1', 'skills', 'skill-b1', 'SKILL.md'),
    '---\nname: skill-b1\ndescription: Skill B1\n---\nPrompt B1',
  );
  writeFileSync(
    join(repoBDir, 'packages', 'plugin-b1', 'plugin.json'),
    JSON.stringify({ name: 'plugin-b1' }),
  );

  mkdirSync(join(repoBDir, 'packages', 'plugin-b2', 'skills', 'skill-b2'), { recursive: true });
  writeFileSync(
    join(repoBDir, 'packages', 'plugin-b2', 'skills', 'skill-b2', 'SKILL.md'),
    '---\nname: skill-b2\ndescription: Skill B2\n---\nPrompt B2',
  );
  writeFileSync(
    join(repoBDir, 'packages', 'plugin-b2', 'plugin.json'),
    JSON.stringify({ name: 'plugin-b2' }),
  );

  return { repoADir, repoBDir };
}

function createMultiMockExecutor(repoADir: string, repoBDir: string): GitExecutor {
  const shaA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const shaB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

  return async (args) => {
    if (args.includes('ls-remote')) {
      const url = args[args.indexOf('ls-remote') + 1];
      const ref = args[args.length - 1];
      const sha = url.includes('repoA') || url.includes('plugin-a') ? shaA : shaB;
      return { exitCode: 0, stdout: `${sha}\t${ref}\n`, stderr: '' };
    }

    if (args.includes('clone')) {
      const url = args[args.indexOf('clone') + 3];
      const dest = args[args.length - 1];
      const src = url.includes('repoA') || url.includes('plugin-a') ? repoADir : repoBDir;
      cpSync(src, dest, { recursive: true });
      mkdirSync(join(dest, '.git'), { recursive: true });
      return { exitCode: 0, stdout: '', stderr: '' };
    }

    if (args.includes('remote') && args.includes('get-url')) {
      return { exitCode: 0, stdout: 'https://github.com/org/repo\n', stderr: '' };
    }

    return { exitCode: 0, stdout: '', stderr: '' };
  };
}

describe('Entry Acquisition Engine — Integration Scenarios', () => {
  let tmpRoot: string;
  let repoADir: string;
  let repoBDir: string;
  let executor: GitExecutor;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'entry-acq-integ-'));
    const fixtures = createMultiRepoFixtures(tmpRoot);
    repoADir = fixtures.repoADir;
    repoBDir = fixtures.repoBDir;
    executor = createMultiMockExecutor(repoADir, repoBDir);
  });

  afterEach(() => {
    try {
      if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  });

  it('acquires entries from aggregated marketplace mixing github, url, and git-subdir shapes', async () => {
    const entries = [
      // Entry 0: local entry (skipped by git engine)
      { entryId: '/plugins/0', source: './local-plugin' },
      // Entry 1: github entry (sha-pinned)
      { entryId: '/plugins/1', source: { source: 'github', repo: 'org/plugin-a', sha: 'a'.repeat(40) } },
      // Entry 2: git-subdir entry 1 (movable ref)
      { entryId: '/plugins/2', source: { source: 'git-subdir', url: 'https://github.com/org/repoB.git', path: 'packages/plugin-b1', ref: 'main' } },
      // Entry 3: git-subdir entry 2 (movable default)
      { entryId: '/plugins/3', source: { source: 'git-subdir', url: 'https://github.com/org/repoB.git', path: 'packages/plugin-b2' } },
      // Entry 4: npm entry (unavailable, skipped by git engine)
      { entryId: '/plugins/4', source: { source: 'npm', package: '@scope/tools' } },
    ];

    const agentDir = join(tmpRoot, 'agent');
    const cache = new SourceCache({ agentDir });

    const batch = await acquireGitEntries(entries, { executor, cache, agentDir });

    expect(batch.ok).toBe(true);
    // Git engine acquired 3 git entries (1, 2, 3)
    expect(batch.entries.size).toBe(3);

    const rec1 = batch.entries.get('/plugins/1')!;
    expect(rec1.spec.shape).toBe('github');
    expect(rec1.resolvedRevision).toBe('a'.repeat(40));
    expect(rec1.validationSnapshot).toBeDefined();
    expect(rec1.snapshot.entries.some((e) => e.relPath === 'skills/skill-a/SKILL.md')).toBe(true);

    const rec2 = batch.entries.get('/plugins/2')!;
    expect(rec2.spec.shape).toBe('git-subdir');
    expect(rec2.spec.subpath).toBe('packages/plugin-b1');
    expect(rec2.resolvedRevision).toBe('b'.repeat(40));
    expect(rec2.snapshot.entries.some((e) => e.relPath === 'skills/skill-b1/SKILL.md')).toBe(true);

    const rec3 = batch.entries.get('/plugins/3')!;
    expect(rec3.spec.shape).toBe('git-subdir');
    expect(rec3.spec.subpath).toBe('packages/plugin-b2');
    expect(rec3.snapshot.entries.some((e) => e.relPath === 'skills/skill-b2/SKILL.md')).toBe(true);

    expect(batch.entrySnapshots['/plugins/1']).toBe(rec1.validationSnapshot);
    expect(batch.entrySnapshots['/plugins/2']).toBe(rec2.validationSnapshot);
    expect(batch.entrySnapshots['/plugins/3']).toBe(rec3.validationSnapshot);

    batch.cleanup();
  });

  it('enforces Validation Budget during entry acquisition: total byte limit exceeded produces Blocking Finding', async () => {
    const bigRepoDir = join(tmpRoot, 'bigRepo');
    mkdirSync(bigRepoDir, { recursive: true });
    // Write a single file exceeding maxTotalBytes (10 MiB)
    writeFileSync(join(bigRepoDir, 'oversized.bin'), Buffer.alloc(BUDGET.maxTotalBytes + 1024));

    const bigExecutor: GitExecutor = async (args) => {
      if (args.includes('ls-remote')) {
        return { exitCode: 0, stdout: `${'f'.repeat(40)}\tHEAD\n`, stderr: '' };
      }
      if (args.includes('clone')) {
        const dest = args[args.length - 1];
        cpSync(bigRepoDir, dest, { recursive: true });
        mkdirSync(join(dest, '.git'), { recursive: true });
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    const parsed = parseGitEntrySpec({ source: 'github', repo: 'org/big-repo' });
    expect(parsed.ok).toBe(true);

    const res = await acquireGitEntry({
      spec: parsed.spec!,
      entryId: '/plugins/0',
      executor: bigExecutor,
    });

    expect(res.ok).toBe(false);
    expect(res.findings.some((f) => f.code === CODE.BUDGET_EXCEEDED)).toBe(true);
  });

  it('enforces Validation Budget during entry acquisition: tree depth exceeded produces Blocking Finding', async () => {
    const deepRepoDir = join(tmpRoot, 'deepRepo');
    let curr = deepRepoDir;
    for (let i = 0; i <= BUDGET.maxTreeDepth + 2; i++) {
      curr = join(curr, `d_${i}`);
    }
    mkdirSync(curr, { recursive: true });
    writeFileSync(join(curr, 'deep.txt'), 'deep');

    const deepExecutor: GitExecutor = async (args) => {
      if (args.includes('ls-remote')) {
        return { exitCode: 0, stdout: `${'f'.repeat(40)}\tHEAD\n`, stderr: '' };
      }
      if (args.includes('clone')) {
        const dest = args[args.length - 1];
        cpSync(deepRepoDir, dest, { recursive: true });
        mkdirSync(join(dest, '.git'), { recursive: true });
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    const parsed = parseGitEntrySpec({ source: 'github', repo: 'org/deep-repo' });
    expect(parsed.ok).toBe(true);

    const res = await acquireGitEntry({
      spec: parsed.spec!,
      entryId: '/plugins/0',
      executor: deepExecutor,
    });

    expect(res.ok).toBe(false);
    expect(res.findings.some((f) => f.code === CODE.BUDGET_EXCEEDED)).toBe(true);
  });

  it('binds per-entry snapshot into SourceCache and enables cache hit on exact fingerprint', async () => {
    const agentDir = join(tmpRoot, 'agent');
    const cache = new SourceCache({ agentDir });

    const parsed = parseGitEntrySpec({ source: 'github', repo: 'org/plugin-a', sha: 'a'.repeat(40) });
    const res = await acquireGitEntry({
      spec: parsed.spec!,
      entryId: '/plugins/0',
      executor,
      cache,
    });

    expect(res.ok).toBe(true);
    const fingerprint = res.snapshot!.fingerprint;

    // Verify cache has tree under fingerprint
    const cached = await cache.hitExact(fingerprint);
    expect(cached).not.toBeNull();
    expect(cached!.fingerprint).toBe(fingerprint);

    if (res.createdTemp && res.acquiredPath) {
      rmSync(res.acquiredPath, { recursive: true, force: true });
    }
  });

  it('performs drift comparison on individual entries independently', async () => {
    const parsedA = parseGitEntrySpec({ source: 'github', repo: 'org/plugin-a', sha: 'a'.repeat(40) });
    const resA = await acquireGitEntry({ spec: parsedA.spec!, entryId: '/plugins/0', executor });
    expect(resA.ok).toBe(true);

    const recordedSnapshots = {
      '/plugins/0': resA.snapshot!.fingerprint,
      '/plugins/1': 'old-fingerprint-that-drifted-000000000000000000000000000000000000',
    };

    // Entry 0 has not drifted
    expect(checkEntryDrift(resA.snapshot!.fingerprint, recordedSnapshots['/plugins/0'])).toBe(false);

    // Entry 1 has drifted
    expect(checkEntryDrift(resA.snapshot!.fingerprint, recordedSnapshots['/plugins/1'])).toBe(true);

    if (resA.createdTemp && resA.acquiredPath) {
      rmSync(resA.acquiredPath, { recursive: true, force: true });
    }
  });
});
