/**
 * Projection — admits Effective State Installations as Projected Plugins and exposes their
 * surviving skills to Pi through Pi's resource-discovery seam at their original snapshot paths.
 * See CONTEXT.md: Projected Plugin, Projected Skill, Runtime Skill Collision, Source Drift,
 * Skill Availability, Runtime Application.
 *
 * Whole-Plugin Blocking Findings (Source Drift, Unavailable Entry, failed classification)
 * deny an entire Plugin; Runtime Skill Collision denies only individual skill candidates and
 * never changes Plugin classification or Projected Plugin determination. Skills are projected
 * directly from the retained snapshot tree — never copied or converted — while the Bridge holds
 * provenance. Only independent host evidence may establish Skill Availability as Available,
 * and a host-verifiable reload through Bridge re-entry is what makes a Runtime Application
 * Applied.
 */

import { loadSkillsFromDir } from '@earendil-works/pi-coding-agent';

import type { BridgeState } from '../bridge-state/types.js';
import {
  computeEffectiveState,
  type EffectiveInstallation,
  type EffectiveRegistration,
} from './effective-state.js';
import {
  resolveRuntimeSkillCollisions,
  type CollisionResolution,
  type SkillCandidate,
} from './collision.js';
import { inspectMarketplaceEntries, type MarketplaceInspection } from '../installation/inspection.js';
import { CODE, RULE, blocking, sortFindings, type ValidationFinding } from '../registration/findings.js';
import { createReceipt, type AttemptReceipt } from '../registration/receipt.js';

export interface ProjectionOptions {
  cwd?: string;
  agentDir?: string;
  projectTrusted?: boolean;
  /** Exact names already claimed by pre-existing Pi skills (host-owned namespace layer). */
  piSkillNames?: string[];
  /** Injection seam for tests; defaults to live local-source inspection. */
  inspectRegistration?: (registration: EffectiveRegistration) => MarketplaceInspection;
  /** Independent host evidence establishing Skill Availability as Available. */
  hostAvailabilityEvidence?: (skillName: string) => boolean;
}

export type SkillAvailability = 'available' | 'snapshot-eligible' | 'unverified' | 'unavailable';

export interface ProjectedSkillView {
  name: string;
  skillId: string;
  pluginId: string;
  status: 'projected' | 'unavailable-collision';
  availability: SkillAvailability;
  /** Original snapshot location of SKILL.md exposed through Pi discovery (no copy). */
  discoveryPath?: string;
}

export interface ProjectedPluginView {
  pluginId: string;
  manifestName?: string;
  installationId: string;
  registrationId?: string;
  sourceScope: 'global' | 'project';
  skills: ProjectedSkillView[];
}

export interface DeniedPluginView {
  installationId: string;
  pluginId?: string;
  /** Whole-Plugin blocking denial; never a skill-granular collision. */
  reason: ValidationFinding;
}

export interface ProjectionResult {
  plugins: ProjectedPluginView[];
  denied: DeniedPluginView[];
  /** Skill-granular collision denials only; whole-plugin denials live in `denied`. */
  findings: ValidationFinding[];
}

function driftFinding(scope: 'global' | 'project'): ValidationFinding {
  return blocking({
    code: CODE.REJECTED_AS_STALE,
    rule: RULE.REJECTED_AS_STALE_SNAPSHOT,
    target: 'registration',
    pointer: '',
    outcome: 'Source Drift: the registered Validation Snapshot no longer matches the source tree; affected Installations cannot become Projected Plugins until Marketplace Refresh produces an Update Candidate',
    scope,
    phase: 'validation',
  });
}

function collisionFinding(scope: 'global' | 'project', skillId: string): ValidationFinding {
  return blocking({
    code: CODE.RUNTIME_SKILL_COLLISION,
    rule: RULE.RUNTIME_SKILL_COLLISION,
    target: 'skill',
    pointer: skillId,
    outcome: `Runtime Skill Collision: skill '${skillId}' is unavailable because another candidate claims this exact Skill Descriptor name`,
    scope,
    phase: 'validation',
  });
}

/**
 * Compute the projection of one Effective State. Read-only: it never mutates either Bridge
 * State document and never persists anything.
 */
