# Changelog

All notable changes to `pi-codex-marketplace` are documented here. Format follows Keep a Changelog and SemVer (starting at `0.1.0`; Git tags `v*` mirror npm versions).

## [Unreleased]

### Changed
- **Global-only 前置：Scope Override 功能端到端退休** (#59)：`/codex-marketplace` TUI 移除「Scope 與繼承」分區、建立／移除 Scope Override 動作與 inherited／suppresses 列標記；刪除 overrides 核心模組（`src/projection/overrides.ts`）與 extension flow adapter（`extensions/pi/scope-overrides.ts`），Effective State 檢視搬移至 observe-only 的 `extensions/pi/effective-state-view.ts`。繼承自 Global 的 Registration / Installation 一律參與 Effective State，無任何抑制路徑；`BridgeState.scopeOverrides` 型別欄位保留但恆為空（schema v2 遷移才剝除）。暫態語意：既有 persisted overrides 立即停止生效（不再被採計）。雙文件持久化、Attempt Fence、Receipt Journal、Global Pending Barrier 行為不變。

## [0.1.10] - 2026-08-25

### Added
- **Runtime Skill Exposure** (#54)：Bridge Extension 實作 host 資源發現接縫（`pi.on("resources_discover")` 回傳 `skillPaths`，startup 與 reload 兩種 reason 皆支援），依當下 Effective State（enabled Installation 減去 Scope Override 與 Project Trust 排除）之 Runtime Skill Collision 存活者，動態貢獻 skill 目錄——Git Registration 直接指向 Source Cache 中其 Validation Snapshot fingerprint 對應 entry 內的個別 skill 目錄，Local Registration 指向 live Marketplace Root；路徑解析重用 retained catalog + Contained Path 解析。發現時僅做被動存在性檢查：不重算指紋、不改動 Bridge State、不產生任何 Attempt Receipt；快取 entry 遭外部刪除時逐項略過且 discovery 必定完成（`SOURCE_REACQUISITION_REQUIRED` / `SOURCE_DRIFT` 仍由 Lifecycle Operations 產生）。新增領域模組 `src/projection/exposure.ts`（ADR 0001）。
- **Invocation Policy advisory warning（COMP-W02）** (#55)：當 `agents/openai.yaml` 宣告 `allow_implicit_invocation: false` 且 Skill Descriptor 未宣告 `disable-model-invocation` 時，驗證產出非 blocking 的 `UNENFORCEABLE_INVOCATION_POLICY`（COMP-W02）warning finding，outcome 引導作者在 SKILL.md frontmatter 補上 `disable-model-invocation: true`；Effective Invocation Policy 計算與 Compatibility Verdict 不變，Registration 不因此被擋。

## [0.1.9] - 2026-08-24

### Added
- **TUI 正體中文化** (#41)：新增集中式呈現字串模組 `extensions/pi/ui-strings.ts`（以穩定訊息 ID 索引的 zh_TW 字典，保留 locale 切換模組縫），`/codex-marketplace` TUI 全部使用者可見字串改由字串模組供應——分區名與描述、列標籤、按鍵提示、狀態列、確認與 consent 文案、help 全譯；Attempt Summary／Recovery Action／Verdict 封閉值以正典在前、中文釋義在後並列（如 `Blocked（受阻）`）；findings 於呈現邊界依 rule code 對應中文文案（rule code／classification／順序不變）；glossary 術語（Bridge State、Receipt Journal…）維持英文；CJK 雙寬字元於 120/80/60 欄寬度安全（無溢位、面板框線完整）；分派續用結構化 intent，顯示語言不影響任何行為。非 TUI 的 `list`/`inspect` 輸出依議題範圍維持原樣。

## [0.1.8] - 2026-08-24

### Added
- **Bridge Ledger TUI** (#38): replace the flat `/codex-marketplace` menu with a responsive five-section workspace, simultaneous Global / Project authority rails, persistent Project Trust and Global Pending Barrier status, structured canonical action intents, scope-partitioned browsing focus, Entry-level Plugin rows with directly bound install paths, eligibility-aware State Repair, and 120/80/60-column keyboard navigation.
- **Shared Transaction Sheet** (#38): present every mutation as `Intent → Validation → Consent → Plan → Commit → Receipt`, preserve separate Default-No Registration / Activation confirmations, provide expandable complete disclosures, and render Durable / Findings / Runtime outcomes with terminal-safe quoting; preflight cancellation produces a durable Declined Receipt, while active Pending Application chains expose an Attempt Fence-held, exact Revision + Validation Snapshot-bound Retry Application with final pre-reload/post-reload verification (missing snapshots disable unsafe replay, interaction-time drift fails closed without reload, and reload errors remain Pending Application). Repair State also exposes safe atomic Receipt Journal reconstruction for `JOURNAL-02` degradation while preserving parsed active chains.

## [0.1.7] - 2026-08-23

### Added
- **Compatibility Profile v1 Skill Agent Profile** (#36/#37)：支援 `skills/<skill>/agents/openai.yaml` 與 invocation policy，並以 bounded YAML parsing、Skill ownership 與 Validation Budget 拒絕不安全輸入；新增 `yaml` runtime dependency。

## [0.1.6] - 2026-08-22

### Added
- **Git Marketplace Plugin 檢驗與安裝** (#34)：接合 `SourceCache`（Git 定址快取）與 `buildGitSnapshot` 指紋驗證，支援 Git Marketplace 的 Plugin 檢驗、TUI 條目呈現（顯示「可安裝」）、`Install Disabled` / `Install and Enable` 以及啟用（Enable）完整生命週期；快取遺失或指紋漂移時精確產生 `SOURCE_REACQUISITION_REQUIRED` / `SOURCE_DRIFT` Blocking Finding。

## [0.1.5] - 2026-08-22

### Fixed
- **README 安裝語意**：對齊 `pi --help` 與 `docs/packages.md` — `pi install` 需 `npm:` 前綴、本地路徑用 `pi install ./path`、臨時試用用 `pi -e <source>`（非 `pi install -e`）、`update`/`remove`/`list`/`config` 語意修正。

## [0.1.4] - 2026-08-22

### Fixed
- **publish Node 22 → 24**：`publish` job `npm 10.9.3` 不支援 OIDC Trusted Publishing（需 `npm 11.5.1+`），改為 `node 24`（`opencode` 同款），移除臨時調試步驟。

## [0.1.3] - 2026-08-22

### Fixed
- 調試 OIDC：新增暫時性 `debug OIDC token` 步驟與 `verbose` 日誌以定位 `ENEEDAUTH`。

## [0.1.2] - 2026-08-22

### Fixed
- **Trusted Publisher OIDC**：對齊 `opencode-roast-tone-plugin` 可發版樣式 — `repository.url` 去除 `git+` 前綴 (`https://github.com/SamWang32191/pi-codex-marketplace`)，`publish.yml` 移除 `environment: npm`（OIDC token 不帶 environment claim），升級 `actions/checkout@v5`/`setup-node@v5` 以匹配可發版 repo 的 proven 流程。

## [0.1.1] - 2026-08-22

### Added
- **Release skill** `.agents/skills/release` — project skill 將發版流程固化為 `v* tag → CI gate → npm provenance → GitHub Release` 五步，涵蓋首發 OTP 與 OIDC Trusted Publisher 分支、常見失敗與完成條件。

## [0.1.0] - 2026-08-22

Initial Bridge Package release — single `pi` extension, Pi `0.84.2` baseline.

### Added
- **Bridge Package** `pi-codex-marketplace@0.1.0` with `pi` extension entry `extensions/pi/index.ts` (loaded via `jiti`, no build step). Published to npm with `npm publish --provenance`; Git tag `v0.1.0` mirrors npm.
- **Bridge State** dual-document atomic store: global `{getAgentDir()}/codex-marketplace/state.json` + project `{cwd}/.pi/codex-marketplace/state.json` with `schemaVersion=1`, opaque monotonic `stateRevision` (`"0"→"1"→"2"…`), file lock (`.lock`), WAL (`state.json.wal`), temp→fsync→rename + dir fsync + read-after-verify. Only authoritative fields persisted; Effective State, catalogs, diagnostics derived at read time.
- **WAL migration** (`src/bridge-state/migrate.ts`): forward migrations via `state.json.wal` (fsynced before commit, replayed on next read after crash, cleaned after commit). Supported forward paths only; unknown/ newer `schemaVersion` → `incompatible` fail-closed; downgrade never writes back.
- **Source Acquisition**: local (canonical real path) and Git (Canonical Git Locator credential-free + Normalized Git Selector `default`/`branch` `refs/heads/*`/`tag` `refs/tags/*`/`commit` lower 40/64 hex) with Resolved Revision, non-executing retrieval (no hooks/filters/submodules/dependencies/Plugin components), Acquisition Trust Base validation (selected Git/SSH, system CAs, existing known-hosts, approved credential helper/agent; rejects unknown/changed host keys and locator-changing redirects).
- **Validation**: Validation Snapshot (ordered paths/types/modes/symlink targets/content hashes + Source Key + Canonical Locator + Resolved Revision + Compatibility Profile v1 + Ruleset + Budget fingerprints), Contained Path/Contained Symlink strict containment, Validation Budget fail-closed at boundary, ordered Findings with stable rule codes (`CONT-01`, `COMP-02`, `FENCE-01`, `BARRIER-01`, etc.) sorted `class→phase→target→pointer→rule`.
- **Compatibility Profile v1**: atomic Compatible/Incompatible/Invalid classification; closed manifest + Skill Descriptor/Body contract, Pi-native skill semantics, Inert Metadata tolerates as Warning, unknown/unsupported Active Component → Incompatible/Incompatible, no partial projection. Collision never changes Plugin classification.
- **Lifecycle**: Scope-local atomic Lifecycle Operations — Registration (local/Git), Installation (`Install Disabled` without Activation Confirmation vs `Install and Enable` with Activation Confirmation, re-enable re-validates), Removal (Registration cascades same-scope Installations), Rebind (fresh validation + Registration Confirmation + complete Update Plan), Marketplace Refresh (non-mutating, Update Candidate only when snapshot differs; `full-commit` ref movement alone never produces a candidate), Apply Update (single WAL commit per complete Update Plan with Registration Confirmation + per-Installation `update`/`disable`/`remove` + per-enabled Activation Confirmation), Scope Overrides (project-only sparse suppression by Registration ID / Installation ID, removal reveals inherited Global without mutating it), Read-time Effective State (`global-baseline + project additions – overrides`, only `enabled`, `project-over-global` precedence), Projected Skills via Pi resource-discovery seam (raw snapshot paths, Bridge-held provenance, host-verifiable reload = `Applied`).
- **Runtime Skill Collision**: skill-granular `Pi → Project Scope → Global Scope` exact-name layering, same-scope Bridge colliders all unavailable, only surviving higher-layer skill reserves the name, lower survives when no higher contender. `Available` only by independent host evidence.
- **Source Cache** (`src/cache/`): Git-only, fingerprint-addressed at `{getAgentDir()}/codex-marketplace/cache`, pinned set = committed Bridge State + pending Update Candidate + in-flight, total 2 GiB LRU on unpinned only, synchronous evict/prune, no background/TTL, offline reuse only on exact fingerprint hit, Stale Snapshot never becomes success. Per-fingerprint `flock`, `p50 <200ms` on hit.
- **Source Drift**: external local-source mutation detected as Blocking Finding, Bridge State unchanged, affected Installations not Projected until explicit Refresh produces an Update Candidate.
- **Receipt Journal + Attempt Fence + Global Pending Barrier** (`src/journal/`, `src/barrier/`, `src/reconciliation/`): immutable redacted Attempt Receipts (`expected`/`target`/`observed` revisions + Validation Snapshots + findings + earlier receipt recovery link), bounded durable journal with active recovery chains preserved across restarts (reconstructible from authority, prunable only outside active chain, degraded diagnosis separate from persistence outcome), per-scope Attempt Fence exclusivity and exact-state binding (`Rejected as Stale` when State Revision or snapshot moves, no queue), Persistence Failed (previous still verified) vs Persistence Indeterminate (neither previous nor target verifiable — blocks further Lifecycle/Runtime until readable and exact, no auto-rollback), Global Pending Barrier (global pending/indeterminate/journal-degraded blocks every project mutation/application, including Lifecycle/Repair/project startup reconciliation; inspection/Refresh remain, global-first recovery), 8 closed Attempt Summaries, closed Recovery Actions (only currently safe next step, no auto-retry), startup reconciliation (produces a new receipt for pending, no retry/rollback).
- **TUI management flow** (`/codex-marketplace`): single aggregated command faithful to `prototype/tui-management-flow@c9107d2` — hybrid discovery/guided, explicit scope choice per operation, Registration/Activation separated snapshot+revision bound Default No confirmations, Update Plan Checklist, partitioned Global/Project lists, skill-granular diagnostics, synchronized Findings, closed Recovery Actions, immediate-reload three-orthogonal Receipt report, Pending/Global Barrier blocking hints.
- **Verification matrix**: synthetic / pinned `SamWang32191/codex-plugins@98e78ca` / adversarial three-tier fixtures × (unit + integration + E2E at the TUI seam) on Pi `0.84.2` / macOS / Linux / Node `>=22.19.0`; every row is a release gate (`v*` → CI full matrix green → `npm publish --provenance` `latest`/`next` channels, `0.y`/`1.0` maintenance windows).

[Unreleased]: https://github.com/SamWang32191/pi-codex-marketplace/compare/v0.1.7...HEAD
[0.1.7]: https://github.com/SamWang32191/pi-codex-marketplace/releases/tag/v0.1.7
[0.1.6]: https://github.com/SamWang32191/pi-codex-marketplace/releases/tag/v0.1.6
[0.1.5]: https://github.com/SamWang32191/pi-codex-marketplace/releases/tag/v0.1.5
[0.1.4]: https://github.com/SamWang32191/pi-codex-marketplace/releases/tag/v0.1.4
[0.1.3]: https://github.com/SamWang32191/pi-codex-marketplace/releases/tag/v0.1.3
[0.1.2]: https://github.com/SamWang32191/pi-codex-marketplace/releases/tag/v0.1.2
[0.1.1]: https://github.com/SamWang32191/pi-codex-marketplace/releases/tag/v0.1.1
[0.1.0]: https://github.com/SamWang32191/pi-codex-marketplace/releases/tag/v0.1.0
