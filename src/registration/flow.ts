/**
 * Local Marketplace Registration flow — the Lifecycle Operation seam for #17.
 * See CONTEXT.md: Marketplace Registration, Registration Confirmation, Validation Disclosure,
 * Attempt Fence, Rejected as Stale, Attempt Receipt, Project Trust.
 *
 * Flow: preflight (fence → identity → validation → disclosure) → Registration Confirmation
 * (snapshot + State Revision bound, Default No) → scope-atomic commit → Attempt Receipt.
 *
 * The TUI layer renders the Validation Disclosure from the preflight and forwards the user's
 * explicit yes/no to `confirmLocalRegistration`; confirmation is never remembered or batched.
 */

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { commitBridgeState, readBridgeState } from '../bridge-state/store.js';
import type { Registration, Scope } from '../bridge-state/types.js';
import { BUDGET } from './budget.js';
import {
  CODE,
  RULE,
  blocking,
  hasBlocking,
  sortFindings,
  type ValidationFinding,
} from './findings.js';
import { parseCatalog, type Catalog } from './catalog.js';
import { resolveContained } from './contained.js';
import { acquireAttemptFence, type AttemptFenceHandle } from './fence.js';
import { createReceipt, type AttemptReceipt } from './receipt.js';
import {
  allocateRegistrationId,
  deriveInitialAlias,
  findDuplicateRegistration,
  sourceKeyForLocalRoot,
} from './registration.js';
import { buildLocalSnapshot, type ValidationSnapshot } from './snapshot.js';
import type { SourceKey } from './source-key.js';

export const MARKETPLACE_CATALOG_RELPATH = '.agents/plugins/marketplace.json';

export interface RegistrationFlowOptions {
  cwd?: string;
  agentDir?: string;
  /** Host-owned decision (ctx.isProjectTrusted()). Without it, Project scope operations are blocked. */
  projectTrusted?: boolean;
  /** Deterministic Registration ID for tests; otherwise UUIDv4 allocated before preflight. */
  preallocatedId?: string;
  fenceTimeoutMs?: number;
}

export interface LocalRegistrationPreflight {
  scope: Scope;
  /** Immutable lowercase UUIDv4 allocated before preflight validation. */
  registrationId: string;
  alias?: string;
  sourceKey: SourceKey;
  canonicalPath: string;
  marketplaceName: string;
  catalog: Catalog;
  snapshot: ValidationSnapshot;
  findings: ValidationFinding[];
  blocked: boolean;
  /** State Revision observed at preflight — bound to confirmation. */
  stateRevision: string;
  fence: AttemptFenceHandle;
  /** True once confirm/cancel reached a terminal outcome (single terminal per preflight). */
  terminal: boolean;
}

export type RegistrationOutcome =
  | {
      status: 'completed';
      registration: Registration;
      receipt: AttemptReceipt;
      newRevision: string;
    }
  | { status: 'declined'; receipt: AttemptReceipt }
  | { status: 'blocked'; findings: ValidationFinding[]; receipt: AttemptReceipt; existing?: Registration }
  | { status: 'rejected-as-stale'; receipt: AttemptReceipt }
  | { status: 'persistence-failed'; receipt: AttemptReceipt; isIndeterminate: boolean };

export type PreflightResult =
  | { ok: true; preflight: LocalRegistrationPreflight }
  | { ok: false; outcome: RegistrationOutcome };

const OPERATION = 'Marketplace Registration';

function triggerFor(rootPath: string): string {
  return `register local ${rootPath}`;
}

/** Build a Blocked preflight result: immutable redacted receipt + released fence (if held). */
function blockedResult(
  scope: Scope,
  rootPath: string,
  expectedRevision: string,
  findings: ValidationFinding[],
  handle: AttemptFenceHandle | null,
  existing?: Registration,
): { ok: false; outcome: RegistrationOutcome } {
  if (handle) handle.release();
  const receipt = createReceipt({
    operation: OPERATION,
    scope,
    trigger: triggerFor(rootPath),
    expectedStateRevision: expectedRevision,
    summary: 'Blocked',
    findings,
  });
  return { ok: false, outcome: { status: 'blocked', findings, receipt, existing } };
}

