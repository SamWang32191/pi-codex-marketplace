---
name: release
description: Release pi-codex-marketplace (發版) to npm with provenance and GitHub Release via v* tag. Use when publishing a new version, bumping SemVer, pushing a release tag, or setting up npm OIDC trusted publisher.
---

# Release

`release` 將 `pi-codex-marketplace` 從本地驗證推向 `npm latest/next` 與 `GitHub Releases`，以 `v*` tag 為鏡像。

## Steps

### 1. 驗證可發版狀態

執行驗證矩陣，確認發版阻擋 gate 全綠：

```bash
git status # 必須乾淨，無未提交變更
npm run typecheck
npm test # 40 files / 322 tests，需全綠
```

**完成條件：** `typecheck` 與 `npm test` 皆通過，且 `git status` 無 `M/??`。

### 2. 決定版本與 dist-tag

- `package.json: version` 為唯一權威，必須與即將推送的 `v*` tag 去掉 `v` 後完全一致（`publish.yml` 會嚴格比對）。
- 含 `-` 的版本（`0.1.1-beta.0`）→ `npm dist-tag next`；不含則 `latest`。
- 若 `src/bridge-state/schema.ts` 的 `CURRENT_SCHEMA_VERSION` 有變，必須同步在 `src/bridge-state/migrate.ts` 新增 WAL forward 遷移。

**完成條件：** `package.json`、`CHANGELOG.md`、`schemaVersion` 三者已對齊下一個 SemVer。

### 3. 更新文件與提交

```bash
# 編輯 package.json (version) 與 CHANGELOG.md ([x.y.z] - YYYY-MM-DD)
git add package.json CHANGELOG.md src/bridge-state/migrate.ts # 若有
git commit -m "chore: bump vX.Y.Z"
git push origin main
```

**完成條件：** `main` 已包含新版本號，且 `npm view pi-codex-marketplace version` 尚未存在該版本。

### 4. 推送 `v*` tag 觸發 Publish

```bash
git tag -a vX.Y.Z -m "pi-codex-marketplace vX.Y.Z"
git push origin vX.Y.Z
```

`v*` 觸發 `.github/workflows/publish.yml`：`gate`（重跑 `ci.yml` 全矩陣 `ubuntu/macos × 22.19.0/22.x`）→ `publish`（`npm publish --provenance --tag latest/next --access public` + `softprops/action-gh-release`）。

**完成條件：** `gh run list --workflow Publish` 顯示 `gate` 成功，且 tag 已出現在 `git ls-remote --tags origin`。

### 5. 驗證發布

```bash
npm view pi-codex-marketplace dist.tags --json
npm view pi-codex-marketplace@X.Y.Z --json | grep -E '"version"|"_npmVersion"|"dist"'
gh release view vX.Y.Z --json tagName,url
```

**完成條件：** `dist.tags.latest`（或 `next`）指向 `X.Y.Z`，且 GitHub Release 存在。

## Reference

### 首發與 OIDC

- **首發限制：** `npm Trusted Publisher (OIDC)` 只能在 package 已存在時設定。`0.1.0` 首版已用 `npm publish --access public --otp=...` 本機推送建立，`v0.1.0` 的 Publish workflow 會因版本已存在而失敗，屬預期。
- **綁定 OIDC（只需一次）：** `npmjs.com → pi-codex-marketplace → Settings → Trusted Publisher → Add → GitHub Actions → Organization: SamWang32191, Repository: pi-codex-marketplace, Workflow: publish.yml, Environment: npm, Allowed actions: npm publish`。存檔後 `0.1.1` 起走 `id-token: write` 的 OIDC，無需 `NPM_TOKEN`。
- 本機 `--provenance` 僅在 GitHub/GitLab OIDC 環境生效，本機首發勿加 `--provenance`。

### 常見失敗

- `Tag version X.Y.Z does not match package.json` → tag 與 `package.json` 不一致，刪 tag 重打。
- `ENEEDAUTH / Unable to authenticate` → `publish.yml` 的 `workflow` 檔名或 `Environment: npm` 與 npm 設定不一致，或未使用 `gh-hosted` runner。
- `EOTP / requires OTP` → 帳號開 2FA 時本機推送需 `--otp=CODE`，CI 的 OIDC 則不需要。

### 來源

- 唯一規範：`README.md#Versioning & release flow`、`CHANGELOG.md`、`package.json: version/engines/pi`、`.github/workflows/ci.yml`、`.github/workflows/publish.yml`
- `schemaVersion` 綁定規則見 `src/bridge-state/migrate.ts` 與 `src/bridge-state/schema.ts`
