# 核准式 Credentialed Acquisition（環境變數 allowlist）

Git Marketplace Source 取得原為 credential-free：`add`／`update` 一律禁用 credential helper，私有 HTTPS repo 因此在 401 時必然失敗，且錯誤訊息誤報為「credential helper/agent not approved」（並無任何 helper 被拒，是設計上從未核准）。決定：以 `PI_CODEX_MARKETPLACE_CREDENTIAL_HELPERS` 環境變數提供逐次（per-invocation）核准的 credential helper allowlist（值為 git `credential.helper` 字串、逗號分隔），`add` 與 `update` 共用同一核准來源，永不持久化、憑證不入定位器／快照／cache identity；SSH 通道維持既有信任基礎（known_hosts + agent）並文件化為私有 repo 的替代路徑；認證失敗診斷改為依核准狀態的兩變體訊息（未核准→提示核准或 SSH；已核准仍 401→提示檢查憑證）。

## Considered Options

- **每次 CLI flag（`--credential-helper`）**：最顯式，但每次 `add`／`update` 都要重打，`update` 特別容易漏 → 註冊後重抓失敗。拒絕。
- **持久化核准（寫入 Bridge State）**：把信任面寫進 Bridge State，新增 store surface，且 helper 與 source 綁定／全域綁定的語意需另立。拒絕。
- **隱式信任本機 git config（不禁用 helper）**：最簡單，但「approved」語意蒸發，任何 helper 都執行；且使用者 URL-scoped `credential.https://<host>.helper` 不受命令列空值覆蓋，行為不可預測。拒絕。
- **SSH 專屬路徑**：零程式改動（我們實測 hardened SSH 環境下 `git ls-remote git@github.com:owner/repo` 可用），但對以 token 為主的 GitHub 使用者有 SSH key 管理摩擦，且原始錯誤場景是 HTTPS。拒絕為唯一方案。