# Changelog

All notable changes to `pi-codex-marketplace` are documented here. Format follows Keep a Changelog and SemVer (starting at `0.1.0`; Git tags `v*` mirror npm versions).

## [Unreleased]

### Added
- **Claude 外掛完整生命週期與驗收劇本** (#48)：
  - Claude 安裝生命週期完備：`Install Disabled` 建立 disabled 狀態（無須 Activation Confirmation）；啟用經由 `preflightPluginEnable` 重新驗證並要求 `Activation Confirmation`（Default No）。
  - Runtime Application 與投影：安裝啟用後 `projectEffectiveState` 及 `discoverProjectedSkillPaths` 動態貢獻 Claude plugins 的宣告技能目錄，並遵循 `Pi → Global` 優先序。
  - Runtime Skill Collision 如實裁決：本地 Pi 原生 skill 優先保留，碰撞之 Bridge 候選標示為 `unavailable-collision`，未碰撞技能正常投影，外掛分類不受影響保持 `Compatible`。
  - Refresh 與 Update Plan：上游變更產生 format-bound `Update Candidate`；`buildUpdatePlan` 與 `applyUpdate` 遵循全有全無原子提交，要求重新 Registration Confirmation 與 Activation Confirmation。
  - Registration Removal 連帶級聯同 registration 下所有 Claude Installations，Global Scope 其餘註冊與安裝不受波及。
  - 驗收劇本與測試：以 mattpocock-shaped fixture 完整驗證相容外掛、技能列出、同名碰撞與 TUI transaction-flow。
- **格式偵測接入登記與瀏覽流程（local + git）** (#47)：
  - 掃描 Marketplace Root 決定性推導 Marketplace Format（codex 優先；兩種 catalog 並存時自動採用 codex，無額外提問）。
  - 僅含 `.claude-plugin/marketplace.json` 的 repo 全程可登記：`format=claude` 固化於 Registration；兩者皆無時 CATALOG_MISSING 行為不變。
  - 驗證披露、Registration Confirmation 畫面與 Attempt Receipt（Transaction Sheet、Receipt Journal、Attempt Summary 通知）顯示 Marketplace Format。
  - 瀏覽（Bridge Ledger / 安裝選單）讀經註冊格式：Compatible entry 顯示外掛與技能清單，不合格 entry 顯示 Unavailable 原因；上游格式翻轉不被靜默採用，僅經 Marketplace Refresh 產生的 Update Candidate 加上明確 Apply Update 變更。
  - transaction-flow 測試以 mock Git executor 完整登記仿 mattpocock 夾具成功。

### Changed
- **Bridge State Schema v3 + format 屬性遷移** (#44)：`schemaVersion` 升為 `3`。
  - `Registration` 記錄新增 Marketplace Format 屬性（`codex | claude`）——本票只鋪持久層地基，格式偵測與 claude 解析由後續票交付。
  - v2 → v3 WAL migration 為既有 Registration 自動補上 `format=codex` 預設值，內容零損失（已宣告的 `codex | claude` 值原樣保留）。
  - 新寫入的 Registration 可承載 `format=claude` 並正確回讀。

## [0.2.0] - 2026-08-26

### Removed (Breaking)
- **Project Scope 與多範圍架構退休（Global-only simplification）** (#58, #61, ADR 0002)：
  - 徹底移除多範圍維度，Bridge State 轉為單一 Global Scope 管理（`~/.pi/agent/codex-marketplace/state.json`）。
  - 磁碟上殘留的既有 project state 檔（`{cwd}/.pi/codex-marketplace/state.json`）完全無視（不讀、不提示、不刪）。
  - 刪除內部 API 之 `Scope` type 與 `'global' | 'project'` 參數；路徑、store、fence、journal、reconciliation 全部收斂為單一全域實例。
  - 移除約 1,800 行專屬 project 模組（`src/projection/overrides.ts`、`src/projection/project.ts`、`src/barrier/global-barrier.ts` 等）。
- **Scope Override 功能端到端退休** (#59)：
  - 移除 overrides 核心模組與 TUI「Scope 與繼承」分區、建立／移除 Scope Override 動作與 inherited／suppresses 標記。
  - 繼承自 Global 的 Registration / Installation 一律參與 Effective State，無任何抑制路徑。
- **Global Pending Barrier 端到端退休** (#60)：
  - 刪除 barrier 核心模組（`src/barrier/global-barrier.ts`）與全部呼叫點；Attempt Fence 取得前不再檢查 barrier。
  - `BARRIER-01` finding code／rule／ui-strings 文案全數清除；Pending Application 復原語意由既有 active recovery chain（如 Retry Application）承擔。

### Changed
- **Bridge State Schema v2 + WAL Migration** (#63)：
  - `schemaVersion` 升為 `2`。
  - v1 → v2 WAL migration 剝除 `scopeOverrides` 死欄位；非空 overrides 剝除並產出 non-blocking `MIGRATE-01` 診斷 finding（不 fail-closed）。
  - 規範化 Installation ID：自動剝除舊版 `global/` 前綴。
- **Runtime Skill Collision 簡化為兩層** (#61)：
  - 碰撞解析由 `Pi → Project Scope → Global Scope` 三層收斂為 `Pi → Global Scope` 兩層。
  - 任何已啟用的 Global Plugin skill 只要未與 Pi 原生/本機 skill 碰撞即正常暴露；同層 Bridge 碰撞者皆為 unavailable。
- **TUI Bridge Ledger 單軌收斂** (#62)：
  - 移除 Project 軌、G/P marker、`g`/`p` 瀏覽焦點鍵與 Trust/Barrier 指示區。
  - 導航重整為 **Observe**、**Sources**、**Plugins**、**Recovery & receipts** 四大正典群組。
- **文件與版本定錨** (#64)：
  - README 全面改寫為單一 Global 行為，釐清 `pi install -l` 屬 Pi host 套件位置，更新 v2 schema 與 TUI 導覽說明。
  - `package.json` 版本定錨為 `0.2.0`，description 移除多範圍字樣。

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

[Unreleased]: https://github.com/SamWang32191/pi-codex-marketplace/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/SamWang32191/pi-codex-marketplace/compare/v0.1.10...v0.2.0
[0.1.10]: https://github.com/SamWang32191/pi-codex-marketplace/compare/v0.1.9...v0.1.10
[0.1.9]: https://github.com/SamWang32191/pi-codex-marketplace/compare/v0.1.8...v0.1.9
[0.1.8]: https://github.com/SamWang32191/pi-codex-marketplace/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/SamWang32191/pi-codex-marketplace/releases/tag/v0.1.7
[0.1.6]: https://github.com/SamWang32191/pi-codex-marketplace/releases/tag/v0.1.6
[0.1.5]: https://github.com/SamWang32191/pi-codex-marketplace/releases/tag/v0.1.5
[0.1.4]: https://github.com/SamWang32191/pi-codex-marketplace/releases/tag/v0.1.4
[0.1.3]: https://github.com/SamWang32191/pi-codex-marketplace/releases/tag/v0.1.3
[0.1.2]: https://github.com/SamWang32191/pi-codex-marketplace/releases/tag/v0.1.2
[0.1.1]: https://github.com/SamWang32191/pi-codex-marketplace/releases/tag/v0.1.1
[0.1.0]: https://github.com/SamWang32191/pi-codex-marketplace/releases/tag/v0.1.0
