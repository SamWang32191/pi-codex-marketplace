import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, cpSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { buildGitSnapshot } from '../../../src/registration/snapshot.js';
import { gitSourceKey } from '../../../src/registration/source-key.js';
import { normalizeGitLocator } from '../../../src/registration/git-locator.js';
import { CODE } from '../../../src/registration/findings.js';
import { runCommand } from '../../../src/bridge/command.js';
import type { GitExecutor } from '../../../src/registration/git-acquisition.js';

// Regression for: add https://github.com/mattpocock/skills → snapshot 建立失敗 —
// "symlink target '.../git-acq-XXX/CLAUDE.md' escapes owning root"
// Root cause: git acquisition root is mkdtempSync(tmpdir()) — raw, NOT realpath'd — while
// checkSymlinkContainment resolved targets via realpathSync.native; on macOS /var → /private/var
// makes every contained symlink look like it escapes. (localSourceKey realpaths the root first,
// which is why local add was unaffected.)
describe('repro: git snapshot symlink containment on macOS tmpdir', () => {
  it('contained symlink (AGENTS.md -> CLAUDE.md) under a raw mkdtemp root must pass', () => {
    const root = mkdtempSync(join(tmpdir(), 'git-acq-repro-'));
    try {
      writeFileSync(join(root, 'CLAUDE.md'), '# hi\n');
      symlinkSync('CLAUDE.md', join(root, 'AGENTS.md'));

      const locRes = normalizeGitLocator('https://github.com/mattpocock/skills');
      if (!locRes.ok || !locRes.locator) throw new Error('locator should normalize');
      const sourceKey = gitSourceKey(locRes.locator);
      const res = buildGitSnapshot(root, sourceKey, {
        canonicalLocator: 'https://github.com/mattpocock/skills',
        resolvedRevision: 'x'.repeat(40),
        selectorCanonical: 'default',
      });
      expect(res.ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('special-file symlink target → blocking（CONTEXT: Contained Symlink）', () => {
    const root = mkdtempSync(join(tmpdir(), 'git-acq-repro-'));
    try {
      execFileSync('mkfifo', [join(root, 'pipe')]); // POSIX-only; CI matrix 為 ubuntu/macos
      symlinkSync('pipe', join(root, 'AGENTS.md'));

      const locRes = normalizeGitLocator('https://github.com/mattpocock/skills');
      if (!locRes.ok || !locRes.locator) throw new Error('locator should normalize');
      const res = buildGitSnapshot(root, gitSourceKey(locRes.locator), {
        canonicalLocator: 'https://github.com/mattpocock/skills',
        resolvedRevision: 'x'.repeat(40),
        selectorCanonical: 'default',
      });
      expect(res.ok).toBe(false);
      expect(res.findings[0].code).toBe(CODE.CONTAINED_SYMLINK_VIOLATION);
      expect(res.findings[0].outcome).toMatch(/special file/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('e2e: add 流程對 contained symlink 不誤判（離線 fixture clone mock）', async () => {
    // fixture: 與 mattpocock/skills 同形的 root 布局 — 含抓得住 add 流程的 marketplace
    // 清單與一個 contained symlink（AGENTS.md -> CLAUDE.md）。git clone 以 mock executor
    // 把 fixture 複製到真實的 mkdtemp 暫存 root，完整走 acquire → snapshot → 註冊，不需網路。
    const fixture = mkdtempSync(join(tmpdir(), 'repro-fixture-'));
    try {
      mkdirSync(join(fixture, '.agents', 'plugins'), { recursive: true });
      writeFileSync(
        join(fixture, '.agents', 'plugins', 'marketplace.json'),
        JSON.stringify({
          name: 'mattpocock',
          plugins: [{ name: 'p1', source: { source: 'local', path: './plugins/p1' } }],
        }),
      );
      mkdirSync(join(fixture, 'plugins', 'p1'), { recursive: true });
      writeFileSync(join(fixture, 'plugins', 'p1', 'plugin.json'), JSON.stringify({ name: 'p1' }));
      writeFileSync(join(fixture, 'CLAUDE.md'), '# hi\n');
      symlinkSync('CLAUDE.md', join(fixture, 'AGENTS.md'));

      const SHA = 'a'.repeat(40);
      const executor: GitExecutor = async (args) => {
        if (args.includes('ls-remote')) {
          const ref = args[args.length - 1];
          return { exitCode: 0, stdout: `${SHA}\t${ref}\n`, stderr: '' };
        }
        if (args.includes('clone')) {
          const dest = args[args.length - 1];
          // verbatimSymlinks: cpSync 預設把相對 link target 重寫成絕對路徑 —
          // 真實 git clone 保留相對 target，fixture 複製必須一致
          cpSync(fixture, dest, { recursive: true, verbatimSymlinks: true });
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (args.includes('get-url')) {
          return { exitCode: 0, stdout: 'https://github.com/mattpocock/skills\n', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      };

      const dir = mkdtempSync(join(tmpdir(), 'repro-e2e-'));
      try {
        const res = await runCommand(['add', 'https://github.com/mattpocock/skills'], {
          agentDir: dir,
          statePath: join(dir, 'state.json'),
          gitExecutor: executor,
        });
        expect(res.output).not.toMatch(/snapshot 建立失敗/);
        expect(res.output).toMatch(/已註冊/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});