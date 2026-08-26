/**
 * Marketplace Format — the codex | claude attribute derived decisively from Marketplace Root
 * content. The glossary entry lands with the R1 docs ticket (#49); the attribute itself and its
 * codex-priority / explicit-flip semantics are decided by #43. See also CONTEXT.md:
 * Marketplace Catalog, Marketplace Registration.
 *
 * Detection order is fixed and codex-prioritized: a root exposing both catalogs is codex without
 * any additional user question. A root exposing neither is CATALOG_MISSING territory (null) —
 * the registration flows turn that into the unchanged Blocking Finding.
 *
 * The detected format is fixed onto the Registration record; it never changes implicitly at
 * runtime. A later upstream flip can only surface as an Update Candidate produced by an explicit
 * Marketplace Refresh and change through an explicit Apply Update.
 */

import { statSync } from 'node:fs';
import { join } from 'node:path';

import type { MarketplaceFormat } from '../bridge-state/types.js';
import { parseCatalog, type CatalogResult } from './catalog.js';
import { CLAUDE_MARKETPLACE_CATALOG_RELPATH, parseClaudeCatalog } from './claude-catalog.js';

/** Canonical `.agents/plugins/marketplace.json` object (codex format catalog path). */
export const CODEX_MARKETPLACE_CATALOG_RELPATH = '.agents/plugins/marketplace.json';
export { CLAUDE_MARKETPLACE_CATALOG_RELPATH };

export interface FormatBoundCatalogContract {
  /** Snapshot-relative catalog location owned by this format. */
  relPath: string;
  /** The format's structural catalog parser. */
  parse(obj: unknown): CatalogResult;
}

const CONTRACTS: Record<MarketplaceFormat, FormatBoundCatalogContract> = {
  codex: { relPath: CODEX_MARKETPLACE_CATALOG_RELPATH, parse: parseCatalog },
  claude: { relPath: CLAUDE_MARKETPLACE_CATALOG_RELPATH, parse: parseClaudeCatalog },
};

/** The closed, format-bound catalog contract (canonical path + structural parser). */
export function catalogContractFor(format: MarketplaceFormat): FormatBoundCatalogContract {
  return CONTRACTS[format];
}

/**
 * Detect the Marketplace Format of one Marketplace Root by scanning for the canonical catalogs.
 * Deterministic; codex wins when both exist; null means neither exists.
 *
 * The check follows symlinks (`statSync`) so a Contained Symlink pointing at a regular file
 * inside the root counts as its target (CONTEXT.md: Contained Symlink); broken or special
 * entries simply fall through. Root escape is not handled here — the Validation Snapshot's
 * symlink containment Blocking Finding denies such sources before any confirmation.
 */
export function detectMarketplaceFormat(root: string): MarketplaceFormat | null {
  for (const format of ['codex', 'claude'] as const) {
    const abs = join(root, ...CONTRACTS[format].relPath.split('/'));
    try {
      if (statSync(abs).isFile()) return format;
    } catch {
      // absent / broken link — continue in fixed priority order
    }
  }
  return null;
}
