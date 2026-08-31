# pi-codex-marketplace

Bridge Package for Codex and Claude Marketplace compatibility in Pi (`Pi 0.84.2`).

> **One-line:** `pi install npm:pi-codex-marketplace` → `/codex-marketplace add <本機資料夾|GitHub 網址>`（或 Shell 下 `npx pi-codex-marketplace add ...`）註冊 marketplace → `install <編號>` 裝到當下最新並在 Pi 可用。

## Install

### Pi Extension（TUI / 互動環境）

```bash
pi install npm:pi-codex-marketplace                    # Global package (writes to ~/.pi/agent/settings.json)
pi install npm:pi-codex-marketplace -l                 # Project package location (.pi/settings.json; Pi host package setting only)
pi install ./path/to/pi-codex-marketplace              # Local path (try without publishing)
pi install ./path/to/pi-codex-marketplace -l           # Local path, Project package location
pi -e npm:pi-codex-marketplace                         # Ephemeral try without installing (temporary)
pi update npm:pi-codex-marketplace                     # Update one package
pi update --all                                        # Update pi + all packages
pi remove npm:pi-codex-marketplace                     # Remove package
pi list                                                # List installed packages
pi config                                              # Enable/disable resources
```

### Headless CLI（Shell / CI/CD 自動化）

```bash
# 免安裝直接以 npx 執行
npx pi-codex-marketplace [subcommand]

# 或全域安裝使用
npm install -g pi-codex-marketplace
pi-codex-marketplace [subcommand]
```

Source types follow `docs/packages.md`: `npm:` for registry, `git:`/`https://` for git, and absolute/relative paths for local. Ephemeral runs use `pi -e <source>` (not `pi install -e`). This package declares a single `pi` extension entry (`extensions/pi/index.ts`) loaded via `jiti` and requires no build step.

> [!NOTE]
> `pi install -l` controls where Pi loads this Bridge Package extension from (`.pi/settings.json` vs `~/.pi/agent/settings.json` on the Pi host). Regardless of how Pi installs the package, the Bridge State managed by `pi-codex-marketplace` is always recorded in the single Global Scope (`~/.pi/agent/codex-marketplace/state.json`).

Requirements: **Pi 0.84.2**, **Node >=22.19.0**, **macOS / Linux** (Windows not supported).

## Usage — `/codex-marketplace`（純文字，無 TUI）

Nine subcommands, no arguments = 總覽：

```
/codex-marketplace
/codex-marketplace help
```

| 子命令 | 行為 |
|--------|------|
| `add <路徑\|網址>` | 註冊 marketplace（本機資料夾、GitHub 完整網址、`owner/repo` 簡寫皆收），自動偵測 codex／claude 格式並告知 `偵測：<format> marketplace · N plugins`。重複註冊同來源被拒絕並提示下一步。Git 來源以安全線取得（`core.hooksPath=/dev/null`、`GIT_LFS_SKIP_SMUDGE=1`、`GIT_TERMINAL_PROMPT=0`），catalog 解析失敗明示錯誤、不註冊。私有 HTTPS repo **開箱即用**：自動偵測本機憑證來源（`gh` 登入／macOS 鑰匙圈／`credential-store`）並逐次核准；也可用 `PI_CODEX_MARKETPLACE_CREDENTIAL_HELPERS` 顯式覆蓋核准清單（逐次生效、永不持久化），或改用 SSH 定位器；用法與範例見下方〈私有 Git repo：Credentialed Acquisition〉。 |
| `list [名稱]` | 列出 plugins（編號／所屬 marketplace／狀態：可安裝・已裝啟用・已裝停用・unavailable＋原因），可帶 marketplace 名稱過濾。 |
| `install <編號\|名稱>` | 裝到**當下最新**並自動啟用＋reload。成功話術如 `安裝 "name"（N skills：a, b, c）· 已重新載入生效`；同名衝突列出 `⚠ skill "b" 與既有同名，未投影（名稱衝突）`。**重複安裝＝重抓最新覆寫**（重裝＝更新，不報錯）。 |
| `update` | 對全部已註冊 marketplace 重抓最新：有變化的 plugin 升到最新、無變化各自顯示「無變化」；整體以「已重新載入生效」收尾（有變時）。 |
| `disable <名稱>` / `enable <名稱>` | 停用／啟用 plugin（enable 重新投影＋reload）。 |
| `remove <名稱>` | 移除單支 plugin（不動 marketplace、不動來源資料）。 |
| `forget <名稱>` | 移除整個 marketplace（含其全部安裝）。 |
| `help` | 子命令清單。 |

