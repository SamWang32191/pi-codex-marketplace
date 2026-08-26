/**
 * Marketplace Catalog — canonical `.agents/plugins/marketplace.json` object within a Marketplace Root.
 * See CONTEXT.md: Marketplace Catalog, Marketplace Entry, Marketplace Entry ID.
 *
 * Only the canonical object participates in Bridge ingestion; legacy/antigravity shapes are ignored
 * (detected as catalog missing). Each entry is enumerated with a snapshot-scoped Marketplace Entry ID
 * `/plugins/<zero-based ordinal>`. Non-local entry source kinds are recognized only as Unavailable
 * Entries rather than recursively acquired.
 */

import { CODE, RULE, blocking, type ValidationFinding } from './findings.js';
import { BUDGET } from './budget.js';

export type EntryType = 'local' | 'git' | 'unsupported';

const LOCAL_KINDS = new Set(['local', 'directory', 'dir', 'file', 'path', 'src']);
const NONLOCAL_KINDS = new Set(['git', 'github', 'repo', 'url', 'remote', 'http', 'https']);

/** Matches lowercase kebab-case names (Codex marketplace declared name). */
export const KEBAB_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export interface MarketplaceEntry {
  /** Snapshot-scoped identity: `/plugins/<ordinal>`. */
  entryId: string;
  /** Zero-based ordinal in the plugins[] array. */
  ordinal: number;
  /** Declared entry name if present. */
  name?: string;
  /** Recognized source kind. */
  type: EntryType;
  /** Declared `./`-relative Contained Path for local entries. */
  path?: string;
  /** Whether this entry can supply an activatable plugin (else Unavailable). */
  available: boolean;
  /** Human reason when unavailable. */
  unavailableReason?: string;
}

export interface Catalog {
  /** Declared validated lowercase kebab-case name. */
  name: string;
  /** Enumerated entries (snapshot-scoped). */
  entries: MarketplaceEntry[];
}

export interface CatalogResult {
  ok: boolean;
  catalog?: Catalog;
  findings: ValidationFinding[];
}

function classifyKind(raw: unknown): { type: EntryType; reason?: string } {
  if (raw === undefined || raw === null || raw === '') return { type: 'local' };
  const s = String(raw).toLowerCase();
  if (LOCAL_KINDS.has(s)) return { type: 'local' };
  if (NONLOCAL_KINDS.has(s)) return { type: 'git' };
  return { type: 'unsupported' };
}

/**
 * Parse a parsed `.agents/plugins/marketplace.json` object structurally.
 * Structural/catalog-identity failures are Blocking (deny Registration); per-entry inability to
 * resolve to a plugin is an Unavailable Entry (disclosed, non-blocking).
 */
