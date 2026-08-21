import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { localSourceKey, sourceKeyEquals, redactSource } from '../../../src/registration/source-key.js';

describe('Source Key (local canonical real path)', () => {
  let root: string;
  beforeEach(() => {
    const tmp = mkdtempSync(join(tmpdir(), 'sourcekey-test-'));
    root = realpathSync.native(tmp);
    mkdirSync(join(root, 'sub'), { recursive: true });
    writeFileSync(join(root, 'file.txt'), 'x');
  });
  afterEach(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {}
  });

  it('builds a key from the canonical real path (resolves symlinks/..)', () => {
    const res = localSourceKey(root);
    expect(res.ok).toBe(true);
    expect(res.sourceKey!.kind).toBe('local');
    expect(res.sourceKey!.key).toBe(`local:${root}`);
    expect(res.sourceKey!.canonicalPath).toBe(root);
    // a path with a trailing slash / redundant segment keys identically
    const res2 = localSourceKey(join(root, 'sub', '..'));
    expect(res2.ok).toBe(true);
    expect(sourceKeyEquals(res.sourceKey!, res2.sourceKey!)).toBe(true);
  });

  it('fails when the root does not exist', () => {
    const res = localSourceKey(join(root, 'nope'));
    expect(res.ok).toBe(false);
  });

  it('fails when the root is not a directory', () => {
    const res = localSourceKey(join(root, 'file.txt'));
    expect(res.ok).toBe(false);
  });

  it('local and git keys remain distinct kinds', () => {
    const local = localSourceKey(root).sourceKey!;
    const gitLike = { kind: 'git' as const, key: `git:https://github.com/x/y:default:${root}` };
    expect(sourceKeyEquals(local, gitLike)).toBe(false);
  });

  it('redacts embedded credentials from locator strings', () => {
    expect(redactSource('/a/b/c')).toBe('/a/b/c');
    expect(redactSource('https://user:secret@example.com/repo')).toBe('https://user:***@example.com/repo');
  });
});