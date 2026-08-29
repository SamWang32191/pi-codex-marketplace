/**
 * Claude Marketplace Catalog — canonical `.claude-plugin/marketplace.json` object within a
 * Marketplace Root registered with Marketplace Format 'claude'.
 * See CONTEXT.md: Marketplace Catalog, Marketplace Entry, Marketplace Entry ID, Unavailable Entry.
 *
 * Structural/catalog-identity failures are Blocking (deny Registration); per-entry inability to
 * resolve to a plugin is an Unavailable Entry (disclosed, non-blocking). Entry IDs reuse the
 * codex-side rule `/plugins/<zero-based ordinal>` so snapshot-scoped identity is format-uniform.
 *
 * Source dispatch (day 1): only `./`-prefixed relative-path strings are locally resolvable
 * candidates. Bare names and `metadata.pluginRoot` resolution, external git-family sources
 * (github/url/git-subdir), npm/archive sources, and entry-defined plugins (`strict:false`) all
 * become Unavailable Entries with stable reasons; command sources are permanently disqualified.
 * No remote content is fetched anywhere in this module.
 *
 * Open field policy (#87 §7 / #91): unknown fields are always ignored and never block —
 * including officially released claude fields such as `renames` and inert presentation metadata.
 * Only the members this parser structurally interprets (`name`, `owner` identity, `metadata`
 * shape, `plugins`, per-entry `source`/`strict`) are read; everything else is discarded. The
 * v2 closed-field checks (unknown-field Blocking, inert-field Warnings, named active-component
 * Blocking) have retired: the minimal install path records and projects skills only and never
 * executes declared components, so they can neither deny Registration nor mark an entry
 * Unavailable.
 */

import { CODE, RULE, blocking, type ValidationFinding } from './findings.js';
import { BUDGET } from './budget.js';
import {
  KEBAB_NAME_RE,
  GIT_FAMILY_UNAVAILABLE_REASON,
  type Catalog,
  type CatalogResult,
  type MarketplaceEntry,
} from './catalog.js';
import { parseGitEntrySpec } from './entry-spec.js';

/**
 * Snapshot-relative location of the claude Marketplace Catalog within a Marketplace Root.
 * Consumed by format detection / registration-flow wiring (issue #47); declared beside the
 * parser so the canonical path has exactly one definition.
 */
export const CLAUDE_MARKETPLACE_CATALOG_RELPATH = '.claude-plugin/marketplace.json';

/**
 * Stable Unavailable Entry reasons for non-local claude entry source forms (day 1).
 *
 * Tests intentionally re-declare these literals instead of importing them: the reason strings
 * are the disclosed Unavailable Entry contract, so a literal here pins the wording — if the
 * implementation drifts, the table-driven matrix fails rather than comparing the implementation
 * against itself.
 */
export const CLAUDE_UNAVAILABLE_REASON = {
  bareName: 'bare name source cannot resolve without metadata.pluginRoot, which is unsupported',
  pluginRoot: 'pluginRoot-dependent source resolution is unsupported',
  notLocalPath: 'source must start with ./ to be locally resolvable',
  noSource: 'no source declared',
  unrecognizedForm: 'unrecognized source form',
  unknownKind: 'unknown entry source kind',
  gitFamily: GIT_FAMILY_UNAVAILABLE_REASON,
  npm: 'npm source entries are not supported',
  archive: 'archive source entries are not supported',
  command: 'command source entries are permanently disqualified',
  strictFalse: 'entry-defined plugin (strict: false) is not supported',
  malformedEntry: 'malformed entry',
} as const;

function catalogFinding(
  code: string,
  rule: string,
  pointer: string,
  outcome: string,
): ValidationFinding {
  return blocking({ code, rule, phase: 'validation', target: 'catalog', pointer, outcome });
}

function entryFinding(
  code: string,
  rule: string,
  pointer: string,
  outcome: string,
): ValidationFinding {
  return blocking({ code, rule, phase: 'validation', target: 'entry', pointer, outcome });
}

