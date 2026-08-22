# pi-codex-marketplace

Bridge Package for Codex Marketplace compatibility in Pi (`Pi 0.84.2`).

> **One-line:** `pi install pi-codex-marketplace` → `/codex-marketplace` shows Global / Project partitioned Bridge State and lifecycle controls with Validation Disclosure, dual Confirmation, and three-orthogonal Receipt reporting.

## Install

```bash
pi install pi-codex-marketplace            # Global Scope (writes to ~/.pi/agent/settings.json)
pi install -l pi-codex-marketplace         # Project Scope (.pi/settings.json)
pi install -e ./path/to/pi-codex-marketplace  # External link (try without publishing)
pi update pi-codex-marketplace             # Update to latest compatible Bridge Package
pi remove pi-codex-marketplace             # Remove Registration + Installations atomically
pi -e ./path/to/repo                       # Ephemeral run without installing
```

All `pi install / -e / -l / update / remove` semantics are handled by the Pi host; this package declares a single `pi` extension entry (`extensions/pi/index.ts`) loaded via `jiti` and requires no build step.

Requirements: **Pi 0.84.2**, **Node >=22.19.0**, **macOS / Linux** (Windows not supported).

## Usage — `/codex-marketplace` (聚合指令)

Single aggregated command in Pi TUI, faithful to `prototype/tui-management-flow@c9107d2`:

```
/codex-marketplace
```

混合發現/導向 (hybrid discovery/guided) flow — every mutation forces **explicit scope choice → Validation Disclosure → State Revision + Validation Snapshot bound confirmation (Default No, never remembered/batched) → scope-atomic commit → immediate reload → three-orthogonal Receipt report**:

- **檢視 Global / Project 分區** — partitioned list of `Global Scope` (`{getAgentDir()}/codex-marketplace/state.json`, baseline) and `Project Scope` (`{cwd}/.pi/codex-marketplace/state.json`, overlay + sparse overrides). Shows `schemaVersion`, `stateRevision`, partitioned registrations/installations/overrides, empty-state guidance, and provenance notes.
- **註冊本地 / Git Marketplace…** — local or Git Marketplace Source Registration. Local uses canonical real path; Git uses Canonical Git Locator (credential-free) + Normalized Git Selector (`default` / `branch refs/heads/*` / `tag refs/tags/*` / `commit` lower 40/64 hex) → Resolved Revision. Validation Disclosure shows source, scope, Marketplace name, State Revision, Validation Snapshot fingerprint, entry outcomes, findings summary. **Registration Confirmation** is snapshot+revision bound, Default No. Blocking Findings (Contained Path / Contained Symlink / Budget / duplicate Source Key / locator/selector trust) block the attempt; concurrent same-scope attempt is blocked by Attempt Fence (`FENCE-01`); changed State Revision or snapshot yields `Rejected as Stale` (`STALE-01/02`).
- **安裝 Compatible Plugin…** — browse registered Marketplace Entries by **Marketplace Entry ID** (`/plugins/<序號>`) with explicit Unavailable reason (unsupported source kind / parse failure / Invalid / Incompatible / Plugin ID collision). Compatibility Profile v1 classifies every Plugin atomically as Compatible / Incompatible / Invalid; collision never changes classification. `Install Disabled` persists provenance without Activation Confirmation; `Install and Enable` discloses exact Plugin, skill list, Skill Resources, Invocation Policies, `Pi → Project → Global` precedence and findings, then requires a separate **Default No** Activation Confirmation (bound to same snapshot+revision). Re-enabling a disabled Installation repeats validation and confirmation; disabling preserves its Installation ID.
- **管理已安裝 Plugin（Enable / Disable）…** — toggle Installation State; disabling preserves provenance, enabling re-validates under current profile/ruleset/budget.
- **建立 / 移除 Scope Override…** — fine-grained Project Scope suppression of inherited Global records (Registration override suppresses marketplace subtree, Installation override suppresses single Plugin). Removing an override reveals the inherited record immediately without mutating the global document. Effective State view marks every record's participation and suppression reason.
- **檢視 Effective State 與 Projected Skills…** — read-time derived Effective State (`global-baseline + project-additions – overrides`, only `enabled` installations, `project-over-global` Plugin ID precedence) and Projected Skills with Runtime Skill Collision resolution (`Pi → Project Scope → Global Scope` exact name layering, same-scope Bridge colliders all unavailable, only surviving higher-layer skill reserves the name, lower layer survives when no higher contender). Whole-Plugin Blocking Findings block the Plugin; collision affects only that skill; `Available` is established only by independent host evidence (`AVAIL-01`).
- **Refresh / 更新 Registration… (Marketplace Refresh → Update Candidate → Update Plan Checklist → Apply Update)** — Refresh is non-mutating and produces an Update Candidate when the validated source state differs (Plugin version alone does not; full-commit Git selector ref movement alone does not). Update Plan Checklist requires fresh **Registration Confirmation** + one explicit outcome per Installation (`update` / `disable` / `remove`, with `update` only when a Compatible candidate exists) + **Activation Confirmation** per enabled installation that remains enabled. Commit is a single scope-atomic Lifecycle Operation replacing the Registration's Validation Snapshot and applying every disclosed same-scope consequence without mixing revisions.
- **Rebind Registration…** — explicitly replace a Registration's locator/selector with fresh validation, Registration Confirmation and a complete Update Plan for every existing Installation; prior activation consent never carries over.
- **移除 Registration / Installation…** — Registration Removal discloses that all same-scope Installations will be atomically removed; Installation Removal discloses which inherited Installation will become effective afterward.
- **檢視 Receipt Journal…** — bounded immutable Receipt Journal (redacted, non-authoritative, with active recovery chain preservation across restarts); degraded journal surfaces `JOURNAL-01/02` without changing Persistence Failed outcome.
- **執行 State Repair…** — explicit, fence-guarded verification and recovery of a degraded Bridge State; never auto-retried.

