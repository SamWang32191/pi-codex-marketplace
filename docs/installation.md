# Installation

安裝 Bridge Package 的兩種表面：**Pi Extension**（TUI／互動環境使用）與 **Headless CLI**（Shell／CI/CD 使用）。

## Pi Extension（TUI / 互動環境）

```bash
pi install npm:pi-codex-marketplace                    # Global package (writes to ~/.pi/agent/settings.json)
pi install npm:pi-codex-marketplace -l                 # Project package location (.pi/settings.json; Pi host package setting only)
pi install ./path/to/pi-codex-marketplace              # Local path (try without publishing)
pi install ./path/to/pi-codex-marketplace -l           # Local path, Project package location
pi -e npm:pi-codex-marketplace                         # Ephemeral try without installing (temporary)
pi update npm:pi-codex-marketplace                     # Update one package
pi update --all                                        # Update pi + all packages
pi remove npm:pi-codex-marketplace                     # Remove package
pi list                                                # List installed packages
pi config                                              # Enable/disable resources
```

### `-l`（Project package location）語意

> [!NOTE]
> `pi install -l` controls where Pi loads this Bridge Package extension from (`.pi/settings.json` vs `~/.pi/agent/settings.json` on the Pi host). Regardless of how Pi installs the package, the Bridge State managed by `pi-codex-marketplace` is always recorded in the single Global Scope (`~/.pi/agent/codex-marketplace/state.json`).

### Source types（來源語法）

Source types follow Pi host docs `docs/packages.md`: `npm:` for registry, `git:`/`https://` for git, and absolute/relative paths for local. Ephemeral runs use `pi -e <source>` (not `pi install -e`). This package declares a single `pi` extension entry (`extensions/pi/index.ts`) loaded via `jiti` and requires no build step.

## Headless CLI（Shell / CI/CD 自動化）

```bash
# 免安裝直接以 npx 執行
npx pi-codex-marketplace [subcommand]

# 或全域安裝使用
npm install -g pi-codex-marketplace
pi-codex-marketplace [subcommand]
```

## Requirements

| 維度 | 需求 | 說明 |
|------|------|------|
| Pi host | **0.84.2** | `peerDependencies` 精確 `0.84.2`（本版本驗證目標）；預期相容範圍 `^0.84.2`（devDeps） |
| Node | **>=22.19.0** | `engines.node` 強制 |
| OS | **macOS / Linux** | Windows not supported（path containment、symlink、`flock` 語意皆 POSIX-only） |

完整支援矩陣見 [architecture.md](./architecture.md#support-matrix)。

## 相關文件

- [usage.md](./usage.md) — 安裝後的 `/codex-marketplace` 使用手冊
- [cli.md](./cli.md) — Headless CLI 使用（輸出契約、狀態生效時機）
- [architecture.md](./architecture.md) — 架構與支援矩陣