# Runtime Skill Exposure via host resource discovery

Bridge 記錄了 Installation、也能唯讀投影 Effective State，但沒有任何機制把 enabled 外掛的 skills 帶進 Pi——reload 再多次也不會出現 slash command。決定：Bridge Extension 透過 host 的資源發現縫（`resources_discover` 回傳 `skillPaths`），在每次 session start 與 reload 時，依當下 Effective State 的 collision 存活者（Projected Skills）動態貢獻 skill 目錄；路徑直接指向 Source Cache 中該 Installation Validation Snapshot 對應的 entry——Installation 本身已永久 pin 該 entry（免於 LRU 驅逐），因此不保留任何 materialized 副本。

## Decisions

- **發現時只做存在性檢查**：完整指紋驗證仍綁在 Lifecycle Operations 與 Retry Application；discovery 是被動檢查，不是 activation admission（見 CONTEXT.md「Runtime Skill Exposure」）。
- **Applied 維持 state-level 語意**：收據代表 state committed + reload re-entered 通過，不斷言 skills 在 runtime 可見（與既有 `Skill Availability` 定義一致）。
- **只貢獻 collision 存活者**：沿用 Runtime Skill Collision 的 `Pi → Project Scope → Global Scope` layering。
- **explicit-only Invocation Policy 照常貢獻**：Pi 目前沒有 policy 攔截點；待 host 端可表達政策再接（追蹤 issue）。

## Considered Options（拒絕）

- **Materialize 副本到 Bridge 專屬目錄**：製造第二份位元組真相，衍生漂移、清理與 snapshot 綁定問題。
- **每次 discovery 重算 fingerprint**：高頻 IO 成本；快取已 pin 且寫入時驗過，事後竄改屬 Source Drift／修復流程管轄。
- **名稱衝突交給 Pi 原生目錄 layering**：等於放棄已實作的 Runtime Skill Collision 投影。
- **本期做 host 層可用性掃描（AVAIL-01）**：需在 extension 內重刻半個 Pi 載入器；AVAIL-01 維持詞彙。
- **升級 receipt 斷言 runtime 可見性**：host 沒有可靠的載入結果內省 API，硬做只是猜測。