Diagnostics throughout are shown with **synchronized ordering** `class → phase → target → pointer → rule` and **closed rule codes** (`CONT-01`, `COMP-02`, `BARRIER-01`, etc.), grouped by severity (`Blocking` / `Validation Warning` / `Operational Notice`). Closed **Recovery Actions** (`Retry` / `Revalidate` / `Refresh` / `Rebind` / `Retry Application` / `Disable` / `Remove` / `Repair State` / `Inspect`) list only the currently safe next step under the exact current State Revision. Every committed operation reports a **three-orthogonal Attempt Summary** (`Completed` / `Completed with diagnostics` / `Declined` / `Blocked` / `Rejected as Stale` / `Persistence Failed` / `Persistence Indeterminate` / `Pending Application`) with separate persistence, findings, and runtime (`Applied` / `Pending Application` / `none`) diagnostics. A post-commit `reload` is attempted immediately; if not host-verifiable at the expected revision it is reported as `Pending Application` and no inspection or Refresh supersedes it. A held Global Scope Attempt Fence, `Persistence Indeterminate`, or Receipt Journal degradation triggers the **Global Pending Barrier** that blocks every Project Scope mutation/application (but leaves inspection/Refresh available) until global recovery (`global-first`). Pending state is reconciled at startup by producing a new reconciling receipt without implicit retry or rollback.

## Bridge State storage & migration

Bridge State is the sole authority, stored as **two scope-local documents**:

```jsonc
{
  "schemaVersion": 1,
  "stateRevision": "1", // opaque monotonic per scope (string "0" -> "1" -> "2" ...)
  "registrations": [],  // immutable Registration ID = UUIDv4 allocated before preflight
  "installations": [], // Installed Plugins (enabled/disabled), each bound to a Validation Snapshot
  "scopeOverrides": [] // Project-only: sparse suppression of Global records
}
```

