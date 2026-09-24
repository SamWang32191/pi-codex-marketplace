# Skill Exclusion 採排除清單而非允許清單

> **Status: 已採納（#156、#157、#158；規格父項 #155）**

Bridge 過去只能整支啟用或停用 Installed Plugin，使用者若只需要 engineering 等 Plugin 的部分 skills，只能二選一：停用整個 Plugin 而失去想留下的 skills，或全數接受。規格父項 #155 之下的三個子 Ticket 依序交付了 Skill Exclusion（#156）、批次 only／reset（#157）與狀態呈現及操作文件（#158）。本 ADR 記錄這條路線的核心取捨：**每個 Installed Plugin 保存一份以 Skill Descriptor 名稱為 key 的排除清單（Skill Exclusions），未列入者預設參與 Runtime Skill Exposure。**

## Decisions

- **排除清單是唯一形狀，不是允許清單**：Bridge State 只記錄「被排除」的名字；沒有 allow-list、沒有「僅允許」欄位。因此新增、改名或上游新出現的 skill 一律預設可參與投影，不會被舊設定意外擋住；既有安裝沒有 `skillExclusions` 欄位時語意等同空清單，不因新功能重置 Bridge State。
- **以 Skill Descriptor 名稱為 identity**：排除以 Skill Descriptor 的 `name` 為 key，而非目錄路徑、索引或雜湊。改名視為新 skill（舊排除不跟隨）；同名先消失再重現時沿用原排除。取消排除與重設只依賴紀錄本身，因此來源不可讀、Plugin 已停用時仍可還原。
- **新增排除須以當下可確認的來源為準**：`exclude` 與 `only` 只接受目前可確認來源（live 本機 root／pinned Git Source Cache）中存在的名稱；未知名稱或來源不可讀一律拒絕且不留部分變更。`only <skill...>` 只調整目前發現的 skills，已消失名稱的排除紀錄原樣保留，未來新增者仍預設允許。`only` 未給名稱是用法錯誤——**排除全部必須逐一 `exclude` 明示**，漏填參數不會造成全面排除。
- **排除先於既有同名衝突判斷**：被排除的候選不進入 Bridge Runtime Skill Collision 解析，既不佔用自己的名稱，也不阻擋其他來源的同名 skill；其他來源的同名 skill 不受影響。刻意**不**改交給 Pi 原生衝突機制。
- **不改變 Installation State**：全部 skills 都被排除的 Plugin 仍維持「已裝啟用」；`disable`／`enable` 的整支 Plugin 語意不變，逐項設定走獨立的 `skills` 純文字操作。重裝／更新／停用／啟用保留排除清單；`remove`／`forget` 刪除紀錄，重新安裝從空清單開始。Pi Extension 與 Headless CLI 共用同一份 Bridge State 與操作語意。
- **呈現區分「可貢獻」與「未知」**：明細對每個名稱給出唯一狀態——已排除、來源已消失、Plugin 已停用、Bridge 已知同名衝突、可貢獻；「可貢獻」只代表 Bridge 願將其交由 Pi 資源發現投影，**不**代表 host 已載入。來源不可讀時列出診斷與仍可讀的既有排除，不以「0 個 skills」或任何已載入說法代替。變更在 Pi 內主動要求 reload；Headless CLI 明示「下次 pi session／/reload 生效」。
- **操作結果為純文字**：沒有勾選介面、沒有新子命令以外的互動；`skills <名稱> [exclude|include|only|reset]` 的輸出（含 Pi 原生 autocomplete 候選）即為完整可腳本化的表面。

## Considered Options（拒絕）

- **每 Plugin 一份允許清單（allow-list）**：使用者最常見的需求是「只不要某一兩個」，允許清單迫使每次上游新增 skill 都要重新維護，且既有安裝升級時容易因清單不完整而靜默少投影；排除清單的預設值（允許）與使用者意圖的方向一致。
- **Pi 全域的 skill 名稱封鎖**：改名為別的 Plugin 的同名 skill 也會被擋，且與 Installation 無關的狀態無法隨 `remove`／`forget` 收斂；排除屬於單一 Installed Plugin 的設定。
- **以目錄路徑或索引記錄排除**：上游搬移、重排即失效；Skill Descriptor 名稱才是 Pi 用來解析的名稱，也是衝突判斷的單位。
- **由 Pi 原生衝突機制處理同名問題**：會改變既有投影結果與順序語意；本次維持「先排除、再判衝突」的既有 Bridge 規則。
- **全部排除時自動停用 Plugin**：把「使用者選擇」誤記成「狀態變更」，會讓事後恢復單一 skill 時語意不明；Installation State 只由 `disable`／`enable` 決定。
- **互動式勾選或「僅禁止模型自動呼叫」模式**：超出追蹤範圍，且需要 host 支援；純文字操作已可由腳本與 autocomplete 完整覆蓋。