語意鐵則：

- 安裝語意不分「安裝／啟用」兩步；輸出不得宣稱 reload 後 skill 已在 host 內可見（host 無內省 API），只說「已重新載入生效」。
- catalog 內 git 型或不支援來源的 entry 一律 `unavailable` 並顯示原因；解析失敗顯示明確錯誤、不給裝。
- 安裝成功後由指令層主動要求 reload；reload 失敗不影響已記錄狀態，下次 session start 或 `/reload` 仍生效。
- `--no-skills` 啟動 Pi 不影響 Bridge 投影。

### Autocomplete（Pi 原生，TUI 限定）

互動（TUI）模式下，`/codex-marketplace` 以 **Pi 原生 autocomplete** 提供兩層、狀態感知的候選。**純文字指令表面維持權威不變**：九個子命令、指令參數、輸出與語意完全不受 autocomplete 影響；RPC／JSON／print 模式根本不註冊 terminal-only provider。

**第一層——九個根層子命令。** 輸入完整的 `/codex-marketplace` 後按 Tab，候選清單顯示全部九個子命令（`add`／`list`／`install`／`update`／`disable`／`enable`／`remove`／`forget`／`help`）與各自說明，支援不分大小寫的模糊搜尋。選取需要參數的子命令（`add`／`list`／`install`／`disable`／`enable`／`remove`／`forget`）會自動補上一個尾隨空格，可直接繼續輸入；`update` 與 `help` 不加。

**第二層——再按一次 Tab 開啟狀態感知候選。** 需要參數的子命令套用後，**再按一次 Tab** 依當下 Bridge State 只列出當下可執行的選項（空集合不給假候選）；**不承諾自動重開 selector**（Pi 0.84.2 在套用候選後不會自動再開一層補完選單，鍵盤流程固定是「輸入 command → Tab 選子命令 → 需要參數時再按一次 Tab」）：

| 子命令 | 候選範圍 | 歧義處理 |
|--------|----------|----------|
| `install` | 可安裝／可重裝的 plugin（**不含 Unavailable Entry**） | 名稱在完整 enumeration 唯一＝插入名稱；同名（含 unavailable sibling）＝插入 enumeration 編號（`#N`），描述顯示 `[marketplace]` 與狀態 |
| `enable` | 僅**已停用**的 Installation | 名稱無法唯一解析的記錄不給候選 |
| `disable` | 僅**已啟用**的 Installation | 同上 |
| `remove` | 全部已安裝 plugin（不分啟用／停用） | 同上 |
| `list` | Marketplace Registrations | 名稱無法唯一解析＝依序改插唯一可解析的 alias、其次 Registration id |
| `forget` | Marketplace Registrations | 同上 |
| `add` | **不提供 Bridge 候選**：Tab 委派 Pi 原生路徑 completion，Git locator 維持自由輸入 | — |

補完只提議當下可執行的動作，候選反映最新 Bridge State，且**被動讀取**——按 Tab 絕不會重置或重寫損壞的 state 文件。其餘輸入（其他 slash 指令、一般文字、檔案／路徑補完）一律原樣委派 Pi 既有 provider；安裝本套件不影響任何其他指令的 autocomplete。

> 沒有 custom TUI、沒有自動第二層 selector：所有操作也都可以照舊以純文字輸入完成，autocomplete 只是 discoverability 與輸入效率層。

### 私有 Git repo：Credentialed Acquisition（核准式取得）

對私有 HTTPS repo，`add`／`update` **開箱即用**：預設會自動偵測本機已存在的憑證來源並逐次核准（**固定白名單**，不讀本機 gitconfig 的任意 helper；偵測結果只限該次呼叫、永不持久化）：

| 偵測來源 | 核准的 credential helper |
|---|---|
| `gh` CLI 已登入（`gh auth status` 成功） | `!gh auth git-credential` |
| macOS 原生鑰匙圈 helper 存在 | `osxkeychain` |
| git `credential-store` 存在 | `store`（明文憑證檔，請知悉風險） |

