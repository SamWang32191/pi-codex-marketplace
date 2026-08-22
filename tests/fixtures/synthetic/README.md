# Synthetic fixture

Deterministic small marketplace used for unit-tier verification.

- Location: `synthetic/marketplace/` (created at test runtime)
- Marketplace name: `synthetic-marketplace`
- Entries:
  - `plugins/01-compatible` — single valid skill `skill-one` with frontmatter
  - `plugins/02-incompatible` — declares `equipment:mcp` unsupported Active Component → Incompatible
  - `plugins/03-invalid` — missing SKILL.md frontmatter → Invalid
  - `plugins/04-war` — Contained Path violation (`../escape`) → Blocking
- Rules: Contained Path/Symlink, Budget (1 MiB catalog), Compatibility Profile v1

Used by unit and integration layers; fingerprint is stable per test run.
