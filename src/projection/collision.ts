/**
 * Runtime Skill Collision — resolution over Pi's flat skill namespace by exact
 * Skill Descriptor name. See CONTEXT.md: Runtime Skill Collision, Projected Skill.
 *
 * Pure and skill-granular only: the result never changes Plugin classification or
 * Projected Plugin determination. Candidates resolve per exact name in
 * `Pi → Project Scope → Global Scope` order; all same-scope Bridge colliders are
 * unavailable; only a surviving higher-layer skill reserves the name, so a lower-layer
 * candidate survives whenever no higher-layer skill does.
 */

export type CollisionLayer = 'pi' | 'project' | 'global';

export interface SkillCandidate {
  /** Namespace layer the candidate comes from. */
  layer: CollisionLayer;
  /** Exact Skill Descriptor name (the contested flat-namespace key). */
  name: string;
  /** Canonical Skill ID = Plugin ID + descriptor name. */
  skillId: string;
  pluginId: string;
}

/** Skill-granular denial record for one contested exact name. */
export interface SkillCollisionFindingInfo {
  name: string;
  /** Skill IDs denied because they collide within their own scope layer. */
  unavailableSkillIds: string[];
  /** The surviving candidate that reserves the name, when one exists. */
  reservedBy?: { layer: CollisionLayer; skillId: string };
}

export interface CollisionResolution {
  survivors: SkillCandidate[];
  findings: SkillCollisionFindingInfo[];
}

function dedupeBySkillId(candidates: SkillCandidate[]): SkillCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((item) => {
    if (seen.has(item.skillId)) return false;
    seen.add(item.skillId);
    return true;
  });
}

/**
 * Resolve every exact-name group independently under the layered rules.
 * Pre-existing Pi skills are host-owned: a Pi-layer claim reserves the name for all
 * Bridge candidates, and Pi-vs-Pi duplicates are outside Bridge adjudication.
 */
export function resolveRuntimeSkillCollisions(candidates: SkillCandidate[]): CollisionResolution {
  const byName = new Map<string, SkillCandidate[]>();
  for (const item of candidates) {
    const group = byName.get(item.name);
    if (group) group.push(item);
    else byName.set(item.name, [item]);
  }

  const survivors: SkillCandidate[] = [];
  const findings: SkillCollisionFindingInfo[] = [];

  for (const [name, group] of [...byName.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const bridge = group.filter((item) => item.layer !== 'pi');
    const piClaims = group.some((item) => item.layer === 'pi');

    if (piClaims) {
      // Only a surviving higher-layer skill reserves the name — the Pi layer does here.
      // Every Bridge candidate below is denied at skill granularity.
      const piSurvivors = group.filter((item) => item.layer === 'pi');
      if (bridge.length > 0) {
        findings.push({
          name,
          unavailableSkillIds: bridge.map((item) => item.skillId).sort((a, b) => a.localeCompare(b)),
          reservedBy: piSurvivors[0] ? { layer: 'pi', skillId: piSurvivors[0].skillId } : undefined,
        });
      }
      survivors.push(...piSurvivors);
      continue;
    }

    let denied: string[] = [];
    let reservedByLowerLayer = false;

    const projectCandidates = dedupeBySkillId(group.filter((item) => item.layer === 'project'));
    const globalCandidates = dedupeBySkillId(group.filter((item) => item.layer === 'global'));

    if (projectCandidates.length > 1) {
      // All same-scope Bridge colliders are unavailable; nobody reserves the name,
      // so lower-layer candidates survive.
      denied.push(...projectCandidates.map((item) => item.skillId));
      reservedByLowerLayer = true;
    } else if (projectCandidates.length === 1) {
      survivors.push(projectCandidates[0]!);
      if (globalCandidates.length > 0) {
        findings.push({
          name,
          unavailableSkillIds: globalCandidates.map((item) => item.skillId).sort((a, b) => a.localeCompare(b)),
          reservedBy: { layer: 'project', skillId: projectCandidates[0]!.skillId },
        });
      }
      continue;
    }

    if (reservedByLowerLayer || projectCandidates.length === 0) {
      const survivingGlobal = dedupeBySkillId(globalCandidates);
      if (survivingGlobal.length > 1) {
        denied.push(...survivingGlobal.map((item) => item.skillId));
      } else {
        survivors.push(...survivingGlobal);
      }
    }

    if (denied.length > 0) {
      findings.push({ name, unavailableSkillIds: [...new Set(denied)].sort((a, b) => a.localeCompare(b)) });
    }
  }

  return { survivors, findings };
}
