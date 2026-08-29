# pi-codex-marketplace

Bridge Package for Codex and Claude Marketplace compatibility in Pi (`Pi 0.84.2`).

> **One-line:** `pi install npm:pi-codex-marketplace` → `/codex-marketplace add <本機資料夾|GitHub 網址>` 註冊 marketplace → `install <編號>` 裝到當下最新並立刻在 Pi 可用。

## Install

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
| `add <路徑\|網址>` | 註冊 marketplace（本機資料夾、GitHub 完整網址、`owner/repo` 簡寫皆收），自動偵測 codex／claude 格式並告知 `偵測：<format> marketplace · N plugins`。重複註冊同來源被拒絕並提示下一步。Git 來源以安全線取得（`core.hooksPath=/dev/null`、`GIT_LFS_SKIP_SMUDGE=1`、`GIT_TERMINAL_PROMPT=0`），catalog 解析失敗明示錯誤、不註冊。 |
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
| Semantics | `pi install` / `pi -e` / `pi install -l` / `pi update` / `pi remove` / `pi list` / `pi config` | Single `pi` extension package; `files` ships `extensions/`, `src/`, `README.md`, `LICENSE` only |

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
| E2E | `/codex-marketplace` 薄 Pi adapter：overview/help 輸出路由、corrupt 重置通知、reload 門控 |

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