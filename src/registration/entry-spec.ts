/**
 * Git-family entry spec parsing — the only surviving slice of Entry Acquisition.
 *
 * Catalog entries are never acquired (#87): a git-family or unsupported source kind is
 * classified as an Unavailable Entry and disclosed with a reason. This module parses and
 * validates the declared source shape so the dual-format catalog parsers can classify
 * `github` / `url` / `git-subdir` / `git` entries and reject npm / archive / command /
 * bare / unresolvable forms — never silently skipping and never executing anything.
 */

import { CODE, RULE, blocking, type ValidationFinding } from './findings.js';
import {
  normalizeGitLocator,
  type CanonicalGitLocator,
} from './git-locator.js';
import {
  normalizeGitSelector,
  type NormalizedGitSelector,
} from './git-selector.js';

export type GitEntryShape = 'github' | 'url' | 'git-subdir';

export interface RawGitEntrySource {
  source?: string;
  repo?: string;
  url?: string;
  path?: string;
  subpath?: string;
  ref?: string;
  sha?: string;
  branch?: string;
  tag?: string;
  commit?: string;
  [key: string]: unknown;
}

export interface NormalizedGitEntrySpec {
  shape: GitEntryShape;
  locator: CanonicalGitLocator;
  selector: NormalizedGitSelector;
  effectivePin: 'sha' | 'ref' | 'default';
  verifiedRef?: NormalizedGitSelector;
  subpath?: string;
  rawSource: unknown;
}

export interface ParseGitEntryResult {
  ok: boolean;
  isGitFamily: boolean;
  spec?: NormalizedGitEntrySpec;
  findings: ValidationFinding[];
  unavailableReason?: string;
}

const GITHUB_SHORTHAND_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function entryFinding(
  code: string,
  rule: string,
  pointer: string,
  outcome: string,
): ValidationFinding {
  return blocking({
    code,
    rule,
    phase: 'validation',
    target: 'entry',
    pointer,
    outcome,
  });
}

/** Check ref name syntax */
function isValidRefSyntax(ref: string): { ok: boolean; reason?: string } {
  if (!ref || ref.length === 0) return { ok: false, reason: 'empty ref' };
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F]/.test(ref)) return { ok: false, reason: 'contains control character' };
  if (/\s/.test(ref)) return { ok: false, reason: 'contains whitespace' };
  if (ref.startsWith('-')) return { ok: false, reason: 'option-like' };
  if (ref.includes('\\')) return { ok: false, reason: 'contains backslash' };
  if (ref.includes('..')) return { ok: false, reason: 'contains double dot ..' };
  if (ref.includes('//')) return { ok: false, reason: 'contains double slash //' };
  if (ref.includes('@{')) return { ok: false, reason: 'contains reflog @{' };
  if (/[~^:?*\[\\]/.test(ref)) return { ok: false, reason: 'contains invalid revision characters ~ ^ : ? * [ \\' };
  if (ref.startsWith('.') || ref.startsWith('/')) return { ok: false, reason: 'starts with . or /' };
  if (ref.endsWith('.') || ref.endsWith('/') || ref.endsWith('.lock')) return { ok: false, reason: 'ends with . / or .lock' };
  if (ref === 'HEAD' || ref === 'head') return { ok: false, reason: 'HEAD is not allowed as ref' };
  return { ok: true };
}

/**
 * Normalize an entry's Git locator.
 * Expands `owner/repo` shorthand to `https://github.com/owner/repo`.
 * Enforces HTTPS/SSH, rejects plaintext, credentials, query/fragment, control chars.
 */
