# 雙格式偵測與 codex 優先 (Dual format detection and codex precedence)

Bridge 擴展至支援 Claude Code 外掛生態系（`.claude-plugin/marketplace.json`），需要決定如何在登記與取得 Marketplace Source 時判定其格式，以及當兩種 catalog 同時存在時的行為。決定：**Marketplace Format 由 Marketplace Root 內容靜態且決定性推導，偵測順序固定為 codex 優先（`.agents/plugins/marketplace.json` > `.claude-plugin/marketplace.json`），判定結果固化於 Registration 記錄；格式翻轉僅能透過明確的 Marketplace Refresh 與 Update Plan 生效。**

## Decisions

- **靜態決定性推導格式**：Marketplace Root 依檔案存在性偵測 `.agents/plugins/marketplace.json` 與 `.claude-plugin/marketplace.json`；若兩者皆無則 fail-closed 報 `CATALOG_MISSING`，不支援啟發式猜測。
- **codex 格式優先（Fixed Precedence）**：當兩種 catalog 檔案並存於同一 repo 時，固定自動採用 `codex`，不向使用者提問、不猜測、亦不提供動態覆寫參數，維持自動判定之可預測性。
- **格式固化於 Registration（Fixed at Registration）**：格式（`format: 'codex' | 'claude'`）於註冊確認（Registration Confirmation）時寫入 Bridge State Registration 紀錄，成為不可變屬性。
- **格式翻轉僅經由 Update Plan（No Silent Format Flip）**：上游來源格式變更（如 codex catalog 被刪除改為 claude）在平日讀取或 reload 時絕不自動翻轉；必須經由明確的 Marketplace Refresh 產生帶有新格式的 Update Candidate，並在使用者審核 Update Plan 及通過 Confirmation 後才原子生效。
- **Entry ID 結構一致**：雙格式皆採 `/plugins/<zero-based ordinal>` 作為 Marketplace Entry ID，維持快照範圍內一致的識別與 TUI 綁定能力。

## Considered Options（拒絕）

- **互動式詢問使用者格式**：破壞自動化流程與指令腳本一致性，增加不必要的 UI 摩擦。
- **支援執行階段動態自適應格式**：動態嗅探會導致快照指紋與持久化狀態不一致，破壞 CAS 與 Validation Snapshot 邊界。
- **同時解析並合併雙格式 catalog**：會產生同一 repo 內 entry 來源重疊、ID 混亂與複雜的跨格式衝突。
- **允許上游格式變更時自動靜默遷移**：靜默變更會繞過 Validation Disclosure 與 Consent 邊界，違反 Default-No 原則。
