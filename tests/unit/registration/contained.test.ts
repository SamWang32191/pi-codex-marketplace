import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { containedPathSyntax, resolveContained } from '../../../src/registration/contained.js';

describe('Contained Path syntax', () => {
  it('accepts clean ./ relative paths, including the owning root', () => {
    expect(containedPathSyntax('./').ok).toBe(true);
    expect(containedPathSyntax('./plugin-a/plugin.json').ok).toBe(true);
    expect(containedPathSyntax('./a/b/c').ok).toBe(true);
  });
  it('rejects absolute paths', () => {
    expect(containedPathSyntax('/etc/passwd').ok).toBe(false);
    expect(containedPathSyntax('C:\\x').ok).toBe(false);
  });
  it('rejects backslash, NUL, dot and parent segments', () => {
    expect(containedPathSyntax('.\\x').ok).toBe(false);
    expect(containedPathSyntax('./a\0b').ok).toBe(false);
    expect(containedPathSyntax('./a/./b').ok).toBe(false);
    expect(containedPathSyntax('./a/../b').ok).toBe(false);
    expect(containedPathSyntax('./..').ok).toBe(false);
    expect(containedPathSyntax('./a//b').ok).toBe(false);
    expect(containedPathSyntax('a/b').ok).toBe(false); // not ./ relative
  });
});

describe('Contained Path resolution', () => {
  let root: string;
  beforeEach(() => {
    const tmp = mkdtempSync(join(tmpdir(), 'contained-test-'));
    root = realpathSync.native(tmp);
    mkdirSync(join(root, 'plugins', 'p1'), { recursive: true });
    writeFileSync(join(root, 'plugins', 'p1', 'plugin.json'), '{}');
  });
  afterEach(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {}
  });

  it('resolves a contained path within the owning root', () => {
    const res = resolveContained(root, './plugins/p1', 'directory');
    expect(res.outcome.kind).toBe('ok');
    if (res.outcome.kind === 'ok') {
      expect(res.outcome.canonicalPath).toBe(join(root, 'plugins', 'p1'));
    }
  });

  it('resolves the owning root itself', () => {
    const res = resolveContained(root, './', 'directory');
    expect(res.outcome.kind).toBe('ok');
    if (res.outcome.kind === 'ok') {
      expect(res.outcome.canonicalPath).toBe(root);
    }
  });

  it('blocks a path whose canonical target escapes the root via a symlink', () => {
    const outside = mkdtempSync(join(tmpdir(), 'outside-'));
    try {
      symlinkSync(outside, join(root, 'escape'));
      const res = resolveContained(root, './escape', 'directory');
      expect(res.outcome.kind).toBe('blocking');
      expect(res.outcome.kind === 'blocking' && res.outcome.reason).toMatch(/escapes|symlink/i);
    } finally {
      try {
        rmSync(outside, { recursive: true, force: true });
      } catch {}
    }
  });

  it('treats a contained symlink to a file inside the root as ok (Contained Symlink)', () => {
    symlinkSync('./plugins/p1/plugin.json', join(root, 'link.json'));
    const res = resolveContained(root, './link.json', 'file');
    expect(res.outcome.kind).toBe('ok');
  });

  it('reports missing targets (resolve failure, not blocking)', () => {
    const res = resolveContained(root, './nope/missing', 'any');
    expect(res.outcome.kind).toBe('missing');
  });

  it('blocks within-root symlinks that point to special files', () => {
    // symlink loop: l -> l
    symlinkSync('./loop', join(root, 'loop'));
    const res = resolveContained(root, './loop', 'any');
    expect(res.outcome.kind).toBe('blocking');
  });
});