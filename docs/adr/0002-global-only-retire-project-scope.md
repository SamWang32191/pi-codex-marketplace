# Global-only: retire Project Scope

> **Status: 部分仍是現行決策（極簡收斂）** — 「Global-only」本身仍成立並維持。決策時點列為「保留」的生命週期機制清單已過時：Refresh／Update Plan、Rebind、Receipt Journal、Repair State、Attempt Fence 及其餘防損毀機械於 #87 極簡定案後經 #95 整層退場，TUI 亦已移除。

Bridge 原本以雙範圍架構交付（Global Scope 基準線 + Project Scope overlay + Scope Overrides），並為此撐起一整組專屬機制：Scope Override、Project Trust、Global Pending Barrier、project precedence、`Pi → Project → Global` 三層碰撞解析，以及雙文件 store / journal / fence。決定：**移除「多範圍」這個維度，Bridge 只管理單一 Global Scope**；其餘生命週期機制（Registration、Installation、Refresh／Update Plan、Rebind、Removal、Receipt Journal、Repair State、Runtime Skill Exposure、Attempt Fence）全部保留，並以 Global 為單一目標（後續 #87 極簡收斂已將其中 Refresh／Update Plan、Rebind、Receipt Journal、Repair State、Attempt Fence 整層退場）。此決策移除約 1,800 行純 project 相關程式碼（`overrides.ts`、`project.ts`、`global-barrier.ts`、`scope-overrides.ts` 等）並大幅收斂 TUI 與測試矩陣。

## Decisions

- **只砍「多範圍」維度**：生命週期機制不重新設計。Scope Override、Project Trust、Global Pending Barrier、project precedence 全數移除；Runtime Skill Collision 改為 `Pi → Global` 兩層；Installation ID 不再含 scope 分量（即 Plugin ID）。
- **既有 project state 檔完全無視**：不讀、不提示、不刪。fail-closed 只作用於 Bridge 實際讀取的檔案；使用者磁碟上殘留的 project 資料由使用者自行處置。`.pi/` 已在 `.gitignore`，無 repo 清理問題。
- **schemaVersion 升為 2**：v1→v2 WAL migration 剝除 `scopeOverrides`。該欄位在 global 語意中定義即為死欄位，故非空 overrides 一律剝除並記 diagnostic finding，**不** fail-closed——避免把正常 Registration 卡死在語意已死的欄位上。（後收斂：極簡 Bridge State 已於 #95 起固定 `schemaVersion = 1`、永不遷移、無 WAL migration——本條僅為 v2 時點之歷史決策，見 docs/architecture.md「Bridge State storage」。）
- **內部 API 移除 scope 參數**：刪除 `Scope` type 與所有 `'global' | 'project'` 分支；路徑／收據／fence helpers 只剩 global 系列（後於 #95 全數拆除）。不為「未來可能回頭」保留死參數——需要時 git 歷史與本 ADR 就是接點。
- **TUI 單軌收斂**：Bridge Ledger 只有 Global 分區；移除 `g`／`p` 瀏覽焦點鍵與「Scope & inheritance」導航群組；Trust／Barrier 指示區移除；導航收斂為 Observe / Sources / Plugins / Recovery & receipts。（TUI 已於 #95 整層移除，本條僅為歷史。）
- **版本 0.2.0**：0.y 視窗內以 minor bump 表達 breaking；schemaVersion 綁版號 bump 依 docs/development.md 既有流程。
- **順序**：本次簡化先行，Claude 雙格式路線圖（#43–#52）在其後——簡化先縮小 Profile v2 每張 ticket 的表面積。

## Considered Options（拒絕）

- **保留雙範圍**：便利性已無對應需求，維護重量（純 project 程式碼 + 大量測試與 TUI 分支）不成比例。
- **自動遷移既有 project 資料到 global**：自動搬運等於讓舊 Activation Confirmation 靜默覆蓋新位置；改為「完全不碰、不讀、不刪」。
- **更深入的儀式簡化**（連 Receipt Journal／Update Plan 一起砍）：與「只提供 Global」的單一目的無關；本次只刪範圍維度。
- **保留 `scope` 參數但只接受 `'global'`**：替未來留接點是騙人的介面。
- **維持 schema 1、保留 `scopeOverrides` 死欄位**：留死欄位給未來讀者埋地雷。
