/**
 * Runtime Skill Collision resolution — pure behavior over exact Skill Descriptor names.
 * See CONTEXT.md: Runtime Skill Collision, Projected Skill, Compatible Plugin.
 *
 * Candidates resolve per name in `Pi → Project Scope → Global Scope` order; all same-scope
 * Bridge colliders are unavailable; only a surviving higher-layer skill reserves the name;
 * a lower-layer candidate survives when no higher-layer skill does.
 */

import { describe, expect, it } from 'vitest';

import { resolveRuntimeSkillCollisions, type SkillCandidate } from '../../../src/projection/collision.js';

function candidate(layer: SkillCandidate['layer'], pluginId: string, name: string): SkillCandidate {
  return { layer, name, skillId: `${pluginId}/${name}`, pluginId };
}

describe('Runtime Skill Collision — layering', () => {
  it('a pre-existing Pi skill reserves the name; every Bridge candidate for it is unavailable', () => {
    const resolution = resolveRuntimeSkillCollisions([
      candidate('pi', '(pi)', 'deploy'),
      candidate('project', 'proj/one', 'deploy'),
      candidate('global', 'glob/two', 'deploy'),
    ]);
    expect(resolution.survivors.map((s) => s.layer)).toEqual(['pi']);
    const denied = resolution.findings.flatMap((f) => f.unavailableSkillIds).sort();
    expect(denied).toEqual(['glob/two/deploy', 'proj/one/deploy'].sort());
  });

  it('a surviving Project Scope skill reserves the name over Global Scope candidates', () => {
    const resolution = resolveRuntimeSkillCollisions([
      candidate('project', 'proj/one', 'lint'),
      candidate('global', 'glob/two', 'lint'),
    ]);
    expect(resolution.survivors.map((s) => s.skillId)).toEqual(['proj/one/lint']);
    expect(resolution.findings[0]?.unavailableSkillIds).toEqual(['glob/two/lint']);
  });

  it('same-scope Bridge colliders are ALL unavailable and the name stays free for the lower layer', () => {
    const resolution = resolveRuntimeSkillCollisions([
      candidate('project', 'proj/one', 'review'),
      candidate('project', 'proj/two', 'review'),
      candidate('global', 'glob/three', 'review'),
    ]);
    // both project colliders denied — no higher-layer survivor reserves the name
    expect(resolution.survivors.map((s) => s.skillId)).toEqual(['glob/three/review']);
    expect(resolution.findings[0]?.unavailableSkillIds.sort()).toEqual(['proj/one/review', 'proj/two/review'].sort());
  });

  it('same-scope colliders in Global Scope are all unavailable with nothing surviving', () => {
    const resolution = resolveRuntimeSkillCollisions([
      candidate('global', 'glob/one', 'format'),
      candidate('global', 'glob/two', 'format'),
    ]);
    expect(resolution.survivors).toEqual([]);
    expect(resolution.findings[0]?.unavailableSkillIds.sort()).toEqual(['glob/one/format', 'glob/two/format'].sort());
  });

  it('a lower-layer candidate survives when no higher-layer competition exists', () => {
    const resolution = resolveRuntimeSkillCollisions([
      candidate('project', 'proj/one', 'unique-a'),
      candidate('global', 'glob/two', 'unique-b'),
    ]);
    expect(resolution.survivors.map((s) => s.skillId).sort()).toEqual(['glob/two/unique-b', 'proj/one/unique-a'].sort());
    expect(resolution.findings).toEqual([]);
  });
});

describe('Runtime Skill Collision — closed semantics', () => {
  it('never denies a whole Plugin: findings stay at skill granularity', () => {
    const resolution = resolveRuntimeSkillCollisions([
      candidate('project', 'proj/one', 'contested'),
      candidate('project', 'proj/two', 'contested'),
    ]);
    for (const finding of resolution.findings) {
      expect(finding.name).toBe('contested');
      expect(finding.unavailableSkillIds.length).toBeGreaterThan(0);
      expect(finding.reservedBy).toBeUndefined();
    }
  });

  it('treats identical candidates as one claim rather than a collision', () => {
    const duplicate = candidate('project', 'proj/one', 'same');
    const resolution = resolveRuntimeSkillCollisions([duplicate, { ...duplicate }]);
    expect(resolution.survivors.map((s) => s.skillId)).toEqual(['proj/one/same']);
    expect(resolution.findings).toEqual([]);
  });

  it('resolves each exact name independently', () => {
    const resolution = resolveRuntimeSkillCollisions([
      candidate('project', 'proj/one', 'alpha'),
      candidate('global', 'glob/two', 'beta'),
    ]);
    expect(resolution.survivors).toHaveLength(2);
  });
});
