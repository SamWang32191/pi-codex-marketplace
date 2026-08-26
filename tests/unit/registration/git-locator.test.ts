import { describe, it, expect } from 'vitest';
import { normalizeGitLocator } from '../../../src/registration/git-locator.js';

function loc(input: string) {
  return normalizeGitLocator(input);
}

describe('Canonical Git Locator normalization', () => {
  it('accepts https:// and preserves host lowercased and path', () => {
    const r = loc('https://github.com/Owner/Repo.git');
    expect(r.ok).toBe(true);
    expect(r.locator!.canonicalUrl).toBe('https://github.com/Owner/Repo.git');
    expect(r.locator!.host).toBe('github.com');
    expect(r.locator!.transport).toBe('https');
    expect(r.locator!.path).toBe('/Owner/Repo.git');
  });

  it('lowercases host but preserves path case', () => {
    const r = loc('https://GITHUB.COM/Owner/Repo');
    expect(r.ok).toBe(true);
    expect(r.locator!.canonicalUrl).toBe('https://github.com/Owner/Repo');
    expect(r.locator!.host).toBe('github.com');
  });

  it('accepts https with explicit port', () => {
    const r = loc('https://github.com:8443/owner/repo');
    expect(r.ok).toBe(true);
    expect(r.locator!.port).toBe(8443);
    expect(r.locator!.canonicalUrl).toBe('https://github.com:8443/owner/repo');
  });

  it('omits default port 443 for https', () => {
    const r = loc('https://github.com:443/owner/repo');
    expect(r.ok).toBe(true);
    expect(r.locator!.port).toBeUndefined();
    expect(r.locator!.canonicalUrl).toBe('https://github.com/owner/repo');
  });

  it('accepts ssh:// with user and preserves it', () => {
    const r = loc('ssh://git@github.com/owner/repo.git');
    expect(r.ok).toBe(true);
    expect(r.locator!.transport).toBe('ssh');
    expect(r.locator!.user).toBe('git');
    expect(r.locator!.canonicalUrl).toBe('ssh://git@github.com/owner/repo.git');
  });

  it('accepts ssh:// without user', () => {
    const r = loc('ssh://github.com/owner/repo');
    expect(r.ok).toBe(true);
    expect(r.locator!.user).toBeUndefined();
    expect(r.locator!.canonicalUrl).toBe('ssh://github.com/owner/repo');
  });

  it('accepts ssh:// with port and omits default 22', () => {
    const r = loc('ssh://git@github.com:2222/owner/repo.git');
    expect(r.ok).toBe(true);
    expect(r.locator!.port).toBe(2222);
    expect(r.locator!.canonicalUrl).toBe('ssh://git@github.com:2222/owner/repo.git');
    const def = loc('ssh://git@github.com:22/owner/repo');
    expect(def.locator!.port).toBeUndefined();
  });

  it('accepts scp-like git@github.com:owner/repo.git and canonicalizes to ssh://', () => {
    const r = loc('git@github.com:owner/repo.git');
    expect(r.ok).toBe(true);
    expect(r.locator!.transport).toBe('ssh');
    expect(r.locator!.canonicalUrl).toBe('ssh://git@github.com/owner/repo.git');
    expect(r.locator!.user).toBe('git');
    expect(r.locator!.host).toBe('github.com');
    expect(r.locator!.path).toBe('/owner/repo.git');
  });

  it('accepts scp-like without user @host:path', () => {
    const r = loc('github.com:owner/repo');
    // This pattern requires user@? Our regex allows optional user, so host=github.com path=owner/repo
    // But our SCP_RE requires host portion before colon, so github.com:owner/repo matches with user undef
    expect(r.ok).toBe(true);
    expect(r.locator!.canonicalUrl).toBe('ssh://github.com/owner/repo');
  });

  it('rejects plaintext http://', () => {
    const r = loc('http://github.com/owner/repo');
    expect(r.ok).toBe(false);
    expect(r.findings[0].code).toBe('GIT_LOCATOR_PLAINTEXT');
  });

  it('rejects git:// transport', () => {
    const r = loc('git://github.com/owner/repo');
    expect(r.ok).toBe(false);
    expect(r.findings[0].code).toBe('GIT_LOCATOR_PLAINTEXT');
  });

  it('rejects file:// local transport', () => {
    const r = loc('file:///tmp/repo');
    expect(r.ok).toBe(false);
    expect(r.findings[0].code).toBe('GIT_LOCATOR_PLAINTEXT');
  });

  it('rejects local absolute path', () => {
    const r = loc('/tmp/repo');
    expect(r.ok).toBe(false);
  });

  it('rejects embedded credentials in https', () => {
    const r = loc('https://user:pass@github.com/owner/repo');
    expect(r.ok).toBe(false);
    expect(r.findings[0].code).toBe('GIT_LOCATOR_CREDENTIAL');
  });

  it('rejects user@ in https (credential)', () => {
    const r = loc('https://user@github.com/owner/repo');
    expect(r.ok).toBe(false);
    expect(r.findings[0].code).toBe('GIT_LOCATOR_CREDENTIAL');
  });

  it('rejects ssh with password', () => {
    const r = loc('ssh://git:secret@github.com/owner/repo');
    expect(r.ok).toBe(false);
    expect(r.findings[0].code).toBe('GIT_LOCATOR_CREDENTIAL');
  });

  it('rejects query string', () => {
    const r = loc('https://github.com/owner/repo?foo=bar');
    expect(r.ok).toBe(false);
    expect(r.findings[0].code).toBe('GIT_LOCATOR_QUERY_FRAGMENT');
  });

  it('rejects fragment', () => {
    const r = loc('https://github.com/owner/repo#frag');
    expect(r.ok).toBe(false);
    expect(r.findings[0].code).toBe('GIT_LOCATOR_QUERY_FRAGMENT');
  });

  it('rejects whitespace', () => {
    const r = loc('https://github.com/owner/repo with space');
    expect(r.ok).toBe(false);
    expect(r.findings[0].code).toBe('GIT_LOCATOR_INVALID');
  });

  it('rejects control characters', () => {
    const r = loc('https://github.com/owner/repo\x01');
    expect(r.ok).toBe(false);
    expect(r.findings[0].code).toBe('GIT_LOCATOR_CONTROL_CHARS');
  });

  it('rejects backslash', () => {
    const r = loc('https://github.com\\owner\\repo');
    expect(r.ok).toBe(false);
  });

  it('rejects ambiguous percent-encoding %2F', () => {
    const r = loc('https://github.com/owner%2Frepo');
    expect(r.ok).toBe(false);
    expect(r.findings[0].code).toBe('GIT_LOCATOR_AMBIGUOUS_ENCODING');
  });

  it('rejects ambiguous %00', () => {
    const r = loc('https://github.com/owner%00repo');
    expect(r.ok).toBe(false);
    expect(r.findings[0].code).toBe('GIT_LOCATOR_AMBIGUOUS_ENCODING');
  });

  it('rejects lone %', () => {
    const r = loc('https://github.com/owner%repo');
    expect(r.ok).toBe(false);
    expect(r.findings[0].code).toBe('GIT_LOCATOR_AMBIGUOUS_ENCODING');
  });

  it('rejects missing path', () => {
    const r = loc('https://github.com/');
    expect(r.ok).toBe(false);
  });

  it('rejects SCP-like with @ in path', () => {
    const r = loc('git@github.com:owner@repo');
    // This would be parsed but we reject due to @ in path? Our check allows? We reject if path contains @
    // But SCP_RE would match host=github.com path=owner@repo — we check path contains @ -> reject
    expect(r.ok).toBe(false);
  });
});