已註冊或欲手動控制時，以逗號分隔設定環境變數——**顯式設定完全覆蓋自動偵測**（逐次生效、永不持久化，`add` 與 `update` 共用同一核准來源）：

```
PI_CODEX_MARKETPLACE_CREDENTIAL_HELPERS='store, !f() { echo "username=${GITHUB_USER}"; echo "password=${GITHUB_TOKEN}"; }; f'
/codex-marketplace add https://github.com/acme/private-mkt
```

Credentialed Acquisition 語意（安全線）：

- 預設（未設 env）＝自動偵測固定白名單（gh／osxkeychain／store），僅限該次呼叫：**不寫入** Bridge State、設定檔或任何持久化位置；偵測到的 helper 以命令列 `credential.helper=` 傳入，gitconfig 的其他 helper（含 URL-scoped）仍被排除。
- 設定 env 後完全覆蓋：值為 git `credential.helper` 字串，逗號分隔、各項 trim、空項目忽略；未設定且偵測無結果＝無任何 helper（行為與 credential-free 完全相同，安全線其餘禁制不變）。
- 憑證與核准清單**永不**進入指令輸出、Bridge State、Canonical Git Locator（定位器）、Validation Snapshot（快照）或 cache identity（快取身份）——取得流程的 identity 判定與憑證完全無關。
- 自動偵測或已核准的 helper 仍被遠端拒絕（401）時，錯誤訊息提示檢查登入（`gh auth status`／keychain）或設環境變數核准其他 helper；本機偵測不到任何憑證來源時提示設環境變數或改用 SSH。
- 設定的 helper 名稱無效時（例如直接寫 `gh`——它不是 git 原生的 credential helper 執行檔），錯誤訊息指出正確寫法：原生 helper 名稱（`osxkeychain`／`store`）或 shell form（`!gh auth git-credential`）。

##### SSH 定位器：私有 repo 的替代路徑

私有 repo 可以完全繞過此環境變數，直接用 SSH 定位器註冊（HTTPS 與 SSH 同屬允許的 credential-free 定位器）：

```
/codex-marketplace add git@github.com:acme/private-mkt       # scp-like 簡寫（canonical：ssh://git@github.com/acme/private-mkt）
/codex-marketplace add ssh://git@github.com:acme/private-mkt
```

前提（與既有 Acquisition Trust Base 一致）：

- host key 必須**預先存在** `~/.ssh/known_hosts`——安全線以 `StrictHostKeyChecking=yes` 只信任既有 host key，遇到未知或變更的主機金鑰直接拒絕，不會提示接受；
- 憑證由 SSH agent 提供，整個取得過程不互動（`BatchMode=yes`）、無任何提示；
- SSH 定位器本身仍維持 credential-free：不得內嵌密碼（`user:pass@` 拒絕）；憑證只能經由 SSH agent 或 Credentialed Acquisition 到達取得流程。

## Headless Bridge CLI — `pi-codex-marketplace`

Bridge Package 除了提供 Pi Extension TUI 指令，亦內建純 Node 輕量 CLI bin shim（`pi-codex-marketplace` / `npx pi-codex-marketplace`），專為 CI/CD 流程、自動化腳本與純 Shell 環境設計。無須啟動 Pi TUI 或 Pi runtime，即可直接管理 Marketplace 註冊與外掛安裝。

### 執行方式

```bash
# 1. 無參數：總覽（列出已註冊 Marketplace、已安裝外掛與指令用法）
npx pi-codex-marketplace

# 2. 版本與說明
npx pi-codex-marketplace --version    # 或 -v
npx pi-codex-marketplace help

# 3. 執行子命令（與 TUI 指令完全一致）
npx pi-codex-marketplace add <路徑|網址>
npx pi-codex-marketplace list [名稱]
npx pi-codex-marketplace install <編號|名稱>
npx pi-codex-marketplace update
npx pi-codex-marketplace disable <名稱>
npx pi-codex-marketplace enable <名稱>
npx pi-codex-marketplace remove <名稱>
npx pi-codex-marketplace forget <名稱>
```