async function readScopeState(scope: Scope, opts: RegistrationFlowOptions) {
  return readBridgeState(scope, { cwd: opts.cwd, agentDir: opts.agentDir });
}

/**
 * Run preflight for a local Marketplace Root registration.
 * Acquires the per-scope Attempt Fence, allocates the Registration ID before validation, validates
 * catalog / paths / symlinks / budget, builds the Validation Snapshot, detects duplicates, and
 * produces the Validation Disclosure material. The fence is held until confirm/cancel.
 */
export async function preflightLocalRegistration(
  scope: Scope,
  rootPath: string,
  opts: RegistrationFlowOptions = {},
): Promise<PreflightResult> {
  const read = await readScopeState(scope, opts);
  let expectedRevision = '0';
  let registrations: Registration[] = [];
  if (read.status === 'missing') {
    expectedRevision = read.state!.stateRevision;
  } else if (read.status === 'ok') {
    expectedRevision = read.state!.stateRevision;
    registrations = read.state!.registrations;
  } else {
    // corrupted / incompatible — fail-closed, no attempt may proceed
    const receipt = createReceipt({
      operation: OPERATION,
      scope,
      trigger: triggerFor(rootPath),
      expectedStateRevision: '?',
      summary: 'Persistence Indeterminate',
      findings: [
        blocking({
          code: CODE.PERSISTENCE_INDETERMINATE,
          phase: 'persistence',
          target: 'registration',
          scope,
          pointer: '',
          rule: 'PERSIST-01',
          outcome: read.error ?? `state is ${read.status}; neither previous nor target verifiable`,
        }),
      ],
    });
    return {
      ok: false,
      outcome: { status: 'persistence-failed', receipt, isIndeterminate: true },
    };
  }

  // Project Trust: host-owned. Untrusted project scope blocks the operation; stored records stay
  // durable and are only excluded from derived Effective State (that read-time projection is #20).
  if (scope === 'project' && opts.projectTrusted === false) {
    const finding = blocking({
      code: CODE.PROJECT_TRUST_DENIED,
      phase: 'admission',
      target: 'registration',
      scope,
      pointer: '',
      rule: RULE.PROJECT_TRUST_DENIED,
      outcome:
        'Project Trust is not granted by the Pi host; project records remain stored but excluded from Effective State, and no Project Scope Lifecycle Operation may mutate them',
    });
    return blockedResult(scope, rootPath, expectedRevision, [finding], null);
  }

  // Attempt Fence (same-scope exclusivity)
  const fence = await acquireAttemptFence(scope, {
    cwd: opts.cwd,
    agentDir: opts.agentDir,
    fenceTimeoutMs: opts.fenceTimeoutMs,
  });
  if (!fence.ok) {
    return blockedResult(scope, rootPath, expectedRevision, [fence.finding!], null);
  }
  const handle = fence.handle!;

  try {
    // Registration ID is allocated before preflight validation (stable derived identities).
    const registrationId = opts.preallocatedId ?? allocateRegistrationId();

    // Source Key (canonical real path)
    const sourceKeyRes = sourceKeyForLocalRoot(rootPath, scope);
    if (!sourceKeyRes.ok) {
      return blockedResult(scope, rootPath, expectedRevision, sourceKeyRes.findings, handle);
    }
    const sourceKey = sourceKeyRes.sourceKey;
    const canonicalPath = sourceKey.canonicalPath!;

    // Marketplace Catalog — canonical `.agents/plugins/marketplace.json`
    const findings: ValidationFinding[] = [];
    const catalogPath = join(canonicalPath, MARKETPLACE_CATALOG_RELPATH);
    let catalogBytes = 0;
    try {
      catalogBytes = statSync(catalogPath).size;
    } catch {
      const finding = blocking({
        code: CODE.CATALOG_MISSING,
        phase: 'validation',
        target: 'catalog',
        scope,
        pointer: MARKETPLACE_CATALOG_RELPATH,
        rule: RULE.CATALOG_MISSING,
        outcome: `Marketplace Catalog not found at ${MARKETPLACE_CATALOG_RELPATH}; legacy marketplace shapes do not participate in Bridge ingestion`,
      });
      return blockedResult(scope, rootPath, expectedRevision, [finding], handle);
    }
    if (catalogBytes > BUDGET.maxCatalogBytes) {
      const finding = blocking({
        code: CODE.BUDGET_EXCEEDED,
        phase: 'validation',
        target: 'catalog',
        scope,
        pointer: MARKETPLACE_CATALOG_RELPATH,
        rule: RULE.BUDGET_EXCEEDED,
        outcome: `Validation Budget exceeded: catalog ${catalogBytes} bytes > ${BUDGET.maxCatalogBytes}`,
      });
      return blockedResult(scope, rootPath, expectedRevision, [finding], handle);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(catalogPath, 'utf-8'));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const finding = blocking({
        code: CODE.CATALOG_MALFORMED,
        phase: 'validation',
        target: 'catalog',
        scope,
        pointer: MARKETPLACE_CATALOG_RELPATH,
        rule: RULE.CATALOG_MALFORMED,
        outcome: `unable to parse marketplace.json: ${msg}`,
      });
      return blockedResult(scope, rootPath, expectedRevision, [finding], handle);
    }

    const catalogResult = parseCatalog(parsed, { scope });
    findings.push(...catalogResult.findings);
    const catalog = catalogResult.catalog!;

    if (catalog.name.length > BUDGET.maxNameLength) {
      findings.push(
        blocking({
          code: CODE.BUDGET_EXCEEDED,
          phase: 'validation',
          target: 'catalog',
          scope,
          pointer: '/name',
          rule: RULE.BUDGET_EXCEEDED,
          outcome: `Validation Budget exceeded: marketplace name ${catalog.name.length} chars > ${BUDGET.maxNameLength}`,
        }),
      );
    }
    if (catalog.entries.length > BUDGET.maxEntries) {
      findings.push(
        blocking({
          code: CODE.BUDGET_EXCEEDED,
          phase: 'validation',
          target: 'catalog',
          scope,
          pointer: '/plugins',
          rule: RULE.BUDGET_EXCEEDED,
          outcome: `Validation Budget exceeded: ${catalog.entries.length} entries > ${BUDGET.maxEntries}`,
        }),
      );
    }

    // Containment resolution per local entry (Unavailable Entries are disclosed, not findings).
    for (const entry of catalog.entries) {
      if (entry.type !== 'local' || !entry.path) continue;
      const res = resolveContained(canonicalPath, entry.path, 'any');
      if (res.outcome.kind === 'blocking') {
        const reason = res.outcome.reason;
        const symlink = res.outcome.blockClass === 'symlink';
        findings.push(
          blocking({
            code: symlink ? CODE.CONTAINED_SYMLINK_VIOLATION : CODE.PATH_CONTAINMENT_VIOLATION,
            phase: 'validation',
            target: 'entry',
            scope,
            pointer: `${entry.entryId}/path`,
            rule: symlink ? RULE.CONTAINED_SYMLINK_VIOLATION : RULE.PATH_CONTAINMENT_VIOLATION,
            outcome: `${entry.entryId}: ${reason}`,
          }),
        );
        entry.available = false;
        entry.unavailableReason = reason;
      } else if (res.outcome.kind === 'missing') {
        entry.available = false;
        entry.unavailableReason = 'cannot resolve to a Plugin: target does not exist';
      }
    }

    // Validation Snapshot (complete tree + binds)
    const snapshotResult = buildLocalSnapshot(canonicalPath, sourceKey, scope);
    findings.push(...snapshotResult.findings);

    const sorted = sortFindings(findings);
    if (hasBlocking(sorted)) {
      return blockedResult(scope, rootPath, expectedRevision, sorted, handle);
    }

    // Duplicate detection (same kind + identical Source Key); directs to the existing Registration.
    const dup = findDuplicateRegistration(scope, sourceKey, registrations);
    if (dup.duplicate) {
      return blockedResult(scope, rootPath, expectedRevision, [dup.finding!], handle, dup.existing);
    }

    const alias = deriveInitialAlias(
      catalog.name,
      registrations.map((r) => r.alias).filter((a): a is string => Boolean(a)),
    );

    const preflight: LocalRegistrationPreflight = {
      scope,
      registrationId,
      alias,
      sourceKey,
      canonicalPath,
      marketplaceName: catalog.name,
      catalog,
      snapshot: snapshotResult.snapshot!,
      findings: sorted,
      blocked: false,
      stateRevision: expectedRevision,
      fence: handle,
      terminal: false,
    };
    return { ok: true, preflight };
  } catch (e) {
    handle.release();
    const msg = e instanceof Error ? e.message : String(e);
    const finding = blocking({
      code: 'PREFLIGHT_ERROR',
      phase: 'validation',
      target: 'registration',
      scope,
      pointer: '',
      rule: 'PREFLIGHT-01',
      outcome: `preflight failed: ${msg}`,
    });
    return blockedResult(scope, rootPath, expectedRevision, [finding], null);
  }
}

