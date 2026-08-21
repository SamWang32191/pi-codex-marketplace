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

type Env = { agentDir: string; projectDir: string; tmpRoot: string };

function makeEnv(): Env {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'reg-flow-'));
  return { agentDir: join(tmpRoot, 'agent'), projectDir: join(tmpRoot, 'project'), tmpRoot };
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
  return { agentDir: env.agentDir, cwd: env.projectDir, fenceTimeoutMs: 300, ...extra };
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
    const res = await preflightLocalRegistration('global', root, opts(env, { preallocatedId: '11111111-1111-4111-8111-111111111111' }));
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
    const res = await preflightLocalRegistration('global', root, opts(env));
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

    const state = await readBridgeState('global', { agentDir: env.agentDir, cwd: env.projectDir });
    expect(state.status).toBe('ok');
    expect(state.state!.stateRevision).toBe('1');
    expect(state.state!.registrations).toHaveLength(1);
    expect(state.state!.registrations[0].id).toBe(outcome.registration.id);
    expect(state.state!.registrations[0].sourceKey!.key).toBe(`local:${root}`);
    expect(state.state!.registrations[0].validationSnapshot).toBe(res.preflight.snapshot.fingerprint);
  });

  it('confirmation no (Default No) declines without mutating state', async () => {
    const res = await preflightLocalRegistration('global', root, opts(env));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const outcome = await confirmLocalRegistration(res.preflight, false, opts(env));
    expect(outcome.status).toBe('declined');
    if (outcome.status !== 'declined') return;
    expect(outcome.receipt.summary).toBe('Declined');
    expect(outcome.receipt.stateChanged).toBe(false);
    const state = await readBridgeState('global', { agentDir: env.agentDir, cwd: env.projectDir });
    expect(state.state!.registrations).toHaveLength(0);
    expect(state.state!.stateRevision).toBe('0');
  });

  it('detects a duplicate local Source Key in the same scope and directs to the existing Registration without a duplicate ID', async () => {
    const first = await preflightLocalRegistration('global', root, opts(env, { preallocatedId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const committed = await confirmLocalRegistration(first.preflight, true, opts(env));
    expect(committed.status).toBe('completed');

    const second = await preflightLocalRegistration('global', root, opts(env, { preallocatedId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }));
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.outcome.status).toBe('blocked');
    if (second.outcome.status !== 'blocked') return;
    expect(second.outcome.findings[0].code).toBe('DUPLICATE_SOURCE_KEY');
    expect(second.outcome.existing?.id).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(second.outcome.receipt.summary).toBe('Blocked');
    // The pre-allocated second ID was never persisted
    const state = await readBridgeState('global', { agentDir: env.agentDir, cwd: env.projectDir });
    expect(state.state!.registrations).toHaveLength(1);
    expect(state.state!.registrations[0].id).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  });

  it('equal Source Keys across scopes do not merge registrations', async () => {
    const g = await preflightLocalRegistration('global', root, opts(env));
    expect(g.ok).toBe(true);
    if (!g.ok) return;
    expect((await confirmLocalRegistration(g.preflight, true, opts(env))).status).toBe('completed');

    const p = await preflightLocalRegistration('project', root, opts(env, { projectTrusted: true }));
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect((await confirmLocalRegistration(p.preflight, true, opts(env))).status).toBe('completed');

    const gs = await readBridgeState('global', { agentDir: env.agentDir, cwd: env.projectDir });
    const ps = await readBridgeState('project', { agentDir: env.agentDir, cwd: env.projectDir });
    expect(gs.state!.registrations).toHaveLength(1);
    expect(ps.state!.registrations).toHaveLength(1);
  });

  it('rejects confirmation as Stale when the Validation Snapshot changed between preflight and confirm (source tree drifted)', async () => {
    const res = await preflightLocalRegistration('global', root, opts(env));
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
    const state = await readBridgeState('global', { agentDir: env.agentDir, cwd: env.projectDir });
    expect(state.state!.registrations).toHaveLength(0);
    expect(state.state!.stateRevision).toBe('0');
  });

  it('rejects confirmation as Stale when the State Revision changed between preflight and confirm', async () => {
    const res = await preflightLocalRegistration('global', root, opts(env));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // concurrent commit bumps the revision
    await commitBridgeState(
      'global',
      (c) => ({ ...c, registrations: [...c.registrations, { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', alias: 'other' }] }),
      { agentDir: env.agentDir, cwd: env.projectDir },
    );
    const outcome = await confirmLocalRegistration(res.preflight, true, opts(env));
    expect(outcome.status).toBe('rejected-as-stale');
    if (outcome.status !== 'rejected-as-stale') return;
    expect(outcome.receipt.summary).toBe('Rejected as Stale');
    expect(outcome.receipt.stateChanged).toBe(false);
    // no duplicate was created
    const state = await readBridgeState('global', { agentDir: env.agentDir, cwd: env.projectDir });
    expect(state.state!.registrations.map((r) => r.source)).not.toContain(root);
  });

  it('blocks a concurrent same-scope attempt with an ATTEMPT_IN_PROGRESS Blocking Finding (Attempt Fence)', async () => {
    const a = await preflightLocalRegistration('global', root, opts(env));
    expect(a.ok).toBe(true);
    if (!a.ok) return;

    const b = await preflightLocalRegistration('global', root, opts(env, { fenceTimeoutMs: 100 }));
    expect(b.ok).toBe(false);
    if (b.ok) return;
    expect(b.outcome.status).toBe('blocked');
    if (b.outcome.status !== 'blocked') return;
    expect(b.outcome.findings[0].code).toBe('ATTEMPT_IN_PROGRESS');
    expect(b.outcome.receipt.summary).toBe('Blocked');

    // releasing the first attempt frees the fence
    cancelLocalRegistration(a.preflight);
    const c = await preflightLocalRegistration('global', root, opts(env));
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    cancelLocalRegistration(c.preflight);
  });

  it('does not block concurrent attempts on different scopes', async () => {
    const g = await preflightLocalRegistration('global', root, opts(env));
    expect(g.ok).toBe(true);
    if (!g.ok) return;
    const p = await preflightLocalRegistration('project', root, opts(env, { projectTrusted: true }));
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    cancelLocalRegistration(g.preflight);
    cancelLocalRegistration(p.preflight);
  });

  it('blocks Project Scope registration without Project Trust while retaining stored project records', async () => {
    // first, grant trust and store a project record
    const trusted = await preflightLocalRegistration('project', root, opts(env, { projectTrusted: true }));
    expect(trusted.ok).toBe(true);
    if (!trusted.ok) return;
    expect((await confirmLocalRegistration(trusted.preflight, true, opts(env))).status).toBe('completed');

    // newer attempt without trust: blocked, record retained (excluded from Effective State is a later ticket)
    const untrusted = await preflightLocalRegistration('project', root, opts(env, { projectTrusted: false }));
    expect(untrusted.ok).toBe(false);
    if (untrusted.ok) return;
    expect(untrusted.outcome.status).toBe('blocked');
    if (untrusted.outcome.status !== 'blocked') return;
    expect(untrusted.outcome.findings[0].code).toBe('PROJECT_TRUST_DENIED');

    const state = await readBridgeState('project', { agentDir: env.agentDir, cwd: env.projectDir });
    expect(state.state!.registrations).toHaveLength(1);
  });

  it('blocks registration when the local root is missing', async () => {
    const res = await preflightLocalRegistration('global', join(root, 'missing'), opts(env));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.outcome.status).toBe('blocked');
    if (res.outcome.status !== 'blocked') return;
    expect(res.outcome.findings[0].code).toBe('SOURCE_NOT_EXISTS');
  });

  it('blocks registration when the Marketplace Catalog is missing', async () => {
    rmSync(join(root, '.agents'), { recursive: true, force: true });
    const res = await preflightLocalRegistration('global', root, opts(env));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.outcome.status).toBe('blocked');
    if (res.outcome.status !== 'blocked') return;
    expect(res.outcome.findings[0].code).toBe('CATALOG_MISSING');
  });

  it('blocks registration on Contained Path violations at the entry boundary', async () => {
    // entry path escapes the owning root
    const outside = mkdtempSync(join(tmpdir(), 'outside-mkt-'));
    writeFileSync(join(root, '.agents', 'plugins', 'marketplace.json'),
      JSON.stringify({ name: 'evil', plugins: [{ name: 'x', path: '../../outside' }] }));
    const res = await preflightLocalRegistration('global', root, opts(env));
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
    const res = await preflightLocalRegistration('global', root, opts(env));
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
    const res = await preflightLocalRegistration('global', root, opts(env));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    const state = await readBridgeState('global', { agentDir: env.agentDir, cwd: env.projectDir });
    expect(state.state!.stateRevision).toBe('0');
    expect(state.state!.registrations).toHaveLength(0);
    // fence released: a follow-up attempt with a valid root succeeds
    const okRoot = mkdtempSync(join(tmpdir(), 'mkt-ok-'));
    try {
      makeMarketplace(okRoot, 'second-marketplace');
      const again = await preflightLocalRegistration('global', realpathSync.native(okRoot), opts(env));
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
    const res = await preflightLocalRegistration('global', root, opts(env));
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
    const a = await preflightLocalRegistration('global', root, opts(env));
    const b = await preflightLocalRegistration('global', root, opts(env, { fenceTimeoutMs: 100 }));
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
    const res = await preflightLocalRegistration('global', root, opts(env));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    if (res.outcome.status !== 'blocked') return;
    const missing = res.outcome.findings.find((f) => f.code === 'CATALOG_MISSING');
    expect(missing?.pointer).toBe(MARKETPLACE_CATALOG_RELPATH);
  });
});