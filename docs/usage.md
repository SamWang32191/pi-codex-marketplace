# Usage — `/codex-marketplace`（純文字，無 TUI）

Ten subcommands, no arguments = 總覽：

```
/codex-marketplace
/codex-marketplace help
```

| 子命令 | 行為 |
|--------|------|
| `add <路徑\|網址>` | 註冊 marketplace（本機資料夾、GitHub 完整網址、`owner/repo` 簡寫皆收），自動偵測 codex／claude 格式並告知 `偵測：<format> marketplace · N plugins`。重複註冊同來源被拒絕並提示下一步。Git 來源以安全線取得（`core.hooksPath=/dev/null`、`GIT_LFS_SKIP_SMUDGE=1`、`GIT_TERMINAL_PROMPT=0`），catalog 解析失敗明示錯誤、不註冊。私有 HTTPS repo **開箱即用**：自動偵測本機憑證來源（`gh` 登入／macOS 鑰匙圈／`credential-store`）並逐次核准；也可用 `PI_CODEX_MARKETPLACE_CREDENTIAL_HELPERS` 顯式覆蓋核准清單（逐次生效、永不持久化），或改用 SSH 定位器；用法與範例見 [private-repos.md](./private-repos.md)。 |
| `list [名稱]` | 列出 plugins（編號／所屬 marketplace／狀態：可安裝・已裝啟用・已裝停用・unavailable＋原因），可帶 marketplace 名稱過濾。 |
| `install <編號\|名稱>` | 裝到**當下最新**並自動啟用＋reload。成功話術如 `安裝 "name"（N skills：a, b, c）· 已重新載入生效`；同名衝突列出 `⚠ skill "b" 與既有同名，未投影（名稱衝突）`。**重複安裝＝重抓最新覆寫**（重裝＝更新，不報錯）。 |
| `update` | 對全部已註冊 marketplace 重抓最新：有變化的 plugin 升到最新、無變化各自顯示「無變化」；整體以「已重新載入生效」收尾（有變時）。 |
| `disable <名稱>` / `enable <名稱>` | 停用／啟用 plugin（enable 重新投影＋reload）。 |
| `remove <名稱>` | 移除單支 plugin（不動 marketplace、不動來源資料）。 |
| `forget <名稱>` | 移除整個 marketplace（含其全部安裝）。 |
| `skills <名稱> [exclude \| include \| only \| reset]` | 查看 Plugin 的 skills 與排除狀態；逐項排除／恢復、一次性只保留目前的指定 skills、重設排除清單（詳見下節）。 |
| `help` | 子命令清單。 |

## Skill 排除清單（`skills`）

每個 Installed Plugin 各自持有一份**排除清單**（key 為 Skill Descriptor 名稱）：未列入者預設交由 Pi 資源發現投影，列入者完全不由該 Plugin 投影。既有安裝若沒有這份紀錄，語意等同空清單，不會因本功能重置。

```bash
/codex-marketplace skills engineering                                       # 查看 skills 與排除狀態（不改變設定）
/codex-marketplace skills engineering exclude kapok-liquibase               # 逐項排除
/codex-marketplace skills engineering include kapok-liquibase               # 逐項恢復
/codex-marketplace skills engineering only kapok-app-design jasmine-app-design  # 一次只保留這兩個
/codex-marketplace skills engineering reset                                 # 清除全部排除
```

明細對每個名稱給出一種狀態：`已排除`、`來源已消失`、`Plugin 已停用`、`Bridge 已知同名衝突`、`可貢獻`。**`可貢獻` 只代表 Bridge 會把它交由 Pi 資源發現投影，不代表 host 已載入**。總覽以 `N skills（已排除 M）` 呈現目前 skills 與排除數量；來源不可讀時改顯示 `skills 未確認（…）` 診斷，不以 `0 skills` 或已載入說法代替。

規則：

- **排除全部只能明示**：`only` 未給名稱是用法錯誤；要排除全部請逐一 `exclude`。
- **新增排除需要可確認的來源**：`exclude`／`only` 只接受目前來源中存在的名稱，未知名稱或來源不可讀一律拒絕且不留部分變更；`only` 只調整目前發現的 skills，已消失名稱的排除紀錄保留、未來新加入者預設允許。`include`／`reset` 只依賴紀錄本身，來源不可讀或 Plugin 已停用時仍可執行。
- **重新安裝、更新、停用／啟用保留排除清單**；`remove`／`forget` 會一併刪除紀錄，重新安裝從空清單開始。
- **排除先於同名衝突判斷**：被排除者不再佔用名稱，其他來源的同名 skill 可正常投影；全部排除也不會改變 Plugin 的啟用狀態。
- 設計取捨（為何是排除清單而非允許清單）見 [ADR 0008](./adr/0008-skill-exclusion-list-not-allow-list.md)。

