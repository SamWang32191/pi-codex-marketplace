# 私有 Git repo：Credentialed Acquisition（核准式取得）

對私有 HTTPS repo，`add`／`update` **開箱即用**：預設會自動偵測本機已存在的憑證來源並逐次核准（**固定白名單**，不讀本機 gitconfig 的任意 helper；偵測結果只限該次呼叫、永不持久化）：

| 偵測來源 | 核准的 credential helper |
|---|---|
| `gh` CLI 已登入（`gh auth status` 成功） | `!gh auth git-credential` |
| macOS 原生鑰匙圈 helper 存在 | `osxkeychain` |
| git `credential-store` 存在 | `store`（明文憑證檔，請知悉風險） |

已註冊或欲手動控制時，以逗號分隔設定環境變數——**顯式設定完全覆蓋自動偵測**（逐次生效、永不持久化，`add` 與 `update` 共用同一核准來源）：

```
PI_CODEX_MARKETPLACE_CREDENTIAL_HELPERS='store, !f() { echo "username=${GITHUB_USER}"; echo "password=${GITHUB_TOKEN}"; }; f'
/codex-marketplace add https://github.com/acme/private-mkt
```

Credentialed Acquisition 語意（安全線）：

- 預設（未設 env）＝自動偵測固定白名單（gh／osxkeychain／store），僅限該次呼叫：**不寫入** Bridge State、設定檔或任何持久化位置；偵測到的 helper 以命令列 `credential.helper=` 傳入，gitconfig 的其他 helper（含 URL-scoped）仍被排除。
- 設定 env 後完全覆蓋：值為 git `credential.helper` 字串，逗號分隔、各項 trim、空項目忽略；未設定且偵測無結果＝無任何 helper（行為與 credential-free 完全相同，安全線其餘禁制不變）。
- 憑證與核准清單**永不**進入指令輸出、Bridge State、Canonical Git Locator（定位器）、Validation Snapshot（快照）或 cache identity（快取身份）——取得流程的 identity 判定與憑證完全無關。
- 自動偵測或已核准的 helper 仍被遠端拒絕（401）時，錯誤訊息提示檢查登入（`gh auth status`／keychain）或設環境變數核准其他 helper；本機偵測不到任何憑證來源時提示設環境變數或改用 SSH。
- 設定的 helper 名稱無效時（例如直接寫 `gh`——它不是 git 原生的 credential helper 執行檔），錯誤訊息指出正確寫法：原生 helper 名稱（`osxkeychain`／`store`）或 shell form（`!gh auth git-credential`）。

## SSH 定位器：私有 repo 的替代路徑

私有 repo 可以完全繞過此環境變數，直接用 SSH 定位器註冊（HTTPS 與 SSH 同屬允許的 credential-free 定位器）：

```
/codex-marketplace add git@github.com:acme/private-mkt       # scp-like 簡寫（canonical：ssh://git@github.com/acme/private-mkt）
/codex-marketplace add ssh://git@github.com/acme/private-mkt
```

前提（與既有 Acquisition Trust Base 一致）：

- host key 必須**預先存在** `~/.ssh/known_hosts`——安全線以 `StrictHostKeyChecking=yes` 只信任既有 host key，遇到未知或變更的主機金鑰直接拒絕，不會提示接受；
- 憑證由 SSH agent 提供，整個取得過程不互動（`BatchMode=yes`）、無任何提示；
- SSH 定位器本身仍維持 credential-free：不得內嵌密碼（`user:pass@` 拒絕）；憑證只能經由 SSH agent 或 Credentialed Acquisition 到達取得流程。

## 相關文件

- [usage.md](./usage.md) — `/codex-marketplace` 使用手冊（`add`／`update` 子命令）
- [cli.md](./cli.md) — Headless CLI（`add`／`update` 共用同一核准來源）
- [architecture.md](./architecture.md#support-matrix) — 支援矩陣與取得安全線