### 九個子命令一覽

| 子命令 | 行為 |
|--------|------|
| `add <路徑\|網址>` | 註冊 marketplace（本機資料夾、GitHub 完整網址、`owner/repo` 簡寫或 SSH 定位器），自動偵測並回報格式。重複來源拒絕。私有 HTTPS repo 支援固定白名單自動偵測與 `PI_CODEX_MARKETPLACE_CREDENTIAL_HELPERS` 環境變數。 |
| `list [名稱]` | 列出 plugins（編號／所屬 marketplace／狀態：可安裝・已裝啟用・已裝停用・unavailable＋原因），支援 marketplace 名稱過濾。 |
| `install <編號\|名稱>` | 裝到當下最新並自動啟用。重複安裝＝重抓最新覆寫（重裝＝更新）。衝突時提示同名未投影警告。 |
| `update` | 對全部已註冊 marketplace 重抓最新並更新有變化的外掛。 |
| `disable <名稱>` / `enable <名稱>` | 停用／啟用 plugin。 |
| `remove <名稱>` | 移除單支 plugin（不動 marketplace 與來源資料）。 |
| `forget <名稱>` | 移除整個 marketplace 及其全部安裝。 |
| `help` | 輸出子命令清單與用法。 |

### 輸出與退出代碼契約（Output & Exit Contract）

CLI 遵循嚴格的標準命令列契約，確保 CI/CD 與腳本整合的確定性：

- **標準輸出（stdout）**：所有正常操作輸出（總覽、說明、版本、查詢清單、成功訊息）寫入 `stdout`，退出代碼為 `0`。
- **標準錯誤（stderr）**：所有錯誤情況（未知子命令、缺少或非法參數、重複註冊、目標不存在或歧義、Git 取得失敗等）寫入 `stderr`，退出代碼為非零（`1`）。
- **絕對免提示（Never prompt）**：全流程不發起任何終端互動提示（no interactive prompts），遇到歧義或錯誤立即明確報錯並退出，背景執行安全無虞。

### 狀態生效時機（Same-State Caveat）

- **單一 Global Scope 一致性**：CLI 與 Extension 共用相同的 `getAgentDir()` 與 Bridge State 儲存位址（`~/.pi/agent/codex-marketplace/state.json`），完全支援 `PI_CODING_AGENT_DIR` / `PI_AGENT_DIR` 環境變數覆寫。
- **無 In-process Reload 提示語轉換**：CLI 執行於 Pi 外部獨立 Node 行程，無 Pi runtime 內部的即時 reload 機制（`ctx.reload`）。狀態變更指令（`install`、`enable`、`update`）輸出將 TUI 的「已重新載入生效」替換為：
  ```
  已寫入 Bridge State · 下次 pi session／/reload 生效
  ```
- **投影時機**：CLI 寫入的變更已持久化至 Bridge State，將在下次啟動 Pi session 或於 Pi TUI 內執行 `/reload` 時，經由 Pi host 資源發現接縫（`resources_discover`）自動完成技能投影。

## Bridge State storage

Bridge State 是唯一權威，存於**單一 Global Scope 文件** `{getAgentDir()}/codex-marketplace/state.json`（`~/.pi/agent/codex-marketplace/state.json`）：

```jsonc
{
  "schemaVersion": 1,   // 固定，永不遷移
  "registrations": [],  // immutable Registration ID = UUIDv4；sourceKind: "local" | "git"；git 帶 snapshot fingerprint（cache 位址）
  "installations": []   // Installed Plugins（enabled/disabled），含 manifestName、skills 與 snapshot（git）
}
```

- **重建＝重置**：壞檔或不認識的格式一律重置為空、重新註冊重裝；沒有 repair、沒有 migration、沒有 State Revision。
- 寫入防護：`write-to-temp → fsync → rename`（原子）＋ 檔案鎖（`.lock` sibling，last-write-wins、無 stale 偵測）＋ read-after-verify。
- Git marketplace 的 snapshot fingerprint 是 **Source Cache 位址鑰匙**（`cache/entries/<fingerprint>`）；投影直讀該 cache entry，指紋不可替換成別種身份值。Cache 只對非 pinned entry 做 LRU 驅逐。

