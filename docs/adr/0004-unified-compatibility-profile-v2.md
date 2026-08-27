# 統一 Compatibility Profile v2 取代凍結 v1 (Unified Compatibility Profile v2 replacing frozen v1)

導入 Claude 外掛支援後，Bridge 需處理兩種不同 manifest 結構（`.codex-plugin/plugin.json` 與 `.claude-plugin/plugin.json`）及各自的技能與中繼資料規範。決定：**以單一統一的 Compatibility Profile v2 取代並凍結 Profile v1，將 Validation Ruleset 跳升至 v2，強制雙格式外掛在同一套嚴格規則集下進行原子分類；Claude 與 Codex 外掛享有完全一致的生命週期、碰撞解析與全有全無語意。**

## Decisions

- **單一統一 Compatibility Profile v2**：不針對 Codex 與 Claude 分別設立平行 profile，而是以 Profile v2 統一收斂雙格式外掛契約；單一驗證器負責雙格式分類。
- **Validation Ruleset 跳升至 v2**：強制所有現存與新註冊在 Profile v2 下重新驗證，確保舊 Validation Snapshot 在新規則下一致過渡。
- **原子性分類（Atomic Classification）**：Plugin 依舊採原子分類（Compatible / Incompatible / Invalid），不允許部分投影（no partial projection）；若含有非支援的主動元件（如 commands/hooks/mcpServers 等）一律歸為 Incompatible 或 Invalid。
- **Manifest 欄位三分法延續**：
  - 結構與主動元件（commands, agents, hooks, mcpServers, lspServers 等）→ Unsupported Active Component (Blocking)。
  - 已知慣性資料（displayName, description, author, repository, tags, keywords, version 等）→ Validation Warning。
  - 未知欄位 → Fail-closed Blocking。
  - Claude entry 層級之 `metadata` 為自由呈現中繼資料，整包視為 Inert Metadata。
- **Skill Descriptor 白名單一致化**：無論 Codex 還是 Claude 格式，`SKILL.md` frontmatter 僅允許 `name`, `description`, `disable-model-invocation` 三個欄位；其餘欄位一律 fail-closed Blocking。
- **Invocation Policy 來源隔離**：Claude 外掛底下的 `agents/openai.yaml` 被視為普通 Skill Resource（不解析政策）；Claude 技能的 Invocation Policy 僅由 frontmatter 之 `disable-model-invocation` 定義，避免跨格式政策衝突。
- **嚴格 Manifest 權威（Strict Manifest Authority）**：Claude 外掛必須自帶 `.claude-plugin/plugin.json`（等效 strict:true），`strict:false` 的 entry-defined 外掛與 entry/manifest 元件合併第一天不支援，列為 Unavailable Entry。

## Considered Options（拒絕）

- **並存 Profile v1 (Codex) 與 Profile-Claude v1**：多軌 profile 增加複雜度與認知負擔，未來維護與遷移矩陣成倍膨脹。
- **寬鬆容忍未知 active components**：若略過不支援的 commands 或 hooks 進行半套投影，會導致外掛在 Pi 中行為不完整或非預期。
- **支援 entry-defined 外掛（strict:false）**：使 entry 與 manifest 元件合併語意變得極端複雜，違反 Manifest 單一權威原則。
- **在 Claude 外掛中解析 `openai.yaml`**：跨生態系混用設定檔會產生政策定義權威模糊與衝突。
