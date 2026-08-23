/**
 * Validation Ruleset / Validation Budget — versioned Bridge contracts applied during validation.
 * See CONTEXT.md: Validation Ruleset, Validation Budget.
 *
 * A changed ruleset or budget requires revalidation even when source bytes are unchanged.
 * Exceeding a budget produces a Blocking Finding at the owning boundary (source/catalog/entry),
 * never partial or best-effort validation.
 */

export const VALIDATION_RULESET = 'ruleset:v2';
export const VALIDATION_BUDGET = 'budget:v2';
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
  /** Maximum bytes read and synchronously parsed from one Skill Agent Profile. */
  maxAgentProfileBytes: 64 * 1024,
  /** Maximum YAML lexer tokens accepted before composing a Skill Agent Profile. */
  maxAgentProfileYamlTokens: 8_192,
  /** Maximum YAML collection nesting accepted in a Skill Agent Profile. */
  maxAgentProfileYamlDepth: 32,
  /** Maximum composed YAML AST nodes accepted in a Skill Agent Profile. */
  maxAgentProfileYamlNodes: 2_048,
  /** Maximum alias expansion count while materializing a Skill Agent Profile. */
  maxAgentProfileYamlAliases: 32,
  /** Maximum plugins entries in a catalog. */
  maxEntries: 1024,
  /** Maximum declared marketplace name length. */
  maxNameLength: 64,
} as const;