export function projectEffectiveState(
  globalState: BridgeState,
  projectState: BridgeState,
  opts: ProjectionOptions = {},
): ProjectionResult {
  const effective = computeEffectiveState(globalState, projectState, { projectTrusted: opts.projectTrusted });
  const denied: DeniedPluginView[] = [];
  const findings: ValidationFinding[] = [];

  const inspections = new Map<string, MarketplaceInspection>();
  const inspect = opts.inspectRegistration ?? ((registration: EffectiveRegistration) => inspectMarketplaceEntries(registration, registration.sourceScope));
  const inspectionFor = (registration: EffectiveRegistration): MarketplaceInspection => {
    const key = `${registration.sourceScope}:${registration.id}`;
    let value = inspections.get(key);
    if (!value) {
      value = inspect(registration);
      inspections.set(key, value);
    }
    return value;
  };

  interface AdmittedPlugin {
    pluginId: string;
    manifestName?: string;
    installationId: string;
    registrationId?: string;
    sourceScope: 'global' | 'project';
    skills: Array<{ name: string; skillId: string; path: string }>;
  }
  const admitted: AdmittedPlugin[] = [];

  for (const installation of effective.installations) {
    const deny = (pluginId: string | undefined, reason: ValidationFinding): void => {
      denied.push({ installationId: installation.id, pluginId, reason });
    };
    const registration = effective.registrations.find(
      (item) => item.id === installation.registrationId && item.sourceScope === installation.sourceScope,
    );
    if (!installation.registrationId || !registration) {
      deny(installation.pluginId, blocking({
        code: CODE.INSTALLATION_NOT_FOUND,
        rule: RULE.INSTALLATION_NOT_FOUND,
        target: 'installation',
        pointer: '',
        outcome: `Installation '${installation.id}' references Registration '${installation.registrationId ?? '?'}' which is not part of Effective State`,
        scope: installation.sourceScope,
        phase: 'validation',
      }));
      continue;
    }
    const inspection = inspectionFor(registration);
    // Source Drift: recorded snapshot no longer matches the live tree — fail closed.
    // Registrations persist the base tree fingerprint; prefer it when the inspector exposes it.
    const currentTreeFingerprint = inspection.treeFingerprint ?? inspection.snapshot?.fingerprint;
    if (registration.validationSnapshot && currentTreeFingerprint !== registration.validationSnapshot) {
      deny(installation.pluginId, driftFinding(installation.sourceScope));
      continue;
    }
    const entryPointer = installation.marketplaceEntryId
      ? installation.marketplaceEntryId.slice(installation.marketplaceEntryId.indexOf('/plugins/'))
      : undefined;
    const inspected = inspection.entries.find((item) =>
      entryPointer !== undefined && `${inspection.marketplaceId}${item.entry.entryId}` === installation.marketplaceEntryId,
    );
    if (!inspection.marketplaceId || !inspected) {
      deny(installation.pluginId, blocking({
        code: CODE.INSTALLATION_NOT_FOUND,
        rule: RULE.INSTALLATION_NOT_FOUND,
        target: 'entry',
        pointer: installation.marketplaceEntryId ?? '',
        outcome: `Installed Plugin '${installation.id}' cannot be resolved to its Marketplace Entry in the current snapshot`,
        scope: installation.sourceScope,
        phase: 'validation',
      }));
      continue;
    }
    // Whole-Plugin admission: any Whole-Plugin Blocking Finding denies the entire Plugin.
    if (inspected.unavailableReason || !inspected.plugin || inspected.findings.some((f) => f.classification === 'blocking')) {
      deny(installation.pluginId, inspected.findings.find((f) => f.classification === 'blocking') ?? blocking({
        code: CODE.PLUGIN_MANIFEST_INVALID,
        rule: RULE.PLUGIN_MANIFEST_INVALID,
        target: 'plugin',
        pointer: '',
        outcome: inspected.unavailableReason ?? 'Plugin is not activatable',
        scope: installation.sourceScope,
        phase: 'validation',
      }));
      continue;
    }
    admitted.push({
      pluginId: inspected.plugin.id,
      manifestName: inspected.plugin.manifestName,
      installationId: installation.id,
      registrationId: registration.id,
      sourceScope: installation.sourceScope,
      skills: inspected.plugin.skills.map((skill) => ({
        name: skill.name,
        skillId: `${inspected.plugin!.id}/${skill.name}`,
        path: joinPath(skill.path, 'SKILL.md'),
      })),
    });
  }

  // Runtime Skill Collision resolution across Pi → Project Scope → Global Scope.
  const candidates: SkillCandidate[] = [
    ...(opts.piSkillNames ?? []).map((name): SkillCandidate => ({ layer: 'pi', name, skillId: `pi/${name}`, pluginId: '(pi)' })),
    ...admitted.flatMap((plugin): SkillCandidate[] => plugin.skills.map((skill) => ({
      layer: plugin.sourceScope,
      name: skill.name,
      skillId: skill.skillId,
      pluginId: plugin.pluginId,
    }))),
  ];
  const resolution: CollisionResolution = resolveRuntimeSkillCollisions(candidates);
  const survivedIds = new Set(resolution.survivors.map((s) => s.skillId));
  for (const info of resolution.findings) {
    for (const skillId of info.unavailableSkillIds) {
      const owner = admitted.find((plugin) => plugin.skills.some((skill) => skill.skillId === skillId));
      if (owner) findings.push(collisionFinding(owner.sourceScope, skillId));
    }
  }

  const plugins: ProjectedPluginView[] = admitted.map((plugin) => ({
    pluginId: plugin.pluginId,
    manifestName: plugin.manifestName,
    installationId: plugin.installationId,
    registrationId: plugin.registrationId,
    sourceScope: plugin.sourceScope,
    skills: plugin.skills.map((skill): ProjectedSkillView => {
      if (!survivedIds.has(skill.skillId)) {
        return { name: skill.name, skillId: skill.skillId, pluginId: plugin.pluginId, status: 'unavailable-collision', availability: 'unavailable' };
      }
      // Pi resource-discovery seam: expose the skill at its original snapshot path.
      let discoveryPath: string | undefined;
      try {
        const loaded = loadSkillsFromDir({ dir: dirnamePath(skill.path), source: `codex-marketplace:${plugin.pluginId}` });
        const match = loaded.skills.find((item) => item.name === skill.name) ?? loaded.skills[0];
        discoveryPath = match?.filePath;
      } catch {
        discoveryPath = undefined;
      }
      if (opts.hostAvailabilityEvidence?.(skill.name)) {
        return { name: skill.name, skillId: skill.skillId, pluginId: plugin.pluginId, status: 'projected', availability: 'available', discoveryPath };
      }
      return {
        name: skill.name,
        skillId: skill.skillId,
        pluginId: plugin.pluginId,
        status: 'projected',
        // Snapshot-bound eligibility only: Available requires independent host evidence.
        availability: discoveryPath ? 'snapshot-eligible' : 'unverified',
        discoveryPath,
      };
    }),
  }));

  return { plugins, denied, findings: sortFindings(findings) };
}

function joinPath(directory: string, file: string): string {
  return directory.endsWith('/') ? `${directory}${file}` : `${directory}/${file}`;
}

function dirnamePath(filePath: string): string {
  const index = filePath.lastIndexOf('/');
  return index > 0 ? filePath.slice(0, index) : filePath;
}

export interface RuntimeApplicationOutcome {
  outcome: 'applied' | 'pending-application';
  receipt: AttemptReceipt;
}

/**
 * Thin Runtime Application seam: reload participation in Pi is Applied only after
 * host-verifiable Bridge re-entry; anything less leaves Pending Application. Full
 * receipt-journal reconciliation arrives with the recovery tickets.
 */
export async function requestRuntimeApplication(
  verifyReload: () => Promise<boolean> | boolean,
  opts: { cwd?: string; agentDir?: string } = {},
): Promise<RuntimeApplicationOutcome> {
  void opts;
  const applied = await verifyReload();
  return {
    outcome: applied ? 'applied' : 'pending-application',
    receipt: createReceipt({
      operation: 'Runtime Application',
      scope: 'project',
      trigger: 'reload projected Effective State',
      expectedStateRevision: '-',
      summary: applied ? 'Completed' : 'Pending Application',
    }),
  };
}
