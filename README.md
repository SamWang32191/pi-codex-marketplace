# pi-codex-marketplace

Bridge Package for Codex Marketplace compatibility in Pi (`Pi 0.84.2`).

> **One-line:** `pi install pi-codex-marketplace` → `/codex-marketplace` shows Global / Project partitioned Bridge State (empty on scaffold).

## Install

```bash
pi install pi-codex-marketplace          # user scope (writes to ~/.pi/agent/settings.json)
pi install -l pi-codex-marketplace       # project scope (.pi/settings.json)
pi -e ./path/to/repo                     # try without installing
```

Requirements: **Pi 0.84.2**, **Node >=22.19.0**, **macOS / Linux** (Windows not supported).

## Usage

In Pi TUI:

```
/codex-marketplace
```

Shows two partitions:

- **Global Scope** — `~/.pi/agent/codex-marketplace/state.json` (baseline)
- **Project Scope** — `{cwd}/.pi/codex-marketplace/state.json` (overlay + sparse overrides)

On scaffold (`v0.1.0`, Issue #16) both partitions are empty. Future tickets will incrementally populate each partition with Registrations / Installations / Scope Overrides.

## Bridge State storage

Bridge State is the sole authority, stored as **two scope-local documents**:

```jsonc
{
  "schemaVersion": 1,
  "stateRevision": "1", // opaque monotonic per scope
  "registrations": [],  // Registration records (immutable Registration ID = UUIDv4)
  "installations": [], // Installed Plugins (with Installation State enabled/disabled)
  "scopeOverrides": [] // Project-only: sparse suppression of Global records
}
```

Only authoritative fields are persisted. `Effective State`, catalogs, compatibility results, diagnostics are **derived at read time**.

- `State Revision` increments monotically (string `"0" -> "1" -> "2" ...`) on each successful commit under file lock.
- Writes are **atomic**: `write-to-temp → fsync → rename` + `fsync` parent dir + **file lock** (`.lock` sibling) + **read-after-verify**.
- Cross-process concurrency is safe: lock serializes RMW; rename prevents torn reads.
- Corrupted / unknown `schemaVersion` → classified as **corrupted / incompatible (Persistence Indeterminate)**, **never auto-rollback or auto-migrate forward** — fail-closed.

See `src/bridge-state/` for `store.ts`, `atomic.ts`, `schema.ts`, `paths.ts`.

## Project Trust

Project Scope mutations and Effective-State participation require Pi's `Project Trust` (host-owned, never granted/persisted by this package). Without trust, project records remain stored but excluded from Effective State.

## Development

```bash
npm install
npm run typecheck
npm test
```

## Compatibility

- `peerDependencies`: `@earendil-works/pi-coding-agent` **exact `0.84.2`** (compatible with `^0.84.2` as per spec)
- `engines.node`: `>=22.19.0`
- Supported: Pi `0.84.2` on **macOS / Linux**

## Domain vocabulary

Canonical terms are defined in [`CONTEXT.md`](./CONTEXT.md) — use them verbatim (Bridge Package vs Bridge Extension, Bridge State vs Effective State, State Revision, Registration ID, Source Key, etc.).

## Issues / Wayfinder

- Wayfinder map: #1
- Scaffold ticket: #16 (this release)
- Remaining: #17–#24
