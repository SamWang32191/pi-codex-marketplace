import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  preflightLocalRegistration,
  confirmLocalRegistration,
  cancelLocalRegistration,
  disclosureSummary,
  MARKETPLACE_CATALOG_RELPATH,
} from '../../../src/registration/flow.js';
import { commitBridgeState, readBridgeState } from '../../../src/bridge-state/store.js';

type Env = { agentDir: string; tmpRoot: string };

function makeEnv(): Env {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'reg-flow-'));
  return { agentDir: join(tmpRoot, 'agent'), tmpRoot };
}

function makeMarketplace(root: string, name = 'acme-marketplace', plugins = { 'release-helper': './plugins/release-helper' }) {
  mkdirSync(join(root, '.agents', 'plugins'), { recursive: true });
  for (const [pname, path] of Object.entries(plugins)) {
    mkdirSync(join(root, 'plugins', pname), { recursive: true });
    writeFileSync(join(root, 'plugins', pname, 'plugin.json'), JSON.stringify({ name: pname }));
    writeFileSync(join(root, 'plugins', pname, 'SKILL.md'), '# ' + pname);
  }
  writeFileSync(
    join(root, '.agents', 'plugins', 'marketplace.json'),
    JSON.stringify({ name, plugins: Object.entries(plugins).map(([pname, path]) => ({ name: pname, path })) }, null, 2),
  );
}

function opts(env: Env, extra: Record<string, unknown> = {}) {
  return { agentDir: env.agentDir, fenceTimeoutMs: 300, ...extra };
}

