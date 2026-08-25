/**
 * Effective State computation — pure read-time behavior.
 * See CONTEXT.md: Effective State, Global Scope, Project Scope,
 * Installed Plugin, Installation State, Project Trust.
 *
 * Only external observable behavior is asserted: which records participate,
 * which inherited records are suppressed and why, and that persisted provenance
 * of selected records is never merged or mutated.
 *
 * Scope Overrides retired (issue #59): legacy persisted `scopeOverrides` entries must be
 * ignored entirely — inherited Global records always participate, with no suppression path.
 */

import { describe, expect, it } from 'vitest';

import {
  computeEffectiveState,
  type EffectiveInstallation,
  type EffectiveRegistration,
} from '../../../src/projection/effective-state.js';
import { createEmptyState, type BridgeState } from '../../../src/bridge-state/types.js';

function withState(patch: Partial<BridgeState>): BridgeState {
  return { ...createEmptyState(), ...patch };
}

const GLOBAL_REG = 'aaaaaaaa-1111-4111-8111-111111111111';
const GLOBAL_REG_2 = 'aaaaaaaa-2222-4222-8222-222222222222';
const PROJECT_REG = 'bbbbbbbb-3333-4333-8333-333333333333';

function globalRegistration(id: string, extra: Record<string, unknown> = {}): BridgeState['registrations'][number] {
  return { id, alias: `alias-${id.slice(0, 6)}`, sourceKind: 'local', source: `/sources/${id}`, ...extra };
}

function installation(id: string, pluginId: string, opts: { scope: 'global' | 'project'; state?: 'enabled' | 'disabled'; registrationId?: string; snapshot?: string }): BridgeState['installations'][number] {
  return {
    id,
    pluginId,
    installationState: opts.state ?? 'enabled',
    registrationId: opts.registrationId,
    validationSnapshot: opts.snapshot,
  };
}

describe('Effective State — inheritance', () => {
  it('inherits global registrations and enabled installations into the project view', () => {
    const global = withState({
      registrations: [globalRegistration(GLOBAL_REG)],
      installations: [
        installation('global/acme-marketplace/alpha', 'aaaa…/alpha', { scope: 'global', registrationId: GLOBAL_REG }),
      ],
    });
    const effective = computeEffectiveState(global, createEmptyState(), { projectTrusted: true });
    expect(effective.registrations.map((r) => r.id)).toEqual([GLOBAL_REG]);
    expect(effective.registrations[0]!.sourceScope).toBe('global');
    expect(effective.installations.map((i) => i.pluginId)).toEqual(['aaaa…/alpha']);
    expect(effective.installations[0]!.sourceScope).toBe('global');
    expect(effective.suppressed).toEqual([]);
  });

  it('excludes disabled installations — only enabled Installations participate', () => {
    const global = withState({
      registrations: [globalRegistration(GLOBAL_REG)],
      installations: [
        installation('global/x/enabled', 'x/enabled-one', { scope: 'global', registrationId: GLOBAL_REG }),
        installation('global/x/disabled', 'x/disabled-one', { scope: 'global', state: 'disabled', registrationId: GLOBAL_REG }),
      ],
    });
    const effective = computeEffectiveState(global, createEmptyState(), { projectTrusted: true });
    expect(effective.installations.map((i) => i.pluginId)).toEqual(['x/enabled-one']);
  });

  it('adds project registrations alongside inherited globals without merging them', () => {
    const global = withState({ registrations: [globalRegistration(GLOBAL_REG)] });
    const project = withState({
      registrations: [{ ...globalRegistration(PROJECT_REG), alias: 'project-local' }],
      installations: [installation('project/y/beta', 'y/beta', { scope: 'project', registrationId: PROJECT_REG })],
    });
    const effective = computeEffectiveState(global, project, { projectTrusted: true });
    expect(effective.registrations.map((r) => [r.id, r.sourceScope])).toEqual([
      [GLOBAL_REG, 'global'],
      [PROJECT_REG, 'project'],
    ]);
    expect(effective.installations.map((i) => i.sourceScope)).toEqual(['project']);
  });
});

describe('Effective State — retired Scope Overrides（暫態語意）', () => {
  const subtreeInstallA = installation('global/r-a/one', 'reg-a/one', { scope: 'global', registrationId: GLOBAL_REG });
  const subtreeInstallB = installation('global/r-a/two', 'reg-a/two', { scope: 'global', registrationId: GLOBAL_REG });
  const otherInstall = installation('global/r-b/keep', 'reg-b/keep', { scope: 'global', registrationId: GLOBAL_REG_2 });

  const populatedGlobal = withState({
    registrations: [globalRegistration(GLOBAL_REG), globalRegistration(GLOBAL_REG_2)],
    installations: [subtreeInstallA, subtreeInstallB, otherInstall],
  });

  it('legacy persisted overrides never suppress — inherited Global records always participate', () => {
    const legacyProject = withState({
      scopeOverrides: [
        { kind: 'registration', targetId: GLOBAL_REG },
        { kind: 'installation', targetId: 'global/r-b/keep' },
        { kind: 'installation', targetId: 'global/missing/nowhere' },
      ],
    });
    const effective = computeEffectiveState(populatedGlobal, legacyProject, { projectTrusted: true });
    expect(effective.registrations.map((r) => r.id)).toEqual([GLOBAL_REG, GLOBAL_REG_2]);
    expect(effective.installations.map((i) => i.id).sort()).toEqual(
      ['global/r-a/one', 'global/r-a/two', 'global/r-b/keep'].sort(),
    );
    // No suppression path exists anymore — not even for stale persisted overrides.
    expect(effective.suppressed).toEqual([]);
  });

  it('a project document whose only difference is its overrides computes the identical Effective State', () => {
    const plain = computeEffectiveState(populatedGlobal, createEmptyState(), { projectTrusted: true });
    const withLegacy = computeEffectiveState(
      populatedGlobal,
      withState({ scopeOverrides: [{ kind: 'registration', targetId: GLOBAL_REG_2 }] }),
      { projectTrusted: true },
    );
    expect(withLegacy).toEqual(plain);
  });
});

