/**
 * Canonical Git Locator — credential-free HTTPS or SSH repository locator.
 * See CONTEXT.md: Canonical Git Locator.
 *
 * Preserves transport/host/port/path/SSH user.
 * Rejects plaintext/local transports, embedded credentials, query, fragment, ambiguous encoding,
 * whitespace, control characters, backslash.
 */

import { CODE, RULE, blocking, type ValidationFinding } from './findings.js';

export type GitTransport = 'https' | 'ssh';

export interface CanonicalGitLocator {
  /** Original input as provided */
  rawInput: string;
  /** Credential-free canonical URL, e.g. https://github.com/owner/repo or ssh://git@github.com/owner/repo */
  canonicalUrl: string;
  transport: GitTransport;
  host: string;
  port?: number;
  /** Posix path with leading slash, case-sensitive, e.g. /owner/repo.git */
  path: string;
  /** SSH user when transport is ssh, e.g. git */
  user?: string;
}

export interface LocatorResult {
  ok: boolean;
  locator?: CanonicalGitLocator;
  findings: ValidationFinding[];
}

/** Check for control characters (\x00-\x1F, \x7F) */
function hasControlChars(s: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\x00-\x1F\x7F]/.test(s);
}

/** Detect ambiguous percent-encodings that decode to sensitive characters: / \ ? # @ : and NUL */
function hasAmbiguousEncoding(s: string): { bad: boolean; reason?: string } {
  // Detect lone % not forming valid encoding first (before early return)
  if (/%(?![0-9A-Fa-f]{2})/.test(s)) {
    return { bad: true, reason: 'lone % without two hex digits' };
  }
  const pct = s.match(/%[0-9A-Fa-f]{2}/g);
  if (!pct) return { bad: false };
  const sensitive = new Set(['%2f', '%2F', '%5c', '%5C', '%3f', '%3F', '%23', '%00', '%40', '%3a', '%3A', '%2e', '%2E']);
  for (const enc of pct) {
    const low = enc.toLowerCase();
    if (sensitive.has(low)) {
      return { bad: true, reason: `ambiguous percent-encoding '${enc}' decodes to sensitive character` };
    }
  }
  return { bad: false };
}

