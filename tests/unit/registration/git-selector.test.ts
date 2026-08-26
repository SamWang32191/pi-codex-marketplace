import { describe, it, expect } from 'vitest';
import { normalizeGitSelector, parseGitSelectorString } from '../../../src/registration/git-selector.js';

function sel(kind: string, value?: string) {
  return normalizeGitSelector({ kind: kind as any, value });
}

describe('Git Selector normalization', () => {
  it('normalizes default', () => {
    const r = sel('default');
    expect(r.ok).toBe(true);
    expect(r.selector!.canonical).toBe('default');
    expect(r.selector!.kind).toBe('default');
  });

  it('rejects default with value', () => {
    const r = sel('default', 'main');
    expect(r.ok).toBe(false);
    expect(r.findings[0].code).toBe('GIT_SELECTOR_INVALID');
  });

  it('normalizes branch short name to refs/heads/*', () => {
    const r = sel('branch', 'main');
    expect(r.ok).toBe(true);
    expect(r.selector!.canonical).toBe('refs/heads/main');
  });

  it('normalizes branch with slash', () => {
    const r = sel('branch', 'feature/foo-bar');
    expect(r.ok).toBe(true);
    expect(r.selector!.canonical).toBe('refs/heads/feature/foo-bar');
  });

  it('accepts branch already qualified refs/heads/*', () => {
    const r = sel('branch', 'refs/heads/main');
    expect(r.ok).toBe(true);
    expect(r.selector!.canonical).toBe('refs/heads/main');
  });

  it('rejects branch with refs/tags/* prefix', () => {
    const r = sel('branch', 'refs/tags/v1');
    expect(r.ok).toBe(false);
    expect(r.findings[0].code).toBe('GIT_SELECTOR_INVALID');
  });

  it('normalizes tag to refs/tags/*', () => {
    const r = sel('tag', 'v1.2.3');
    expect(r.ok).toBe(true);
    expect(r.selector!.canonical).toBe('refs/tags/v1.2.3');
  });

  it('accepts tag already qualified', () => {
    const r = sel('tag', 'refs/tags/v1.0.0');
    expect(r.ok).toBe(true);
    expect(r.selector!.canonical).toBe('refs/tags/v1.0.0');
  });

  it('rejects tag with refs/heads/* prefix', () => {
    const r = sel('tag', 'refs/heads/main');
    expect(r.ok).toBe(false);
  });

  it('normalizes commit 40 hex to lowercase', () => {
    const upper = 'ABCDEF1234567890ABCDEF1234567890ABCDEF12';
    const r = sel('commit', upper);
    expect(r.ok).toBe(true);
    expect(r.selector!.canonical).toBe(upper.toLowerCase());
    expect(r.selector!.canonical).toMatch(/^[0-9a-f]{40}$/);
  });

  it('accepts commit 64 hex', () => {
    const sha64 = 'a'.repeat(64);
    const r = sel('commit', sha64);
    expect(r.ok).toBe(true);
    expect(r.selector!.canonical).toBe(sha64);
  });

  it('rejects abbreviated commit (7 chars)', () => {
    const r = sel('commit', 'abc123d');
    expect(r.ok).toBe(false);
    expect(r.findings[0].code).toBe('GIT_SELECTOR_COMMIT_INVALID');
  });

  it('rejects commit with non-hex', () => {
    const r = sel('commit', 'g'.repeat(40));
    expect(r.ok).toBe(false);
    expect(r.findings[0].code).toBe('GIT_SELECTOR_COMMIT_INVALID');
  });

  it('rejects HEAD', () => {
    const r = sel('branch', 'HEAD');
    expect(r.ok).toBe(false);
    expect(r.findings[0].code).toBe('GIT_SELECTOR_INVALID');
  });

  it('rejects reflog expression', () => {
    const r = sel('branch', 'main@{1}');
    expect(r.ok).toBe(false);
    expect(r.findings[0].code).toBe('GIT_SELECTOR_INVALID');
  });

  it('rejects revision chars ~', () => {
    const r = sel('branch', 'main~1');
    expect(r.ok).toBe(false);
  });

  it('rejects revision chars ^', () => {
    const r = sel('branch', 'main^');
    expect(r.ok).toBe(false);
  });

  it('rejects colon', () => {
    const r = sel('branch', 'main:foo');
    expect(r.ok).toBe(false);
  });

  it('rejects whitespace', () => {
    const r = sel('branch', 'main branch');
    expect(r.ok).toBe(false);
    expect(r.findings[0].code).toBe('GIT_SELECTOR_INVALID');
  });

  it('rejects control chars', () => {
    const r = sel('branch', 'main\x01');
    expect(r.ok).toBe(false);
  });

  it('rejects option-like', () => {
    const r = sel('branch', '--help');
    expect(r.ok).toBe(false);
    expect(r.findings[0].code).toBe('GIT_SELECTOR_INVALID');
  });

  it('rejects empty value for branch', () => {
    const r = sel('branch', '');
    expect(r.ok).toBe(false);
    expect(r.findings[0].code).toBe('GIT_SELECTOR_BRANCH_INVALID');
  });

  it('rejects empty value for tag', () => {
    const r = sel('tag', '');
    expect(r.ok).toBe(false);
  });

  it('rejects empty value for commit', () => {
    const r = sel('commit', '');
    expect(r.ok).toBe(false);
  });

  it('rejects invalid ref name with ..', () => {
    const r = sel('branch', 'feature..foo');
    expect(r.ok).toBe(false);
  });

  it('rejects invalid ref name with //', () => {
    const r = sel('branch', 'feature//foo');
    expect(r.ok).toBe(false);
  });

  it('rejects ref ending with .lock', () => {
    const r = sel('branch', 'feature.lock');
    expect(r.ok).toBe(false);
  });

  it('rejects ref starting with .', () => {
    const r = sel('branch', '.hidden');
    expect(r.ok).toBe(false);
  });

  it('parse string: default', () => {
    const r = parseGitSelectorString('default');
    expect(r.ok).toBe(true);
    expect(r.selector!.kind).toBe('default');
  });

  it('parse string: refs/heads/main', () => {
    const r = parseGitSelectorString('refs/heads/main');
    expect(r.ok).toBe(true);
    expect(r.selector!.canonical).toBe('refs/heads/main');
  });

  it('parse string: refs/tags/v1', () => {
    const r = parseGitSelectorString('refs/tags/v1.0.0');
    expect(r.ok).toBe(true);
    expect(r.selector!.canonical).toBe('refs/tags/v1.0.0');
  });

  it('parse string: 40 hex commit', () => {
    const sha = 'a'.repeat(40);
    const r = parseGitSelectorString(sha);
    expect(r.ok).toBe(true);
    expect(r.selector!.kind).toBe('commit');
  });

  it('parse string: branch:main', () => {
    const r = parseGitSelectorString('branch:main');
    expect(r.ok).toBe(true);
    expect(r.selector!.canonical).toBe('refs/heads/main');
  });

  it('parse string: invalid throws', () => {
    const r = parseGitSelectorString('unknown-selector');
    expect(r.ok).toBe(false);
  });
});
