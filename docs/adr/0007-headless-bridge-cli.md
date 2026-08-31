# Headless Bridge CLI（純 Node 輕量 Shim＋單一 Global Scope＋Parity 輸出契約）

> **Status: 已採納（#132, #133）**

Bridge Package 原僅透過 Pi Extension（`/codex-marketplace` 指令與 `resources_discover`）提供管理與投影功能，必須在 Pi TUI 內或經由 Pi runtime 啟動。但在 CI/CD 流程、自動化腳本及純 Shell 環境下，開發者需要直接管理 Marketplace 註冊與外掛安裝。#132 與 #133 決定：在 Bridge Package 提供純 Node 輕量 CLI shim（`pi-codex-marketplace`），直接調度純粹的 `runCommand` 縫，操作同一份單一 Global Scope（`state.json`），提供無須啟動 Pi runtime、免互動、確定性輸出與退出代碼的 headless 管理表面。

## Decisions

- **Node ≥22.19 原生 Type Stripping 執行**：CLI bin shim（`bin/pi-codex-marketplace.js`）直接執行並以內建 module loader hook 解析 TypeScript，無須額外建置步驟（no build step），與 extension `jiti` 載入哲學一致。
- **純粹適配層（`runCli(argv, io, opts)`）**：將 `process.argv` 轉發至既有純粹 `runCommand` 派發縫；注入式 `io`（stdout/stderr/exit）使 E2E 測試完全隔離，不觸發真實處理程序退出或污染終端。
- **輸出與退出代碼契約（Output & Exit Contract）**：
  - 主要輸出（overview、help、--version、查詢結果、成功訊息）寫入 stdout，退出代碼為 `0`。
  - 錯誤訊息（未知子命令、缺少或非法參數、註冊/安裝/狀態寫入失敗）寫入 stderr，退出代碼非零（`1`）。
  - 絕對免提示（Never prompt）：背景與 CI 執行安全。
  - 狀態變更（`reload: true`）提示語轉換：CLI 無 in-process reload（`ctx.reload`），原「已重新載入生效」改為「已寫入 Bridge State · 下次 pi session／/reload 生效」，明確告知變更將於下次 Pi 啟動或 `/reload` 生效。
- **單一 Global Scope 一致性**：CLI 與 Extension 共用相同的 `getAgentDir()` 與 Bridge State 儲存位址，完全支援 `PI_CODING_AGENT_DIR` / `PI_AGENT_DIR` 環境變數覆寫，測試不污染本機 `~/.pi/agent`。
- **語意與參數 Parity**：九個子命令（`add`, `list`, `install`, `update`, `disable`, `enable`, `remove`, `forget`, `help`）及 `--version` 維持與 TUI 相同的語彙與行為。

## Considered Options（拒絕）

- **修改 Pi Core 支援 Extension Top-Level Verbs**：需破壞 Pi 核心架構與擴充契約。拒絕。
- **僅支援 TUI / 僅在 Pi 進程內操作**：CI 與自動化腳本無法運作。拒絕。
- **常駐 Background Daemon / In-process Reload 守護進程**：過度設計；Global Scope 檔案寫入本就於下次 Pi session 或 `/reload` 自然生效。拒絕。
- **首期支援 `--json` 機器可讀輸出**：超出追蹤子彈範疇；首期專注於與 TUI 輸出 Parity 及標準 CLI 退出碼。