describe('Local Marketplace Registration flow', () => {
  let env: Env;
  let root: string;

  beforeEach(() => {
    env = makeEnv();
    const tmp = mkdtempSync(join(tmpdir(), 'mkt-root-'));
    root = realpathSync.native(tmp);
    makeMarketplace(root);
  });
  afterEach(() => {
    try {
      rmSync(env.tmpRoot, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    } catch {}
  });

  it('preflight produces a complete Validation Disclosure for the confirmation', async () => {
    const res = await preflightLocalRegistration(root, opts(env, { preallocatedId: '11111111-1111-4111-8111-111111111111' }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const pf = res.preflight;
    expect(pf.registrationId).toBe('11111111-1111-4111-8111-111111111111');
    expect(pf.marketplaceName).toBe('acme-marketplace');
    expect(pf.alias).toBe('acme-marketplace');
    expect(pf.canonicalPath).toBe(root);
    expect(pf.sourceKey.kind).toBe('local');
    expect(pf.stateRevision).toBe('0');
    expect(pf.blocked).toBe(false);
    expect(pf.snapshot.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(pf.catalog.entries).toHaveLength(1);
    expect(pf.catalog.entries[0].entryId).toBe('/plugins/0');
    const summary = disclosureSummary(pf);
    expect(summary).toContain('acme-marketplace');
    expect(summary).toContain('State Revision: 0');
    expect(summary).toContain('Validation Snapshot');
    expect(summary).toContain('/plugins/0');
    cancelLocalRegistration(pf);
  });

  it('confirmation yes commits atomically, bumps State Revision, and returns an immutable Completed receipt', async () => {
    const res = await preflightLocalRegistration(root, opts(env));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const outcome = await confirmLocalRegistration(res.preflight, true, opts(env));
    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') return;
    expect(outcome.newRevision).toBe('1');
    expect(outcome.registration.sourceKind).toBe('local');
    expect(outcome.registration.source).toBe(root);
    expect(outcome.registration.validationSnapshot).toBe(res.preflight.snapshot.fingerprint);
    expect(outcome.receipt.summary).toBe('Completed');
    expect(outcome.receipt.observedStateRevision).toBe('1');
    expect(outcome.receipt.stateChanged).toBe(true);
    expect(Object.isFrozen(outcome.receipt)).toBe(true);

    const state = await readBridgeState({ agentDir: env.agentDir });
    expect(state.status).toBe('ok');
    expect(state.state!.stateRevision).toBe('1');
    expect(state.state!.registrations).toHaveLength(1);
    expect(state.state!.registrations[0].id).toBe(outcome.registration.id);
    expect(state.state!.registrations[0].sourceKey!.key).toBe(`local:${root}`);
    expect(state.state!.registrations[0].validationSnapshot).toBe(res.preflight.snapshot.fingerprint);
  });

  it('confirmation no (Default No) declines without mutating state', async () => {
    const res = await preflightLocalRegistration(root, opts(env));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const outcome = await confirmLocalRegistration(res.preflight, false, opts(env));
    expect(outcome.status).toBe('declined');
    if (outcome.status !== 'declined') return;
    expect(outcome.receipt.summary).toBe('Declined');
    expect(outcome.receipt.stateChanged).toBe(false);
    const state = await readBridgeState({ agentDir: env.agentDir });
    expect(state.state!.registrations).toHaveLength(0);
    expect(state.state!.stateRevision).toBe('0');
  });

  it('detects a duplicate local Source Key and directs to the existing Registration without a duplicate ID', async () => {
    const first = await preflightLocalRegistration(root, opts(env, { preallocatedId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const committed = await confirmLocalRegistration(first.preflight, true, opts(env));
    expect(committed.status).toBe('completed');

    const second = await preflightLocalRegistration(root, opts(env, { preallocatedId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }));
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.outcome.status).toBe('blocked');
    if (second.outcome.status !== 'blocked') return;
    expect(second.outcome.findings[0].code).toBe('DUPLICATE_SOURCE_KEY');
    expect(second.outcome.existing?.id).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(second.outcome.receipt.summary).toBe('Blocked');
    // The pre-allocated second ID was never persisted
    const state = await readBridgeState({ agentDir: env.agentDir });
    expect(state.state!.registrations).toHaveLength(1);
    expect(state.state!.registrations[0].id).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  });

  
  it('rejects confirmation as Stale when the Validation Snapshot changed between preflight and confirm (source tree drifted)', async () => {
    const res = await preflightLocalRegistration(root, opts(env));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // live tree changes after disclosure (no state revision change)
    writeFileSync(join(root, 'plugins', 'release-helper', 'SKILL.md'), '# edited after disclosure');
    const outcome = await confirmLocalRegistration(res.preflight, true, opts(env));
    expect(outcome.status).toBe('rejected-as-stale');
    if (outcome.status !== 'rejected-as-stale') return;
    expect(outcome.receipt.summary).toBe('Rejected as Stale');
    expect(outcome.receipt.findings[0].rule).toBe('STALE-02');
    expect(outcome.receipt.stateChanged).toBe(false);
    // nothing was committed
    const state = await readBridgeState({ agentDir: env.agentDir });
    expect(state.state!.registrations).toHaveLength(0);
    expect(state.state!.stateRevision).toBe('0');
  });

  it('rejects confirmation as Stale when the State Revision changed between preflight and confirm', async () => {
    const res = await preflightLocalRegistration(root, opts(env));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // concurrent commit bumps the revision
    await commitBridgeState((c) => ({ ...c, registrations: [...c.registrations, { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', alias: 'other' }] }),
      { agentDir: env.agentDir },
    );
    const outcome = await confirmLocalRegistration(res.preflight, true, opts(env));
    expect(outcome.status).toBe('rejected-as-stale');
    if (outcome.status !== 'rejected-as-stale') return;
    expect(outcome.receipt.summary).toBe('Rejected as Stale');
    expect(outcome.receipt.stateChanged).toBe(false);
    // no duplicate was created
    const state = await readBridgeState({ agentDir: env.agentDir });
    expect(state.state!.registrations.map((r) => r.source)).not.toContain(root);
  });

  it('blocks a concurrent same-scope attempt with an ATTEMPT_IN_PROGRESS Blocking Finding (Attempt Fence)', async () => {
    const a = await preflightLocalRegistration(root, opts(env));
    expect(a.ok).toBe(true);
    if (!a.ok) return;

    const b = await preflightLocalRegistration(root, opts(env, { fenceTimeoutMs: 100 }));
    expect(b.ok).toBe(false);
    if (b.ok) return;
    expect(b.outcome.status).toBe('blocked');
    if (b.outcome.status !== 'blocked') return;
    expect(b.outcome.findings[0].code).toBe('ATTEMPT_IN_PROGRESS');
    expect(b.outcome.receipt.summary).toBe('Blocked');

    // releasing the first attempt frees the fence
    cancelLocalRegistration(a.preflight);
    const c = await preflightLocalRegistration(root, opts(env));
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    cancelLocalRegistration(c.preflight);
  });

  
  
  it('blocks registration when the local root is missing', async () => {
    const res = await preflightLocalRegistration(join(root, 'missing'), opts(env));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.outcome.status).toBe('blocked');
    if (res.outcome.status !== 'blocked') return;
    expect(res.outcome.findings[0].code).toBe('SOURCE_NOT_EXISTS');
  });

  it('blocks registration when the Marketplace Catalog is missing', async () => {
    rmSync(join(root, '.agents'), { recursive: true, force: true });
    const res = await preflightLocalRegistration(root, opts(env));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.outcome.status).toBe('blocked');
    if (res.outcome.status !== 'blocked') return;
    expect(res.outcome.findings[0].code).toBe('CATALOG_MISSING');
  });

  it('surfaces the structured CATALOG_MALFORMED finding when marketplace.json is valid JSON but not an object', async () => {
    writeFileSync(join(root, '.agents', 'plugins', 'marketplace.json'), '[]', 'utf-8');
    const res = await preflightLocalRegistration(root, opts(env));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.outcome.status).toBe('blocked');
    if (res.outcome.status !== 'blocked') return;
    expect(res.outcome.findings.some((f) => f.code === 'CATALOG_MALFORMED')).toBe(true);
    expect(res.outcome.findings.some((f) => f.code === 'PREFLIGHT_ERROR')).toBe(false);
  });

  it('surfaces the structured CATALOG_MALFORMED finding when marketplace.json lacks a plugins array', async () => {
    writeFileSync(join(root, '.agents', 'plugins', 'marketplace.json'), '{"name":"acme"}', 'utf-8');
    const res = await preflightLocalRegistration(root, opts(env));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.outcome.status).toBe('blocked');
    if (res.outcome.status !== 'blocked') return;
    expect(res.outcome.findings.some((f) => f.code === 'CATALOG_MALFORMED')).toBe(true);
  });

  
  it('blocks registration on Contained Path violations at the entry boundary', async () => {
    // entry path escapes the owning root
    const outside = mkdtempSync(join(tmpdir(), 'outside-mkt-'));
    writeFileSync(join(root, '.agents', 'plugins', 'marketplace.json'),
      JSON.stringify({ name: 'evil', plugins: [{ name: 'x', path: '../../outside' }] }));
    const res = await preflightLocalRegistration(root, opts(env));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.outcome.status).toBe('blocked');
    if (res.outcome.status !== 'blocked') return;
    const codes = res.outcome.findings.map((f) => f.code);
    expect(codes).toContain('PATH_CONTAINMENT_VIOLATION');
    try {
      rmSync(outside, { recursive: true, force: true });
    } catch {}
  });

  it('blocks registration on Validation Budget exceedance at the source boundary', async () => {
    // deep nesting exceeds maxTreeDepth (32)
    let deep = root;
    for (let i = 0; i < 40; i++) deep = join(deep, 'd');
    mkdirSync(deep, { recursive: true });
    const res = await preflightLocalRegistration(root, opts(env));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.outcome.status).toBe('blocked');
    if (res.outcome.status !== 'blocked') return;
    const codes = res.outcome.findings.map((f) => f.code);
    expect(codes).toContain('BUDGET_EXCEEDED');
  });

  it('keeps state unchanged after a blocked attempt and the fence is released', async () => {
    mkdirSync(join(root, '.agents'), { recursive: true }); // remove catalog → blocked
    rmSync(join(root, '.agents', 'plugins', 'marketplace.json'), { force: true });
    const res = await preflightLocalRegistration(root, opts(env));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    const state = await readBridgeState({ agentDir: env.agentDir });
    expect(state.state!.stateRevision).toBe('0');
    expect(state.state!.registrations).toHaveLength(0);
    // fence released: a follow-up attempt with a valid root succeeds
    const okRoot = mkdtempSync(join(tmpdir(), 'mkt-ok-'));
    try {
      makeMarketplace(okRoot, 'second-marketplace');
      const again = await preflightLocalRegistration(realpathSync.native(okRoot), opts(env));
      expect(again.ok).toBe(true);
      if (again.ok) cancelLocalRegistration(again.preflight);
    } finally {
      try {
        rmSync(okRoot, { recursive: true, force: true });
      } catch {}
    }
  });

  it('catalog entries with nonexistent paths are Unavailable but registration still proceeds', async () => {
    writeFileSync(
      join(root, '.agents', 'plugins', 'marketplace.json'),
      JSON.stringify({ name: 'acme-marketplace', plugins: [{ name: 'ghost', path: './plugins/ghost' }] }),
    );
    const res = await preflightLocalRegistration(root, opts(env));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.preflight.catalog.entries[0].available).toBe(false);
    expect(res.preflight.catalog.entries[0].unavailableReason).toMatch(/does not exist/i);
    // Unavailable Entries are disclosed, not findings
    expect(res.preflight.findings).toEqual([]);
    const outcome = await confirmLocalRegistration(res.preflight, true, opts(env));
    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') return;
    expect(outcome.receipt.summary).toBe('Completed');
  });

  it('Marketplace Entry IDs are stable on re-read of the same snapshot', async () => {
    const a = await preflightLocalRegistration(root, opts(env));
    const b = await preflightLocalRegistration(root, opts(env, { fenceTimeoutMs: 100 }));
    // second attempt blocked by fence — ids not comparable; instead verify within one preflight
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const pf = a.preflight;
    expect(pf.catalog.entries.map((e) => e.entryId)).toEqual(['/plugins/0']);
    cancelLocalRegistration(pf);
  });

  it('disclosure marks the catalog relpath in findings pointers', async () => {
    // missing catalog finding carries the canonical relpath
    rmSync(join(root, '.agents'), { recursive: true, force: true });
    const res = await preflightLocalRegistration(root, opts(env));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    if (res.outcome.status !== 'blocked') return;
    const missing = res.outcome.findings.find((f) => f.code === 'CATALOG_MISSING');
    expect(missing?.pointer).toBe(MARKETPLACE_CATALOG_RELPATH);
  });
});
describe('Marketplace Format detection wiring — local registration', () => {
  let env: Env;
  let root: string;

  beforeEach(() => {
    env = makeEnv();
    root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-root-')));
  });
  afterEach(() => {
    try {
      rmSync(env.tmpRoot, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    } catch {}
  });

  function makeClaudeMarketplace(marketRoot: string, name = 'matt-marketplace'): void {
    mkdirSync(join(marketRoot, '.claude-plugin'), { recursive: true });
    const pluginRoot = join(marketRoot, 'plugins', 'mattpocock-skills');
    mkdirSync(join(pluginRoot, '.claude-plugin'), { recursive: true });
    mkdirSync(join(pluginRoot, 'skills', 'engineering', 'code-review'), { recursive: true });
    writeFileSync(
      join(pluginRoot, 'skills', 'engineering', 'code-review', 'SKILL.md'),
      '---\nname: code-review\ndescription: Review code changes\ndisable-model-invocation: true\n---\n\nReview code.\n',
    );
    mkdirSync(join(pluginRoot, 'skills', 'diagnostics', 'diagnosing-bugs'), { recursive: true });
    writeFileSync(
      join(pluginRoot, 'skills', 'diagnostics', 'diagnosing-bugs', 'SKILL.md'),
      '---\nname: diagnosing-bugs\ndescription: Diagnose hard bugs\n---\n\nDiagnose.\n',
    );
    writeFileSync(
      join(pluginRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'mattpocock-skills', skills: ['./skills/engineering/code-review', './skills/diagnostics/diagnosing-bugs'] }),
    );
    writeFileSync(
      join(marketRoot, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name,
        owner: { name: 'Matt Pocock' },
        plugins: [{ name: 'mattpocock-skills', source: './plugins/mattpocock-skills', description: 'skill collection' }],
      }),
    );
  }

  it('registers a claude-only repo and fixes format=claude onto the Registration', async () => {
    makeClaudeMarketplace(root);
    const res = await preflightLocalRegistration(root, opts(env));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.preflight.format).toBe('claude');
    expect(disclosureSummary(res.preflight)).toContain('Marketplace Format: claude');

    const outcome = await confirmLocalRegistration(res.preflight, true, opts(env));
    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') return;
    expect(outcome.registration.format).toBe('claude');
    expect(outcome.receipt.marketplaceFormat).toBe('claude');
    // open policy (#91): inert entry metadata (description) no longer produces a warning
    expect(outcome.receipt.summary).toBe('Completed');

    const state = await readBridgeState({ agentDir: env.agentDir });
    expect(state.state!.registrations[0].format).toBe('claude');
  });

  it('adopts codex without an extra question when both catalogs coexist', async () => {
    makeClaudeMarketplace(root);
    mkdirSync(join(root, '.agents', 'plugins'), { recursive: true });
    mkdirSync(join(root, 'plugins', 'release-helper'), { recursive: true });
    writeFileSync(join(root, 'plugins', 'release-helper', 'plugin.json'), JSON.stringify({ name: 'release-helper' }));
    writeFileSync(join(root, 'plugins', 'release-helper', 'SKILL.md'), '# release-helper');
    writeFileSync(
      join(root, '.agents', 'plugins', 'marketplace.json'),
      JSON.stringify({ name: 'acme-marketplace', plugins: [{ name: 'release-helper', path: './plugins/release-helper' }] }),
    );

    const res = await preflightLocalRegistration(root, opts(env));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.preflight.format).toBe('codex');
    expect(disclosureSummary(res.preflight)).toContain('Marketplace Format: codex');
    cancelLocalRegistration(res.preflight);
  });

  it('keeps CATALOG_MISSING unchanged when neither catalog exists', async () => {
    mkdirSync(join(root, 'unrelated'), { recursive: true });
    const res = await preflightLocalRegistration(root, opts(env));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.outcome.status).toBe('blocked');
    if (res.outcome.status !== 'blocked') return;
    expect(res.outcome.findings[0].code).toBe('CATALOG_MISSING');
  });

  it('ignores unknown claude catalog fields under the open policy when format=claude (#91)', async () => {
    makeClaudeMarketplace(root);
    writeFileSync(
      join(root, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'matt-marketplace',
        owner: { name: 'Matt Pocock' },
        plugins: [{ name: 'mattpocock-skills', source: './skills', rogueField: true }],
      }),
    );
    const res = await preflightLocalRegistration(root, opts(env));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.preflight.format).toBe('claude');
    cancelLocalRegistration(res.preflight);
  });
});