Only authoritative fields are persisted. `Effective State`, catalogs, compatibility results, diagnostics are **derived at read time**.

- `State Revision` increments monotonically under file lock; commit is CAS-guarded by `expectedStateRevision` when supplied.
- Writes are **atomic**: `write-to-temp → fsync → rename` + `fsync` parent dir + **file lock** (`.lock` sibling) + **WAL** (`state.json.wal`) + **read-after-verify**.
- Cross-process concurrency is safe: lock serializes RMW; rename prevents torn reads; per-fingerprint `flock` guards Source Cache fetches with `p50 <200ms` on cache hit.
- **WAL migration** (`src/bridge-state/migrate.ts`): supported forward migrations are applied atomically via WAL (`state.json.wal` fsynced before commit, replayed on the next read after a crash, cleaned after commit success). Migrations are **non-waivable, opt-in per version**, require no implicit activation, and preserve the active recovery chain. Unknown/older-without-path and newer (`schemaVersion > CURRENT_SCHEMA_VERSION`) versions are treated as **incompatible** — fail-closed, no auto-migration, no rollback. **Downgrade never writes back** (`isDowngradeAttempt` guard): a newer durable file is never overwritten by an older Bridge Package; the operator must update the package first.
- Corrupted / unknown `schemaVersion` → classified as **corrupted / incompatible (Persistence Indeterminate)**, **never auto-rollback** — fail-closed. `validateSchema` and `migrateForward` enforce the closed set `CORRUPTED_JSON` / `INVALID_SCHEMA` / `INCOMPATIBLE_SCHEMA_VERSION` / `UNKNOWN_OLD_VERSION` / `MIGRATION_FAILED`.

See `src/bridge-state/` for `store.ts`, `atomic.ts`, `schema.ts`, `migrate.ts`, `paths.ts`.

## Project Trust

Project Scope mutations and Effective-State participation require Pi's `Project Trust` (host-owned, never granted/persisted by this package). Without trust, project records remain stored but excluded from Effective State and no Project Scope Lifecycle Operation may mutate them.

## Support matrix

| Dimension | Supported | Notes |
|-----------|-----------|-------|
| OS | **macOS**, **Linux** | Windows not supported (path containment, symlink, `flock` semantics are POSIX-only) |
| Node | **>=22.19.0** | `engines.node` enforced; `npm-shrinkwrap.json` pins Pi 0.84.2 host |
| Pi host | **0.84.2** | `peerDependencies` exact `0.84.2`; expected compatible range `^0.84.2` (devDeps). `pi-ai`/`pi-tui` peers `*` per Pi extension docs. |
| Semantics | `pi install` / `pi install -e` / `pi install -l` / `pi update` / `pi remove` | Single `pi` extension package; `files` ships `extensions/`, `src/`, `README.md`, `LICENSE` only |

Peer declaration (dual): **精確 `0.84.2`** in `peerDependencies` (exact host that this version was validated against) + **預期 `^0.84.2`** in `devDependencies` (range expected to remain compatible). `pi-ai` and `pi-tui` remain `*` because they are bundled by Pi.

## Versioning & release flow

- **Package**: `pi-codex-marketplace` published to **npm** as primary, **Git tag** `v*` as mirror.
- **SemVer**: starts at `0.1.0`; `0.y` maintenance window until `1.0.0` signals a stable Bridge State contract.
- **schemaVersion is bound to the package version**: bumping `schemaVersion` requires a package version bump and a WAL migration entry in `src/bridge-state/migrate.ts`; unknown `schemaVersion` is incompatible and never silently accepted.
- **Publishing**: `v*` tag → CI **full matrix green** (below) is a **release gate** → `npm publish --provenance` (OIDC). `latest` tracks stable tags (`v0.*` stable line and later `v1.*`); `next` tracks pre-release tags. Provenance is required (`--provenance`) and verified post-publish by the publish workflow. See `.github/workflows/ci.yml` and `.github/workflows/publish.yml`.
- **Maintenance windows**: `0.y` (current) may include additive schema migrations with WAL forward paths; `1.0` will freeze the `schemaVersion` contract and only accept forward-compatible additive changes via new `schemaVersion`s.