const SCP_RE = /^(?:(?<user>[A-Za-z0-9._-]+)@)?(?<host>[A-Za-z0-9.-]+):(?<path>[^\0\s?#]+)$/;

function normalizeHost(host: string): string {
  return host.toLowerCase();
}

function normalizePath(path: string): string {
  // Ensure leading slash, collapse duplicate slashes already rejected, keep case, remove trailing slash not needed
  let p = path;
  if (!p.startsWith('/')) p = '/' + p;
  // Remove trailing slash except when path is just "/"
  if (p.length > 1 && p.endsWith('/')) p = p.replace(/\/+$/, '');
  return p;
}

function validateHost(host: string): boolean {
  if (!host || host.length === 0) return false;
  if (host.includes('..')) return false;
  if (!/^[A-Za-z0-9.-]+$/.test(host)) return false;
  if (host.startsWith('.') || host.startsWith('-') || host.endsWith('.') || host.endsWith('-')) return false;
  return true;
}

function validatePath(path: string): { ok: boolean; reason?: string } {
  if (!path || path.length === 0) return { ok: false, reason: 'empty path' };
  if (path.includes('\\')) return { ok: false, reason: 'backslash in path' };
  if (path.includes('//')) return { ok: false, reason: 'double slash in path' };
  if (path.includes('\0')) return { ok: false, reason: 'NUL in path' };
  // Path must be slash-separated segments, each segment non-empty, not "." or "..", no whitespace/control
  const segments = path.split('/').filter((s) => s.length > 0);
  if (segments.length === 0) return { ok: false, reason: 'no path segments' };
  for (const seg of segments) {
    if (seg === '.' || seg === '..') return { ok: false, reason: `dot segment '${seg}'` };
    if (/\s/.test(seg)) return { ok: false, reason: `whitespace in segment '${seg}'` };
    if (/[\x00-\x1F\x7F]/.test(seg)) return { ok: false, reason: `control character in segment '${seg}'` };
  }
  return { ok: true };
}

/** Build a blocking finding for locator */
function locatorFinding(code: string, rule: string, outcome: string): ValidationFinding {
  return blocking({
    code,
    phase: 'validation',
    target: 'source',
    pointer: '',
    rule,
    outcome,
  });
}

/**
 * Normalize a Git Locator to its credential-free canonical form.
 * Preserves transport/host/port/path/SSH user; rejects plaintext, credentials, query/fragment, ambiguous encoding.
 */
export function normalizeGitLocator(input: string): LocatorResult {
  const findings: ValidationFinding[] = [];
  const raw = input;

  if (typeof input !== 'string' || input.length === 0) {
    findings.push(locatorFinding(CODE.GIT_LOCATOR_INVALID, RULE.GIT_LOCATOR_INVALID, 'Git locator is empty'));
    return { ok: false, findings };
  }

  // Control chars
  if (hasControlChars(input)) {
    findings.push(
      locatorFinding(CODE.GIT_LOCATOR_CONTROL_CHARS, RULE.GIT_LOCATOR_CONTROL_CHARS, 'Git locator contains control characters'),
    );
    return { ok: false, findings };
  }

  // Whitespace (space, tab, newline)
  if (/\s/.test(input)) {
    findings.push(
      locatorFinding(CODE.GIT_LOCATOR_INVALID, RULE.GIT_LOCATOR_INVALID, 'Git locator contains whitespace'),
    );
    return { ok: false, findings };
  }

  if (input.includes('\\')) {
    findings.push(
      locatorFinding(CODE.GIT_LOCATOR_INVALID, RULE.GIT_LOCATOR_INVALID, 'Git locator contains backslash'),
    );
    return { ok: false, findings };
  }

  // Query / fragment — any ? or # is rejected (not accepted per spec)
  if (input.includes('?') || input.includes('#')) {
    findings.push(
      locatorFinding(
        CODE.GIT_LOCATOR_QUERY_FRAGMENT,
        RULE.GIT_LOCATOR_QUERY_FRAGMENT,
        'Git locator must not contain query (?) or fragment (#)',
      ),
    );
    return { ok: false, findings };
  }

  // Ambiguous encoding
  const amb = hasAmbiguousEncoding(input);
  if (amb.bad) {
    findings.push(
      locatorFinding(
        CODE.GIT_LOCATOR_AMBIGUOUS_ENCODING,
        RULE.GIT_LOCATOR_AMBIGUOUS_ENCODING,
        `Git locator has ambiguous encoding: ${amb.reason}`,
      ),
    );
    return { ok: false, findings };
  }

  // Detect plaintext/local transports early by checking scheme
  // If input contains "://", parse scheme
  const hasScheme = input.includes('://');

  // SCP-like handling (no scheme, contains @ and : before slash)
  if (!hasScheme) {
    // Check if it looks like a local path or file:// without scheme
    if (input.startsWith('/') || input.startsWith('.') || input.startsWith('file:')) {
      findings.push(
        locatorFinding(CODE.GIT_LOCATOR_PLAINTEXT, RULE.GIT_LOCATOR_PLAINTEXT, `Git locator transport is not allowed: local/file transport rejected — use https:// or ssh://`),
      );
      return { ok: false, findings };
    }
    const m = input.match(SCP_RE);
    if (m && m.groups) {
      const user = m.groups.user;
      const host = normalizeHost(m.groups.host);
      let path = m.groups.path;
      // path from scp is like owner/repo.git without leading slash; ensure we treat
      if (path.startsWith('/')) {
        findings.push(
          locatorFinding(CODE.GIT_LOCATOR_INVALID, RULE.GIT_LOCATOR_INVALID, 'SCP-like path must not start with /'),
        );
        return { ok: false, findings };
      }
      // Check for embedded credentials: path should not contain @ or : beyond the initial separator
      if (path.includes('@')) {
        findings.push(
          locatorFinding(CODE.GIT_LOCATOR_CREDENTIAL, RULE.GIT_LOCATOR_CREDENTIAL, 'SCP-like locator must not contain @ in path (embedded credential)'),
        );
        return { ok: false, findings };
      }
      if (!validateHost(host)) {
        findings.push(locatorFinding(CODE.GIT_LOCATOR_INVALID, RULE.GIT_LOCATOR_INVALID, `invalid host '${host}'`));
        return { ok: false, findings };
      }
      const normPath = normalizePath(path);
      const pathCheck = validatePath(normPath);
      if (!pathCheck.ok) {
        findings.push(
          locatorFinding(CODE.GIT_LOCATOR_INVALID, RULE.GIT_LOCATOR_INVALID, `invalid path '${path}': ${pathCheck.reason}`),
        );
        return { ok: false, findings };
      }
      const canonicalUrl = user ? `ssh://${user}@${host}${normPath}` : `ssh://${host}${normPath}`;
      return {
        ok: true,
        findings: [],
        locator: {
          rawInput: raw,
          canonicalUrl,
          transport: 'ssh',
          host,
          path: normPath,
          user,
        },
      };
    }
    // No scheme and not SCP => invalid
    findings.push(
      locatorFinding(CODE.GIT_LOCATOR_INVALID, RULE.GIT_LOCATOR_INVALID, 'Git locator must be https://, ssh://, or scp-like user@host:path — missing scheme'),
    );
    return { ok: false, findings };
  }

  // Has scheme: parse via URL
  let url: URL;
  try {
    url = new URL(input);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    findings.push(locatorFinding(CODE.GIT_LOCATOR_INVALID, RULE.GIT_LOCATOR_INVALID, `unable to parse locator: ${msg}`));
    return { ok: false, findings };
  }

  const scheme = url.protocol; // includes colon, e.g. "https:"
  if (scheme === 'http:') {
    findings.push(
      locatorFinding(
        CODE.GIT_LOCATOR_PLAINTEXT,
        RULE.GIT_LOCATOR_PLAINTEXT,
        'plaintext http:// transport is not allowed — use https://',
      ),
    );
    return { ok: false, findings };
  }
  if (scheme === 'ftp:' || scheme === 'file:' || scheme === 'git:') {
    findings.push(
      locatorFinding(CODE.GIT_LOCATOR_PLAINTEXT, RULE.GIT_LOCATOR_PLAINTEXT, `transport '${scheme.slice(0, -1)}' is not allowed — use https:// or ssh://`),
    );
    return { ok: false, findings };
  }
  if (scheme !== 'https:' && scheme !== 'ssh:') {
    findings.push(
      locatorFinding(CODE.GIT_LOCATOR_INVALID, RULE.GIT_LOCATOR_INVALID, `unsupported transport '${scheme.slice(0, -1)}' — use https:// or ssh://`),
    );
    return { ok: false, findings };
  }

  // Credentials check
  if (scheme === 'https:' && (url.username.length > 0 || url.password.length > 0)) {
    findings.push(
      locatorFinding(
        CODE.GIT_LOCATOR_CREDENTIAL,
        RULE.GIT_LOCATOR_CREDENTIAL,
        'https locator must not contain embedded credentials (user:pass@)',
      ),
    );
    return { ok: false, findings };
  }
  if (scheme === 'ssh:' && url.password.length > 0) {
    findings.push(
      locatorFinding(
        CODE.GIT_LOCATOR_CREDENTIAL,
        RULE.GIT_LOCATOR_CREDENTIAL,
        'ssh locator must not contain password (user:pass@)',
      ),
    );
    return { ok: false, findings };
  }

  // Query/fragment already rejected, but double-check URL search/hash
  if (url.search.length > 0 || url.hash.length > 0) {
    findings.push(
      locatorFinding(
        CODE.GIT_LOCATOR_QUERY_FRAGMENT,
        RULE.GIT_LOCATOR_QUERY_FRAGMENT,
        'Git locator must not contain query or fragment',
      ),
    );
    return { ok: false, findings };
  }

  const host = normalizeHost(url.hostname);
  if (!validateHost(host)) {
    findings.push(locatorFinding(CODE.GIT_LOCATOR_INVALID, RULE.GIT_LOCATOR_INVALID, `invalid host '${host}'`));
    return { ok: false, findings };
  }

  // Port handling
  let port: number | undefined;
  if (url.port) {
    const p = Number(url.port);
    if (!Number.isInteger(p) || p <= 0 || p > 65535) {
      findings.push(locatorFinding(CODE.GIT_LOCATOR_INVALID, RULE.GIT_LOCATOR_INVALID, `invalid port '${url.port}'`));
      return { ok: false, findings };
    }
    port = p;
    // For https, default 443 may be omitted in canonical? Keep only if non-default for simplicity preserve as given
    // For ssh, default 22 omitted
    if ((scheme === 'https:' && port === 443) || (scheme === 'ssh:' && port === 22)) {
      port = undefined; // omit default
    }
  }

  const rawPath = url.pathname; // includes leading slash
  // For ssh/https, pathname must be at least /something
  if (!rawPath || rawPath === '/') {
    findings.push(locatorFinding(CODE.GIT_LOCATOR_INVALID, RULE.GIT_LOCATOR_INVALID, 'Git locator path is empty — expected /owner/repo'));
    return { ok: false, findings };
  }
  const normPath = normalizePath(rawPath);
  const pathCheck = validatePath(normPath);
  if (!pathCheck.ok) {
    findings.push(
      locatorFinding(CODE.GIT_LOCATOR_INVALID, RULE.GIT_LOCATOR_INVALID, `invalid path '${rawPath}': ${pathCheck.reason}`),
    );
    return { ok: false, findings };
  }

  // Check ambiguous encoding in path already done via raw input, but also check pathname
  // User part: for ssh, preserve
  const user = url.username || undefined;

  // Build canonical URL
  let canonicalUrl: string;
  const transport: GitTransport = scheme === 'https:' ? 'https' : 'ssh';
  if (transport === 'https') {
    canonicalUrl = `https://${host}${port ? `:${port}` : ''}${normPath}`;
  } else {
    canonicalUrl = `ssh://${user ? `${user}@` : ''}${host}${port ? `:${port}` : ''}${normPath}`;
  }

  return {
    ok: true,
    findings: [],
    locator: {
      rawInput: raw,
      canonicalUrl,
      transport,
      host,
      port,
      path: normPath,
      user,
    },
  };
}

/** Check if a locator string is canonical (already normalized). */
export function isCanonicalGitLocator(canonical: string): boolean {
  const res = normalizeGitLocator(canonical);
  return res.ok && res.locator!.canonicalUrl === canonical;
}
