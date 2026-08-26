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
 * Fail-closed field policy: every object this parser structurally interprets has a closed member
 * set. Unknown top-level/entry fields are Blocking; known Inert Metadata produces Validation
 * Warnings; named active-component declarations are Unsupported Blocking Findings. The sole
 * exception is the entry-level free-form `metadata` object, which Claude Code documents as
 * unread presentation data and which is therefore inert as a whole.
 */

import { CODE, RULE, blocking, warning, type ValidationFinding } from './findings.js';
import { BUDGET } from './budget.js';
import { KEBAB_NAME_RE, type Catalog, type CatalogResult, type MarketplaceEntry } from './catalog.js';

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
  gitFamily: 'external git-family entry sources (github/url/git-subdir) are not supported yet',
  npm: 'npm source entries are not supported',
  archive: 'archive source entries are not supported',
  command: 'command source entries are permanently disqualified',
  strictFalse: 'entry-defined plugin (strict: false) is not supported',
  malformedEntry: 'malformed entry',
} as const;

/** Closed top-level field set beyond the required name/owner/plugins. */
const TOP_INERT_FIELDS = new Set(['$schema', 'description', 'version']);
/** Structural objects descended into by this parser (closed member sets below). */
const TOP_STRUCTURAL_FIELDS = new Set(['name', 'owner', 'plugins', 'metadata']);
const METADATA_KNOWN_FIELDS = new Set(['pluginRoot', 'description', 'version']);
const OWNER_KNOWN_FIELDS = new Set(['name', 'email', 'url']);

/**
 * Entry-level fields that declare active behaviour (component configuration, archive credential
 * execution, or install-time enablement). Named Unsupported Active Components under Profile v2.
 */
const ENTRY_ACTIVE_FIELDS = new Set([
  'commands',
  'agents',
  'hooks',
  'mcpServers',
  'lspServers',
  'skills',
  'headers',
  'headersHelper',
  'defaultEnabled',
]);

/** Known inert entry-level presentation metadata (Validation Warning when present). */
const ENTRY_INERT_FIELDS = new Set([
  'displayName',
  'description',
  'version',
  'author',
  'homepage',
  'repository',
  'license',
  'keywords',
  'category',
  'tags',
  'relevance',
  'metadata',
]);
/** Entry fields interpreted by this parser rather than classified as inert/active. */
const ENTRY_INTERPRETED_FIELDS = new Set(['name', 'source', 'strict']);

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