## Verification matrix (發版阻擋 gate)

Every row is a **release blocker**: `v*` may not publish unless the full matrix is green.

| Layer | Fixture | OS | Node | Pi host | What is covered |
|-------|---------|----|------|---------|-----------------|
| unit | **synthetic** | macOS + Linux | 22.19.0 | — | selector/locator normalization, Contained Path/Symlink, budget, compatibility atomic classification, precedence, collision, fence/sync ordering |
| unit | **pinned** `SamWang32191/codex-plugins@98e78ca` | macOS + Linux | 22.19.0 | — | catalog parsing + validation against a real pinned marketplace snapshot (fingerprint-stable) |
| unit | **adversarial** | macOS + Linux | 22.19.0 | — | malformed manifests, path-escapes, symlink loops, budget overflows, ID collisions, parser depth |
| integration | synthetic | macOS + Linux | 22.19.0 | 0.84.2 | Bridge State atomic WAL + file lock + read-after-verify, Cache pinning/LRU/flock, Receipt Journal rebuild & prune (active chain), Global Barrier |
| integration | pinned | macOS + Linux | 22.19.0 | 0.84.2 | Git acquisition (non-executing), Snapshot fingerprinting, Installation dual-path, Effective State, projection/collision, Refresh/Rebind/Removal WAL commit |
| integration | adversarial | macOS + Linux | 22.19.0 | 0.84.2 | Source Drift (Blocking), Stale Snapshot rejection, Persistence Indeterminate fail-closed, Fence/Barrier admission, Cache stale-snapshot never promotes |
| E2E (highest seam — **TUI**) | synthetic | macOS + Linux | 22.19.0 | **0.84.2** | `/codex-marketplace` → scope choice → disclosure → confirmation → commit → reload → receipt (three-orthogonal) → partitioned list → skill-granular `Available` |
| E2E (highest seam — **TUI**) | pinned | macOS + Linux | 22.19.0 | **0.84.2** | full lifecycle (Register → Install Disabled / Install and Enable → Disable/Enable → Refresh → Update Plan Checklist → Apply Update / Rebind → Removal → Override → Barrier) with fence/cache/external observability |
| E2E (highest seam — **TUI**) | adversarial | macOS + Linux | 22.19.0 | **0.84.2** | collision (`Pi → Project → Global`), barrier (`Global Pending` blocks project, Refresh/inspect still allowed), cache (`offline exact fingerprint hit` vs `stale never success`) |

Fixtures: `tests/fixtures/synthetic/`, `tests/fixtures/pinned/` (captured `SamWang32191/codex-plugins@98e78ca` snapshot + fingerprint manifest), `tests/fixtures/adversarial/` (path-escape / symlink-loop / budget-overflow / malformed frontmatter corpora). See `tests/acceptance/` for the matrix runner that enforces per-row gating (any row failure blocks publish).

Run locally:

```bash
npm run typecheck
npm test                          # full matrix (unit + integration + E2E)
npm run test:acceptance           # acceptance matrix only (three-tier × three-fixture)
```

## Development

```bash
npm install
npm run typecheck
npm test
npm run test:acceptance
```

## Domain vocabulary

Canonical terms are defined in [`CONTEXT.md`](./CONTEXT.md) — use them verbatim (Bridge Package vs Bridge Extension, Bridge State vs Effective State, State Revision, Registration ID, Source Key, etc.).

## Changelog & Releases

See [`CHANGELOG.md`](./CHANGELOG.md) and [GitHub Releases](../../releases). Version `0.1.0` is the first SemVer release; Git tags mirror npm versions (`v0.1.0` → `0.1.0`).
