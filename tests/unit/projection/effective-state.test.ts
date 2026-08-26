/**
 * Effective State computation — pure read-time behavior.
 * See CONTEXT.md: Effective State, Installed Plugin, Installation State.
 *
 * Only external observable behavior is asserted: which records participate
 * and that persisted provenance of selected records is never mutated.
 *
 * Global-only (#61): the Effective State is computed directly from the single Global document;
 * disabled Installations stay durable but never participate.
 */

import { describe, expect, it } from 'vitest';

import {
  computeEffectiveState,
} from '../../../src/projection/effective-state.js';
import { createEmptyState, type BridgeState } from '../../../src/bridge-state/types.js';

function withState(patch: Partial<BridgeState>): BridgeState {
  return { ...createEmptyState(), ...patch };
}

const REG = 'aaaaaaaa-1111-4111-8111-111111111111';
const REG_2 = 'aaaaaaaa-2222-4222-8222-222222222222';

function registration(id: string, extra: Record<string, unknown> = {}): BridgeState['registrations'][number] {
  return { id, alias: `alias-${id.slice(0, 6)}`, sourceKind: 'local', source: `/sources/${id}`, ...extra };
}

function installation(id: string, pluginId: string, opts: { state?: 'enabled' | 'disabled'; registrationId?: string; snapshot?: string } = {}): BridgeState['installations'][number] {
  return {
    id,
    pluginId,
    installationState: opts.state ?? 'enabled',
    registrationId: opts.registrationId,
    validationSnapshot: opts.snapshot,
  };
}

describe('Effective State — participation', () => {
  it('admits registrations and enabled installations from the Global document', () => {
    const state = withState({
      registrations: [registration(REG)],
      installations: [
        installation('acme-marketplace/alpha', 'aaaa…/alpha', { registrationId: REG }),
      ],
    });
    const effective = computeEffectiveState(state);
    expect(effective.registrations.map((r) => r.id)).toEqual([REG]);
    expect(effective.installations.map((i) => i.pluginId)).toEqual(['aaaa…/alpha']);
  });

  it('excludes disabled installations — only enabled Installations participate', () => {
    const state = withState({
      registrations: [registration(REG)],
      installations: [
        installation('x/enabled-one', 'x/enabled-one', { registrationId: REG }),
        installation('x/disabled-one', 'x/disabled-one', { state: 'disabled', registrationId: REG }),
      ],
    });
    const effective = computeEffectiveState(state);
    expect(effective.installations.map((i) => i.pluginId)).toEqual(['x/enabled-one']);
  });

  it('an empty document computes an empty Effective State', () => {
    const effective = computeEffectiveState(createEmptyState());
    expect(effective.registrations).toEqual([]);
    expect(effective.installations).toEqual([]);
  });

  it('never mutates the input state', () => {
    const state = withState({
      registrations: [registration(REG)],
      installations: [installation('acme/alpha', 'acme/alpha', { registrationId: REG })],
    });
    const snapshot = JSON.parse(JSON.stringify(state));
    computeEffectiveState(state);
    expect(state).toEqual(snapshot);
  });
});

describe('Effective State — retired scope dimensions (Global-only)', () => {
  const installA = installation('reg-a/one', 'reg-a/one', { registrationId: REG });
  const installB = installation('reg-a/two', 'reg-a/two', { registrationId: REG });
  const otherInstall = installation('reg-b/keep', 'reg-b/keep', { registrationId: REG_2 });

  const populated = withState({
    registrations: [registration(REG), registration(REG_2)],
    installations: [installA, installB, otherInstall],
  });

  it('legacy persisted overrides are ignored entirely — records always participate', () => {
    const legacy = withState({
      scopeOverrides: [
        { kind: 'registration', targetId: REG },
        { kind: 'installation', targetId: 'reg-b/keep' },
      ],
    } as any);
    const effective = computeEffectiveState(legacy);
    expect(effective.registrations).toEqual([]);
    // Overrides carry no records themselves; nothing is suppressed or excluded.
  });

  it('a document whose only difference is its legacy overrides computes the identical Effective State', () => {
    const plain = computeEffectiveState(populated);
    const withLegacy = computeEffectiveState(
      withState({
        registrations: populated.registrations,
        installations: populated.installations,
        scopeOverrides: [{ kind: 'registration', targetId: REG_2 }],
      } as any),
    );
    expect(withLegacy).toEqual(plain);
  });

  it('every record carries exactly what its own entry holds — no merged provenance', () => {
    const state = withState({
      registrations: [{ ...registration(REG), validationSnapshot: 'snap-a' }, { ...registration(REG_2), validationSnapshot: 'snap-b' }],
      installations: [],
    });
    const effective = computeEffectiveState(state);
    expect(effective.registrations.find((r) => r.id === REG)!.validationSnapshot).toBe('snap-a');
    expect(effective.registrations.find((r) => r.id === REG_2)!.validationSnapshot).toBe('snap-b');
  });
});
