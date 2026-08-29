# Entry 級取得的信任邊界與定位器正規化 (Entry-level acquisition trust boundary and locator normalization)

> **Status: superseded（#95/#96 拆除）** — Entry Acquisition 已整層退場（極簡 #87 Out of Scope）：catalog 內 git 家族 entry 一律標記 `unavailable`，不再取得、不再 pin、無保留解析器（`parseGitEntrySpec` 一併移除）。本記錄保留為歷史決策參考。

Marketplace Catalog（包含 Claude 與 Codex 格式）允許 Marketplace 聚合分散於外部 Git 倉庫的外掛條目（如 `github`、`url`、`git-subdir` 形態）。Bridge 需要在不擴大既有信任基礎與維持「零執行」（Zero-Execution）安全承諾的前提下，取得並驗證這些外部 entry。決定：**Entry 級外部 Git 取得完全遵循頂層 Marketplace 既有的 Acquisition Trust Base 與 Validation Budget 約束；`owner/repo` 簡寫一律決定性正規化為 canonical HTTPS 定位器；`command` 來源永久不合格；外掛宣告以 `sha` 為不可變 pin，而可動 `ref` 於 Refresh 時產生 Update Candidate，確保第三方聚合不擴大信任面與執行邊界。**

## Decisions

- **重用既有 Acquisition Trust Base（No Trust Base Expansion）**：Entry 級取得完全限制在既有信任基礎內（指定的 Git 與 SSH 執行檔、OS CA 憑證、既有 SSH known_hosts、嚴格主機金鑰驗證 `StrictHostKeyChecking=yes`、`core.hooksPath=/dev/null`、`GIT_LFS_SKIP_SMUDGE=1`），絕不將信任延伸至外部 repository 所宣告的 git 設定。
- **零執行原則（Zero-Execution Acquisition）**：取得外部 entry 過程絕不執行任何 repository 提供的 hooks、filters、submodules、相依套件安裝（如 `npm install`）、建置腳本或外掛元件，確保取得過程純粹為靜態位元組擷取。
- **拒絕不安全傳輸與憑證嵌入**：明文傳輸（`http://`、`git://`）與嵌入認證資訊（`https://user:pass@...`）一律拒絕並產出 Blocking Finding；重定向亦嚴格禁止變更 canonical locator。
- **嚴格 Validation Budget 約束與原子批次取得**：每個外部 entry 的下載體積、目錄深度、檔案數量及解析時間均受 Validation Budget 嚴格限制；單一 Marketplace 註冊時所有外部 entry 採原子批次取得，任一 entry 失敗或超限即整批 fail-closed 並自動清理暫存目錄。
- **`command` 來源永久不合格（Permanent Disqualification）**：任何以 `command`（執行 shell 指令或腳本）形式宣告的 entry 永久不予支援，直接標記為 `Unavailable Entry`。執行任意指令將徹底破壞沙盒與零執行信任邊界，引入未知的供應鏈安全威脅，因此 command 來源屬於永久排除而非暫時性功能缺口。
- **`npm` / `archive` 來源暫不收編**：npm 與 tarball/zip 壓縮包需要獨立的安全傳輸通道、完整性校驗與解壓縮安全防護（防止 zip-slip / tarbomb），目前維持標記為 `Unavailable Entry`，待後續專屬規格確立。
- **HTTPS Shorthand 正規化（Deterministic HTTPS Normalization）**：`github: "owner/repo"` 或裸字串 shorthand 一律決定性展開為標準 canonical HTTPS 定位器（`https://github.com/<owner>/<repo>`），不支援 SSH shorthand 猜測或自訂通訊協定，確保定位器語意無歧義且能被標準公開 CA 驗證。
- **Pin 矩陣與獨立快照（Per-entry Snapshot & Pin Matrix）**：
  - Selector 映射：`sha` (40/64-hex commit) 映射為固定 `commit` pin；`ref` (branch/tag) 映射為可動 `branch` 或 `tag`；未指定時映射為可動 `default` 分支。
  - 當 `sha` 與 `ref` 並存時，`sha` 為唯一有效 pin，`ref` 僅作格式合法性檢驗，確保內容不可變性。
  - 每個外部 entry 產生獨立的 Validation Snapshot 與指紋（`entrySnapshots`），並快取於 Source Cache；Marketplace Refresh 列舉所有 entry，可動 ref 在上游移動時產生 `Update Candidate`，而 `sha` 固定 pin 則不受上游分支漂移影響。

## Considered Options（拒絕）

- **在沙盒或容器中執行 command 來源**：沙盒隔離難以完全消除逃逸與執行階段副作用風險，大幅增加複雜度且背離零執行鐵律。
- **允許 shorthand 猜測或展開為 SSH 協定**：SSH 金鑰與已知主機設定因人而異，容易導致非預期的連線失敗或隱性認證傳遞，缺乏 HTTPS 公開憑證鏈的確定性。
- **取得 entry 時自動執行 npm install 或建置**：安裝腳本（如 postinstall）具備任意程式碼執行能力，嚴重違反 Bridge 安全模型。
- **允許部分 entry 取得失敗的寬鬆註冊（Partial Success）**：會導致 Marketplace 呈現殘缺狀態與快照指紋不完整，破壞 CAS（Compare-And-Swap）一致性保證。
- **當 sha 與 ref 並存時以 ref 為準**：以可動 ref 覆寫 sha 會使使用者無法鎖定確切版本，喪失供應鏈不可變性防護。
