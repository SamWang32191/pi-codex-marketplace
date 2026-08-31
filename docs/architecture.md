# Architecture

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

## Domain vocabulary

Canonical terms are defined in [`CONTEXT.md`](../CONTEXT.md) — use them verbatim (Bridge Package vs Bridge Extension, Bridge State vs Effective State, Marketplace Source, Source Key, Validation Snapshot, Projected Skill, etc.).

## Architecture decision records

歷次決策收錄於 [`docs/adr/`](./adr/)，由新至舊：

| ADR | 決策 |
|-----|------|
| [0007](./adr/0007-headless-bridge-cli.md) | Headless Bridge CLI（純 Node 輕量 Shim＋單一 Global Scope＋Parity 輸出契約） |
| [0006](./adr/0006-credentialed-acquisition-approval.md) | 核准式 Credentialed Acquisition（固定白名單自動偵測＋環境變數覆寫） |
| [0005](./adr/0005-entry-acquisition-trust-boundary.md) | Entry 級取得的信任邊界與定位器正規化 |
| [0004](./adr/0004-unified-compatibility-profile-v2.md) | 統一 Compatibility Profile v2 取代凍結 v1 |
| [0003](./adr/0003-dual-format-detection-and-codex-precedence.md) | 雙格式偵測與 codex 優先 |
| [0002](./adr/0002-global-only-retire-project-scope.md) | Global-only：移除 Project Scope |
| [0001](./adr/0001-runtime-skill-exposure-via-host-discovery.md) | Runtime Skill Exposure via host resource discovery |

## 相關文件

- [installation.md](./installation.md) — 安裝與 requirements
- [development.md](./development.md) — 驗證矩陣、版本化與發布流程