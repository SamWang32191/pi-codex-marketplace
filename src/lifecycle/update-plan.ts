/**
 * Update Plan — the Validation Snapshot- and State Revision-bound set of explicit outcomes
 * required before Apply Update / Registration Rebind can replace one Registration's source state.
 * See CONTEXT.md: Update Plan, Apply Update, Registration Rebind, Activation Confirmation,
 * Registration Confirmation.
 *
 * A plan requires:
 * - a fresh Registration Confirmation bound to the candidate snapshot + observed State Revision;
 * - an update / disablement / removal outcome for every existing Installation;
 * - an Activation Confirmation for every enabled Installation that remains enabled;
 * - Installations without a Compatible candidate in the new snapshot must be disabled or
 *   removed, or the plan is abandoned.
 *
 * The plan itself commits nothing; `applyUpdate` performs the single atomic commit.
 */

import type { Installation, Registration } from '../bridge-state/types.js';
import type { CompatiblePlugin } from '../compatibility/profile.js';
import { CODE, RULE, blocking, type ValidationFinding } from '../registration/findings.js';
import type { ValidationSnapshot } from '../registration/snapshot.js';
import type { UpdateCandidate } from './refresh.js';

export type InstallationChoice = 'update' | 'disable' | 'remove';

export interface PlanEntry {
  installationId: string;
  pluginId: string;
  choice: InstallationChoice;
  /** Durable state before the plan commits. */
  currentState: 'enabled' | 'disabled';
  /** Durable state after the plan commits. */
  installationState: 'enabled' | 'disabled';
  /** Activation-bound snapshot under the candidate tree (updated installations only). */
  newSnapshot?: ValidationSnapshot;
  /** New snapshot-scoped Marketplace Entry pointer (updated installations only). */
  newMarketplaceEntryId?: string;
  manifestName?: string;
}

export interface UpdatePlan {
  kind: 'apply-update' | 'rebind';
  registrationId: string;
  /** State Revision observed while the plan was built; Apply Update re-verifies it under CAS. */
  stateRevision: string;
  candidate: UpdateCandidate;
  entries: PlanEntry[];
  /** Rebind-only: the complete replacement source attributes preserving the Registration ID. */
  rebindSource?: RebindSourceAttributes;
}

/** Replacement locator/selector/revision attributes for a Registration Rebind. */
export interface RebindSourceAttributes {
  sourceKind: 'local' | 'git';
  source: string;
  sourceKey: UpdateCandidate['sourceKey'];
  canonicalLocator?: string;
  gitSelector?: Registration['gitSelector'];
  resolvedRevision?: string;
}

export interface UpdatePlanInput {
  /** Fresh Registration Confirmation bound to the candidate snapshot + State Revision (Default No). */
  registrationConfirmed: boolean;
  /** Explicit outcome per existing Installation ID — never batched, never defaulted. */
  choices: Record<string, InstallationChoice>;
  /** Per-Installation Activation Confirmations for enabled installations that remain enabled. */
  activationConfirmations?: Record<string, boolean>;
  kind?: 'apply-update' | 'rebind';
  /** Rebind-only: validated replacement source attributes. */
  rebindSource?: RebindSourceAttributes;
}

export type UpdatePlanResult =
  | { ok: true; plan: UpdatePlan }
  | { ok: false; problems: ValidationFinding[] };

function planProblem(target: ValidationFinding['target'], pointer: string, code: string, outcome: string): ValidationFinding {
  return blocking({ code, rule: RULE.UPDATE_PLAN_INCOMPLETE, target, pointer, outcome, phase: 'admission' });
}

/**
 * Plugin IDs with a Compatible candidate in the new Validation Snapshot — the identity an
 * Installation keeps across updates. Shared by plan validation and the TUI checklist so the
 * disclosure surface and the commit rules can never diverge.
 */
export function compatibleCandidateIds(candidate: UpdateCandidate): Set<string> {
  const ids = new Set<string>();
  for (const item of candidate.inspection.entries) {
    if (!item.plugin || item.unavailableReason) continue;
    if (item.findings.some((f) => f.classification === 'blocking')) continue;
    ids.add(item.plugin.id);
  }
  return ids;
}

