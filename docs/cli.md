# Headless Bridge CLI — `pi-codex-marketplace`

Bridge Package 除了提供 Pi Extension TUI 指令，亦內建純 Node 輕量 CLI bin shim（`pi-codex-marketplace` / `npx pi-codex-marketplace`），專為 CI/CD 流程、自動化腳本與純 Shell 環境設計。無須啟動 Pi TUI 或 Pi runtime，即可直接管理 Marketplace 註冊與外掛安裝。

## 執行方式

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

## 九個子命令一覽

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

## 輸出與退出代碼契約（Output & Exit Contract）

CLI 遵循嚴格的標準命令列契約，確保 CI/CD 與腳本整合的確定性：

- **標準輸出（stdout）**：所有正常操作輸出（總覽、說明、版本、查詢清單、成功訊息）寫入 `stdout`，退出代碼為 `0`。
- **標準錯誤（stderr）**：所有錯誤情況（未知子命令、缺少或非法參數、重複註冊、目標不存在或歧義、Git 取得失敗等）寫入 `stderr`，退出代碼為非零（`1`）。
- **絕對免提示（Never prompt）**：全流程不發起任何終端互動提示（no interactive prompts），遇到歧義或錯誤立即明確報錯並退出，背景執行安全無虞。

## 狀態生效時機（Same-State Caveat）

- **單一 Global Scope 一致性**：CLI 與 Extension 共用相同的 `getAgentDir()` 與 Bridge State 儲存位址（`~/.pi/agent/codex-marketplace/state.json`），完全支援 `PI_CODING_AGENT_DIR` / `PI_AGENT_DIR` 環境變數覆寫。
- **無 In-process Reload 提示語轉換**：CLI 執行於 Pi 外部獨立 Node 行程，無 Pi runtime 內部的即時 reload 機制（`ctx.reload`）。狀態變更指令（`install`、`enable`、`update`）輸出將 TUI 的「已重新載入生效」替換為：
  ```
  已寫入 Bridge State · 下次 pi session／/reload 生效
  ```
- **投影時機**：CLI 寫入的變更已持久化至 Bridge State，將在下次啟動 Pi session 或於 Pi TUI 內執行 `/reload` 時，經由 Pi host 資源發現接縫（`resources_discover`）自動完成技能投影。

## 相關文件

- [usage.md](./usage.md) — TUI 表面 `/codex-marketplace`（子命令語意與 CLI 完全一致）
- [installation.md](./installation.md) — Headless CLI 安裝方式（npx 免安裝或 `npm install -g`）
- [private-repos.md](./private-repos.md) — `add`／`update` 的私有 repo 憑證取得（兩者共用同一核准來源）