## 語意鐵則

- 安裝語意不分「安裝／啟用」兩步；輸出不得宣稱 reload 後 skill 已在 host 內可見（host 無內省 API），只說「已重新載入生效」。
- Skill 排除清單以 Skill Descriptor 名稱識別：改名視為新 skill，同名消失後重現仍維持排除；未列入者（含上游未來新增者）預設允許。
- `skills` 明細與總覽只輸出狀態；「可貢獻」不等於 host 已載入。變更在 Pi 內主動要求 reload，Headless CLI 則於下次 session 或手動 `/reload` 生效。
- catalog 內 git 型或不支援來源的 entry 一律 `unavailable` 並顯示原因；解析失敗顯示明確錯誤、不給裝。
- 安裝成功後由指令層主動要求 reload；reload 失敗不影響已記錄狀態，下次 session start 或 `/reload` 仍生效。
- `--no-skills` 啟動 Pi 不影響 Bridge 投影。

## Autocomplete（Pi 原生，TUI 限定）

互動（TUI）模式下，`/codex-marketplace` 以 **Pi 原生 autocomplete** 提供兩層、狀態感知的候選。**純文字指令表面維持權威不變**：十個子命令、指令參數、輸出與語意完全不受 autocomplete 影響；RPC／JSON／print 模式根本不註冊 terminal-only provider。

**第一層——十個根層子命令。** 輸入完整的 `/codex-marketplace` 後按 Tab，候選清單顯示全部十個子命令（`add`／`list`／`install`／`update`／`disable`／`enable`／`remove`／`forget`／`skills`／`help`）與各自說明，支援不分大小寫的模糊搜尋。選取需要參數的子命令（`add`／`list`／`install`／`disable`／`enable`／`remove`／`forget`／`skills`）會自動補上一個尾隨空格，可直接繼續輸入；`update` 與 `help` 不加。

**第二層——再按一次 Tab 開啟狀態感知候選。** 需要參數的子命令套用後，**再按一次 Tab** 依當下 Bridge State 只列出當下可執行的選項（空集合不給假候選）；**不承諾自動重開 selector**（Pi 在套用候選後不會自動再開一層補完選單，鍵盤流程固定是「輸入 command → Tab 選子命令 → 需要參數時再按一次 Tab」）：

| 子命令 | 候選範圍 | 歧義處理 |
|--------|----------|----------|
| `install` | 可安裝／可重裝的 plugin（**不含 Unavailable Entry**） | 名稱在完整 enumeration 唯一＝插入名稱；同名（含 unavailable sibling）＝插入 enumeration 編號（`#N`），描述顯示 `[marketplace]` 與狀態 |
| `enable` | 僅**已停用**的 Installation | 名稱無法唯一解析的記錄不給候選 |
| `disable` | 僅**已啟用**的 Installation | 同上 |
| `remove` | 全部已安裝 plugin（不分啟用／停用） | 同上 |
| `list` | Marketplace Registrations | 名稱無法唯一解析＝依序改插唯一可解析的 alias、其次 Registration id |
| `forget` | Marketplace Registrations | 同上 |
| `skills` | 已安裝 plugin（不分啟用／停用）→ 四個操作（`exclude`／`include`／`only`／`reset`）→ 可操作的 skill 名稱 | 名稱無法唯一解析的 Installation 不給候選；`exclude` 只列目前來源確認且未排除者、`only` 列目前來源確認的全部名稱（含已排除者）、`include` 依紀錄列已排除者；來源不可確認時 `exclude`／`only` 不給候選 |
| `add` | **不提供 Bridge 候選**：Tab 委派 Pi 原生路徑 completion，Git locator 維持自由輸入 | — |

補完只提議當下可執行的動作，候選反映最新 Bridge State，且**被動讀取**——按 Tab 絕不會重置或重寫損壞的 state 文件。其餘輸入（其他 slash 指令、一般文字、檔案／路徑補完）一律原樣委派 Pi 既有 provider；安裝本套件不影響任何其他指令的 autocomplete。

> 沒有 custom TUI、沒有自動第二層 selector：所有操作也都可以照舊以純文字輸入完成，autocomplete 只是 discoverability 與輸入效率層。

## 相關文件

- [private-repos.md](./private-repos.md) — 私有 Git repo 的 Credentialed Acquisition 與 SSH 定位器
- [cli.md](./cli.md) — Shell／CI 環境等價的 Headless CLI 管理表面
- [installation.md](./installation.md) — 安裝／更新／移除