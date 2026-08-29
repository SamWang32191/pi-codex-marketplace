# 核准式 Credentialed Acquisition（固定白名單自動偵測＋環境變數覆寫）

Git Marketplace Source 取得原為 credential-free：`add`／`update` 一律禁用 credential helper，私有 HTTPS repo 因此在 401 時必然失敗，且錯誤訊息誤報為「credential helper/agent not approved」（並無任何 helper 被拒，是設計上從未核准）。#109 決定：以 `PI_CODEX_MARKETPLACE_CREDENTIAL_HELPERS` 環境變數提供逐次（per-invocation）核准的 credential helper allowlist（值為 git `credential.helper` 字串、逗號分隔），`add` 與 `update` 共用同一核准來源，永不持久化、憑證不入定位器／快照／cache identity；SSH 通道維持既有信任基礎（known_hosts + agent）並文件化為私有 repo 的替代路徑；認證失敗診斷改為依核准狀態的變體訊息。

**#117 決策修訂（開箱即用）**：env 未設定時，改為自動偵測**固定白名單**（gh CLI 已登入 → `!gh auth git-credential`；`git-credential-osxkeychain` 存在 → `osxkeychain`；`git-credential-store` 存在 → `store`）並逐次核准；env 顯式設定仍**完全覆蓋**偵測（可預測性不變，未設定且偵測無結果時維持 credential-free 語意）。認證失敗分類擴為三態（none／detected／approved）+ 新增 GIT-35（helper 名稱無效，如直接寫 `gh`——正確寫法為 shell form `!gh auth git-credential` 或原生 helper 名稱）。

## Considered Options

- **每次 CLI flag（`--credential-helper`）**：最顯式，但每次 `add`／`update` 都要重打，`update` 特別容易漏 → 註冊後重抓失敗。拒絕。
- **持久化核准（寫入 Bridge State）**：把信任面寫進 Bridge State，新增 store surface，且 helper 與 source 綁定／全域綁定的語意需另立。拒絕。
- **隱式信任本機 git config（不禁用 helper）**：最簡單，但「approved」語意蒸發，任何 helper 都執行；且使用者 URL-scoped `credential.https://<host>.helper` 不受命令列空值覆蓋，行為不可預測。拒絕。#117 的自動偵測與此不同：白名單**固定**（gh／osxkeychain／store），不讀 gitconfig，命令列 `credential.helper=` 清空 + 只允許白名單的機制維持不變。
- **固定白名單自動偵測（#117 採納）**：預設（env 未設定）偵測本機已登入的 gh CLI、macOS 鑰匙圈、git credential-store 並逐次核准——私有 repo 開箱即用；env 顯式設定完全覆蓋；偵測無結果則維持原 credential-free 語意（錯誤訊息指引設 env 或改 SSH）。偵測成本為本機 subprocess 檢查（gh auth status、git --exec-path），無網路互動、無持久化。
- **SSH 專屬路徑**：零程式改動（實測 hardened SSH 環境下 `git ls-remote git@github.com:owner/repo` 可用），但對以 token 為主的 GitHub 使用者有 SSH key 管理摩擦。拒絕為唯一方案。#117 之後 SSH 仍為替代路徑。