function unavailable(entryId: string, ordinal: number, name: string | undefined, type: MarketplaceEntry['type'], reason: string): MarketplaceEntry {
  return { entryId, ordinal, name, type, available: false, unavailableReason: reason };
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function classifyObjectSource(source: Record<string, unknown>): { type: MarketplaceEntry['type']; reason: string } {
  switch (source.source) {
    case 'github':
    case 'url':
    case 'git-subdir':
      return { type: 'git', reason: CLAUDE_UNAVAILABLE_REASON.gitFamily };
    case 'npm':
      return { type: 'unsupported', reason: CLAUDE_UNAVAILABLE_REASON.npm };
    case 'archive':
      return { type: 'unsupported', reason: CLAUDE_UNAVAILABLE_REASON.archive };
    case 'command':
      return { type: 'unsupported', reason: CLAUDE_UNAVAILABLE_REASON.command };
    default:
      return { type: 'unsupported', reason: CLAUDE_UNAVAILABLE_REASON.unknownKind };
  }
}

/**
 * Dispatch one claude entry's `source` declaration to its availability outcome.
 * Pure structural classification — never touches the filesystem or network.
 */
function classifySource(
  source: unknown,
  hasPluginRoot: boolean,
): { type: MarketplaceEntry['type']; path?: string; available: boolean; reason?: string } {
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
    const kind = classifyObjectSource(source);
    return { type: kind.type, available: false, reason: kind.reason };
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
    for (const key of Object.keys(o.owner)) {
      if (!OWNER_KNOWN_FIELDS.has(key)) {
        findings.push(
          catalogFinding(CODE.CATALOG_UNKNOWN_FIELD, RULE.CATALOG_UNKNOWN_FIELD, `/owner/${key}`, `Unknown owner field '${key}' is fail-closed`),
        );
      }
    }
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
      for (const key of Object.keys(o.metadata).sort((a, b) => a.localeCompare(b))) {
        if (!METADATA_KNOWN_FIELDS.has(key)) {
          findings.push(
            catalogFinding(CODE.CATALOG_UNKNOWN_FIELD, RULE.CATALOG_UNKNOWN_FIELD, `/metadata/${key}`, `Unknown metadata field '${key}' is fail-closed`),
          );
        } else if (key !== 'pluginRoot') {
          findings.push(
            warning({
              code: CODE.INERT_METADATA_IGNORED,
              rule: RULE.INERT_METADATA_IGNORED,
              phase: 'validation',
              target: 'catalog',
              pointer: `/metadata/${key}`,
              outcome: `Ignored Inert Metadata 'metadata.${key}' does not change catalog parsing`,
            }),
          );
        }
      }
      hasPluginRoot = typeof o.metadata.pluginRoot === 'string' && o.metadata.pluginRoot.length > 0;
    }
  }

  for (const key of Object.keys(o).sort((a, b) => a.localeCompare(b))) {
    if (TOP_STRUCTURAL_FIELDS.has(key)) continue;
    if (TOP_INERT_FIELDS.has(key)) {
      findings.push(
        warning({
          code: CODE.INERT_METADATA_IGNORED,
          rule: RULE.INERT_METADATA_IGNORED,
          phase: 'validation',
          target: 'catalog',
          pointer: `/${key}`,
          outcome: `Ignored Inert Metadata '${key}' does not change catalog parsing`,
        }),
      );
      continue;
    }
    findings.push(
      catalogFinding(CODE.CATALOG_UNKNOWN_FIELD, RULE.CATALOG_UNKNOWN_FIELD, `/${key}`, `Unknown catalog field '${key}' is fail-closed`),
    );
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

    // Closed-field policy per entry: active components block, unknown fields block, known inert
    // fields warn. `strict` is interpreted separately below.
    for (const key of Object.keys(e).sort((a, b) => a.localeCompare(b))) {
      if (ENTRY_INTERPRETED_FIELDS.has(key)) continue;
      if (ENTRY_ACTIVE_FIELDS.has(key)) {
        findings.push(
          entryFinding(CODE.UNSUPPORTED_ACTIVE_COMPONENT, RULE.UNSUPPORTED_ACTIVE_COMPONENT, `${entryId}/${key}`, `Compatibility Profile v2 does not support active entry component '${key}'`),
        );
      } else if (ENTRY_INERT_FIELDS.has(key)) {
        findings.push(
          warning({
            code: CODE.INERT_METADATA_IGNORED,
            rule: RULE.INERT_METADATA_IGNORED,
            phase: 'validation',
            target: 'entry',
            pointer: `${entryId}/${key}`,
            outcome: `Ignored Inert Metadata '${key}' does not change entry availability`,
          }),
        );
      } else {
        findings.push(
          entryFinding(CODE.CATALOG_UNKNOWN_FIELD, RULE.CATALOG_UNKNOWN_FIELD, `${entryId}/${key}`, `Unknown entry field '${key}' is fail-closed`),
        );
      }
    }

    const resolved = classifySource(e.source, hasPluginRoot);
    if (!resolved.available) {
      entries.push(unavailable(entryId, index, name, resolved.type, resolved.reason!));
      return;
    }
    // Manifest-backed plugins only: an entry-defined plugin (strict:false) cannot supply an
    // activatable Plugin on day 1 even when its local path resolves.
    if (e.strict === false) {
      entries.push(unavailable(entryId, index, name, resolved.type, CLAUDE_UNAVAILABLE_REASON.strictFalse));
      return;
    }
    entries.push({
      entryId,
      ordinal: index,
      name,
      type: resolved.type,
      path: resolved.path,
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
