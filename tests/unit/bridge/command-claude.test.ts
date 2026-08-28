import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCommand } from '../../../src/bridge/command.js';
import { readMinimalBridgeState } from '../../../src/bridge/state.js';
import { discoverProjectedSkillPaths } from '../../../src/projection/exposure.js';

/** The command surface treats git-family entries as Unavailable (minimal bridge: local only). */
const GIT_UNAVAILABLE_REASON =
  'external git-family entry sources (github/url/git-subdir) are not supported yet';

const BARE_NAME_REASON =
  'bare name source cannot resolve without metadata.pluginRoot, which is unsupported';

interface ClaudePluginSpec {
  name: string;
  /** Catalog `source` override (defaults to `./plugins/<name>`). */
  source?: unknown;
  /** Extra catalog entry fields (official or unknown — all ignored under the open policy). */
  entryFields?: Record<string, unknown>;
  /** Manifest body merged into `.claude-plugin/plugin.json` (defaults to `{ name }`). */
  manifest?: Record<string, unknown>;
  /** Declared `skills` array paths in the manifest (claude declared-paths style). */
  manifestSkills?: string[];
  /** Convention-based `skills/<name>/SKILL.md` directories. */
  skills?: string[];
}

function writeSkill(pluginDir: string, skill: string): void {
  const sdir = join(pluginDir, 'skills', skill);
  mkdirSync(sdir, { recursive: true });
  writeFileSync(
    join(sdir, 'SKILL.md'),
    `---\nname: ${skill}\ndescription: Desc for ${skill}\n---\n\nBody for ${skill}\n`,
  );
}

/**
 * Synthetic claude marketplace (#91): canonical `.claude-plugin/marketplace.json` carrying the
 * officially released fields (`$schema`, `metadata`, `renames`) plus per-entry presentation and
 * unknown fields — none of which may block registration.
 */
