/**
 * Runtime Skill Collision resolution — pure behavior over exact Skill Descriptor names.
 * See CONTEXT.md: Runtime Skill Collision, Projected Skill, Compatible Plugin.
 *
 * Candidates resolve per name in `Pi → Global` order; all same-layer Bridge colliders are
 * unavailable; a Pi-layer skill reserves the name; a Global candidate survives whenever no
 * Pi skill claims the name.
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
      candidate('global', 'glob/two', 'deploy'),
    ]);
    expect(resolution.survivors.map((s) => s.layer)).toEqual(['pi']);
    const denied = resolution.findings.flatMap((f) => f.unavailableSkillIds).sort();
    expect(denied).toEqual(['glob/two/deploy'].sort());
    expect(resolution.findings[0]?.reservedBy?.layer).toBe('pi');
  });

  it('same-layer Bridge colliders in Global are ALL unavailable with nothing surviving', () => {
    const resolution = resolveRuntimeSkillCollisions([
      candidate('global', 'glob/one', 'format'),
      candidate('global', 'glob/two', 'format'),
    ]);
    expect(resolution.survivors).toEqual([]);
    expect(resolution.findings[0]?.unavailableSkillIds.sort()).toEqual(['glob/one/format', 'glob/two/format'].sort());
  });

  it('a lone Global candidate survives when no Pi competition exists', () => {
    const resolution = resolveRuntimeSkillCollisions([
      candidate('global', 'glob/two', 'unique-b'),
    ]);
    expect(resolution.survivors.map((s) => s.skillId)).toEqual(['glob/two/unique-b']);
    expect(resolution.findings).toEqual([]);
  });

  it('Pi-vs-Pi duplicates stay outside Bridge adjudication: only the Pi survivors survive', () => {
    const resolution = resolveRuntimeSkillCollisions([
      candidate('pi', '(pi)', 'dup'),
      candidate('pi', '(pi-2)', 'dup'),
      candidate('global', 'glob/two', 'dup'),
    ]);
    expect(resolution.survivors.map((s) => s.layer)).toEqual(['pi', 'pi']);
    expect(resolution.findings[0]?.unavailableSkillIds).toEqual(['glob/two/dup']);
  });
});

describe('Runtime Skill Collision — closed semantics', () => {
  it('never denies a whole Plugin: findings stay at skill granularity', () => {
    const resolution = resolveRuntimeSkillCollisions([
      candidate('global', 'glob/one', 'contested'),
      candidate('global', 'glob/two', 'contested'),
    ]);
    for (const finding of resolution.findings) {
      expect(finding.name).toBe('contested');
      expect(finding.unavailableSkillIds.length).toBeGreaterThan(0);
      expect(finding.reservedBy).toBeUndefined();
    }
  });

  it('treats identical candidates as one claim rather than a collision', () => {
    const duplicate = candidate('global', 'glob/one', 'same');
    const resolution = resolveRuntimeSkillCollisions([duplicate, { ...duplicate }]);
    expect(resolution.survivors.map((s) => s.skillId)).toEqual(['glob/one/same']);
    expect(resolution.findings).toEqual([]);
  });

  it('resolves each exact name independently', () => {
    const resolution = resolveRuntimeSkillCollisions([
      candidate('pi', '(pi)', 'alpha'),
      candidate('global', 'glob/one', 'beta'),
      candidate('global', 'glob/two', 'gamma'),
    ]);
    // alpha: pi reserves, no bridge candidates. beta/gamma: distinct names survive.
    expect(resolution.survivors.map((s) => s.skillId).sort()).toEqual(['(pi)/alpha', 'glob/one/beta', 'glob/two/gamma'].sort());
    expect(resolution.findings).toEqual([]);
  });
});
