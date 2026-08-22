/**
 * Git Marketplace Registration flow — the Lifecycle Operation seam for #18.
 * See CONTEXT.md: Marketplace Registration, Canonical Git Locator, Git Selector, Resolved Revision,
 * Source Acquisition, Acquisition Trust Base, Source Key (git), Validation Snapshot.
 *
 * Flow: preflight (fence → locator/selector normalization → Source Key → duplicate → acquisition
 * → snapshot + catalog/validation → disclosure) → Registration Confirmation
 * (snapshot + State Revision bound, Default No) → scope-atomic commit → Attempt Receipt.
 */

import { readFileSync, statSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

import { commitBridgeState, readBridgeState } from '../bridge-state/store.js';
import type { Registration, Scope } from '../bridge-state/types.js';
import { BUDGET } from './budget.js';
import { CODE, RULE, blocking, hasBlocking, sortFindings, type ValidationFinding } from './findings.js';
import { parseCatalog, type Catalog } from './catalog.js';
import { resolveContained } from './contained.js';
import { acquireAttemptFence, type AttemptFenceHandle } from './fence.js';
import { createReceipt, type AttemptReceipt } from './receipt.js';
import { appendReceipt } from '../journal/journal.js';
import { allocateRegistrationId, deriveInitialAlias, findDuplicateRegistration } from './registration.js';
import { buildGitSnapshot, type ValidationSnapshot } from './snapshot.js';
import { gitSourceKey, type SourceKey } from './source-key.js';
import { normalizeGitLocator, type CanonicalGitLocator } from './git-locator.js';
import { normalizeGitSelector, parseGitSelectorString, type GitSelectorInput, type NormalizedGitSelector } from './git-selector.js';
import { acquireGitSource, cleanupAcquisition, type GitExecutor, type AcquisitionTrustOptions } from './git-acquisition.js';
import { MARKETPLACE_CATALOG_RELPATH } from './flow.js';

export interface GitRegistrationFlowOptions {
  cwd?: string;
  agentDir?: string;
  projectTrusted?: boolean;
  preallocatedId?: string;
  fenceTimeoutMs?: number;
  /** Injected executor for tests (mocks git) */
  executor?: GitExecutor;
  /** Trust base options */
  trust?: AcquisitionTrustOptions;
  /** Destination dir for acquisition (tests) — if not provided, temp is created */
  destDir?: string;
}

export interface GitRegistrationPreflight {
  scope: Scope;
  registrationId: string;
  alias?: string;
  sourceKey: SourceKey;
  locator: CanonicalGitLocator;
  selector: NormalizedGitSelector;
  resolvedRevision: string;
  marketplaceName: string;
  catalog: Catalog;
  snapshot: ValidationSnapshot;
  findings: ValidationFinding[];
  blocked: boolean;
  stateRevision: string;
  fence: AttemptFenceHandle;
  terminal: boolean;
  /** Temp acquisition path (cleaned on cancel/confirm, not persisted) */
  acquiredPath?: string;
  createdTemp?: boolean;
}

export type GitRegistrationOutcome =
  | { status: 'completed'; registration: Registration; receipt: AttemptReceipt; newRevision: string }
  | { status: 'declined'; receipt: AttemptReceipt }
  | { status: 'blocked'; findings: ValidationFinding[]; receipt: AttemptReceipt; existing?: Registration }
  | { status: 'rejected-as-stale'; receipt: AttemptReceipt }
  | { status: 'persistence-failed'; receipt: AttemptReceipt; isIndeterminate: boolean };

export type GitPreflightResult =
  | { ok: true; preflight: GitRegistrationPreflight }
  | { ok: false; outcome: GitRegistrationOutcome };

const OPERATION = 'Marketplace Registration';

function triggerFor(locator: string, selector: string): string {
  return `register git ${locator}#${selector}`;
}

async function blockedResult(
  scope: Scope,
  locatorInput: string,
  selectorInput: string,
  expectedRevision: string,
  findings: ValidationFinding[],
  handle: AttemptFenceHandle | null,
  opts: GitRegistrationFlowOptions = {},
  existing?: Registration,
): Promise<{ ok: false; outcome: GitRegistrationOutcome }> {
  if (handle) handle.release();
  const receipt = createReceipt({
    operation: OPERATION,
    scope,
    trigger: triggerFor(locatorInput, selectorInput),
    expectedStateRevision: expectedRevision,
    summary: 'Blocked',
    findings,
  });
  await appendReceipt(scope, receipt, opts);
  return { ok: false, outcome: { status: 'blocked', findings, receipt, existing } };
}

async function readScopeState(scope: Scope, opts: GitRegistrationFlowOptions) {
  return readBridgeState(scope, { cwd: opts.cwd, agentDir: opts.agentDir });
}

function selectorToString(input: GitSelectorInput | string): string {
  if (typeof input === 'string') return input;
  return `${input.kind}:${input.value ?? ''}`;
}

/**
 * Run preflight for a Git Marketplace Source registration.
 */
export async function preflightGitRegistration(
  scope: Scope,
  locatorInput: string,
  selectorInput: GitSelectorInput | string,
  opts: GitRegistrationFlowOptions = {},
): Promise<GitPreflightResult> {
  const read = await readScopeState(scope, opts);
  let expectedRevision = '0';
  let registrations: Registration[] = [];
  if (read.status === 'missing') {
    expectedRevision = read.state!.stateRevision;
  } else if (read.status === 'ok') {
    expectedRevision = read.state!.stateRevision;
    registrations = read.state!.registrations;
  } else {
    const receipt = createReceipt({
      operation: OPERATION,
      scope,
      trigger: triggerFor(String(locatorInput), selectorToString(selectorInput)),
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
    await appendReceipt(scope, receipt, opts);
    return { ok: false, outcome: { status: 'persistence-failed', receipt, isIndeterminate: true } };
  }

  if (scope === 'project' && opts.projectTrusted !== true) {
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
    const selStr = selectorToString(selectorInput);
    return blockedResult(scope, locatorInput, selStr, expectedRevision, [finding], null, opts);
  }

  const fence = await acquireAttemptFence(scope, {
    cwd: opts.cwd,
    agentDir: opts.agentDir,
    fenceTimeoutMs: opts.fenceTimeoutMs,
    projectTrusted: opts.projectTrusted,
  });
  if (!fence.ok) {
    const selStr = selectorToString(selectorInput);
    return blockedResult(scope, locatorInput, selStr, expectedRevision, [fence.finding!], null, opts);
  }
  const handle = fence.handle!;

  let acquiredPath: string | undefined;
  let createdTemp = false;

  try {
    const registrationId = opts.preallocatedId ?? allocateRegistrationId();

    // Normalize locator
    const locRes = normalizeGitLocator(locatorInput, scope);
    if (!locRes.ok) {
      const selStr = selectorToString(selectorInput);
      return blockedResult(scope, locatorInput, selStr, expectedRevision, locRes.findings, handle, opts);
    }
    const locator = locRes.locator!;

    // Normalize selector
    let selRes;
    if (typeof selectorInput === 'string') {
      selRes = parseGitSelectorString(selectorInput, scope);
    } else {
      selRes = normalizeGitSelector(selectorInput as GitSelectorInput, scope);
    }
    if (!selRes.ok) {
      return blockedResult(
        scope,
        locatorInput,
        selectorToString(selectorInput),
        expectedRevision,
        selRes.findings,
        handle,
        opts,
      );
    }
    const selector = selRes.selector!;
    const selCanonical = selector.canonical;

    // Git Source Key (canonical URL + exact selector), distinct from local
    const sourceKey = gitSourceKey(locator, selector);

    // Duplicate check (same scope, same kind+key)
    const dup = findDuplicateRegistration(scope, sourceKey, registrations);
    if (dup.duplicate) {
      return blockedResult(scope, locatorInput, selCanonical, expectedRevision, [dup.finding!], handle, opts, dup.existing);
    }

    // Non-executing Source Acquisition (clone --no-checkout, no hooks/filters/submodules)
    const acq = await acquireGitSource({
      scope,
      locator,
      selector,
      trust: opts.trust,
      executor: opts.executor,
      destDir: opts.destDir,
    });
    if (!acq.ok) {
      return blockedResult(scope, locatorInput, selCanonical, expectedRevision, acq.findings, handle, opts);
    }
    acquiredPath = realpathSync.native(acq.acquiredPath!);
    createdTemp = acq.createdTemp ?? false;
    const resolvedRevision = acq.resolvedRevision!;

    // Attach resolved to sourceKey for provenance
    (sourceKey as SourceKey).resolvedRevision = resolvedRevision;
    (sourceKey as SourceKey).canonicalUrl = locator.canonicalUrl;
    (sourceKey as SourceKey).selector = selCanonical;

    // Catalog / containment / budget
    const findings: ValidationFinding[] = [];
    const catalogPath = join(acquiredPath, MARKETPLACE_CATALOG_RELPATH);
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
      cleanupAcquisition(acquiredPath);
      return blockedResult(scope, locatorInput, selCanonical, expectedRevision, [finding], handle, opts);
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
      cleanupAcquisition(acquiredPath);
      return blockedResult(scope, locatorInput, selCanonical, expectedRevision, [finding], handle, opts);
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
      cleanupAcquisition(acquiredPath);
      return blockedResult(scope, locatorInput, selCanonical, expectedRevision, [finding], handle, opts);
    }

    const catalogResult = parseCatalog(parsed, { scope });
    findings.push(...catalogResult.findings);
    if (!catalogResult.ok) {
      cleanupAcquisition(acquiredPath);
      return blockedResult(scope, locatorInput, selCanonical, expectedRevision, sortFindings(findings), handle, opts);
    }
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

    for (const entry of catalog.entries) {
      if (entry.type !== 'local' || !entry.path) continue;
      const res = resolveContained(acquiredPath, entry.path, 'any');
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

    const snapshotResult = buildGitSnapshot(acquiredPath, sourceKey, scope, {
      canonicalLocator: locator.canonicalUrl,
      resolvedRevision,
      selectorCanonical: selCanonical,
    });
    findings.push(...snapshotResult.findings);

    const sorted = sortFindings(findings);
    if (hasBlocking(sorted)) {
      cleanupAcquisition(acquiredPath);
      return blockedResult(scope, locatorInput, selCanonical, expectedRevision, sorted, handle, opts);
    }

    const alias = deriveInitialAlias(
      catalog.name,
      registrations.map((r) => r.alias).filter((a): a is string => Boolean(a)),
    );

    const preflight: GitRegistrationPreflight = {
      scope,
      registrationId,
      alias,
      sourceKey,
      locator,
      selector,
      resolvedRevision,
      marketplaceName: catalog.name,
      catalog,
      snapshot: snapshotResult.snapshot!,
      findings: sorted,
      blocked: false,
      stateRevision: expectedRevision,
      fence: handle,
      terminal: false,
      acquiredPath,
      createdTemp,
    };
    return { ok: true, preflight };
  } catch (e) {
    if (acquiredPath) cleanupAcquisition(acquiredPath);
    handle.release();
    const msg = e instanceof Error ? e.message : String(e);
    const finding = blocking({
      code: CODE.GIT_ACQUISITION_FAILED,
      phase: 'validation',
      target: 'registration',
      scope,
      pointer: '',
      rule: RULE.GIT_ACQUISITION_FAILED,
      outcome: `preflight failed: ${msg}`,
    });
    const selStr = selectorToString(selectorInput);
    return blockedResult(scope, locatorInput, selStr, expectedRevision, [finding], null, opts);
  }
}

function snapshotBinds(snapshot: ValidationSnapshot) {
  return { profile: snapshot.profile, ruleset: snapshot.ruleset, budget: snapshot.budget };
}

export async function confirmGitRegistration(
  preflight: GitRegistrationPreflight,
  yes: boolean,
  opts: GitRegistrationFlowOptions = {},
): Promise<GitRegistrationOutcome> {
  if (preflight.terminal) {
    const receipt = createReceipt({
      operation: OPERATION,
      scope: preflight.scope,
      trigger: triggerFor(preflight.locator.canonicalUrl, preflight.selector.canonical),
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
    await appendReceipt(preflight.scope, receipt, opts);
    return { status: 'blocked', findings: [], receipt };
  }
  preflight.terminal = true;
  const { fence, scope } = preflight;
  const release = () => {
    fence.release();
    if (preflight.acquiredPath) cleanupAcquisition(preflight.acquiredPath);
  };

  if (!yes) {
    const receipt = createReceipt({
      operation: OPERATION,
      scope,
      trigger: triggerFor(preflight.locator.canonicalUrl, preflight.selector.canonical),
      expectedStateRevision: preflight.stateRevision,
      validationSnapshot: preflight.snapshot.fingerprint,
      summary: 'Declined',
      findings: preflight.findings,
      stateChanged: false,
    });
    await appendReceipt(scope, receipt, opts);
    release();
    return { status: 'declined', receipt };
  }

  const fresh = await readScopeState(scope, opts);
  if (fresh.status !== 'ok' && fresh.status !== 'missing') {
    const receipt = createReceipt({
      operation: OPERATION,
      scope,
      trigger: triggerFor(preflight.locator.canonicalUrl, preflight.selector.canonical),
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
    await appendReceipt(scope, receipt, opts);
    release();
    return { status: 'persistence-failed', receipt, isIndeterminate: true };
  }
  const currentRevision = fresh.state!.stateRevision;
  if (currentRevision !== preflight.stateRevision) {
    const receipt = createReceipt({
      operation: OPERATION,
      scope,
      trigger: triggerFor(preflight.locator.canonicalUrl, preflight.selector.canonical),
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
    await appendReceipt(scope, receipt, opts);
    release();
    return { status: 'rejected-as-stale', receipt };
  }

  const dup = findDuplicateRegistration(scope, preflight.sourceKey, fresh.state!.registrations);
  if (dup.duplicate) {
    const receipt = createReceipt({
      operation: OPERATION,
      scope,
      trigger: triggerFor(preflight.locator.canonicalUrl, preflight.selector.canonical),
      expectedStateRevision: preflight.stateRevision,
      validationSnapshot: preflight.snapshot.fingerprint,
      summary: 'Blocked',
      findings: [dup.finding!],
    });
    await appendReceipt(scope, receipt, opts);
    release();
    return { status: 'blocked', findings: [dup.finding!], receipt, existing: dup.existing };
  }

  const registration: Registration = {
    id: preflight.registrationId,
    alias: preflight.alias,
    marketplaceName: preflight.marketplaceName,
    sourceKind: 'git',
    source: preflight.locator.canonicalUrl,
    sourceKey: preflight.sourceKey,
    canonicalLocator: preflight.locator.canonicalUrl,
    gitSelector: { kind: preflight.selector.kind, canonical: preflight.selector.canonical, raw: preflight.selector.raw },
    resolvedRevision: preflight.resolvedRevision,
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
      trigger: triggerFor(preflight.locator.canonicalUrl, preflight.selector.canonical),
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
    await appendReceipt(scope, receipt, opts);
    release();
    return { status: 'persistence-failed', receipt, isIndeterminate: write.isIndeterminate ?? false };
  }

  const targetRevision = write.newRevision!;
  const hasDiagnostics = preflight.findings.some((f) => f.classification !== 'blocking');
  const receipt = createReceipt({
    operation: OPERATION,
    scope,
    trigger: triggerFor(preflight.locator.canonicalUrl, preflight.selector.canonical),
    expectedStateRevision: preflight.stateRevision,
    targetStateRevision: targetRevision,
    observedStateRevision: targetRevision,
    validationSnapshot: preflight.snapshot.fingerprint,
    summary: hasDiagnostics ? 'Completed with diagnostics' : 'Completed',
    findings: preflight.findings,
    stateChanged: true,
  });
  await appendReceipt(scope, receipt, opts);
  release();
  return { status: 'completed', registration, receipt, newRevision: targetRevision };
}

export function cancelGitRegistration(preflight: GitRegistrationPreflight): void {
  if (preflight.terminal) return;
  preflight.terminal = true;
  preflight.fence.release();
  if (preflight.acquiredPath) cleanupAcquisition(preflight.acquiredPath);
}

export function disclosureSummaryGit(preflight: GitRegistrationPreflight): string {
  const entries = preflight.catalog.entries;
  const available = entries.filter((e) => e.available).length;
  const unavailable = entries.length - available;
  const blockingCount = preflight.findings.filter((f) => f.classification === 'blocking').length;
  const warningCount = preflight.findings.filter((f) => f.classification === 'warning').length;
  const lines = [
    `Scope: ${preflight.scope}`,
    `Canonical Locator: ${preflight.locator.canonicalUrl} (${preflight.locator.transport} · ${preflight.locator.host}${preflight.locator.port ? `:${preflight.locator.port}` : ''}${preflight.locator.path}${preflight.locator.user ? ` · user=${preflight.locator.user}` : ''})`,
    `Git Selector: ${preflight.selector.kind} → ${preflight.selector.canonical}`,
    `Resolved Revision: ${preflight.resolvedRevision}`,
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
