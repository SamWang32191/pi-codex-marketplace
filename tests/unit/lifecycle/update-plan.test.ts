import { describe, expect, it } from 'vitest';

import type { Installation, Scope } from '../../../src/bridge-state/types.js';
import { buildUpdatePlan } from '../../../src/lifecycle/update-plan.js';
import type { UpdateCandidate } from '../../../src/lifecycle/refresh.js';
import type { CompatiblePlugin } from '../../../src/compatibility/profile.js';

const SCOPE: Scope = 'global';
const REG_ID = '11111111-1111-4111-8111-111111111111';

function plugin(id: string): CompatiblePlugin {
  return {
    id,
    manifestName: id.slice(id.lastIndexOf('/') + 1),
    marketplaceEntryId: `${id.replace(/\/[^/]+$/, '')}/plugins/0`,
    skills: [],
  };
}

function candidate(opts: {
  plugins?: CompatiblePlugin[];
}): UpdateCandidate {
  const plugins = opts.plugins ?? [plugin(`${REG_ID}/acme-marketplace/release-helper`)];
  return {
    scope: SCOPE,
    registrationId: REG_ID,
    stateRevision: '0',
    recordedFingerprint: 'old',
    snapshot: {
      fingerprint: 'new-snapshot-fingerprint',
      scope: SCOPE,
      entries: [],
      sourceKey: { kind: 'local', key: 'k', canonicalPath: '/tmp/marketplace' },
      profile: 'p',
      ruleset: 'r',
      budget: 'b',
    },
    marketplaceName: 'acme-marketplace',
    catalog: { name: 'acme-marketplace', entries: [] },
    inspection: {
      entries: plugins.map((p) => ({ entry: { entryId: p.marketplaceEntryId.slice((`${REG_ID}/acme-marketplace`).length), ordinal: 0, type: 'local' as const, available: true }, plugin: p, findings: [] })),
      findings: [],
      marketplaceId: `${REG_ID}/acme-marketplace`,
      snapshot: {
        fingerprint: 'activation-bound-fingerprint',
        scope: SCOPE,
        entries: [],
        sourceKey: { kind: 'local', key: 'k', canonicalPath: '/tmp/marketplace' },
        profile: 'p',
        ruleset: 'r',
        budget: 'b',
      },
    },
    sourceKey: { kind: 'local', key: 'k', canonicalPath: '/tmp/marketplace' },
  };
}

function existingInstallation(pluginId: string, state: 'enabled' | 'disabled' = 'enabled'): Pick<Installation, 'id' | 'pluginId' | 'installationState'> {
  return {
    id: `${SCOPE}/${pluginId}`,
    pluginId,
    installationState: state,
  };
}

