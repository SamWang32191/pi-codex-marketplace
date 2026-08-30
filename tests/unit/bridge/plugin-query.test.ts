import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { queryMarketplacePlugins } from '../../../src/bridge/plugin-query.js';
import type { MinimalBridgeState } from '../../../src/bridge/state.js';
import { getCacheDir, getCacheEntriesDir } from '../../../src/cache/paths.js';
import { BUDGET } from '../../../src/registration/budget.js';

const SNAPSHOT = 'a'.repeat(64);

function writeCodexCatalog(root: string, catalog: unknown): void {
  const path = join(root, '.agents', 'plugins', 'marketplace.json');
  mkdirSync(join(root, '.agents', 'plugins'), { recursive: true });
  writeFileSync(path, JSON.stringify(catalog));
}

function writeClaudeCatalog(root: string, catalog: unknown): void {
  const path = join(root, '.claude-plugin', 'marketplace.json');
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  writeFileSync(path, JSON.stringify(catalog));
}

describe('queryMarketplacePlugins', () => {
  let root: string;
  let localRoot: string;
  let agentDir: string;
  let gitRoot: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'plugin-query-'));
    localRoot = join(root, 'local-marketplace');
    agentDir = join(root, 'agent');
    gitRoot = join(getCacheEntriesDir(getCacheDir(agentDir)), SNAPSHOT);
    mkdirSync(localRoot, { recursive: true });
    mkdirSync(gitRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('依 registration／entry 原順序提供全域編號、來源材料、候選名稱、可安裝性與安裝狀態', () => {
    writeCodexCatalog(localRoot, {
      name: 'local-market',
      plugins: [
        { name: 'enabled-plugin', source: { source: 'local', path: './plugins/enabled-plugin' } },
        { source: { source: 'local', path: './plugins/path-fallback' } },
        { name: 'remote-plugin', source: { source: 'github', repo: 'acme/remote-plugin' } },
      ],
    });
    writeClaudeCatalog(gitRoot, {
      name: 'git-market',
      owner: { name: 'Acme' },
      plugins: [{ name: 'git-plugin', source: './plugins/git-plugin' }],
    });

    const state: MinimalBridgeState = {
      schemaVersion: 1,
      registrations: [
        {
          id: 'local-reg',
          alias: 'local-alias',
          marketplaceName: 'local-market',
          format: 'codex',
          sourceKind: 'local',
          source: localRoot,
        },
        {
          id: 'git-reg',
          marketplaceName: 'git-market',
          format: 'claude',
          sourceKind: 'git',
          source: 'https://example.test/acme/marketplace.git',
          snapshot: SNAPSHOT,
        },
      ],
      installations: [
        {
          id: 'enabled-installation',
          pluginId: 'enabled-plugin',
          enabled: true,
          registrationId: 'local-reg',
          manifestName: 'enabled-plugin',
          sourceKind: 'local',
          source: localRoot,
        },
        {
          id: 'disabled-installation',
          pluginId: 'path-fallback',
          enabled: false,
          installationState: 'disabled',
          registrationId: 'local-reg',
          manifestName: 'path-fallback',
          sourceKind: 'local',
          source: localRoot,
        },
      ],
    };
    const before = JSON.stringify(state);

    const result = queryMarketplacePlugins(state, { agentDir });

    expect(JSON.stringify(state)).toBe(before);
    expect(result.diagnostics).toEqual([]);
    expect(result.plugins.map((plugin) => ({
      number: plugin.number,
      candidateName: plugin.candidateName,
      marketplaceName: plugin.marketplaceName,
      marketplaceSource: plugin.marketplaceSource,
      marketplaceRoot: plugin.marketplaceRoot,
      structurallyInstallable: plugin.structurallyInstallable,
      installationId: plugin.installation?.id,
      installationState: plugin.installationState,
      unavailableReason: plugin.unavailableReason,
      entryId: plugin.entry.entryId,
    }))).toEqual([
      {
        number: 1,
        candidateName: 'enabled-plugin',
        marketplaceName: 'local-market',
        marketplaceSource: localRoot,
        marketplaceRoot: localRoot,
        structurallyInstallable: true,
        installationId: 'enabled-installation',
        installationState: 'enabled',
        unavailableReason: undefined,
        entryId: '/plugins/0',
      },
      {
        number: 2,
        candidateName: 'path-fallback',
        marketplaceName: 'local-market',
        marketplaceSource: localRoot,
        marketplaceRoot: localRoot,
        structurallyInstallable: true,
        installationId: 'disabled-installation',
        installationState: 'disabled',
        unavailableReason: undefined,
        entryId: '/plugins/1',
      },
      {
        number: 3,
        candidateName: 'remote-plugin',
        marketplaceName: 'local-market',
        marketplaceSource: localRoot,
        marketplaceRoot: localRoot,
        structurallyInstallable: false,
        installationId: undefined,
        installationState: 'not-installed',
        unavailableReason: 'external git-family entry sources (github/url/git-subdir) are not supported yet',
        entryId: '/plugins/2',
      },
      {
        number: 4,
        candidateName: 'git-plugin',
        marketplaceName: 'git-market',
        marketplaceSource: 'https://example.test/acme/marketplace.git',
        marketplaceRoot: gitRoot,
        structurallyInstallable: true,
        installationId: undefined,
        installationState: 'not-installed',
        unavailableReason: undefined,
        entryId: '/plugins/0',
      },
    ]);
  });

  it('對缺失、不可讀、malformed、超過 budget 與 Git cache material 缺失回傳既有診斷且不產生部分列舉', () => {
    const unreadableRoot = join(root, 'unreadable');
    const malformedRoot = join(root, 'malformed');
    const overBudgetRoot = join(root, 'over-budget');
    mkdirSync(join(unreadableRoot, '.agents', 'plugins', 'marketplace.json'), { recursive: true });
    mkdirSync(malformedRoot, { recursive: true });
    mkdirSync(join(overBudgetRoot, '.agents', 'plugins'), { recursive: true });
    writeCodexCatalog(malformedRoot, { name: 'malformed-market', plugins: 'not-an-array' });
    writeFileSync(
      join(overBudgetRoot, '.agents', 'plugins', 'marketplace.json'),
      ' '.repeat(BUDGET.maxCatalogBytes + 1),
    );

    const state: MinimalBridgeState = {
      schemaVersion: 1,
      registrations: [
        { id: 'missing', marketplaceName: 'missing-market', format: 'codex', sourceKind: 'local', source: join(root, 'missing') },
        { id: 'unreadable', marketplaceName: 'unreadable-market', format: 'codex', sourceKind: 'local', source: unreadableRoot },
        { id: 'malformed', marketplaceName: 'malformed-market', format: 'codex', sourceKind: 'local', source: malformedRoot },
        { id: 'over', marketplaceName: 'over-market', format: 'codex', sourceKind: 'local', source: overBudgetRoot },
        {
          id: 'git-no-fingerprint',
          marketplaceName: 'git-no-fingerprint',
          format: 'codex',
          sourceKind: 'git',
          source: 'https://example.test/no-fingerprint.git',
        },
        {
          id: 'git-no-material',
          marketplaceName: 'git-no-material',
          format: 'codex',
          sourceKind: 'git',
          source: 'https://example.test/no-material.git',
          snapshot: 'b'.repeat(64),
        },
      ],
      installations: [],
    };

    const result = queryMarketplacePlugins(state, { agentDir });

    expect(result.plugins).toEqual([]);
    expect(result.diagnostics.map((diagnostic) => ({
      marketplace: diagnostic.marketplace,
      marketplaceSource: diagnostic.marketplaceSource,
      marketplaceRoot: diagnostic.marketplaceRoot,
      error: diagnostic.error,
      findingCodes: diagnostic.findings.map((finding) => finding.code),
    }))).toEqual([
      {
        marketplace: 'missing-market',
        marketplaceSource: join(root, 'missing'),
        marketplaceRoot: join(root, 'missing'),
        error: 'catalog 缺失（.agents/plugins/marketplace.json）',
        findingCodes: [],
      },
      {
        marketplace: 'unreadable-market',
        marketplaceSource: unreadableRoot,
        marketplaceRoot: unreadableRoot,
        error: 'catalog 無法讀取：EISDIR: illegal operation on a directory, read',
        findingCodes: [],
      },
      {
        marketplace: 'malformed-market',
        marketplaceSource: malformedRoot,
        marketplaceRoot: malformedRoot,
        error: 'catalog 解析失敗 (CATALOG_MALFORMED) — catalog malformed',
        findingCodes: ['CATALOG_MALFORMED'],
      },
      {
        marketplace: 'over-market',
        marketplaceSource: overBudgetRoot,
        marketplaceRoot: overBudgetRoot,
        error: `catalog 檔案過大（${BUDGET.maxCatalogBytes + 1} bytes > ${BUDGET.maxCatalogBytes}）— 超過 Validation Budget 上限，catalog 無法解析`,
        findingCodes: [],
      },
      {
        marketplace: 'git-no-fingerprint',
        marketplaceSource: 'https://example.test/no-fingerprint.git',
        marketplaceRoot: undefined,
        error: 'git marketplace 缺少 cache 指紋',
        findingCodes: [],
      },
      {
        marketplace: 'git-no-material',
        marketplaceSource: 'https://example.test/no-material.git',
        marketplaceRoot: undefined,
        error: 'cache 快照缺失（bbbbbbbbbbbb…）',
        findingCodes: [],
      },
    ]);
  });
});
