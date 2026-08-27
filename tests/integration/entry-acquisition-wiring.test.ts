import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readBridgeState } from '../../src/bridge-state/store.js';
import {
  preflightLocalRegistration,
  confirmLocalRegistration,
} from '../../src/registration/flow.js';
import {
  preflightGitRegistration,
  confirmGitRegistration,
} from '../../src/registration/git-flow.js';
import {
  preflightPluginInstallation,
  confirmPluginInstallation,
} from '../../src/installation/flow.js';
import { inspectMarketplaceEntries } from '../../src/installation/inspection.js';
import { refreshRegistration } from '../../src/lifecycle/refresh.js';
import { buildUpdatePlan } from '../../src/lifecycle/update-plan.js';
import { applyUpdate } from '../../src/lifecycle/update.js';
import { SourceCache } from '../../src/cache/source-cache.js';
import type { GitExecutor } from '../../src/registration/git-acquisition.js';

function makeFixture(root: string, opts: { subpath?: string; pluginName: string; skillName: string; isCodex?: boolean }) {
  const targetDir = opts.subpath ? join(root, opts.subpath) : root;
  mkdirSync(targetDir, { recursive: true });
  mkdirSync(join(targetDir, 'skills', opts.skillName), { recursive: true });

  writeFileSync(
    join(targetDir, 'skills', opts.skillName, 'SKILL.md'),
    `---\nname: ${opts.skillName}\ndescription: Test skill for ${opts.pluginName}\n---\nHello from ${opts.skillName}`,
  );
  if (opts.isCodex) {
    mkdirSync(join(targetDir, '.codex-plugin'), { recursive: true });
    writeFileSync(
      join(targetDir, '.codex-plugin', 'plugin.json'),
      JSON.stringify({ name: opts.pluginName, skills: './skills/' }),
    );
  } else {
    mkdirSync(join(targetDir, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(targetDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: opts.pluginName, skills: [`./skills/${opts.skillName}`] }),
    );
  }
}

function makeMockGitExecutor(fixtures: Record<string, { root: string; sha: string }>): GitExecutor {
  return async (args, execOpts) => {
    if (args.includes('ls-remote')) {
      const url = args.find((a) => a.startsWith('https://') || a.startsWith('git://') || a.includes('@')) ?? '';
      const matched = Object.entries(fixtures).find(([key]) => url.includes(key));
      const sha = matched ? matched[1].sha : '1111111111111111111111111111111111111111';
      const ref = args[args.length - 1];
      return { exitCode: 0, stdout: `${sha}\t${ref}\n`, stderr: '' };
    }

    if (args.includes('clone')) {
      const url = args.find((a) => a.startsWith('https://') || a.startsWith('git://') || a.includes('@')) ?? '';
      const matched = Object.entries(fixtures).find(([key]) => url.includes(key));
      const dest = args[args.length - 1];
      if (matched) {
        cpSync(matched[1].root, dest, { recursive: true });
      } else {
        mkdirSync(dest, { recursive: true });
      }
      mkdirSync(join(dest, '.git'), { recursive: true });
      return { exitCode: 0, stdout: '', stderr: '' };
    }

    return { exitCode: 0, stdout: '', stderr: '' };
  };
}

