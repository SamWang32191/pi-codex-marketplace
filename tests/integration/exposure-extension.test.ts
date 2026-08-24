/**
 * Integration: the Bridge Extension registers the host resource-discovery handler and returns
 * Runtime Skill Exposure paths through `resources_discover` (Issue #54, ADR 0001).
 *
 * External observable behavior only: startup and reload reasons produce identical contributions,
 * Project Trust gates project additions, and passive inspection writes no Attempt Receipt.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import registerBridgeExtension from '../../extensions/pi/index.js';
import { commitBridgeState } from '../../src/bridge-state/store.js';
import { getReceiptsJournalPath } from '../../src/bridge-state/paths.js';
import { SourceCache } from '../../src/cache/source-cache.js';
import type { BridgeState } from '../../src/bridge-state/types.js';

const GLOBAL_REG = '11111111-1111-4111-8111-111111111111';
const FINGERPRINT = 'a'.repeat(64);

interface DiscoverHandler {
  (event: { type: 'resources_discover'; cwd: string; reason: 'startup' | 'reload' }, ctx: { cwd: string; isProjectTrusted(): boolean }): Promise<{ skillPaths?: string[] }>;
}

function captureHandlers(): Map<string, DiscoverHandler> {
  const handlers = new Map<string, DiscoverHandler>();
  registerBridgeExtension({
    on(event: string, handler: DiscoverHandler) {
      handlers.set(event, handler);
    },
    registerCommand() {},
  } as never);
  return handlers;
}

function makeEnv() {
  const root = mkdtempSync(join(tmpdir(), 'exposure-extension-'));
  const env = {
    root,
    agentDir: join(root, 'agent'),
    projectDir: join(root, 'project'),
    marketplace: join(root, 'marketplace'),
  };
  mkdirSync(join(env.marketplace, '.agents', 'plugins'), { recursive: true });
  writeFileSync(
    join(env.marketplace, '.agents', 'plugins', 'marketplace.json'),
    JSON.stringify({
      name: 'acme-marketplace',
      plugins: [{ name: 'release-helper', source: { source: 'local', path: './plugins/release-helper' } }],
    }),
  );
  mkdirSync(join(env.marketplace, 'plugins', 'release-helper', '.codex-plugin'), { recursive: true });
  writeFileSync(join(env.marketplace, 'plugins', 'release-helper', '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'release-helper', skills: './skills/' }));
  mkdirSync(join(env.marketplace, 'plugins', 'release-helper', 'skills', 'release-notes'), { recursive: true });
  writeFileSync(
    join(env.marketplace, 'plugins', 'release-helper', 'skills', 'release-notes', 'SKILL.md'),
    '---\nname: release-notes\ndescription: Write release notes\n---\n\nWrite release notes.\n',
  );
  return env;
}

async function seedEnabledGlobalInstallation(agentDir: string, projectDir: string): Promise<void> {
  await commitBridgeState(
    'global',
    (state: BridgeState) => ({
      ...state,
      registrations: [
        ...state.registrations,
        {
          id: GLOBAL_REG,
          alias: 'acme',
          marketplaceName: 'acme-marketplace',
          sourceKind: 'git' as const,
          source: 'https://github.com/acme/marketplace.git',
          canonicalLocator: 'https://github.com/acme/marketplace.git',
          validationSnapshot: FINGERPRINT,
        },
      ],
      installations: [
        ...state.installations,
        {
          id: `global/${GLOBAL_REG}/acme-marketplace/release-helper`,
          pluginId: `${GLOBAL_REG}/acme-marketplace/release-helper`,
          installationState: 'enabled' as const,
          registrationId: GLOBAL_REG,
          marketplaceEntryId: `${GLOBAL_REG}/acme-marketplace/plugins/0`,
          validationSnapshot: `bound-${FINGERPRINT.slice(0, 8)}`,
          manifestName: 'release-helper',
        },
      ],
    }),
    { agentDir, cwd: projectDir },
  );
}

let envs: ReturnType<typeof makeEnv>[] = [];

beforeEach(() => {
  envs = [];
});

afterEach(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_AGENT_DIR;
  while (envs.length > 0) rmSync(envs.pop()!.root, { recursive: true, force: true });
});

describe('Bridge Extension resources_discover seam (#54)', () => {
  it('registers a resources_discover handler that contributes enabled Installation skills on startup and reload', async () => {
    const env = makeEnv();
    envs.push(env);
    // Acquire the marketplace tree into the Source Cache exactly like Git acquisition.
    await new SourceCache({ agentDir: env.agentDir }).storeTree(env.marketplace, FINGERPRINT);
    await seedEnabledGlobalInstallation(env.agentDir, env.projectDir);
    process.env.PI_CODING_AGENT_DIR = env.agentDir;
    process.env.PI_AGENT_DIR = env.agentDir;

    const handlers = captureHandlers();
    const handler = handlers.get('resources_discover');
    expect(handler).toBeDefined();

    const ctx = { cwd: env.projectDir, isProjectTrusted: () => true };
    const startup = await handler!({ type: 'resources_discover', cwd: env.projectDir, reason: 'startup' }, ctx);
    const reload = await handler!({ type: 'resources_discover', cwd: env.projectDir, reason: 'reload' }, ctx);

    expect(startup.skillPaths).toHaveLength(1);
    expect(startup.skillPaths).toEqual(reload.skillPaths);
    expect(startup.skillPaths![0]!).toContain(join('plugins', 'release-helper', 'skills', 'release-notes'));
    expect(existsSync(join(startup.skillPaths![0]!, 'SKILL.md'))).toBe(true);
  });

  it('gates project additions on Project Trust through the host context and writes no Attempt Receipt', async () => {
    const env = makeEnv();
    envs.push(env);
    await new SourceCache({ agentDir: env.agentDir }).storeTree(env.marketplace, FINGERPRINT);
    await seedEnabledGlobalInstallation(env.agentDir, env.projectDir);
    process.env.PI_CODING_AGENT_DIR = env.agentDir;
    process.env.PI_AGENT_DIR = env.agentDir;

    const handlers = captureHandlers();
    const handler = handlers.get('resources_discover')!;
    let trusted = false;
    const untrusted = await handler(
      { type: 'resources_discover', cwd: env.projectDir, reason: 'startup' },
      { cwd: env.projectDir, isProjectTrusted: () => trusted },
    );
    expect(untrusted.skillPaths).toHaveLength(1); // global baseline still contributes

    trusted = true;
    const result = await handler(
      { type: 'resources_discover', cwd: env.projectDir, reason: 'reload' },
      { cwd: env.projectDir, isProjectTrusted: () => trusted },
    );
    expect(result.skillPaths).toEqual(untrusted.skillPaths);

    // Passive inspection creates none.
    expect(existsSync(getReceiptsJournalPath('global', { agentDir: env.agentDir, cwd: env.projectDir }))).toBe(false);
    expect(existsSync(getReceiptsJournalPath('project', { agentDir: env.agentDir, cwd: env.projectDir }))).toBe(false);
  });
});
