# Adversarial fixture

Corpus of malformed / policy-violating inputs used to verify fail-closed behaviour.

- `adversarial/cases/` — each subdir is a marketplace root:
  - `budget-overflow/` — >1 MiB catalog (BUDG-01)
  - `path-escape/` — Contained Path `../../etc/passwd`
  - `symlink-loop/` — Contained Symlink loop
  - `symlink-escape/` — symlink targets `../..`
  - `frontmatter-missing/` — SKILL.md without YAML frontmatter (COMP-02)
  - `manifest-missing/` — `.codex-plugin/plugin.json` missing
  - `plugin-id-collision/` — two entries reference same manifest name (COMP-04)
  - `deep-nesting/` — > 16 path depth (Budget path depth)
- Each case produces a Blocking Finding at its owning boundary (source/catalog/entry/Plugin) and never partial validation.

Used by unit/integration/E2E adversarial row; every case must yield `Blocked` rather than `Completed`.