export function normalizeEntryLocator(
  rawLocator: string,
  entryId = '/plugins/0',
): { ok: boolean; locator?: CanonicalGitLocator; findings: ValidationFinding[]; isShorthand?: boolean } {
  if (typeof rawLocator !== 'string' || rawLocator.trim().length === 0) {
    return {
      ok: false,
      findings: [entryFinding(CODE.GIT_LOCATOR_INVALID, RULE.GIT_LOCATOR_INVALID, `${entryId}/source`, 'locator is empty')],
    };
  }

  const trimmed = rawLocator.trim();

  // Check shorthand owner/repo pattern: no scheme, no @ (not scp), contains 1 slash
  if (!trimmed.includes('://') && !trimmed.includes('@') && GITHUB_SHORTHAND_RE.test(trimmed)) {
    const expanded = `https://github.com/${trimmed}`;
    const res = normalizeGitLocator(expanded);
    if (!res.ok) {
      const findings = res.findings.map((f) => entryFinding(f.code, f.rule, `${entryId}/source`, f.outcome));
      return { ok: false, findings, isShorthand: true };
    }
    return { ok: true, locator: res.locator, findings: [], isShorthand: true };
  }

  // Normal git locator
  const res = normalizeGitLocator(trimmed);
  if (!res.ok) {
    const findings = res.findings.map((f) => entryFinding(f.code, f.rule, `${entryId}/source`, f.outcome));
    return { ok: false, findings };
  }

  return { ok: true, locator: res.locator, findings: [] };
}

/**
 * Resolve an entry's Git selector and effective pin.
 * Pin matrix:
 * - `sha` / `commit` present: commit selector (complete 40/64 hex), effectivePin = 'sha'
 * - `ref` / `branch` / `tag` present (no sha): branch/tag selector, effectivePin = 'ref'
 * - neither present: default selector, effectivePin = 'default'
 * - both `sha` and `ref` present: `sha` is effective pin; `ref` is validated for syntax
 */
