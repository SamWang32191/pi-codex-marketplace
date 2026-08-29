/**
 * Credentialed Acquisition approval (#109) — env-var allowlist parsing.
 * See CONTEXT.md: Credentialed Acquisition; docs/adr/0006-credentialed-acquisition-approval.md.
 *
 * Per-invocation approval of git credential helpers via
 * `PI_CODEX_MARKETPLACE_CREDENTIAL_HELPERS` (comma-separated `credential.helper`
 * strings). Empty/unset means "not approved" — but since #117 the approval may also
 * come from an auto-detected fixed allowlist, so empty/unset falls back to detection.
 * This module only parses/detects; the resulting allowlist travels through
 * AcquisitionTrustOptions and never touches Bridge State, snapshots, or cache identity.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const CREDENTIAL_HELPERS_ENV = 'PI_CODEX_MARKETPLACE_CREDENTIAL_HELPERS';

/**
 * 允許清單來源：#117 開箱即用後，credential helper 可能有兩種來源。
 * - approved：使用者經 `PI_CODEX_MARKETPLACE_CREDENTIAL_HELPERS` 顯式核准（可完全覆蓋偵測）。
 * - detected：預設自動偵測的固定白名單（gh CLI／macOS keychain／git credential-store）。
 * - none：無任何 helper 可用（錯誤訊息給「未核准」指引變體）。
 */
export type CredentialHelperMode = 'none' | 'detected' | 'approved';

/**
 * 自動偵測介面——可注入（測試）或使用預設真機偵測。偵測目標是**固定白名單**，
 * 不是讀本機 gitconfig：gitconfig 的任意 helper（含 URL-scoped）仍被命令列
 * `credential.helper=` 清空排除，僅白名單上的 helper 參與（#117，與 ADR 0006
 * 被拒的「隱式信任本機 git config」不同）。
 */
export interface CredentialHelperDetector {
  /** gh CLI 已登入（`gh auth status` exit 0） */
  ghLoggedIn(): boolean;
  /** git 原生 credential helper 執行檔存在（`git --exec-path` 或 PATH） */
  hasGitHelper(name: string): boolean;
}

const defaultDetector: CredentialHelperDetector = {
  ghLoggedIn() {
    try {
      const res = spawnSync('gh', ['auth', 'status'], { stdio: 'ignore', timeout: 5000 });
      return res.status === 0;
    } catch {
      return false;
    }
  },
  hasGitHelper(name) {
    try {
      const execPath = spawnSync('git', ['--exec-path'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
      if (execPath.status === 0) {
        const dir = String(execPath.stdout ?? '').trim();
        if (dir && existsSync(join(dir, `git-${name}`))) return true;
      }
    } catch {
      // fall through to PATH check
    }
    try {
      const which = spawnSync('sh', ['-c', `command -v git-${name}`], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
      return which.status === 0 && String(which.stdout ?? '').trim().length > 0;
    } catch {
      return false;
    }
  },
};

/**
 * Parse the approval env var into a helper allowlist.
 * Comma-separated, each entry trimmed, empty entries ignored.
 * Empty/unset → no explicit approval ([]).
 */
export function parseCredentialHelpers(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export interface ResolvedCredentialAllowlist {
  helpers: string[];
  mode: CredentialHelperMode;
}

/**
 * 解析最終 allowlist（#117 開箱即用）：
 * - env 有非空內容 → 顯式核准，完全覆蓋自動偵測（可預測性不變）。
 * - env 未設定／空白 → 自動偵測固定白名單。
 */
export function resolveApprovedHelpers(
  raw: string | undefined,
  detector: CredentialHelperDetector = defaultDetector,
): ResolvedCredentialAllowlist {
  const parsed = parseCredentialHelpers(raw);
  if (parsed.length > 0) return { helpers: parsed, mode: 'approved' };
  const detected: string[] = [];
  if (detector.ghLoggedIn()) detected.push('!gh auth git-credential');
  if (detector.hasGitHelper('credential-osxkeychain')) detected.push('osxkeychain');
  if (detector.hasGitHelper('credential-store')) detected.push('store');
  return { helpers: detected, mode: detected.length > 0 ? 'detected' : 'none' };
}