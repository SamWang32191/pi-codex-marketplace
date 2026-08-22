/**
 * TUI listing helpers for Scope Override management.
 * Acceptance (#20): the listing clearly marks suppressed records and their effective sources.
 */

import { describe, expect, it } from 'vitest';

import { createEmptyState, type BridgeState } from '../../../src/bridge-state/types.js';
import { inheritedRecordRows } from '../../../extensions/pi/scope-overrides.js';

function withState(patch: Partial<BridgeState>): BridgeState {
  return { ...createEmptyState(), ...patch };
}

const REG_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const REG_B = 'aaaaaaaa-2222-4222-8222-222222222222';

describe('inherited record listing', () => {
  const global = withState({
    registrations: [
      { id: REG_A, alias: 'acme', sourceKind: 'local', source: '/sources/a' },
      { id: REG_B, alias: 'beta', sourceKind: 'local', source: '/sources/b' },
    ],
    installations: [
      { id: 'global/acme/one', pluginId: 'acme/one', installationState: 'enabled', registrationId: REG_A },
      { id: 'global/acme/two', pluginId: 'acme/two', installationState: 'disabled', registrationId: REG_A },
    ],
  });

  it('marks records suppressed by an override and leaves effective sources unmarked', () => {
    const project = withState({ scopeOverrides: [{ kind: 'registration', targetId: REG_B }] });
    const rows = inheritedRecordRows(global, project, true);

    const regA = rows.find((row) => row.targetId === REG_A)!;
    const regB = rows.find((row) => row.targetId === REG_B)!;
    expect(regA.suppressedByOverride).toBe(false);
    expect(regB.suppressedByOverride).toBe(true);
    expect(regB.label).toContain('已抑制');
    expect(regA.label).not.toContain('已抑制');
  });

  it('suppressing a Registration marks its subtree installations as inherited-subtree suppressed', () => {
    const project = withState({ scopeOverrides: [{ kind: 'registration', targetId: REG_A }] });
    const rows = inheritedRecordRows(global, project, true);
    const installOne = rows.find((row) => row.targetId === 'global/acme/one')!;
    expect(installOne.suppressedByOverride).toBe(true);
    expect(installOne.label).toContain('子樹');
  });

  it('never lists disabled installations — only enabled Installations participate', () => {
    const rows = inheritedRecordRows(global, createEmptyState(), true);
    expect(rows.filter((row) => row.kind === 'installation').map((row) => row.targetId)).toEqual(['global/acme/one']);
  });

  it('marks precedence-superseded installations without calling them override-suppressed', () => {
    const project = withState({
      registrations: [{ id: 'bbbbbbbb-3333-4333-8333-333333333333', sourceKind: 'local' }],
      installations: [{ id: 'project/acme/one', pluginId: 'acme/one', installationState: 'enabled' }],
    });
    const rows = inheritedRecordRows(global, project, true);
    const installOne = rows.find((row) => row.targetId === 'global/acme/one')!;
    expect(installOne.supersededByProject).toBe(true);
    expect(installOne.suppressedByOverride).toBe(false);
    expect(installOne.label).toContain('優先取代');
  });
});