describe('Entry Acquisition Wiring Integration Tests (#51)', () => {
  let tmpRoot: string;
  let agentDir: string;
  let cache: SourceCache;

  let ghFixtureRoot: string;
  let urlFixtureRoot: string;
  let monoFixtureRoot: string;
  let codexGitFixtureRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'entry-acq-test-'));
    agentDir = join(tmpRoot, 'agent');
    cache = new SourceCache({ agentDir });

    ghFixtureRoot = join(tmpRoot, 'fixtures', 'gh-plugin');
    makeFixture(ghFixtureRoot, { pluginName: 'gh-plugin', skillName: 'gh-skill' });

    urlFixtureRoot = join(tmpRoot, 'fixtures', 'url-plugin');
    makeFixture(urlFixtureRoot, { pluginName: 'url-plugin', skillName: 'url-skill' });

    monoFixtureRoot = join(tmpRoot, 'fixtures', 'mono-repo');
    makeFixture(monoFixtureRoot, { subpath: 'packages/sub-plugin', pluginName: 'subdir-plugin', skillName: 'sub-skill' });

    codexGitFixtureRoot = join(tmpRoot, 'fixtures', 'codex-git');
    makeFixture(codexGitFixtureRoot, { pluginName: 'codex-git-plugin', skillName: 'codex-git-skill', isCodex: true });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('AC1 & AC5: Claude marketplace with github/url/git-subdir entries acquires, browses, installs, and keeps npm/archive/command unavailable', async () => {
    const marketplaceRoot = join(tmpRoot, 'claude-marketplace');
    mkdirSync(join(marketplaceRoot, '.claude-plugin'), { recursive: true });

    writeFileSync(
      join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'claude-hub',
        owner: { name: 'Acme' },
        plugins: [
          { name: 'gh-tool', source: { source: 'github', repo: 'samwang/gh-tool' } },
          { name: 'url-tool', source: { source: 'url', url: 'https://example.test/url-tool.git' } },
          { name: 'sub-tool', source: { source: 'git-subdir', url: 'https://example.test/mono.git', path: 'packages/sub-plugin' } },
          { name: 'npm-tool', source: { source: 'npm', package: '@scope/pkg' } },
          { name: 'arch-tool', source: { source: 'archive', url: 'https://example.test/tool.zip' } },
          { name: 'cmd-tool', source: { source: 'command', command: 'make build' } },
        ],
      }),
    );

    const fixtures = {
      'samwang/gh-tool': { root: ghFixtureRoot, sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      'url-tool.git': { root: urlFixtureRoot, sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
      'mono.git': { root: monoFixtureRoot, sha: 'cccccccccccccccccccccccccccccccccccccccc' },
    };
    const executor = makeMockGitExecutor(fixtures);

    // 1. Preflight
    const preRes = await preflightLocalRegistration(marketplaceRoot, {
      agentDir,
      executor,
      cache,
    });
    expect(preRes.ok).toBe(true);
    if (!preRes.ok) throw new Error('preflight failed');
    const preflight = preRes.preflight;
    expect(preflight.format).toBe('claude');
    expect(preflight.entrySnapshots).toBeDefined();
    expect(Object.keys(preflight.entrySnapshots!)).toEqual(['/plugins/0', '/plugins/1', '/plugins/2']);

    // 2. Confirm registration
    const confRes = await confirmLocalRegistration(preflight, true, { agentDir });
    expect(confRes.status).toBe('completed');
    if (confRes.status !== 'completed') throw new Error('conf failed');
    const reg = confRes.registration;
    expect(reg.entrySnapshots).toEqual(preflight.entrySnapshots);

    // 3. Inspect marketplace
    const inspection = inspectMarketplaceEntries(reg, { agentDir, cache });
    expect(inspection.entries).toHaveLength(6);

    // Git entries are available and classified as compatible plugins
    expect(inspection.entries[0].entry.available).toBe(true);
    expect(inspection.entries[0].plugin?.manifestName).toBe('gh-plugin');
    expect(inspection.entries[0].classification).toBe('compatible');

    expect(inspection.entries[1].entry.available).toBe(true);
    expect(inspection.entries[1].plugin?.manifestName).toBe('url-plugin');

    expect(inspection.entries[2].entry.available).toBe(true);
    expect(inspection.entries[2].plugin?.manifestName).toBe('subdir-plugin');

    // npm, archive, command entries are permanently / consistently unavailable (AC5)
    expect(inspection.entries[3].entry.available).toBe(false);
    expect(inspection.entries[3].unavailableReason).toMatch(/npm/i);

    expect(inspection.entries[4].entry.available).toBe(false);
    expect(inspection.entries[4].unavailableReason).toMatch(/archive/i);

    expect(inspection.entries[5].entry.available).toBe(false);
    expect(inspection.entries[5].unavailableReason).toMatch(/command/i);

    // 4. Install gh-plugin
    const installPreRes = await preflightPluginInstallation(reg.id, '/plugins/0', { agentDir, cache });
    expect(installPreRes.ok).toBe(true);
    if (!installPreRes.ok) throw new Error('inst pre failed');
    const installConfRes = await confirmPluginInstallation(installPreRes.preflight, 'enabled', true, {
      agentDir,
    });
    expect(installConfRes.status).toBe('completed');
    if (installConfRes.status !== 'completed') throw new Error('inst conf failed');
    expect(installConfRes.installation.installationState).toBe('enabled');
    expect(installConfRes.installation.manifestName).toBe('gh-plugin');

    const state = (await readBridgeState({ agentDir })).state!;
    expect(state.installations).toHaveLength(1);
    expect(state.installations[0].manifestName).toBe('gh-plugin');
  });

  it('AC2: Codex marketplace with git-kind entry acquires and installs symmetrically', async () => {
    const marketplaceRoot = join(tmpRoot, 'codex-marketplace');
    mkdirSync(join(marketplaceRoot, '.agents', 'plugins'), { recursive: true });

    // Local plugin
    const localDir = join(marketplaceRoot, 'plugins', 'local-p');
    mkdirSync(localDir, { recursive: true });
    mkdirSync(join(localDir, '.codex-plugin'), { recursive: true });
    mkdirSync(join(localDir, 'skills', 'local-s'), { recursive: true });
    writeFileSync(join(localDir, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'local-plugin', skills: './skills/' }));
    writeFileSync(join(localDir, 'skills', 'local-s', 'SKILL.md'), '---\nname: local-s\ndescription: local skill\n---\nLocal');

    writeFileSync(
      join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'),
      JSON.stringify({
        name: 'codex-hub',
        plugins: [
          { name: 'remote-git', source: { source: 'git', url: 'https://example.test/codex-git.git' } },
          { name: 'local-tool', source: { source: 'local', path: './plugins/local-p' } },
        ],
      }),
    );

    const fixtures = {
      'codex-git.git': { root: codexGitFixtureRoot, sha: 'dddddddddddddddddddddddddddddddddddddddd' },
    };
    const executor = makeMockGitExecutor(fixtures);

    const preRes = await preflightLocalRegistration(marketplaceRoot, {
      agentDir,
      executor,
      cache,
    });
    expect(preRes.ok).toBe(true);
    if (!preRes.ok) throw new Error('pre failed');
    expect(preRes.preflight.format).toBe('codex');
    expect(preRes.preflight.entrySnapshots).toHaveProperty('/plugins/0');

    const confRes = await confirmLocalRegistration(preRes.preflight, true, { agentDir });
    expect(confRes.status).toBe('completed');
    if (confRes.status !== 'completed') throw new Error('conf failed');
    const reg = confRes.registration;

    const inspection = inspectMarketplaceEntries(reg, { agentDir, cache });
    expect(inspection.entries).toHaveLength(2);
    expect(inspection.entries[0].entry.available).toBe(true);
    expect(inspection.entries[0].plugin?.manifestName).toBe('codex-git-plugin');
    expect(inspection.entries[1].entry.available).toBe(true);
    expect(inspection.entries[1].plugin?.manifestName).toBe('local-plugin');

    // Install external git plugin
    const installPreRes = await preflightPluginInstallation(reg.id, '/plugins/0', { agentDir, cache });
    expect(installPreRes.ok).toBe(true);
    if (!installPreRes.ok) throw new Error('inst pre failed');
    const installConfRes = await confirmPluginInstallation(installPreRes.preflight, 'enabled', true, {
      agentDir,
    });
    expect(installConfRes.status).toBe('completed');
    if (installConfRes.status !== 'completed') throw new Error('inst conf failed');
    expect(installConfRes.installation.manifestName).toBe('codex-git-plugin');
  });

  it('AC3 & AC4: Movable ref produces Update Candidate on upstream drift; SHA-pinned does not; Apply Update enforces disposition', async () => {
    const marketplaceRoot = join(tmpRoot, 'mixed-marketplace');
    mkdirSync(join(marketplaceRoot, '.claude-plugin'), { recursive: true });

    writeFileSync(
      join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'mixed-hub',
        owner: { name: 'Acme' },
        plugins: [
          { name: 'movable-entry', source: { source: 'github', repo: 'samwang/movable', ref: 'main' } },
          { name: 'pinned-entry', source: { source: 'github', repo: 'samwang/pinned', sha: '1111111111111111111111111111111111111111' } },
        ],
      }),
    );

    const movableRoot = join(tmpRoot, 'fixtures', 'movable');
    makeFixture(movableRoot, { pluginName: 'movable-plugin', skillName: 'movable-skill' });

    const pinnedRoot = join(tmpRoot, 'fixtures', 'pinned');
    makeFixture(pinnedRoot, { pluginName: 'pinned-plugin', skillName: 'pinned-skill' });

    let movableSha = '2222222222222222222222222222222222222222';
    const fixtures: Record<string, { root: string; sha: string }> = {
      'samwang/movable': { root: movableRoot, get sha() { return movableSha; } },
      'samwang/pinned': { root: pinnedRoot, sha: '1111111111111111111111111111111111111111' },
    };
    const executor = makeMockGitExecutor(fixtures);

    // Initial Registration
    const preRes = await preflightLocalRegistration(marketplaceRoot, { agentDir, executor, cache });
    expect(preRes.ok).toBe(true);
    if (!preRes.ok) throw new Error('pre failed');
    const confRes = await confirmLocalRegistration(preRes.preflight, true, { agentDir });
    if (confRes.status !== 'completed') throw new Error('conf failed');
    const reg = confRes.registration;

    // Install movable-plugin
    const instPre = await preflightPluginInstallation(reg.id, '/plugins/0', { agentDir, cache });
    if (!instPre.ok) throw new Error('inst pre failed');
    const instConf = await confirmPluginInstallation(instPre.preflight, 'enabled', true, { agentDir });
    if (instConf.status !== 'completed') throw new Error('inst conf failed');
    const inst = instConf.installation;

    // 1. Refresh when upstream has NOT moved -> no-change
    const ref1 = await refreshRegistration(reg.id, { agentDir, executor, cache });
    expect(ref1.status).toBe('no-change');

    // 2. Upstream moves for movable ref entry
    movableSha = '3333333333333333333333333333333333333333';
    // Modify content in movable fixture so tree snapshot actually changes
    writeFileSync(join(movableRoot, 'skills', 'movable-skill', 'SKILL.md'), '---\nname: movable-skill\ndescription: v2\n---\nUpdated content');

    const ref2 = await refreshRegistration(reg.id, { agentDir, executor, cache });
    expect(ref2.status).toBe('update-candidate');
    const candidate = (ref2 as { candidate: any }).candidate;
    expect(candidate.entrySnapshots['/plugins/0']).not.toEqual(reg.entrySnapshots?.['/plugins/0']);
    // Pinned entry snapshot stayed unchanged
    expect(candidate.entrySnapshots['/plugins/1']).toEqual(reg.entrySnapshots?.['/plugins/1']);

    // 3. Build Update Plan without confirming -> fails closed (AC4)
    const planFail = buildUpdatePlan(candidate, [inst], candidate.stateRevision, {
      registrationConfirmed: false,
      choices: { [inst.id]: 'update' },
    });
    expect(planFail.ok).toBe(false);

    // 4. Build Update Plan with update choice and activation confirmation
    const planRes = buildUpdatePlan(candidate, [inst], candidate.stateRevision, {
      registrationConfirmed: true,
      choices: { [inst.id]: 'update' },
      activationConfirmations: { [inst.id]: true },
    });
    expect(planRes.ok).toBe(true);
    if (!planRes.ok) throw new Error('plan failed');

    // 5. Apply Update
    const applyRes = await applyUpdate(planRes.plan, { agentDir, cache });
    expect(applyRes.status).toBe('completed');
    expect((applyRes as { receipt: any }).receipt.stateChanged).toBe(true);

    // Verify durable state
    const postState = (await readBridgeState({ agentDir })).state!;
    const updatedReg = postState.registrations.find((r) => r.id === reg.id)!;
    expect(updatedReg.entrySnapshots).toEqual(candidate.entrySnapshots);
    const updatedInst = postState.installations.find((i) => i.id === inst.id)!;
    expect(updatedInst.installationState).toBe('enabled');
    expect(updatedInst.validationSnapshot).toBeDefined();
  });

  it('AC6: Transaction flow scenario — aggregated marketplace end-to-end registration and installation', async () => {
    const marketplaceRoot = join(tmpRoot, 'agg-marketplace');
    mkdirSync(join(marketplaceRoot, '.claude-plugin'), { recursive: true });

    writeFileSync(
      join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'agg-hub',
        owner: { name: 'Acme' },
        plugins: [
          { name: 'agg-gh', source: { source: 'github', repo: 'samwang/agg-gh' } },
        ],
      }),
    );

    const aggFixture = join(tmpRoot, 'fixtures', 'agg-gh');
    makeFixture(aggFixture, { pluginName: 'agg-gh-plugin', skillName: 'agg-skill' });

    const fixtures = {
      'samwang/agg-gh': { root: aggFixture, sha: '9999999999999999999999999999999999999999' },
    };
    const executor = makeMockGitExecutor(fixtures);

    // Preflight registration with executor
    const regPre = await preflightLocalRegistration(marketplaceRoot, { agentDir, executor, cache });
    expect(regPre.ok).toBe(true);
    if (!regPre.ok) throw new Error('reg pre failed');
    const regConf = await confirmLocalRegistration(regPre.preflight, true, { agentDir });
    expect(regConf.status).toBe('completed');
    if (regConf.status !== 'completed') throw new Error('reg conf failed');
    const registration = regConf.registration;

    // Preflight installation for external git entry
    const instPre = await preflightPluginInstallation(registration.id, '/plugins/0', { agentDir, cache });
    expect(instPre.ok).toBe(true);
    if (!instPre.ok) throw new Error('inst pre failed');
    const instConf = await confirmPluginInstallation(instPre.preflight, 'enabled', true, { agentDir });
    expect(instConf.status).toBe('completed');
    if (instConf.status !== 'completed') throw new Error('inst conf failed');
    expect(instConf.installation.pluginId).toBe(`${registration.id}/agg-hub/agg-gh-plugin`);

    const state = (await readBridgeState({ agentDir })).state!;
    expect(state.registrations).toHaveLength(1);
    expect(state.installations).toHaveLength(1);
    expect(state.installations[0].manifestName).toBe('agg-gh-plugin');
  });

  it('preflightGitRegistration without opts.cache initializes SourceCache fallback and stores entry trees', async () => {
    const gitMarketplaceFixture = join(tmpRoot, 'fixtures', 'remote-git-marketplace');
    mkdirSync(join(gitMarketplaceFixture, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(gitMarketplaceFixture, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'remote-hub',
        owner: { name: 'Acme' },
        plugins: [
          { name: 'gh-tool', source: { source: 'github', repo: 'samwang/gh-tool' } },
        ],
      }),
    );

    const fixtures = {
      'remote-hub.git': { root: gitMarketplaceFixture, sha: '8888888888888888888888888888888888888888' },
      'samwang/gh-tool': { root: ghFixtureRoot, sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    };
    const executor = makeMockGitExecutor(fixtures);

    // Call preflightGitRegistration WITHOUT opts.cache — must initialize fallback cache from agentDir
    const preRes = await preflightGitRegistration('https://github.com/example/remote-hub.git', 'refs/heads/main', {
      agentDir,
      executor,
    });
    expect(preRes.ok).toBe(true);
    if (!preRes.ok) throw new Error('git pre failed');
    expect(preRes.preflight.entrySnapshots).toHaveProperty('/plugins/0');

    const confRes = await confirmGitRegistration(preRes.preflight, true, { agentDir });
    expect(confRes.status).toBe('completed');
    if (confRes.status !== 'completed') throw new Error('git conf failed');

    // Inspect marketplace using a new SourceCache instance with the same agentDir — entry snapshot must hit!
    const inspectCache = new SourceCache({ agentDir });
    const inspection = inspectMarketplaceEntries(confRes.registration, { agentDir, cache: inspectCache });
    expect(inspection.entries[0].entry.available).toBe(true);
    expect(inspection.entries[0].plugin?.manifestName).toBe('gh-plugin');
  });
});