describe('Update Plan — Validation Snapshot- and State Revision-bound outcomes', () => {
  const candidateWithHelper = candidate({});

  it('accepts a complete plan: fresh Registration Confirmation + every Installation outcome + Activation Confirmation for enabled updates', () => {
    const inst = existingInstallation(`${REG_ID}/acme-marketplace/release-helper`);
    const result = buildUpdatePlan(candidateWithHelper, [inst], '7', {
      registrationConfirmed: true,
      choices: { [inst.id]: 'update' },
      activationConfirmations: { [inst.id]: true },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.stateRevision).toBe('7');
    expect(result.plan.entries).toHaveLength(1);
    expect(result.plan.entries[0].choice).toBe('update');
    // Updated Installations bind the same activation-bound snapshot a fresh install would receive.
    expect(result.plan.entries[0].newSnapshot?.fingerprint).toBe('activation-bound-fingerprint');
    expect(result.plan.candidate.snapshot.fingerprint).toBe('new-snapshot-fingerprint');
  });

  it('rejects the plan when Registration Confirmation is missing (fresh consent is mandatory)', () => {
    const inst = existingInstallation(`${REG_ID}/acme-marketplace/release-helper`, 'disabled');
    const result = buildUpdatePlan(candidateWithHelper, [inst], '7', {
      registrationConfirmed: false,
      choices: { [inst.id]: 'disable' },
      activationConfirmations: {},
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.some((p) => p.rule === 'UPD-01' && /Registration Confirmation/.test(p.outcome))).toBe(true);
  });

  it('rejects the plan when any Installation lacks an explicit update/disable/remove outcome', () => {
    const a = existingInstallation(`${REG_ID}/acme-marketplace/release-helper`);
    const b = existingInstallation(`${REG_ID}/acme-marketplace/other`);
    const candidates = candidate({ plugins: [plugin(`${REG_ID}/acme-marketplace/release-helper`), plugin(`${REG_ID}/acme-marketplace/other`)] });
    const result = buildUpdatePlan(candidates, [a, b], '7', {
      registrationConfirmed: true,
      choices: { [a.id]: 'update' },
      activationConfirmations: { [a.id]: true },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.some((p) => p.target === 'installation' && p.pointer === b.id)).toBe(true);
  });

  it('forces disable or remove for an Installation without a Compatible candidate in the new snapshot', () => {
    const gone = existingInstallation(`${REG_ID}/acme-marketplace/deprecated`);
    const asUpdate = buildUpdatePlan(candidateWithHelper, [gone], '7', {
      registrationConfirmed: true,
      choices: { [gone.id]: 'update' },
      activationConfirmations: {},
    });
    expect(asUpdate.ok).toBe(false);

    const asDisable = buildUpdatePlan(candidateWithHelper, [gone], '7', {
      registrationConfirmed: true,
      choices: { [gone.id]: 'disable' },
      activationConfirmations: {},
    });
    expect(asDisable.ok).toBe(true);
  });

  it('requires Activation Confirmation for each enabled Installation that remains enabled; disabled ones need none', () => {
    const enabled = existingInstallation(`${REG_ID}/acme-marketplace/release-helper`, 'enabled');
    const noConsent = buildUpdatePlan(candidateWithHelper, [enabled], '7', {
      registrationConfirmed: true,
      choices: { [enabled.id]: 'update' },
      activationConfirmations: {},
    });
    expect(noConsent.ok).toBe(false);

    const disabled = existingInstallation(`${REG_ID}/acme-marketplace/release-helper`, 'disabled');
    const disabledUpdate = buildUpdatePlan(candidateWithHelper, [disabled], '7', {
      registrationConfirmed: true,
      choices: { [disabled.id]: 'update' },
      activationConfirmations: {},
    });
    expect(disabledUpdate.ok).toBe(true);
    if (!disabledUpdate.ok) return;
    expect(disabledUpdate.plan.entries[0].installationState).toBe('disabled');
  });

  it('binds updated Installations to their new Marketplace Entry pointer and keeps removals explicit', () => {
    const keep = existingInstallation(`${REG_ID}/acme-marketplace/release-helper`);
    const drop = existingInstallation(`${REG_ID}/acme-marketplace/legacy`);
    const candidates = candidate({ plugins: [plugin(`${REG_ID}/acme-marketplace/release-helper`)] });
    const result = buildUpdatePlan(candidates, [keep, drop], '9', {
      registrationConfirmed: true,
      choices: { [keep.id]: 'update', [drop.id]: 'remove' },
      activationConfirmations: { [keep.id]: true },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.entries.find((entry) => entry.installationId === keep.id)?.choice).toBe('update');
    expect(result.plan.entries.find((entry) => entry.installationId === drop.id)?.choice).toBe('remove');
  });

  it('records that prior activation consent never carries over by requiring per-plan confirmations only', () => {
    // A disabled installation choosing 'disable' needs neither activation nor re-consent beyond the plan.
    const disabled = existingInstallation(`${REG_ID}/acme-marketplace/release-helper`, 'disabled');
    const result = buildUpdatePlan(candidateWithHelper, [disabled], '7', {
      registrationConfirmed: true,
      choices: { [disabled.id]: 'disable' },
      activationConfirmations: {},
    });
    expect(result.ok).toBe(true);
  });

  it('exposes the registration identity preserved through the plan (Rebind keeps Registration ID)', () => {
    const inst = existingInstallation(`${REG_ID}/acme-marketplace/release-helper`, 'disabled');
    const result = buildUpdatePlan(candidateWithHelper, [inst], '3', {
      registrationConfirmed: true,
      kind: 'rebind',
      rebindSource: { sourceKind: 'local', source: '/tmp/marketplace-v2', sourceKey: candidateWithHelper.sourceKey },
      choices: { [inst.id]: 'disable' },
      activationConfirmations: {},
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.kind).toBe('rebind');
    expect(result.plan.registrationId).toBe(REG_ID);
  });
});