export function resolveEntrySelector(
  rawSource: Record<string, unknown>,
  entryId = '/plugins/0',
): {
  ok: boolean;
  selector?: NormalizedGitSelector;
  effectivePin: 'sha' | 'ref' | 'default';
  verifiedRef?: NormalizedGitSelector;
  findings: ValidationFinding[];
} {
  const findings: ValidationFinding[] = [];
  const rawSha = rawSource.sha ?? rawSource.commit;
  const rawRef = rawSource.ref ?? rawSource.branch ?? rawSource.tag;

  // 1. If sha / commit is present
  if (rawSha !== undefined && rawSha !== null && rawSha !== '') {
    const shaStr = String(rawSha);
    // Validate commit hex format
    const selRes = normalizeGitSelector({ kind: 'commit', value: shaStr });
    if (!selRes.ok) {
      findings.push(
        ...selRes.findings.map((f) => entryFinding(f.code, f.rule, `${entryId}/sha`, f.outcome)),
      );
      return { ok: false, effectivePin: 'sha', findings };
    }

    let verifiedRef: NormalizedGitSelector | undefined;
    // When ref is ALSO present, validate ref for syntax ("並存時 sha 有效、ref 僅驗證不綁定")
    if (rawRef !== undefined && rawRef !== null && rawRef !== '') {
      const refStr = String(rawRef);
      const syntax = isValidRefSyntax(refStr);
      if (!syntax.ok) {
        findings.push(
          entryFinding(
            CODE.GIT_SELECTOR_INVALID,
            RULE.GIT_SELECTOR_INVALID,
            `${entryId}/ref`,
            `invalid ref '${refStr}': ${syntax.reason}`,
          ),
        );
        return { ok: false, effectivePin: 'sha', findings };
      }

      // Try normalizing ref
      if (rawSource.branch !== undefined) {
        const bRes = normalizeGitSelector({ kind: 'branch', value: String(rawSource.branch) });
        if (!bRes.ok) {
          findings.push(...bRes.findings.map((f) => entryFinding(f.code, f.rule, `${entryId}/branch`, f.outcome)));
          return { ok: false, effectivePin: 'sha', findings };
        }
        verifiedRef = bRes.selector;
      } else if (rawSource.tag !== undefined) {
        const tRes = normalizeGitSelector({ kind: 'tag', value: String(rawSource.tag) });
        if (!tRes.ok) {
          findings.push(...tRes.findings.map((f) => entryFinding(f.code, f.rule, `${entryId}/tag`, f.outcome)));
          return { ok: false, effectivePin: 'sha', findings };
        }
        verifiedRef = tRes.selector;
      } else {
        if (refStr.startsWith('refs/heads/')) {
          verifiedRef = { kind: 'branch', canonical: refStr, raw: refStr };
        } else if (refStr.startsWith('refs/tags/')) {
          verifiedRef = { kind: 'tag', canonical: refStr, raw: refStr };
        } else if (refStr.startsWith('v') && /^[0-9]/.test(refStr.slice(1))) {
          verifiedRef = { kind: 'tag', canonical: `refs/tags/${refStr}`, raw: refStr };
        } else {
          verifiedRef = { kind: 'branch', canonical: `refs/heads/${refStr}`, raw: refStr };
        }
      }
    }

    return {
      ok: true,
      selector: selRes.selector!,
      effectivePin: 'sha',
      verifiedRef,
      findings: [],
    };
  }

  // 2. If ref / branch / tag is present (without sha)
  if (rawRef !== undefined && rawRef !== null && rawRef !== '') {
    if (rawSource.branch !== undefined) {
      const bRes = normalizeGitSelector({ kind: 'branch', value: String(rawSource.branch) });
      if (!bRes.ok) {
        findings.push(...bRes.findings.map((f) => entryFinding(f.code, f.rule, `${entryId}/branch`, f.outcome)));
        return { ok: false, effectivePin: 'ref', findings };
      }
      return { ok: true, selector: bRes.selector!, effectivePin: 'ref', findings: [] };
    }

    if (rawSource.tag !== undefined) {
      const tRes = normalizeGitSelector({ kind: 'tag', value: String(rawSource.tag) });
      if (!tRes.ok) {
        findings.push(...tRes.findings.map((f) => entryFinding(f.code, f.rule, `${entryId}/tag`, f.outcome)));
        return { ok: false, effectivePin: 'ref', findings };
      }
      return { ok: true, selector: tRes.selector!, effectivePin: 'ref', findings: [] };
    }

    const refStr = String(rawRef);
    const syntax = isValidRefSyntax(refStr);
    if (!syntax.ok) {
      findings.push(
        entryFinding(
          CODE.GIT_SELECTOR_INVALID,
          RULE.GIT_SELECTOR_INVALID,
          `${entryId}/ref`,
          `invalid ref '${refStr}': ${syntax.reason}`,
        ),
      );
      return { ok: false, effectivePin: 'ref', findings };
    }

    let selector: NormalizedGitSelector;
    if (refStr.startsWith('refs/heads/')) {
      selector = { kind: 'branch', canonical: refStr, raw: refStr };
    } else if (refStr.startsWith('refs/tags/')) {
      selector = { kind: 'tag', canonical: refStr, raw: refStr };
    } else if (refStr.startsWith('branch:')) {
      const bRes = normalizeGitSelector({ kind: 'branch', value: refStr.slice(7) });
      if (!bRes.ok) {
        findings.push(...bRes.findings.map((f) => entryFinding(f.code, f.rule, `${entryId}/ref`, f.outcome)));
        return { ok: false, effectivePin: 'ref', findings };
      }
      selector = bRes.selector!;
    } else if (refStr.startsWith('tag:')) {
      const tRes = normalizeGitSelector({ kind: 'tag', value: refStr.slice(4) });
      if (!tRes.ok) {
        findings.push(...tRes.findings.map((f) => entryFinding(f.code, f.rule, `${entryId}/ref`, f.outcome)));
        return { ok: false, effectivePin: 'ref', findings };
      }
      selector = tRes.selector!;
    } else if (refStr.startsWith('v') && /^[0-9]/.test(refStr.slice(1))) {
      selector = { kind: 'tag', canonical: `refs/tags/${refStr}`, raw: refStr };
    } else {
      selector = { kind: 'branch', canonical: `refs/heads/${refStr}`, raw: refStr };
    }

    return { ok: true, selector, effectivePin: 'ref', findings: [] };
  }

  // 3. Neither sha nor ref: movable default selector
  return {
    ok: true,
    selector: { kind: 'default', canonical: 'default', raw: 'default' },
    effectivePin: 'default',
    findings: [],
  };
}

/**
 * Parse and validate a raw entry source into NormalizedGitEntrySpec.
 * Distinguishes local vs external git vs unavailable forms (npm/archive/command/bare).
 */
