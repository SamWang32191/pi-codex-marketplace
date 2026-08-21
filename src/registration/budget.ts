/**
 * Validation Ruleset / Validation Budget — versioned Bridge contracts applied during validation.
 * See CONTEXT.md: Validation Ruleset, Validation Budget.
 *
 * A changed ruleset or budget requires revalidation even when source bytes are unchanged.
 * Exceeding a budget produces a Blocking Finding at the owning boundary (source/catalog/entry),
 * never partial or best-effort validation.
 */

export const VALIDATION_RULESET = 'ruleset:v1';
export const VALIDATION_BUDGET = 'budget:v1';
/** Compatibility Profile reference bound into every snapshot (full profile contract is #19). */
export const COMPATIBILITY_PROFILE = 'profile:v1';

export const BUDGET = {
  /** Maximum tree depth under the Marketplace Root (1 = immediate children). */
  maxTreeDepth: 32,
  /** Maximum inspected files (regular files) under the root. */
  maxFiles: 10_000,
  /** Maximum total bytes of inspected file content. */
  maxTotalBytes: 512 * 1024 * 1024,
  /** Maximum Marketplace Catalog file bytes. */
  maxCatalogBytes: 1 * 1024 * 1024,
  /** Maximum plugins entries in a catalog. */
  maxEntries: 1024,
  /** Maximum declared marketplace name length. */
  maxNameLength: 64,
} as const;