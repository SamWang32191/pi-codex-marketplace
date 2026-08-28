import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { runCommand } from '../../../src/bridge/command.js';
import { readMinimalBridgeState } from '../../../src/bridge/state.js';

function makeCodexMarketplace(root: string, name: string, plugins: { name: string; path: string }[]) {
  mkdirSync(join(root, '.agents', 'plugins'), { recursive: true });
  writeFileSync(join(root, '.agents', 'plugins', 'marketplace.json'), JSON.stringify({ name, plugins }));
  for (const p of plugins) {
    const abs = join(root, p.path.replace(/^\.\//, ''));
    mkdirSync(abs, { recursive: true });
    writeFileSync(join(abs, 'plugin.json'), JSON.stringify({ name: p.name }));
  }
}

function materializePinnedMarketplace(root: string): void {
  const fixture = JSON.parse(
    readFileSync(join(import.meta.dirname, '..', '..', 'fixtures', 'pinned', 'codex-plugins-98e78caf.json'), 'utf8'),
  ) as { commit: string; encoding: string; files: Record<string, string[]> };
  for (const [relativePath, chunks] of Object.entries(fixture.files)) {
    const path = join(root, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(chunks.join(''), 'base64'));
  }
}

describe('runCommand add/list 本機 codex marketplace (#89)', () => {
  let tmpDir: string;
  let statePath: string;
  let mktRoot: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bridge-add89-'));
    statePath = join(tmpDir, 'state.json');
    mktRoot = mkdtempSync(join(tmpdir(), 'mkt89-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(mktRoot, { recursive: true, force: true });
  });

  it('add 本機 codex marketplace（合成 fixture）→ 偵測與已註冊，且不自動安裝', async () => {
    makeCodexMarketplace(mktRoot, 'synthetic-marketplace', [
      { name: 'demo', path: './plugins/demo' },
      { name: 'demo2', path: './plugins/demo2' },
    ]);

    const result = await runCommand(['add', mktRoot], { statePath });

    expect(result.reload).toBe(false);
    expect(result.output).toContain('偵測：codex marketplace');
    expect(result.output).toMatch(/2 plugins/);
    expect(result.output).toContain('已註冊');
    expect(result.output).toContain('synthetic-marketplace');

    const st = readMinimalBridgeState({ statePath });
    expect(st.state.registrations).toHaveLength(1);
    expect(st.state.registrations[0].marketplaceName).toBe('synthetic-marketplace');
    expect(st.state.registrations[0].format).toBe('codex');
    expect(st.state.registrations[0].sourceKind).toBe('local');
    expect(st.state.installations).toHaveLength(0);
  });

  it('add 本機 codex marketplace（真實 pinned fixture）→ 偵測與已註冊', async () => {
    const pinnedRoot = mkdtempSync(join(tmpdir(), 'mkt89-pinned-'));
    try {
      materializePinnedMarketplace(pinnedRoot);
      const result = await runCommand(['add', pinnedRoot], { statePath });

      expect(result.output).toContain('偵測：codex marketplace');
      expect(result.output).toMatch(/2 plugins/);
      expect(result.output).toContain('已註冊');
      expect(result.output).toContain('samwang');

      const st = readMinimalBridgeState({ statePath });
      expect(st.state.registrations).toHaveLength(1);
      expect(st.state.registrations[0].marketplaceName).toBe('samwang');
      expect(st.state.installations).toHaveLength(0);
    } finally {
      rmSync(pinnedRoot, { recursive: true, force: true });
    }
  });

  it('重複註冊同 realpath → 拒絕並提示正確下一步', async () => {
    makeCodexMarketplace(mktRoot, 'demo-marketplace', [{ name: 'demo', path: './plugins/demo' }]);

    const first = await runCommand(['add', mktRoot], { statePath });
    expect(first.output).toContain('已註冊');

    const dup = await runCommand(['add', mktRoot], { statePath });
    expect(dup.output).toContain('已註冊過相同來源');
    expect(dup.output).toContain('想更新？`update`；想換？先 `remove` 再 `add`');

    const st = readMinimalBridgeState({ statePath });
    expect(st.state.registrations).toHaveLength(1);
  });

  it('重複註冊同 realpath（經 symlink）→ 同樣拒絕', async () => {
    makeCodexMarketplace(mktRoot, 'demo-marketplace', [{ name: 'demo', path: './plugins/demo' }]);
    await runCommand(['add', mktRoot], { statePath });

    const linkPath = join(tmpdir(), `link89-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    symlinkSync(mktRoot, linkPath);
    try {
      const dup = await runCommand(['add', linkPath], { statePath });
      expect(dup.output).toContain('已註冊過相同來源');
      expect(dup.output).toContain('想更新？`update`；想換？先 `remove` 再 `add`');
      const st = readMinimalBridgeState({ statePath });
      expect(st.state.registrations).toHaveLength(1);
    } finally {
      rmSync(linkPath, { force: true });
    }
  });

  it('list 顯示已註冊 marketplace（名稱／格式／來源）', async () => {
    makeCodexMarketplace(mktRoot, 'demo-marketplace', [{ name: 'demo', path: './plugins/demo' }]);
    await runCommand(['add', mktRoot], { statePath });

    const list = await runCommand(['list'], { statePath });
    expect(list.output).toContain('demo-marketplace');
    expect(list.output).toContain('codex');
    expect(list.output).toContain('本地');
    // source should contain the realpath
    const st = readMinimalBridgeState({ statePath });
    expect(list.output).toContain(st.state.registrations[0].source);
  });

  it('catalog 缺失 → 顯示錯誤、不註冊、不寫入', async () => {
    // Empty directory without catalog
    const result = await runCommand(['add', mktRoot], { statePath });
    expect(result.output).toMatch(/catalog.*缺失|找不到.*catalog/i);
    const st = readMinimalBridgeState({ statePath });
    expect(st.state.registrations).toHaveLength(0);
  });

  it('catalog malformed → 顯示錯誤、不註冊、不寫入', async () => {
    mkdirSync(join(mktRoot, '.agents', 'plugins'), { recursive: true });
    writeFileSync(join(mktRoot, '.agents', 'plugins', 'marketplace.json'), '{ malformed json,,');
    const result = await runCommand(['add', mktRoot], { statePath });
    expect(result.output).toMatch(/catalog.*解析失敗|catalog.*malformed/i);
    const st = readMinimalBridgeState({ statePath });
    expect(st.state.registrations).toHaveLength(0);
  });

  it('catalog 名稱非法 → 顯示錯誤、不註冊', async () => {
    mkdirSync(join(mktRoot, '.agents', 'plugins'), { recursive: true });
    writeFileSync(
      join(mktRoot, '.agents', 'plugins', 'marketplace.json'),
      JSON.stringify({ name: 'Bad Name', plugins: [] }),
    );
    const result = await runCommand(['add', mktRoot], { statePath });
    expect(result.output).toMatch(/錯誤.*catalog|解析失敗/i);
    const st = readMinimalBridgeState({ statePath });
    expect(st.state.registrations).toHaveLength(0);
  });

  it('註冊後 state.json 記入一筆 registration 記錄（縫層斷言）', async () => {
    makeCodexMarketplace(mktRoot, 'seam-market', [{ name: 'p1', path: './plugins/p1' }]);
    await runCommand(['add', mktRoot], { statePath });

    const raw = readFileSync(statePath, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.registrations).toHaveLength(1);
    expect(parsed.registrations[0].marketplaceName).toBe('seam-market');
    expect(parsed.registrations[0].sourceKind).toBe('local');
    expect(parsed.schemaVersion).toBe(1);
  });

  it('走 runCommand 縫測試，不經 TUI，且支援相對路徑 via cwd', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cwd89-'));
    const inner = join(cwd, 'my-mkt');
    try {
      makeCodexMarketplace(inner, 'rel-market', [{ name: 'p', path: './plugins/p' }]);
      const result = await runCommand(['add', 'my-mkt'], { statePath, cwd });
      expect(result.output).toContain('已註冊');
      expect(result.output).toContain('rel-market');
      const st = readMinimalBridgeState({ statePath });
      expect(st.state.registrations).toHaveLength(1);
      expect(st.state.registrations[0].marketplaceName).toBe('rel-market');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