/** Compatible candidates keyed by Plugin ID. */
function compatibleById(candidate: UpdateCandidate): Map<string, { plugin: CompatiblePlugin; snapshot: ValidationSnapshot }> {
  const map = new Map<string, { plugin: CompatiblePlugin; snapshot: ValidationSnapshot }>();
  // Every updated installation binds the same marketplace-wide activation-bound snapshot
  // (catalog captures folded in by inspection) that a fresh installation under the candidate
  // tree would receive — the same convention Plugin Installation has used since #19.
  const activationSnapshot = candidate.inspection.snapshot ?? candidate.snapshot;
  for (const item of candidate.inspection.entries) {
    if (!compatibleCandidateIds(candidate).has(item.plugin?.id ?? '')) continue;
    map.set(item.plugin!.id, { plugin: item.plugin!, snapshot: activationSnapshot });
  }
  return map;
}

/**
 * Assemble and validate an Update Plan. Any missing consent or outcome abandons the plan with
 * structured Blocking findings — nothing partial is ever committable.
 */
export function buildUpdatePlan(
  candidate: UpdateCandidate,
  installations: Installation[],
  stateRevision: string,
  input: UpdatePlanInput,
): UpdatePlanResult {
  const problems: ValidationFinding[] = [];
  const kind = input.kind ?? 'apply-update';

  if (kind === 'rebind' && !input.rebindSource) {
    problems.push(planProblem('attempt', '', CODE.UPDATE_PLAN_INCOMPLETE, 'Registration Rebind requires validated replacement source attributes'));
  }

  if (!input.registrationConfirmed) {
    problems.push(
      planProblem('registration',
        candidate.registrationId,
        CODE.UPDATE_PLAN_INCOMPLETE,
        'a fresh Registration Confirmation bound to the candidate Validation Snapshot and State Revision is required before Apply Update',
      ),
    );
  }

  const candidates = compatibleById(candidate);
  const entries: PlanEntry[] = [];

  for (const installation of installations) {
    const choice = input.choices[installation.id];
    if (!choice) {
      problems.push(
        planProblem('installation', installation.id, CODE.UPDATE_PLAN_INCOMPLETE, `Installation '${installation.id}' has no update/disable/remove outcome; the plan cannot commit without an explicit choice`),
      );
      continue;
    }
    if (choice !== 'update' && choice !== 'disable' && choice !== 'remove') {
      problems.push(planProblem('installation', installation.id, CODE.UPDATE_PLAN_INCOMPLETE, `unknown outcome '${String(choice)}'`));
      continue;
    }

    if (choice === 'update') {
      const match = candidates.get(installation.pluginId);
      if (!match) {
        problems.push(
          planProblem('installation',
            installation.id,
            CODE.UPDATE_PLAN_INCOMPLETE,
            `no Compatible candidate for Plugin '${installation.pluginId}' exists in the new Validation Snapshot; the Installation must be disabled or removed, or the plan abandoned`,
          ),
        );
        continue;
      }
      const remainsEnabled = installation.installationState === 'enabled';
      if (remainsEnabled && input.activationConfirmations?.[installation.id] !== true) {
        problems.push(
          blocking({
            code: CODE.ACTIVATION_CONFIRMATION_REQUIRED,
            rule: RULE.ACTIVATION_CONFIRMATION_REQUIRED,
            target: 'installation',
            pointer: installation.id,
            outcome: 'an enabled Installation that remains enabled needs its own Activation Confirmation bound to the new Validation Snapshot (default No)',
            phase: 'admission',
          }),
        );
        continue;
      }
      entries.push({
        installationId: installation.id,
        pluginId: installation.pluginId,
        choice,
        currentState: installation.installationState,
        installationState: remainsEnabled ? 'enabled' : 'disabled',
        newSnapshot: match.snapshot,
        newMarketplaceEntryId: match.plugin.marketplaceEntryId,
        manifestName: match.plugin.manifestName,
      });
      continue;
    }

    entries.push({
      installationId: installation.id,
      pluginId: installation.pluginId,
      choice,
      currentState: installation.installationState,
      installationState: 'disabled',
    });
  }

  if (problems.length > 0) return { ok: false, problems };

  return {
    ok: true,
    plan: {
      kind,
      registrationId: candidate.registrationId,
      stateRevision,
      candidate,
      entries,
      rebindSource: input.rebindSource,
    },
  };
}
