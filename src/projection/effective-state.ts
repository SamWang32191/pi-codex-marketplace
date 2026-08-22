/**
 * Effective State — computed project view of inherited Global Scope records,
 * Project Scope additions, and ID-keyed Scope Overrides.
 * See CONTEXT.md: Effective State, Scope Override, Project Trust, Installation State, Installed Plugin.
 *
 * This is a pure read-time computation over the two authoritative Bridge State documents.
 * Nothing here is persisted: no merged state document exists. Only enabled Installations
 * participate, an enabled project Installation of an inherited global Plugin ID takes
 * precedence over the retained global Installation, and no selected record's independently
 * persisted provenance is merged or mutated — each record carries exactly what its own
 * scope's document holds.
 */

import type { BridgeState, Installation, Registration } from '../bridge-state/types.js';

export type EffectiveSourceScope = 'global' | 'project';

export interface EffectiveRegistration extends Registration {
  sourceScope: EffectiveSourceScope;
}

export interface EffectiveInstallation extends Installation {
  sourceScope: EffectiveSourceScope;
}

/** Why one inherited Global Scope record does not participate in this Effective State. */
export interface SuppressedGlobalRecord {
  kind: 'registration' | 'installation';
  /** Canonical Registration ID or Installation ID of the suppressed record. */
  targetId: string;
  pluginId?: string;
  reason: 'scope-override-registration' | 'scope-override-installation' | 'project-precedence';
  /** For precedence suppression: the project Installation that supersedes the global one. */
  supersededBy?: string;
}

/**
 * Project Scope records stored in the project document but excluded from Effective State:
 * Project Trust not granted, or an invalid duplicate of an inherited Registration ID.
 */
export interface ExcludedProjectRecord {
  kind: 'registration' | 'installation' | 'scope-override';
  id: string;
  reason: 'project-trust-not-granted' | 'invalid-duplicate-registration-id';
}

export interface EffectiveState {
  registrations: EffectiveRegistration[];
  installations: EffectiveInstallation[];
  suppressed: SuppressedGlobalRecord[];
  excluded: ExcludedProjectRecord[];
}

export interface EffectiveStateOptions {
  /**
   * Pi host-owned Project Trust. Defaults to false: project records remain stored but are
   * excluded, and overrides do not participate, until the host grants trust.
   */
  projectTrusted?: boolean;
}

/**
 * Compute the Effective State from both scope documents. Pure — never mutates inputs and
 * never persists anything; callers recompute after every read or commit.
 */
export function computeEffectiveState(
  globalState: BridgeState,
  projectState: BridgeState,
  opts: EffectiveStateOptions = {},
): EffectiveState {
  const projectTrusted = opts.projectTrusted === true;
  const suppressed: SuppressedGlobalRecord[] = [];
  const excluded: ExcludedProjectRecord[] = [];

  // Without Project Trust every project-side record stays durable but non-participating.
  if (!projectTrusted) {
    for (const registration of projectState.registrations) {
      excluded.push({ kind: 'registration', id: registration.id, reason: 'project-trust-not-granted' });
    }
    for (const installation of projectState.installations) {
      excluded.push({ kind: 'installation', id: installation.id, reason: 'project-trust-not-granted' });
    }
    for (const override of projectState.scopeOverrides) {
      const id = `${override.kind}/${override.targetId}`;
      excluded.push({ kind: 'scope-override', id, reason: 'project-trust-not-granted' });
    }
    return {
      registrations: globalState.registrations.map((registration) => ({ ...registration, sourceScope: 'global' })),
      installations: globalState.installations
        .filter((installation) => installation.installationState === 'enabled')
        .map((installation) => ({ ...installation, sourceScope: 'global' })),
      suppressed,
      excluded,
    };
  }

  // Overrides are keyed by canonical Registration ID / Installation ID and suppress only
  // inherited Global Scope records.
  const overriddenRegistrationIds = new Set(
    projectState.scopeOverrides.filter((o) => o.kind === 'registration').map((o) => o.targetId),
  );
  const overriddenInstallationIds = new Set(
    projectState.scopeOverrides.filter((o) => o.kind === 'installation').map((o) => o.targetId),
  );

  const survivingGlobalRegistrations = globalState.registrations.filter((registration) => {
    if (!overriddenRegistrationIds.has(registration.id)) return true;
    suppressed.push({ kind: 'registration', targetId: registration.id, reason: 'scope-override-registration' });
    return false;
  });

  // A project record that duplicates a global Registration ID is invalid rather than an
  // override; it stays durable but cannot participate in Effective State.
  const globalRegistrationIds = new Set(survivingGlobalRegistrations.map((registration) => registration.id));
  const projectRegistrations = projectState.registrations.filter((registration) => {
    if (!globalRegistrationIds.has(registration.id)) return true;
    excluded.push({ kind: 'registration', id: registration.id, reason: 'invalid-duplicate-registration-id' });
    return false;
  });

  // A Registration Override suppresses its whole marketplace subtree: every Installation
  // supplied by that Registration disappears with it.
  const survivingGlobalInstallations: Installation[] = [];
  for (const installation of globalState.installations) {
    if (installation.registrationId && overriddenRegistrationIds.has(installation.registrationId)) {
      suppressed.push({
        kind: 'installation',
        targetId: installation.id,
        pluginId: installation.pluginId,
        reason: 'scope-override-registration',
      });
      continue;
    }
    if (overriddenInstallationIds.has(installation.id)) {
      suppressed.push({
        kind: 'installation',
        targetId: installation.id,
        pluginId: installation.pluginId,
        reason: 'scope-override-installation',
      });
      continue;
    }
    survivingGlobalInstallations.push(installation);
  }

  // Only enabled Installations ever participate; a disabled project Installation neither
  // participates nor supersedes its inherited global twin.
  const enabledProjectInstallations = projectState.installations.filter(
    (installation) => installation.installationState === 'enabled',
  );
  const projectPluginIds = new Set(enabledProjectInstallations.map((installation) => installation.pluginId));

  for (const installation of survivingGlobalInstallations) {
    if (installation.installationState !== 'enabled') continue;
    if (!projectPluginIds.has(installation.pluginId)) continue;
    const supersedingId = enabledProjectInstallations.find((item) => item.pluginId === installation.pluginId)!.id;
    suppressed.push({
      kind: 'installation',
      targetId: installation.id,
      pluginId: installation.pluginId,
      reason: 'project-precedence',
      supersededBy: supersedingId,
    });
  }

  const supersededIds = new Set(suppressed.filter((s) => s.reason === 'project-precedence').map((s) => s.targetId));

  return {
    registrations: [
      ...survivingGlobalRegistrations.map((registration): EffectiveRegistration => ({ ...registration, sourceScope: 'global' })),
      ...projectRegistrations.map((registration): EffectiveRegistration => ({ ...registration, sourceScope: 'project' })),
    ],
    installations: [
      ...survivingGlobalInstallations
        .filter((installation) => installation.installationState === 'enabled' && !supersededIds.has(installation.id))
        .map((installation): EffectiveInstallation => ({ ...installation, sourceScope: 'global' })),
      ...enabledProjectInstallations.map((installation): EffectiveInstallation => ({ ...installation, sourceScope: 'project' })),
    ],
    suppressed,
    excluded,
  };
}