describe('Effective State — project-over-global precedence', () => {
  const sharedPluginId = 'acme/shared';
  it('an enabled project Installation of an inherited global Plugin ID takes precedence over the retained global Installation', () => {
    const global = withState({
      installations: [
        installation('global/acme/shared', sharedPluginId, { scope: 'global', registrationId: GLOBAL_REG, snapshot: 'global-fingerprint' }),
      ],
    });
    const project = withState({
      registrations: [globalRegistration(PROJECT_REG)],
      installations: [
        installation('project/acme/shared', sharedPluginId, { scope: 'project', registrationId: PROJECT_REG, snapshot: 'project-fingerprint' }),
      ],
    });
    const effective = computeEffectiveState(global, project, { projectTrusted: true });
    expect(effective.installations).toHaveLength(1);
    const selected: EffectiveInstallation = effective.installations[0]!;
    expect(selected.id).toBe('project/acme/shared');
    // no merged provenance: the selected record keeps its own independently persisted fingerprint
    expect(selected.validationSnapshot).toBe('project-fingerprint');
    expect(effective.suppressed).toEqual([
      expect.objectContaining({ kind: 'installation', targetId: 'global/acme/shared', reason: 'project-precedence', supersededBy: 'project/acme/shared' }),
    ]);
  });

  it('a disabled project Installation does not supersede the inherited global Installation', () => {
    const global = withState({
      installations: [installation('global/acme/shared', sharedPluginId, { scope: 'global', registrationId: GLOBAL_REG })],
    });
    const project = withState({
      installations: [installation('project/acme/shared', sharedPluginId, { scope: 'project', state: 'disabled', registrationId: PROJECT_REG })],
    });
    const effective = computeEffectiveState(global, project, { projectTrusted: true });
    expect(effective.installations.map((i) => i.id)).toEqual(['global/acme/shared']);
    expect(effective.suppressed).toEqual([]);
  });

  it('selected records never carry merged provenance across scopes', () => {
    const global = withState({
      registrations: [{ ...globalRegistration(GLOBAL_REG), validationSnapshot: 'snap-global', resolvedRevision: undefined }],
      installations: [],
    });
    const project = withState({
      registrations: [{ ...globalRegistration(GLOBAL_REG, { alias: 'should-not-merge' }), validationSnapshot: 'snap-project' }],
    });
    const effective = computeEffectiveState(global, project, { projectTrusted: true });
    const selected: EffectiveRegistration = effective.registrations.find((r) => r.sourceScope === 'global')!;
    expect(selected.validationSnapshot).toBe('snap-global');
    expect(effective.registrations.filter((r) => r.sourceScope === 'project')).toHaveLength(0);
  });
});

describe('Effective State — Project Trust boundary', () => {
  const global = withState({
    registrations: [globalRegistration(GLOBAL_REG)],
    installations: [installation('global/acme/alpha', 'acme/alpha', { scope: 'global', registrationId: GLOBAL_REG })],
  });
  const project = withState({
    registrations: [globalRegistration(PROJECT_REG)],
    installations: [installation('project/acme/beta', 'acme/beta', { scope: 'project', registrationId: PROJECT_REG })],
    scopeOverrides: [{ kind: 'registration', targetId: GLOBAL_REG }],
  });

  it('without Project Trust, project records remain stored but are excluded from Effective State', () => {
    const effective = computeEffectiveState(global, project, { projectTrusted: false });
    expect(effective.registrations.map((r) => r.id)).toEqual([GLOBAL_REG]);
    expect(effective.installations.map((i) => i.id)).toEqual(['global/acme/alpha']);
    expect(effective.suppressed).toEqual([]);
    // Legacy persisted overrides are ignored entirely — only real records get excluded.
    expect(effective.excluded.map((e) => e.reason)).toHaveLength(2);
    expect(effective.excluded.map((e) => e.kind).sort()).toEqual(['installation', 'registration']);
  });

  it('defaults to untrusted unless the host explicitly granted Project Trust', () => {
    const effective = computeEffectiveState(global, project);
    expect(effective.excluded.length).toBeGreaterThan(0);
  });
});