function makeClaudeMarketplace(
  root: string,
  name: string,
  plugins: ClaudePluginSpec[],
  catalogExtra: Record<string, unknown> = {},
): void {
  const entries = plugins.map((p) => ({
    name: p.name,
    source: p.source ?? `./plugins/${p.name}`,
    ...(p.entryFields ?? {}),
  }));
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(root, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      $schema: 'https://anthropic.com/claude-code/marketplace.schema.json',
      name,
      owner: { name: 'Acme Team', email: 'team@example.test' },
      metadata: { description: 'synthetic claude marketplace' },
      renames: { 'legacy-plugin': plugins[0]?.name ?? 'new-plugin' },
      plugins: entries,
      ...catalogExtra,
    }),
  );
  for (const p of plugins) {
    if (typeof p.source === 'string' && !p.source.startsWith('./')) continue;
    const rel = typeof p.source === 'string' ? p.source : `./plugins/${p.name}`;
    const abs = join(root, rel.replace(/^\.\//, ''));
    mkdirSync(join(abs, '.claude-plugin'), { recursive: true });
    const manifestBody: Record<string, unknown> = { name: p.name, ...(p.manifest ?? {}) };
    if (p.manifestSkills) manifestBody.skills = p.manifestSkills.map((s) => `./skills/${s}`);
    writeFileSync(join(abs, '.claude-plugin', 'plugin.json'), JSON.stringify(manifestBody));
    for (const skill of p.skills ?? []) writeSkill(abs, skill);
  }
}

describe('runCommand add/list/install 本機 claude marketplace（#91）', () => {
  let tmpDir: string;
  let statePath: string;
  let mktRoot: string;
  let agentDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bridge-claude91-'));
    statePath = join(tmpDir, 'state.json');
    mktRoot = mkdtempSync(join(tmpdir(), 'mkt-claude91-'));
    agentDir = mkdtempSync(join(tmpdir(), 'agent-claude91-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(mktRoot, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  });

  it('add 本機 claude marketplace（官方欄位 renames/metadata/$schema＋entry 未知欄位）→ 未知欄位不擋、偵測 claude、已註冊', async () => {
    makeClaudeMarketplace(mktRoot, 'claude-market', [
      { name: 'conv-plugin', skills: ['skill-a'] },
      {
        name: 'extra-fields',
        skills: ['skill-b'],
        entryFields: {
          description: 'demo entry',
          version: '1.0.0',
          author: { name: 'A' },
          keywords: ['x'],
          preview: true,
          defaultBranch: 'main',
        },
      },
    ]);

    const result = await runCommand(['add', mktRoot], { statePath });

    expect(result.output).toContain('偵測：claude marketplace');
    expect(result.output).toMatch(/2 plugins/);
    expect(result.output).toContain('已註冊');
    expect(result.output).toContain('claude-market');

    const st = readMinimalBridgeState({ statePath });
    expect(st.state.registrations).toHaveLength(1);
    expect(st.state.registrations[0].marketplaceName).toBe('claude-market');
    expect(st.state.registrations[0].format).toBe('claude');
    expect(st.state.registrations[0].sourceKind).toBe('local');
    expect(st.state.installations).toHaveLength(0);
  });

  it('list 顯示 claude plugins（編號／所屬 marketplace／可安裝）', async () => {
    makeClaudeMarketplace(mktRoot, 'claude-market', [
      { name: 'conv-plugin', skills: ['skill-a'] },
      { name: 'conv-plugin-2', skills: ['skill-c'] },
    ]);
    await runCommand(['add', mktRoot], { statePath });

    const list = await runCommand(['list'], { statePath });
    expect(list.output).toContain('claude-market');
    expect(list.output).toMatch(/1\s+conv-plugin\b/);
    expect(list.output).toMatch(/2\s+conv-plugin-2\b/);
    expect(list.output).toContain('可安裝');
  });

  it('install claude plugin（convention skills 目錄）→ 同一條 install 路徑：裝到最新＋自動啟用＋reload', async () => {
    makeClaudeMarketplace(mktRoot, 'claude-market', [{ name: 'conv-plugin', skills: ['skill-a', 'skill-b'] }]);
    await runCommand(['add', mktRoot], { statePath });

    const res = await runCommand(['install', '1'], { statePath });

    expect(res.output).toContain('安裝 "conv-plugin"');
    expect(res.output).toContain('2 skills');
    expect(res.output).toContain('skill-a');
    expect(res.output).toContain('已重新載入生效');
    expect(res.reload).toBe(true);

    const st = readMinimalBridgeState({ statePath });
    expect(st.state.installations).toHaveLength(1);
    expect(st.state.installations[0].manifestName).toBe('conv-plugin');
    expect(st.state.installations[0].skills).toEqual(['skill-a', 'skill-b'].sort());
    expect(st.state.installations[0].enabled).toBe(true);
  });

  it('install claude plugin（manifest.skills 宣告路徑）→ 同一條 install 路徑', async () => {
    makeClaudeMarketplace(mktRoot, 'claude-market', [
      { name: 'declared-plugin', manifestSkills: ['skill-d'], skills: ['skill-d'] },
    ]);
    await runCommand(['add', mktRoot], { statePath });

    const res = await runCommand(['install', 'declared-plugin'], { statePath });

    expect(res.output).toContain('安裝 "declared-plugin"');
    expect(res.output).toContain('1 skills');
    expect(res.output).toContain('skill-d');
    expect(res.output).toContain('已重新載入生效');
    expect(res.reload).toBe(true);
  });

  it('claude 衝突清單語意與 codex 一致：同名 skill 列入「未投影（名稱衝突）」', async () => {
    makeClaudeMarketplace(mktRoot, 'claude-market', [{ name: 'first', skills: ['shared-skill'] }]);
    await runCommand(['add', mktRoot], { statePath });
    await runCommand(['install', '1'], { statePath });

    const mktRoot2 = mkdtempSync(join(tmpdir(), 'mkt-claude91-2-'));
    try {
      makeClaudeMarketplace(mktRoot2, 'claude-market-2', [{ name: 'second', skills: ['shared-skill', 'other-skill'] }]);
      await runCommand(['add', mktRoot2], { statePath });
      const res = await runCommand(['install', '2'], { statePath });

      expect(res.output).toContain('安裝 "second"');
      expect(res.output).toContain('未投影（名稱衝突）');
      expect(res.output).toContain('shared-skill');
      expect(res.output).not.toContain('other-skill 與既有同名');

      const st = readMinimalBridgeState({ statePath });
      expect(st.state.installations).toHaveLength(2);
      expect(st.state.installations[1].skills).toContain('other-skill');
    } finally {
      rmSync(mktRoot2, { recursive: true, force: true });
    }
  });

  it('claude 重複安裝＝重抓最新覆寫，不報錯（語意與 codex 一致）', async () => {
    makeClaudeMarketplace(mktRoot, 'claude-market', [{ name: 'conv-plugin', skills: ['skill-a'] }]);
    await runCommand(['add', mktRoot], { statePath });
    await runCommand(['install', '1'], { statePath });

    writeSkill(join(mktRoot, 'plugins', 'conv-plugin'), 'skill-new');
    const res = await runCommand(['install', '1'], { statePath });

    expect(res.output).toContain('2 skills');
    expect(res.output).toContain('skill-new');
    const st = readMinimalBridgeState({ statePath });
    expect(st.state.installations).toHaveLength(1);
    expect(st.state.installations[0].skills).toContain('skill-new');
  });

  it('e2e：install 後 discoverProjectedSkillPaths 投影 claude skill（convention 目錄與 manifest.skills 兩形皆可）', async () => {
    makeClaudeMarketplace(mktRoot, 'claude-market', [
      { name: 'conv-plugin', skills: ['conv-skill'] },
      { name: 'declared-plugin', manifestSkills: ['declared-skill'], skills: ['declared-skill'] },
    ]);
    let res = await runCommand(['add', mktRoot], { agentDir });
    expect(res.output).toContain('已註冊');
    res = await runCommand(['install', '1'], { agentDir });
    expect(res.output).toContain('已重新載入生效');
    expect(res.reload).toBe(true);
    res = await runCommand(['install', '2'], { agentDir });
    expect(res.output).toContain('已重新載入生效');

    const proj = discoverProjectedSkillPaths({ agentDir });
    expect(proj.skillPaths.some((p) => p.includes('conv-skill'))).toBe(true);
    expect(proj.skillPaths.some((p) => p.includes('declared-skill'))).toBe(true);
  });

  it('catalog 內 git 型／不支援 source 型 entry → list 顯示 unavailable＋原因，install 不給裝', async () => {
    makeClaudeMarketplace(mktRoot, 'claude-unavailable', [
      { name: 'local-ok', skills: ['skill-a'] },
      { name: 'git-one', source: { source: 'github', repo: 'owner/repo' } },
      { name: 'npm-one', source: { source: 'npm', package: '@scope/pkg' } },
      { name: 'bare-one', source: 'formatter' },
      { name: 'defined-here', source: './plugins/defined-here', entryFields: { strict: false } },
    ]);
    await runCommand(['add', mktRoot], { statePath });

    const list = await runCommand(['list'], { statePath });
    expect(list.output).toContain('unavailable');
    expect(list.output).toContain(GIT_UNAVAILABLE_REASON);
    expect(list.output).toContain('npm source entries are not supported');
    expect(list.output).toContain(BARE_NAME_REASON);
    expect(list.output).toContain('entry-defined plugin (strict: false) is not supported');
    // the local entry stays installable
    expect(list.output).toMatch(/1\s+local-ok\b[\s\S]*可安裝/);

    // install by name → refused with the disclosed reason
    const byName = await runCommand(['install', 'git-one'], { statePath });
    expect(byName.output).toContain('unavailable');
    expect(byName.output).toContain(GIT_UNAVAILABLE_REASON);
    expect(byName.reload).toBe(false);

    // install by number → refused with the disclosed reason
    const byNumber = await runCommand(['install', '3'], { statePath });
    expect(byNumber.output).toContain('unavailable');
    expect(byNumber.output).toContain('npm source entries are not supported');

    const st = readMinimalBridgeState({ statePath });
    expect(st.state.installations).toHaveLength(0);
  });

  it('catalog 缺失／malformed／超上限／name 非法 → add 顯示錯誤，不註冊', async () => {
    // missing catalog
    const missing = await runCommand(['add', mktRoot], { statePath });
    expect(missing.output).toMatch(/catalog.*缺失|找不到.*catalog/i);
    expect(readMinimalBridgeState({ statePath }).state.registrations).toHaveLength(0);

    // malformed JSON
    mkdirSync(join(mktRoot, '.claude-plugin'), { recursive: true });
    writeFileSync(join(mktRoot, '.claude-plugin', 'marketplace.json'), '{ malformed claude json,,');
    const malformed = await runCommand(['add', mktRoot], { statePath });
    expect(malformed.output).toMatch(/解析失敗|malformed/i);
    expect(readMinimalBridgeState({ statePath }).state.registrations).toHaveLength(0);

    // invalid marketplace name
    writeFileSync(
      join(mktRoot, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({ name: 'Bad Name', owner: { name: 'o' }, plugins: [] }),
    );
    const badName = await runCommand(['add', mktRoot], { statePath });
    expect(badName.output).toMatch(/錯誤.*catalog|解析失敗/i);
    expect(readMinimalBridgeState({ statePath }).state.registrations).toHaveLength(0);

    // over Validation Budget (entries > 1024)
    writeFileSync(
      join(mktRoot, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'huge-market',
        owner: { name: 'o' },
        plugins: Array.from({ length: 1025 }, (_, i) => ({ name: `p${i}`, source: './p' })),
      }),
    );
    const over = await runCommand(['add', mktRoot], { statePath });
    expect(over.output).toMatch(/超過.*上限|BUDGET_EXCEEDED|解析失敗/i);
    expect(readMinimalBridgeState({ statePath }).state.registrations).toHaveLength(0);
  });

  it('已註冊後 catalog 壞掉 → list/install 顯示錯誤，不靜默略過', async () => {
    makeClaudeMarketplace(mktRoot, 'claude-market', [{ name: 'conv-plugin', skills: ['skill-a'] }]);
    await runCommand(['add', mktRoot], { statePath });

    writeFileSync(join(mktRoot, '.claude-plugin', 'marketplace.json'), '{ broken after registration');
    const list = await runCommand(['list'], { statePath });
    expect(list.output).toMatch(/解析失敗|malformed/i);

    const inst = await runCommand(['install', '1'], { statePath });
    expect(inst.output).toMatch(/解析失敗|malformed/i);
    expect(inst.reload).toBe(false);
  });

  it('同資料夾雙格式並存 → codex 優先偵測', async () => {
    makeClaudeMarketplace(mktRoot, 'claude-side', [{ name: 'claude-plugin', skills: ['skill-a'] }]);
    mkdirSync(join(mktRoot, '.agents', 'plugins'), { recursive: true });
    writeFileSync(
      join(mktRoot, '.agents', 'plugins', 'marketplace.json'),
      JSON.stringify({
        name: 'codex-side',
        plugins: [{ name: 'codex-plugin', source: { source: 'local', path: './plugins/codex-plugin' } }],
      }),
    );
    const codexPluginDir = join(mktRoot, 'plugins', 'codex-plugin');
    mkdirSync(codexPluginDir, { recursive: true });
    writeFileSync(join(codexPluginDir, 'plugin.json'), JSON.stringify({ name: 'codex-plugin' }));

    const res = await runCommand(['add', mktRoot], { statePath });

    expect(res.output).toContain('偵測：codex marketplace');
    expect(res.output).toContain('codex-side');
    const st = readMinimalBridgeState({ statePath });
    expect(st.state.registrations).toHaveLength(1);
    expect(st.state.registrations[0].format).toBe('codex');
    expect(st.state.registrations[0].marketplaceName).toBe('codex-side');
  });

  it('claude plugin 安裝記錄寫入 state.json（縫層斷言）', async () => {
    makeClaudeMarketplace(mktRoot, 'claude-market', [{ name: 'conv-plugin', skills: ['skill-a'] }]);
    await runCommand(['add', mktRoot], { statePath });
    await runCommand(['install', '1'], { statePath });

    const raw = JSON.parse(readFileSync(statePath, 'utf-8')) as { registrations: unknown[]; installations: Array<Record<string, unknown>> };
    expect(raw.installations).toHaveLength(1);
    expect(raw.installations[0].manifestName).toBe('conv-plugin');
    expect(raw.installations[0].sourceKind).toBe('local');
    const st = readMinimalBridgeState({ statePath });
    expect(st.state.installations[0].registrationId).toBe(st.state.registrations[0].id);
  });
});
