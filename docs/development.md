# Development

## 本地開發流程

```bash
npm install
npm run typecheck
npm test
npm run test:acceptance
```

## Verification matrix（發版阻擋 gate）

Every row is a **release blocker**: `v*` may not publish unless the full matrix is green.

| Layer | What is covered |
|-------|-----------------|
| unit — 縫層 | `runCommand` 指令分派（add/list/install/update/disable/enable/remove/forget/help、重複註冊拒絕、重裝覆寫、衝突未投影清單、corrupt→重置、unavailable 顯示、git 重抓）、Minimal Bridge State 原子持久化 |
| unit — 低層 | 雙格式 catalog 解析（codex＋claude、open 政策、unavailable entry）、git locator／source-key（fixed `default` selector）、contained path／symlink、collision、投影（exposure）、source-cache（store/hit/LRU/pin/flock）、git acquisition（mock executor） |
| integration | 真 Pi 縫：extension 註冊 `resources_discover` → 投影 skillPaths（startup/reload 一致、trust flag 無關、被動不變異） |
| E2E | `/codex-marketplace` 薄 Pi adapter 與 `pi-codex-marketplace` CLI 適配層（overview/help、--version、雙格式 add/list、install/update、lifecycle 停用啟用移除、狀態變更 reload 提示轉換、確定性退出碼與環境隔離） |

Fixtures: `tests/fixtures/synthetic/`, `tests/fixtures/pinned/`（captured `SamWang32191/codex-plugins@98e78ca` snapshot）、`tests/fixtures/adversarial/`。See `tests/acceptance/` for the matrix runner that enforces per-row gating (any row failure blocks publish).

Run locally:

```bash
npm run typecheck
npm test                          # full matrix (unit + integration + E2E)
npm run test:acceptance           # acceptance matrix only
```

## Versioning & release flow

- **Package**: `pi-codex-marketplace` published to **npm** as primary, **Git tag** `v*` as mirror.
- **SemVer**: starts at `0.1.0`; `0.y` maintenance window until `1.0.0` signals a stable Bridge State contract.
- **Publishing**: `v*` tag → CI **full matrix green** (below) is a **release gate** → `npm publish --provenance` (OIDC). `latest` tracks stable tags (`v0.*` stable line and later `v1.*`); `next` tracks pre-release tags. Provenance is required (`--provenance`) and verified post-publish by the publish workflow. See `.github/workflows/ci.yml` and `.github/workflows/publish.yml`.

## Changelog & Releases

See [`CHANGELOG.md`](../CHANGELOG.md) and [GitHub Releases](https://github.com/SamWang32191/pi-codex-marketplace/releases). Version `0.1.0` is the first SemVer release; Git tags mirror npm versions (`v0.1.0` → `0.1.0`).