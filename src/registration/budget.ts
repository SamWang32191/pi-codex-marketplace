/**
 * Minimal budget guards — only the two catalog-size limits that remain after the v2 ritual
 * retired (maxCatalogBytes / maxEntries) plus generic tree-walk safety caps. Exceeding a
 * budget produces a Blocking Finding at the owning boundary, never partial validation.
 */

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
