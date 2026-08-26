import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CLAUDE_MARKETPLACE_CATALOG_RELPATH,
  CODEX_MARKETPLACE_CATALOG_RELPATH,
  catalogContractFor,
  detectMarketplaceFormat,
} from '../../../src/registration/format.js';

describe('Marketplace Format detection', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'format-detect-'));
  });
  afterEach(() => {
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  });

  function writeCodex(body: unknown = { name: 'acme', plugins: [] }): void {
    mkdirSync(join(root, '.agents', 'plugins'), { recursive: true });
    writeFileSync(join(root, CODEX_MARKETPLACE_CATALOG_RELPATH), JSON.stringify(body));
  }
  function writeClaude(body: unknown = { name: 'acme', owner: { name: 'o' }, plugins: [] }): void {
    mkdirSync(join(root, '.claude-plugin'), { recursive: true });
    writeFileSync(join(root, CLAUDE_MARKETPLACE_CATALOG_RELPATH), JSON.stringify(body));
  }

  it('detects codex when only the codex catalog exists', () => {
    writeCodex();
    expect(detectMarketplaceFormat(root)).toBe('codex');
  });

  it('detects claude when only the claude catalog exists', () => {
    writeClaude();
    expect(detectMarketplaceFormat(root)).toBe('claude');
  });

  it('prioritizes codex when both catalogs coexist — no extra question is asked', () => {
    writeCodex();
    writeClaude();
    expect(detectMarketplaceFormat(root)).toBe('codex');
  });

  it('returns null when neither catalog exists (CATALOG_MISSING territory)', () => {
    expect(detectMarketplaceFormat(root)).toBeNull();
  });

  it('does not accept a directory sitting at the catalog path', () => {
    mkdirSync(join(root, '.agents', 'plugins', 'marketplace.json'), { recursive: true });
    mkdirSync(join(root, '.claude-plugin'), { recursive: true });
    writeFileSync(join(root, CLAUDE_MARKETPLACE_CATALOG_RELPATH), '{}');
    expect(detectMarketplaceFormat(root)).toBe('claude');
  });

  it('follows a contained symlinked catalog to its in-root target (Contained Symlink)', () => {
    writeClaude();
    // A codex catalog that is a symlink to the claude catalog file inside the same root.
    mkdirSync(join(root, '.agents', 'plugins'), { recursive: true });
    symlinkSync(
      join(root, CLAUDE_MARKETPLACE_CATALOG_RELPATH),
      join(root, CODEX_MARKETPLACE_CATALOG_RELPATH),
    );
    expect(detectMarketplaceFormat(root)).toBe('codex');
  });

  it('treats a broken symlinked catalog as absent and falls through to the next candidate', () => {
    mkdirSync(join(root, '.agents', 'plugins'), { recursive: true });
    symlinkSync(join(root, 'nowhere.json'), join(root, CODEX_MARKETPLACE_CATALOG_RELPATH));
    writeClaude();
    expect(detectMarketplaceFormat(root)).toBe('claude');
  });

  it('binds each format to its canonical catalog contract', () => {
    const codex = catalogContractFor('codex');
    expect(codex.relPath).toBe(CODEX_MARKETPLACE_CATALOG_RELPATH);
    const claude = catalogContractFor('claude');
    expect(claude.relPath).toBe(CLAUDE_MARKETPLACE_CATALOG_RELPATH);

    // The parser dispatch honors the closed field policy of each shape.
    const claudeParsed = claude.parse({ name: 'acme', owner: { name: 'o' }, plugins: [] });
    expect(claudeParsed.ok).toBe(true);
    const claudeUnknown = claude.parse({ name: 'acme', owner: { name: 'o' }, plugins: [], rogue: 1 });
    expect(claudeUnknown.ok).toBe(false);

    const codexParsed = codex.parse({ name: 'acme', plugins: [] });
    expect(codexParsed.ok).toBe(true);
  });
});