See `src/bridge/state.ts`（Minimal Bridge State）、`src/bridge-state/atomic.ts`（原子寫入＋檔案鎖）、`src/cache/source-cache.ts`。

## Support matrix

| Dimension | Supported | Notes |
|-----------|-----------|-------|
| OS | **macOS**, **Linux** | Windows not supported (path containment, symlink, `flock` semantics are POSIX-only) |
| Node | **>=22.19.0** | `engines.node` enforced |
| Pi host | **0.84.2** | `peerDependencies` exact `0.84.2`; expected compatible range `^0.84.2` (devDeps). `pi-ai`/`pi-tui` peers `*` per Pi extension docs. |
| Semantics | `pi install` / `pi -e` / `pi install -l` / `pi update` / `pi remove` / `pi list` / `pi config` ＋ `npx pi-codex-marketplace` / `bin/pi-codex-marketplace.js` CLI | Single `pi` extension package + headless CLI bin; `files` ships `bin/`, `extensions/`, `src/`, `README.md`, `LICENSE` only |

Peer declaration (dual): **精確 `0.84.2`** in `peerDependencies` (exact host that this version was validated against) + **預期 `^0.84.2`** in `devDependencies` (range expected to remain compatible). `pi-ai` and `pi-tui` remain `*` because they are bundled by Pi.

## Versioning & release flow

- **Package**: `pi-codex-marketplace` published to **npm** as primary, **Git tag** `v*` as mirror.
- **SemVer**: starts at `0.1.0`; `0.y` maintenance window until `1.0.0` signals a stable Bridge State contract.
- **Publishing**: `v*` tag → CI **full matrix green** (below) is a **release gate** → `npm publish --provenance` (OIDC). `latest` tracks stable tags (`v0.*` stable line and later `v1.*`); `next` tracks pre-release tags. Provenance is required (`--provenance`) and verified post-publish by the publish workflow. See `.github/workflows/ci.yml` and `.github/workflows/publish.yml`.

## Verification matrix (發版阻擋 gate)

Every row is a **release blocker**: `v*` may not publish unless the full matrix is green.

| Layer | What is covered |
|-------|-----------------|
| unit — 縫層 | `runCommand` 指令分派（add/list/install/update/disable/enable/remove/forget/help、重複註冊拒絕、重裝覆寫、衝突未投影清單、corrupt→重置、unavailable 顯示、git 重抓）、Minimal Bridge State 原子持久化 |
| unit — 低層 | 雙格式 catalog 解析（codex＋claude、open 政策、unavailable entry）、git locator／source-key（fixed `default` selector）、contained path／symlink、collision、投影（exposure）、source-cache（store/hit/LRU/pin/flock）、git acquisition（mock executor） |
| integration | 真 Pi 縫：extension 註冊 `resources_discover` → 投影 skillPaths（startup/reload 一致、trust flag 無關、被動不變異） |
| E2E | `/codex-marketplace` 薄 Pi adapter 與 `pi-codex-marketplace` CLI 適配層（overview/help、--version、雙格式 add/list、install/update、lifecycle 停用啟用移除、狀態變更 reload 提示轉換、確定性退出碼與環境隔離） |

Fixtures: `tests/fixtures/synthetic/`, `tests/fixtures/pinned/`（captured `SamWang32191/codex-plugins@98e78ca` snapshot）、`tests/fixtures/adversarial/`。See `tests/acceptance/` for the matrix runner that enforces per-row gating (any row failure blocks publish).

Run locally:

```bash
npm run typecheck
npm test                          # full matrix (unit + integration + E2E)
npm run test:acceptance           # acceptance matrix only
```

## Development

```bash
npm install
npm run typecheck
npm test
npm run test:acceptance
```

## Domain vocabulary

Canonical terms are defined in [`CONTEXT.md`](./CONTEXT.md) — use them verbatim (Bridge Package vs Bridge Extension, Bridge State vs Effective State, Marketplace Source, Source Key, Validation Snapshot, Projected Skill, etc.).

## Changelog & Releases

See [`CHANGELOG.md`](./CHANGELOG.md) and [GitHub Releases](../../releases). Version `0.1.0` is the first SemVer release; Git tags mirror npm versions (`v0.1.0` → `0.1.0`).