function unavailable(entryId: string, ordinal: number, name: string | undefined, type: MarketplaceEntry['type'], reason: string, source?: unknown): MarketplaceEntry {
  return { entryId, ordinal, name, type, source, available: false, unavailableReason: reason };
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Dispatch one claude entry's `source` declaration to its availability outcome.
 * Pure structural classification — never touches the filesystem or network.
 */
function classifySource(
  source: unknown,
  hasPluginRoot: boolean,
  entryId = '/plugins/0',
): { type: MarketplaceEntry['type']; path?: string; source?: unknown; available: boolean; reason?: string; findings?: ValidationFinding[] } {
  if (source === undefined || source === null || source === '') {
    return { type: 'unsupported', available: false, reason: CLAUDE_UNAVAILABLE_REASON.noSource };
  }
  if (typeof source === 'string') {
    if (source.startsWith('./')) return { type: 'local', path: source, available: true };
    // A bare name (no "/") depends on metadata.pluginRoot; any other slash-bearing form is not a
    // valid local declaration at all.
    if (!source.includes('/')) {
      return {
        type: 'unsupported',
        available: false,
        reason: hasPluginRoot ? CLAUDE_UNAVAILABLE_REASON.pluginRoot : CLAUDE_UNAVAILABLE_REASON.bareName,
      };
    }
    return { type: 'unsupported', available: false, reason: CLAUDE_UNAVAILABLE_REASON.notLocalPath };
  }
  if (isMapping(source)) {
    const rawKind = typeof source.source === 'string' ? source.source.toLowerCase() : undefined;
    if (rawKind === 'npm') {
      return { type: 'unsupported', source, available: false, reason: CLAUDE_UNAVAILABLE_REASON.npm };
    }
    if (rawKind === 'archive') {
      return { type: 'unsupported', source, available: false, reason: CLAUDE_UNAVAILABLE_REASON.archive };
    }
    if (rawKind === 'command') {
      return { type: 'unsupported', source, available: false, reason: CLAUDE_UNAVAILABLE_REASON.command };
    }
    const parsed = parseGitEntrySpec(source, entryId);
    if (parsed.isGitFamily) {
      if (parsed.ok) {
        return { type: 'git', source, available: true };
      }
      return { type: 'git', source, available: false, reason: parsed.unavailableReason ?? 'invalid git entry', findings: parsed.findings };
    }
    return { type: 'unsupported', source, available: false, reason: CLAUDE_UNAVAILABLE_REASON.unknownKind };
  }
  return { type: 'unsupported', available: false, reason: CLAUDE_UNAVAILABLE_REASON.unrecognizedForm };
}

/**
 * Parse a parsed `.claude-plugin/marketplace.json` object structurally.
 * Mirrors `parseCatalog`'s contract: Blocking findings deny Registration (ok=false); Unavailable
 * Entries disclose per-entry inability to supply an activatable Plugin without blocking.
 */
export function parseClaudeCatalog(obj: unknown): CatalogResult {
  const findings: ValidationFinding[] = [];

  if (!isMapping(obj)) {
    return {
      ok: false,
      findings: [
        catalogFinding(CODE.CATALOG_MALFORMED, RULE.CATALOG_MALFORMED, '/', 'marketplace.json is not an object'),
      ],
    };
  }
  const o = obj;

  if (typeof o.name !== 'string' || o.name.trim().length === 0) {
    findings.push(
      catalogFinding(CODE.CATALOG_NAME_INVALID, RULE.CATALOG_NAME_INVALID, '/name', 'declared marketplace name is missing'),
    );
  } else if (!KEBAB_NAME_RE.test(o.name.trim())) {
    findings.push(
      catalogFinding(CODE.CATALOG_NAME_INVALID, RULE.CATALOG_NAME_INVALID, '/name', `declared marketplace name '${o.name}' is not lowercase kebab-case`),
    );
  }

  if (!isMapping(o.owner)) {
    findings.push(
      catalogFinding(CODE.CATALOG_OWNER_INVALID, RULE.CATALOG_OWNER_INVALID, '/owner', 'declared owner is missing or not an object'),
    );
  } else {
    if (typeof o.owner.name !== 'string' || o.owner.name.trim().length === 0) {
      findings.push(
        catalogFinding(CODE.CATALOG_OWNER_INVALID, RULE.CATALOG_OWNER_INVALID, '/owner/name', 'owner requires a non-empty name'),
      );
    }
  }

  let hasPluginRoot = false;
  if (Object.hasOwn(o, 'metadata')) {
    if (!isMapping(o.metadata)) {
      findings.push(
        catalogFinding(CODE.CATALOG_MALFORMED, RULE.CATALOG_MALFORMED, '/metadata', 'metadata must be an object when declared'),
      );
    } else {
      // Open policy: only pluginRoot changes parsing; every other member is ignored.
      hasPluginRoot = typeof o.metadata.pluginRoot === 'string' && o.metadata.pluginRoot.length > 0;
    }
  }

  if (!Array.isArray(o.plugins)) {
    findings.push(
      catalogFinding(CODE.CATALOG_MALFORMED, RULE.CATALOG_MALFORMED, '/plugins', 'plugins is not an array'),
    );
    return { ok: false, findings };
  }

  if (o.plugins.length > BUDGET.maxEntries) {
    return {
      ok: false,
      findings: [
        catalogFinding(CODE.BUDGET_EXCEEDED, RULE.BUDGET_EXCEEDED, '/plugins', `Validation Budget exceeded: ${o.plugins.length} entries > ${BUDGET.maxEntries}`),
      ],
    };
  }

  const entries: MarketplaceEntry[] = [];
  o.plugins.forEach((entryRaw, index) => {
    const entryId = `/plugins/${index}`;
    if (!isMapping(entryRaw)) {
      findings.push(
        entryFinding(CODE.CATALOG_ENTRY_MALFORMED, RULE.CATALOG_ENTRY_MALFORMED, entryId, 'marketplace entry is not an object'),
      );
      entries.push(unavailable(entryId, index, undefined, 'unsupported', CLAUDE_UNAVAILABLE_REASON.malformedEntry));
      return;
    }
    const e = entryRaw;
    const name = typeof e.name === 'string' ? e.name : undefined;

    const resolved = classifySource(e.source, hasPluginRoot, entryId);
    if (resolved.findings && resolved.findings.length > 0) {
      findings.push(...resolved.findings);
    }
    if (!resolved.available) {
      entries.push(unavailable(entryId, index, name, resolved.type, resolved.reason!, resolved.source));
      return;
    }
    // Manifest-backed plugins only: an entry-defined plugin (strict:false) cannot supply an
    // activatable Plugin on day 1 even when its local path resolves.
    if (e.strict === false) {
      entries.push(unavailable(entryId, index, name, resolved.type, CLAUDE_UNAVAILABLE_REASON.strictFalse, resolved.source));
      return;
    }
    entries.push({
      entryId,
      ordinal: index,
      name,
      type: resolved.type,
      path: resolved.path,
      source: resolved.source,
      available: true,
    });
  });

  // Duplicate entry names are distinguished by Entry ID; not a Blocking here (identity is ordinal-based).
  const blocked = findings.some((f) => f.classification === 'blocking');
  if (!blocked) {
    return {
      ok: true,
      catalog: { name: typeof o.name === 'string' ? o.name.trim() : '', entries },
      findings,
    };
  }
  return { ok: false, catalog: { name: typeof o.name === 'string' ? o.name.trim() : '', entries }, findings };
}
