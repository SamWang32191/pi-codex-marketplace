# Usage — `/codex-marketplace`（純文字，無 TUI）

Nine subcommands, no arguments = 總覽：

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
| `help` | 子命令清單。 |

## 語意鐵則

- 安裝語意不分「安裝／啟用」兩步；輸出不得宣稱 reload 後 skill 已在 host 內可見（host 無內省 API），只說「已重新載入生效」。
- catalog 內 git 型或不支援來源的 entry 一律 `unavailable` 並顯示原因；解析失敗顯示明確錯誤、不給裝。
- 安裝成功後由指令層主動要求 reload；reload 失敗不影響已記錄狀態，下次 session start 或 `/reload` 仍生效。
- `--no-skills` 啟動 Pi 不影響 Bridge 投影。

## Autocomplete（Pi 原生，TUI 限定）

互動（TUI）模式下，`/codex-marketplace` 以 **Pi 原生 autocomplete** 提供兩層、狀態感知的候選。**純文字指令表面維持權威不變**：九個子命令、指令參數、輸出與語意完全不受 autocomplete 影響；RPC／JSON／print 模式根本不註冊 terminal-only provider。

**第一層——九個根層子命令。** 輸入完整的 `/codex-marketplace` 後按 Tab，候選清單顯示全部九個子命令（`add`／`list`／`install`／`update`／`disable`／`enable`／`remove`／`forget`／`help`）與各自說明，支援不分大小寫的模糊搜尋。選取需要參數的子命令（`add`／`list`／`install`／`disable`／`enable`／`remove`／`forget`）會自動補上一個尾隨空格，可直接繼續輸入；`update` 與 `help` 不加。

**第二層——再按一次 Tab 開啟狀態感知候選。** 需要參數的子命令套用後，**再按一次 Tab** 依當下 Bridge State 只列出當下可執行的選項（空集合不給假候選）；**不承諾自動重開 selector**（Pi 0.84.2 在套用候選後不會自動再開一層補完選單，鍵盤流程固定是「輸入 command → Tab 選子命令 → 需要參數時再按一次 Tab」）：

| 子命令 | 候選範圍 | 歧義處理 |
|--------|----------|----------|
| `install` | 可安裝／可重裝的 plugin（**不含 Unavailable Entry**） | 名稱在完整 enumeration 唯一＝插入名稱；同名（含 unavailable sibling）＝插入 enumeration 編號（`#N`），描述顯示 `[marketplace]` 與狀態 |
| `enable` | 僅**已停用**的 Installation | 名稱無法唯一解析的記錄不給候選 |
| `disable` | 僅**已啟用**的 Installation | 同上 |
| `remove` | 全部已安裝 plugin（不分啟用／停用） | 同上 |
| `list` | Marketplace Registrations | 名稱無法唯一解析＝依序改插唯一可解析的 alias、其次 Registration id |
| `forget` | Marketplace Registrations | 同上 |
| `add` | **不提供 Bridge 候選**：Tab 委派 Pi 原生路徑 completion，Git locator 維持自由輸入 | — |

補完只提議當下可執行的動作，候選反映最新 Bridge State，且**被動讀取**——按 Tab 絕不會重置或重寫損壞的 state 文件。其餘輸入（其他 slash 指令、一般文字、檔案／路徑補完）一律原樣委派 Pi 既有 provider；安裝本套件不影響任何其他指令的 autocomplete。

> 沒有 custom TUI、沒有自動第二層 selector：所有操作也都可以照舊以純文字輸入完成，autocomplete 只是 discoverability 與輸入效率層。

## 相關文件

- [private-repos.md](./private-repos.md) — 私有 Git repo 的 Credentialed Acquisition 與 SSH 定位器
- [cli.md](./cli.md) — Shell／CI 環境等價的 Headless CLI 管理表面
- [installation.md](./installation.md) — 安裝／更新／移除