export function parseCatalog(obj: unknown): CatalogResult {
  const findings: ValidationFinding[] = [];

  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return {
      ok: false,
      findings: [
        blocking({
          code: CODE.CATALOG_MALFORMED,
          phase: 'validation',
          target: 'catalog',
          pointer: '/',
          rule: RULE.CATALOG_MALFORMED,
          outcome: 'marketplace.json is not an object',
        }),
      ],
    };
  }
  const o = obj as Record<string, unknown>;

  if (typeof o.name !== 'string' || o.name.trim().length === 0) {
    findings.push(
      blocking({
        code: CODE.CATALOG_NAME_INVALID,
        phase: 'validation',
        target: 'catalog',
        pointer: '/name',
        rule: RULE.CATALOG_NAME_INVALID,
        outcome: 'declared marketplace name is missing',
      }),
    );
  } else if (!KEBAB_NAME_RE.test(o.name.trim())) {
    findings.push(
      blocking({
        code: CODE.CATALOG_NAME_INVALID,
        phase: 'validation',
        target: 'catalog',
        pointer: '/name',
        rule: RULE.CATALOG_NAME_INVALID,
        outcome: `declared marketplace name '${o.name}' is not lowercase kebab-case`,
      }),
    );
  }

  if (!Array.isArray(o.plugins)) {
    findings.push(
      blocking({
        code: CODE.CATALOG_MALFORMED,
        phase: 'validation',
        target: 'catalog',
        pointer: '/plugins',
        rule: RULE.CATALOG_MALFORMED,
        outcome: 'plugins is not an array',
      }),
    );
    return {
      ok: false,
      findings,
    };
  }

  if (o.plugins.length > BUDGET.maxEntries) {
    return {
      ok: false,
      findings: [blocking({
        code: CODE.BUDGET_EXCEEDED,
        phase: 'validation',
        target: 'catalog',
        pointer: '/plugins',
        rule: RULE.BUDGET_EXCEEDED,
        outcome: `Validation Budget exceeded: ${o.plugins.length} entries > ${BUDGET.maxEntries}`,
      })],
    };
  }

  const entries: MarketplaceEntry[] = [];
  o.plugins.forEach((entryRaw, index) => {
    const entryId = `/plugins/${index}`;
    if (typeof entryRaw !== 'object' || entryRaw === null || Array.isArray(entryRaw)) {
      findings.push(
        blocking({
          code: CODE.CATALOG_ENTRY_MALFORMED,
          phase: 'validation',
          target: 'entry',
          pointer: entryId,
          rule: RULE.CATALOG_ENTRY_MALFORMED,
          outcome: 'marketplace entry is not an object',
        }),
      );
      entries.push({ entryId, ordinal: index, type: 'unsupported', available: false, unavailableReason: 'malformed entry' });
      return;
    }
    const e = entryRaw as Record<string, unknown>;
    // Codex Marketplace v1 uses `source: { source: "local", path: "./…" }`.
    // Retain the earlier flat shape as a backward-compatible input, but derive the canonical
    // source kind/path from the nested object when present.
    const nestedSource = typeof e.source === 'object' && e.source !== null && !Array.isArray(e.source)
      ? e.source as Record<string, unknown>
      : undefined;
    const nestedKind = nestedSource ? classifyKind(nestedSource.source ?? nestedSource.type) : undefined;
    const flatKind = classifyKind(e.type ?? e.kind);
    const nestedPath = typeof nestedSource?.path === 'string' ? nestedSource.path : undefined;
    const flatPath = typeof e.path === 'string' ? e.path : undefined;
    // The canonical nested v1 source is an indivisible declaration.  Never mix a flat kind/path
    // with it: a conflicting flat `type: local` must not disguise nested `source: git`.
    if (nestedSource && ((e.type !== undefined || e.kind !== undefined) && flatKind.type !== nestedKind!.type || (flatPath !== undefined && flatPath !== nestedPath))) {
      entries.push({ entryId, ordinal: index, type: 'unsupported', available: false, unavailableReason: 'conflicting nested and flat source declaration' });
      return;
    }
    const kind = nestedKind ?? flatKind;
    const name = typeof e.name === 'string' ? e.name : undefined;
    const path = nestedSource ? nestedPath : flatPath;

    if (kind.type !== 'local') {
      // Recognized only as an Unavailable Entry (never recursively acquired). Disclosed, not a finding.
      entries.push({
        entryId,
        ordinal: index,
        name,
        type: kind.type,
        path,
        available: false,
        unavailableReason: 'unsupported source kind',
      });
      return;
    }

    // local entry
    if (!path) {
      entries.push({
        entryId,
        ordinal: index,
        name,
        type: 'local',
        path,
        available: false,
        unavailableReason: 'cannot resolve to a Plugin: no local path declared',
      });
      return;
    }
    entries.push({ entryId, ordinal: index, name, type: 'local', path, available: true });
  });

  // Duplicate entry names are distinguished by Entry ID; not a Blocking here (identity is ordinal-based).
  const blocked = findings.some((f) => f.classification === 'blocking');
  if (!blocked) {
    return {
      ok: true,
      catalog: { name: String(o.name).trim(), entries },
      findings,
    };
  }
  return { ok: false, catalog: { name: typeof o.name === 'string' ? o.name.trim() : '', entries }, findings };
}