export function parseGitEntrySpec(entrySource: unknown, entryId = '/plugins/0'): ParseGitEntryResult {
  const findings: ValidationFinding[] = [];

  if (entrySource === undefined || entrySource === null || entrySource === '') {
    return {
      ok: false,
      isGitFamily: false,
      findings: [],
      unavailableReason: 'no source declared',
    };
  }

  // Case 1: string source
  if (typeof entrySource === 'string') {
    const s = entrySource.trim();
    if (s.startsWith('./')) {
      return {
        ok: false,
        isGitFamily: false,
        findings: [],
      };
    }

    // Shorthand owner/repo
    if (GITHUB_SHORTHAND_RE.test(s)) {
      const locRes = normalizeEntryLocator(s, entryId);
      if (!locRes.ok) {
        return { ok: false, isGitFamily: true, findings: locRes.findings };
      }
      const spec: NormalizedGitEntrySpec = {
        shape: 'github',
        locator: locRes.locator!,
        selector: { kind: 'default', canonical: 'default', raw: 'default' },
        effectivePin: 'default',
        rawSource: entrySource,
      };
      return { ok: true, isGitFamily: true, spec, findings: [] };
    }

    // Full URL or protocol string
    if (s.includes('://') || s.includes('@')) {
      const locRes = normalizeEntryLocator(s, entryId);
      if (!locRes.ok) {
        return { ok: false, isGitFamily: true, findings: locRes.findings };
      }
      const spec: NormalizedGitEntrySpec = {
        shape: 'url',
        locator: locRes.locator!,
        selector: { kind: 'default', canonical: 'default', raw: 'default' },
        effectivePin: 'default',
        rawSource: entrySource,
      };
      return { ok: true, isGitFamily: true, spec, findings: [] };
    }

    // Bare name or other unresolvable string
    if (!s.includes('/')) {
      return {
        ok: false,
        isGitFamily: false,
        findings: [],
        unavailableReason: 'bare name source cannot resolve without metadata.pluginRoot, which is unsupported',
      };
    }

    return {
      ok: false,
      isGitFamily: false,
      findings: [],
      unavailableReason: 'source must start with ./ to be locally resolvable',
    };
  }

  // Case 2: object source
  if (isMapping(entrySource)) {
    const raw = entrySource as RawGitEntrySource;
    const sourceKind = typeof raw.source === 'string' ? raw.source.toLowerCase() : undefined;

    // npm / archive / command are unavailable
    if (sourceKind === 'npm') {
      return { ok: false, isGitFamily: false, findings: [], unavailableReason: 'npm source entries are not supported' };
    }
    if (sourceKind === 'archive') {
      return { ok: false, isGitFamily: false, findings: [], unavailableReason: 'archive source entries are not supported' };
    }
    if (sourceKind === 'command') {
      return { ok: false, isGitFamily: false, findings: [], unavailableReason: 'command source entries are permanently disqualified' };
    }

    // github shape
    if (sourceKind === 'github') {
      if (typeof raw.repo !== 'string' || raw.repo.trim().length === 0) {
        findings.push(
          entryFinding(CODE.GIT_LOCATOR_INVALID, RULE.GIT_LOCATOR_INVALID, `${entryId}/repo`, 'github source requires a non-empty repo string'),
        );
        return { ok: false, isGitFamily: true, findings };
      }

      const locRes = normalizeEntryLocator(raw.repo, entryId);
      if (!locRes.ok) {
        return { ok: false, isGitFamily: true, findings: locRes.findings };
      }

      const selRes = resolveEntrySelector(raw, entryId);
      if (!selRes.ok) {
        return { ok: false, isGitFamily: true, findings: selRes.findings };
      }

      const subpath = typeof raw.subpath === 'string' ? raw.subpath : typeof raw.path === 'string' && !raw.path.startsWith('./') ? raw.path : undefined;

      const spec: NormalizedGitEntrySpec = {
        shape: 'github',
        locator: locRes.locator!,
        selector: selRes.selector!,
        effectivePin: selRes.effectivePin,
        verifiedRef: selRes.verifiedRef,
        subpath,
        rawSource: entrySource,
      };
      return { ok: true, isGitFamily: true, spec, findings: [] };
    }

    // url shape
    if (sourceKind === 'url') {
      if (typeof raw.url !== 'string' || raw.url.trim().length === 0) {
        findings.push(
          entryFinding(CODE.GIT_LOCATOR_INVALID, RULE.GIT_LOCATOR_INVALID, `${entryId}/url`, 'url source requires a non-empty url string'),
        );
        return { ok: false, isGitFamily: true, findings };
      }

      const locRes = normalizeEntryLocator(raw.url, entryId);
      if (!locRes.ok) {
        return { ok: false, isGitFamily: true, findings: locRes.findings };
      }

      const selRes = resolveEntrySelector(raw, entryId);
      if (!selRes.ok) {
        return { ok: false, isGitFamily: true, findings: selRes.findings };
      }

      const subpath = typeof raw.subpath === 'string' ? raw.subpath : typeof raw.path === 'string' && !raw.path.startsWith('./') ? raw.path : undefined;

      const spec: NormalizedGitEntrySpec = {
        shape: 'url',
        locator: locRes.locator!,
        selector: selRes.selector!,
        effectivePin: selRes.effectivePin,
        verifiedRef: selRes.verifiedRef,
        subpath,
        rawSource: entrySource,
      };
      return { ok: true, isGitFamily: true, spec, findings: [] };
    }

    // git-subdir shape
    if (sourceKind === 'git-subdir') {
      const targetUrl = typeof raw.url === 'string' ? raw.url : typeof raw.repo === 'string' ? raw.repo : undefined;
      if (!targetUrl || targetUrl.trim().length === 0) {
        findings.push(
          entryFinding(CODE.GIT_LOCATOR_INVALID, RULE.GIT_LOCATOR_INVALID, `${entryId}/url`, 'git-subdir requires a non-empty url or repo string'),
        );
        return { ok: false, isGitFamily: true, findings };
      }

      const locRes = normalizeEntryLocator(targetUrl, entryId);
      if (!locRes.ok) {
        return { ok: false, isGitFamily: true, findings: locRes.findings };
      }

      const rawPath = typeof raw.path === 'string' ? raw.path : typeof raw.subpath === 'string' ? raw.subpath : undefined;
      if (!rawPath || rawPath.trim().length === 0) {
        findings.push(
          entryFinding(CODE.PATH_CONTAINMENT_VIOLATION, RULE.PATH_CONTAINMENT_VIOLATION, `${entryId}/path`, 'git-subdir requires a non-empty path string'),
        );
        return { ok: false, isGitFamily: true, findings };
      }

      const selRes = resolveEntrySelector(raw, entryId);
      if (!selRes.ok) {
        return { ok: false, isGitFamily: true, findings: selRes.findings };
      }

      const spec: NormalizedGitEntrySpec = {
        shape: 'git-subdir',
        locator: locRes.locator!,
        selector: selRes.selector!,
        effectivePin: selRes.effectivePin,
        verifiedRef: selRes.verifiedRef,
        subpath: rawPath.trim(),
        rawSource: entrySource,
      };
      return { ok: true, isGitFamily: true, spec, findings: [] };
    }

    // Codex git kind compatibility: { source: "git", url: "..." }
    if (sourceKind === 'git') {
      if (typeof raw.url !== 'string' || raw.url.trim().length === 0) {
        findings.push(
          entryFinding(CODE.GIT_LOCATOR_INVALID, RULE.GIT_LOCATOR_INVALID, `${entryId}/url`, 'git source requires a non-empty url string'),
        );
        return { ok: false, isGitFamily: true, findings };
      }

      const locRes = normalizeEntryLocator(raw.url, entryId);
      if (!locRes.ok) {
        return { ok: false, isGitFamily: true, findings: locRes.findings };
      }

      const selRes = resolveEntrySelector(raw, entryId);
      if (!selRes.ok) {
        return { ok: false, isGitFamily: true, findings: selRes.findings };
      }

      const subpath = typeof raw.path === 'string' && !raw.path.startsWith('./') ? raw.path : typeof raw.subpath === 'string' ? raw.subpath : undefined;

      const spec: NormalizedGitEntrySpec = {
        shape: 'url',
        locator: locRes.locator!,
        selector: selRes.selector!,
        effectivePin: selRes.effectivePin,
        verifiedRef: selRes.verifiedRef,
        subpath,
        rawSource: entrySource,
      };
      return { ok: true, isGitFamily: true, spec, findings: [] };
    }

    // Unknown discriminator
    return {
      ok: false,
      isGitFamily: false,
      findings: [],
      unavailableReason: 'unknown entry source kind',
    };
  }

  return {
    ok: false,
    isGitFamily: false,
    findings: [],
    unavailableReason: 'unrecognized source form',
  };
}