function snapshotBinds(snapshot: ValidationSnapshot) {
  return { profile: snapshot.profile, ruleset: snapshot.ruleset, budget: snapshot.budget };
}

/**
 * Registration Confirmation — bound to the preflight's Validation Snapshot + State Revision,
 * Default No, never remembered or applied in bulk. Passing yes=false declines with a Declined
 * receipt (state unchanged). Passing yes=true re-verifies the State Revision (stale ⇒ Rejected as
 * Stale) and duplicates, then commits atomically and returns a Completed Attempt Receipt.
 */
export async function confirmLocalRegistration(
  preflight: LocalRegistrationPreflight,
  yes: boolean,
  opts: RegistrationFlowOptions = {},
): Promise<RegistrationOutcome> {
  if (preflight.terminal) {
    // a second confirm/cancel on the same preflight is a programming error — treat as blocked
    const receipt = createReceipt({
      operation: OPERATION,
      scope: preflight.scope,
      trigger: triggerFor(preflight.canonicalPath),
      expectedStateRevision: preflight.stateRevision,
      validationSnapshot: preflight.snapshot.fingerprint,
      summary: 'Blocked',
      findings: [
        blocking({
          code: CODE.ATTEMPT_IN_PROGRESS,
          phase: 'admission',
          target: 'attempt',
          scope: preflight.scope,
          pointer: '',
          rule: RULE.ATTEMPT_IN_PROGRESS,
          outcome: 'attempt already reached a terminal outcome',
        }),
      ],
    });
    return { status: 'blocked', findings: [], receipt };
  }
  preflight.terminal = true;
  const { fence, scope } = preflight;
  const release = () => fence.release();

  if (!yes) {
    const receipt = createReceipt({
      operation: OPERATION,
      scope,
      trigger: triggerFor(preflight.canonicalPath),
      expectedStateRevision: preflight.stateRevision,
      validationSnapshot: preflight.snapshot.fingerprint,
      summary: 'Declined',
      findings: preflight.findings,
      stateChanged: false,
    });
    release();
    return { status: 'declined', receipt };
  }

  // Re-verify exact State Revision (bound confirmation). Any change ⇒ Rejected as Stale.
  const fresh = await readScopeState(scope, opts);
  if (fresh.status !== 'ok' && fresh.status !== 'missing') {
    const receipt = createReceipt({
      operation: OPERATION,
      scope,
      trigger: triggerFor(preflight.canonicalPath),
      expectedStateRevision: preflight.stateRevision,
      validationSnapshot: preflight.snapshot.fingerprint,
      summary: 'Persistence Indeterminate',
      findings: [
        blocking({
          code: CODE.PERSISTENCE_INDETERMINATE,
          phase: 'persistence',
          target: 'registration',
          scope,
          pointer: '',
          rule: 'PERSIST-01',
          outcome: fresh.error ?? `state is ${fresh.status}; neither previous nor target verifiable`,
        }),
      ],
    });
    release();
    return { status: 'persistence-failed', receipt, isIndeterminate: true };
  }
  const currentRevision = fresh.state!.stateRevision;
  if (currentRevision !== preflight.stateRevision) {
    const receipt = createReceipt({
      operation: OPERATION,
      scope,
      trigger: triggerFor(preflight.canonicalPath),
      expectedStateRevision: preflight.stateRevision,
      targetStateRevision: currentRevision,
      validationSnapshot: preflight.snapshot.fingerprint,
      summary: 'Rejected as Stale',
      findings: [
        blocking({
          code: CODE.REJECTED_AS_STALE,
          phase: 'persistence',
          target: 'attempt',
          scope,
          pointer: '',
          rule: RULE.REJECTED_AS_STALE,
          outcome: `State Revision changed (${preflight.stateRevision} → ${currentRevision}); re-run preflight and confirmation — no automatic merge`,
        }),
      ],
      stateChanged: false,
    });
    release();
    return { status: 'rejected-as-stale', receipt };
  }

  // Re-check duplicates under the fresh state (a concurrent commit may have created one).
  const dup = findDuplicateRegistration(scope, preflight.sourceKey, fresh.state!.registrations);
  if (dup.duplicate) {
    const receipt = createReceipt({
      operation: OPERATION,
      scope,
      trigger: triggerFor(preflight.canonicalPath),
      expectedStateRevision: preflight.stateRevision,
      validationSnapshot: preflight.snapshot.fingerprint,
      summary: 'Blocked',
      findings: [dup.finding!],
    });
    release();
    return { status: 'blocked', findings: [dup.finding!], receipt, existing: dup.existing };
  }

  // Re-verify the Validation Snapshot fingerprint against the live tree. A fingerprint mismatch
  // (source drift between preflight and confirmation) is a Blocking Finding and the confirmation
  // is Rejected as Stale — new validation, disclosure, and confirmation are required (CONTEXT: the
  // fingerprint must still match before durable state mutation).
  const revalidated = buildLocalSnapshot(preflight.canonicalPath, preflight.sourceKey, scope);
  if (!revalidated.ok || revalidated.snapshot!.fingerprint !== preflight.snapshot.fingerprint) {
    const receipt = createReceipt({
      operation: OPERATION,
      scope,
      trigger: triggerFor(preflight.canonicalPath),
      expectedStateRevision: preflight.stateRevision,
      validationSnapshot: preflight.snapshot.fingerprint,
      summary: 'Rejected as Stale',
      findings: [
        blocking({
          code: CODE.REJECTED_AS_STALE,
          phase: 'validation',
          target: 'registration',
          scope,
          pointer: '/',
          rule: RULE.REJECTED_AS_STALE_SNAPSHOT,
          outcome:
            'Validation Snapshot fingerprint changed since disclosure (source tree drifted); re-run preflight and confirmation — no automatic merge',
        }),
      ],
      stateChanged: false,
    });
    release();
    return { status: 'rejected-as-stale', receipt };
  }

  const registration: Registration = {
    id: preflight.registrationId,
    alias: preflight.alias,
    marketplaceName: preflight.marketplaceName,
    sourceKind: 'local',
    source: preflight.canonicalPath,
    sourceKey: preflight.sourceKey,
    validationSnapshot: preflight.snapshot.fingerprint,
    snapshotBinds: snapshotBinds(preflight.snapshot),
  };

  const write = await commitBridgeState(
    scope,
    (current) => ({ ...current, registrations: [...current.registrations, registration] }),
    { cwd: opts.cwd, agentDir: opts.agentDir, lockTimeoutMs: opts.fenceTimeoutMs ?? 5000 },
  );
  if (!write.success) {
    const summary: 'Persistence Failed' | 'Persistence Indeterminate' = write.isIndeterminate
      ? 'Persistence Indeterminate'
      : 'Persistence Failed';
    const receipt = createReceipt({
      operation: OPERATION,
      scope,
      trigger: triggerFor(preflight.canonicalPath),
      expectedStateRevision: preflight.stateRevision,
      targetStateRevision: '?',
      validationSnapshot: preflight.snapshot.fingerprint,
      summary,
      findings: [
        blocking({
          code: write.isIndeterminate ? CODE.PERSISTENCE_INDETERMINATE : CODE.PERSISTENCE_FAILED,
          phase: 'persistence',
          target: 'registration',
          scope,
          pointer: '',
          rule: write.isIndeterminate ? 'PERSIST-01' : 'PERSIST-02',
          outcome: write.error ?? summary,
        }),
      ],
      stateChanged: false,
    });
    release();
    return { status: 'persistence-failed', receipt, isIndeterminate: write.isIndeterminate ?? false };
  }

  const targetRevision = write.newRevision!;
  const hasDiagnostics = preflight.findings.some((f) => f.classification !== 'blocking');
  const receipt = createReceipt({
    operation: OPERATION,
    scope,
    trigger: triggerFor(preflight.canonicalPath),
    expectedStateRevision: preflight.stateRevision,
    targetStateRevision: targetRevision,
    observedStateRevision: targetRevision,
    validationSnapshot: preflight.snapshot.fingerprint,
    summary: hasDiagnostics ? 'Completed with diagnostics' : 'Completed',
    findings: preflight.findings,
    stateChanged: true,
  });
  release();
  return { status: 'completed', registration, receipt, newRevision: targetRevision };
}

