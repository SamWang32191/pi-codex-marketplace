# pi-codex-marketplace

Bridge Package for Codex and Claude Marketplace compatibility in Pi (`Pi 0.84.2`）。

> **One-line:** `pi install npm:pi-codex-marketplace` → `/codex-marketplace add <本機資料夾|GitHub 網址>`（或 Shell 下 `npx pi-codex-marketplace add ...`）註冊 marketplace → `install <編號>` 裝到當下最新並在 Pi 可用。

## Quickstart

```bash
# 1. 安裝（擇一表面）
pi install npm:pi-codex-marketplace                 # Pi Extension（TUI／互動環境）
npm install -g pi-codex-marketplace                 # Headless CLI（Shell／CI；亦可 npx 免安裝）

# 2. 註冊 marketplace
/codex-marketplace add <本機資料夾|GitHub 網址>      # TUI 內
npx pi-codex-marketplace add <本機資料夾|GitHub 網址>  # Shell 下

# 3. 裝到當下最新並自動啟用
/codex-marketplace install <編號|名稱>
```

Requirements: **Pi 0.84.2** · **Node >=22.19.0** · **macOS / Linux**（Windows not supported）。完整安裝方式見 [docs/installation.md](./docs/installation.md)。

## 子命令速查

TUI `/codex-marketplace` 與 Headless CLI `pi-codex-marketplace` 共用同一組九個子命令（無參數＝總覽）：

| 子命令 | 行為 |
|--------|------|
| `add <路徑\|網址>` | 註冊 marketplace（本機資料夾、GitHub 網址、`owner/repo` 簡寫、SSH 定位器） |
| `list [名稱]` | 列出 plugins（編號／所屬 marketplace／狀態，可帶名稱過濾） |
| `install <編號\|名稱>` | 裝到**當下最新**並自動啟用＋reload |
| `update` | 全部已註冊 marketplace 重抓最新 |
| `disable <名稱>` / `enable <名稱>` | 停用／啟用 plugin |
| `remove <名稱>` | 移除單支 plugin |
| `forget <名稱>` | 移除整個 marketplace（含其全部安裝） |
| `help` | 子命令清單 |

## Documentation

完整文件結構化於 `docs/` 下（GitHub 檢視；npm 上以本 README 為入口）：

| 文件 | 內容 |
|------|------|
| [docs/installation.md](./docs/installation.md) | 安裝／更新／移除：Pi Extension 各模式、Headless CLI、`-l` 語意、requirements |
| [docs/usage.md](./docs/usage.md) | `/codex-marketplace` 使用手冊：九子命令細節、語意鐵則、Pi 原生 autocomplete |
| [docs/cli.md](./docs/cli.md) | Headless Bridge CLI：執行方式、輸出與退出代碼契約、狀態生效時機 |
| [docs/private-repos.md](./docs/private-repos.md) | 私有 Git repo：Credentialed Acquisition（核准式取得）、SSH 定位器 |
| [docs/architecture.md](./docs/architecture.md) | 架構：Bridge State storage、支援矩陣、領域詞彙、ADR |
| [docs/development.md](./docs/development.md) | 開發：驗證矩陣（發版 gate）、版本化與發布流程 |

領域術語（正典詞彙）見 [`CONTEXT.md`](./CONTEXT.md)；發布紀錄見 [`CHANGELOG.md`](./CHANGELOG.md) 與 [GitHub Releases](https://github.com/SamWang32191/pi-codex-marketplace/releases)。