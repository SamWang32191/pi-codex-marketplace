import { describe, expect, it } from 'vitest';

import type { Scope } from '../../../src/bridge-state/types.js';
import type { UpdateCandidate } from '../../../src/lifecycle/refresh.js';
import { candidateSummary, planChoicesFor } from '../../../extensions/pi/lifecycle.js';
import type { CompatiblePlugin } from '../../../src/compatibility/profile.js';

const SCOPE: Scope = 'global';
const REG_ID = '11111111-1111-4111-8111-111111111111';
const MARKET_ID = `${REG_ID}/acme-marketplace`;

function plugin(name: string): CompatiblePlugin {
  return { id: `${MARKET_ID}/${name}`, manifestName: name, marketplaceEntryId: `${MARKET_ID}/plugins/0`, skills: [] };
}

function candidateWith(entries: { plugin?: CompatiblePlugin; unavailableReason?: string }[]): UpdateCandidate {
  return {
    scope: SCOPE,
    registrationId: REG_ID,
    stateRevision: '7',
    recordedFingerprint: 'a'.repeat(64),
    snapshot: {
      fingerprint: 'b'.repeat(64),
      scope: SCOPE,
      entries: [],
      sourceKey: { kind: 'local', key: 'k', canonicalPath: '/tmp/m' },
      profile: 'p',
      ruleset: 'r',
      budget: 'b',
    },
    marketplaceName: 'acme-marketplace',
    catalog: { name: 'acme-marketplace', entries: [] },
    inspection: {
      entries: entries.map((item, index) => ({
        entry: { entryId: `/plugins/${index}`, ordinal: index, type: 'local' as const, available: !item.unavailableReason },
        plugin: item.plugin,
        findings: [],
        unavailableReason: item.unavailableReason,
      })),
      findings: [],
      marketplaceId: MARKET_ID,
    },
    sourceKey: { kind: 'local', key: 'k', canonicalPath: '/tmp/m' },
  };
}

describe('Update Plan Checklist TUI helpers', () => {
  it("offers 'update' only when a Compatible candidate exists; disable/remove always selectable", () => {
    const kept = plugin('kept');
    const candidate = candidateWith([
      { plugin: kept },
      { unavailableReason: 'incompatible' },
    ]);
    const installations = [
      { id: `global/${kept.id}`, pluginId: kept.id, installationState: 'enabled' as const },
      { id: 'global/gone', pluginId: `${MARKET_ID}/gone`, installationState: 'disabled' as const },
    ];
    const result = planChoicesFor(installations, candidate);
    expect(result).toHaveLength(2);
    const updateForKept = result[0]!.options.find((o) => o.value === 'update')!;
    expect(updateForKept.enabled).toBe(true);
    const updateForGone = result[1]!.options.find((o) => o.value === 'update')!;
    expect(updateForGone.enabled).toBe(false);
    for (const entry of result) {
      for (const value of ['disable', 'remove'] as const) {
        expect(entry.options.find((o) => o.value === value)?.enabled).toBe(true);
      }
    }
  });

  it('renders a candidate summary disclosing scope, both fingerprints, revision movement, and per-entry availability', () => {
    const candidate = candidateWith([{ plugin: plugin('kept') }, { unavailableReason: 'invalid manifest' }]);
    candidate.resolvedRevision = 'c'.repeat(40);
    candidate.recordedResolvedRevision = 'd'.repeat(40);
    const summary = candidateSummary(candidate);
    expect(summary).toContain('Scope: global');
    expect(summary).toContain('b'.repeat(16));
    expect(summary).toContain('aaaa');
    expect(summary).toContain('cccc');
    expect(summary).toContain('/plugins/0');
    expect(summary).toContain('unavailable (invalid manifest)');
    // Marketplace-controlled text is quoted so values cannot forge disclosure lines.
    expect(summary).toContain('"kept"');
  });
});