/** Cancel a preflight without confirming — releases the Attempt Fence (no state mutation). */
export function cancelLocalRegistration(preflight: LocalRegistrationPreflight): void {
  if (preflight.terminal) return;
  preflight.terminal = true;
  preflight.fence.release();
}

/**
 * Validation Disclosure material for the confirmation surface: source, scope, marketplace name,
 * State Revision, Validation Snapshot fingerprint, entry outcomes, findings summary.
 */
export function disclosureSummary(preflight: LocalRegistrationPreflight): string {
  const entries = preflight.catalog.entries;
  const available = entries.filter((e) => e.available).length;
  const unavailable = entries.length - available;
  const blockingCount = preflight.findings.filter((f) => f.classification === 'blocking').length;
  const warningCount = preflight.findings.filter((f) => f.classification === 'warning').length;
  const lines = [
    `Scope: ${preflight.scope}`,
    `Source: ${preflight.canonicalPath}`,
    `Marketplace: ${preflight.marketplaceName}`,
    `State Revision: ${preflight.stateRevision}`,
    `Validation Snapshot: ${preflight.snapshot.fingerprint.slice(0, 16)}…`,
    `Entries: ${entries.length} (${available} locatable / ${unavailable} unavailable)`,
    `Findings: ${blockingCount} blocking · ${warningCount} warning`,
  ];
  for (const entry of entries) {
    const status = entry.available ? 'locatable' : `unavailable (${entry.unavailableReason ?? '?'})`;
    lines.push(`  ${entry.entryId} ${entry.name ? `· ${entry.name} ` : ''}— ${status}`);
  }
  return lines.join('\n');
}