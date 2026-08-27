/**
 * Lifecycle module — Refresh / Update Candidate / Apply Update / Rebind / Removal.
 * See CONTEXT.md: Marketplace Refresh, Update Candidate, Update Plan, Apply Update,
 * Registration Rebind, Registration Removal, Installation Removal, Lifecycle Operation.
 *
 * Marketplace Refresh is a non-mutating inspection: it never writes Bridge State and never
 * acquires the Attempt Fence (checks and Refresh stay available while mutations are barred).
 * It produces either no change or an Update Candidate applied only by a separate
 * Lifecycle Operation bound to a complete Update Plan.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { readBridgeState } from '../bridge-state/store.js';
import type { BridgeState } from '../bridge-state/types.js';
import type { MarketplaceFormat, Registration } from '../bridge-state/types.js';
import type { MarketplaceInspection } from '../installation/inspection.js';
import { inspectMarketplaceEntries } from '../installation/inspection.js';
import type { Catalog, MarketplaceEntry } from '../registration/catalog.js';
import {
  CODE,
  RULE,
  blocking,
  sortFindings,
  type ValidationFinding,
} from '../registration/findings.js';
import {
  acquireGitSource,
  cleanupAcquisition,
  resolveGitRevision,
  type GitExecutor,
} from '../registration/git-acquisition.js';
import { SourceCache } from '../cache/source-cache.js';
import { catalogContractFor, detectMarketplaceFormat } from '../registration/format.js';
import { normalizeGitLocator } from '../registration/git-locator.js';
import {
  normalizeGitSelector,
  type GitSelectorInput,
} from '../registration/git-selector.js';
import { createReceipt, type AttemptReceipt } from '../registration/receipt.js';
import {
  buildGitSnapshot,
  buildLocalSnapshot,
  type ValidationSnapshot,
} from '../registration/snapshot.js';
import { gitSourceKey, type SourceKey } from '../registration/source-key.js';
import {
  acquireGitEntry,
  checkEntryDrift,
  parseGitEntrySpec,
} from '../registration/entry-acquisition.js';

export interface LifecycleFlowOptions {
  agentDir?: string;
  fenceTimeoutMs?: number;
  /** Injected git executor for tests. */
  executor?: GitExecutor;
  /** Injected Source Cache (defaults to a cache under the given agentDir). */
  cache?: SourceCache;
}

/**
 * A newly validated source state for one Registration that differs from its recorded
 * Validation Snapshot. Applied only by a separate Lifecycle Operation (Apply Update /
 * Registration Rebind) under a complete Update Plan.
 */
export interface UpdateCandidate {
  registrationId: string;
  /** State Revision observed while this candidate was validated; plans bind exactly this. */
  stateRevision: string;
  /** Recorded Validation Snapshot fingerprint before the refresh. */
  recordedFingerprint?: string;
  recordedResolvedRevision?: string;
  /** Newly validated snapshot with full tree + binds (base-tree fingerprint, as registered). */
  snapshot: ValidationSnapshot;
  marketplaceName: string;
  /** Marketplace Format detected on the candidate source state; applied only by the explicit Apply Update / Rebind commit. */
  format?: MarketplaceFormat;
  catalog: Catalog;
  inspection: MarketplaceInspection;
  sourceKey: SourceKey;
  /** Git-only binds of the candidate state. */
  canonicalLocator?: string;
  resolvedRevision?: string;
  selectorCanonical?: string;
  /** Per-entry candidate Validation Snapshot fingerprints */
  entrySnapshots?: Record<string, string>;
}

export type RefreshOutcome =
  | { status: 'no-change'; receipt: AttemptReceipt }
  | { status: 'update-candidate'; candidate: UpdateCandidate; receipt: AttemptReceipt }
  | { status: 'blocked'; findings: ValidationFinding[]; receipt: AttemptReceipt };

const OPERATION = 'Marketplace Refresh';

function finding(code: string, rule: string, target: ValidationFinding['target'], pointer: string, outcome: string): ValidationFinding {
  return blocking({ code, rule, target, pointer, outcome, phase: 'validation' });
}

async function refreshGitEntries(
  entries: MarketplaceEntry[],
  currentEntrySnapshots: Record<string, string>,
  opts: LifecycleFlowOptions,
  cache: SourceCache,
): Promise<{
  anyMoved: boolean;
  candidateEntrySnapshots: Record<string, string>;
  candidateEntryRoots: Map<string, string>;
  cleanups: Array<() => void>;
}> {
  const candidateEntrySnapshots: Record<string, string> = {};
  const candidateEntryRoots = new Map<string, string>();
  const cleanups: Array<() => void> = [];
  let anyMoved = false;

  for (const entry of entries) {
    if (entry.type !== 'git' || !entry.available) continue;
    const parsedSpec = parseGitEntrySpec(entry.source, entry.entryId);
    if (!parsedSpec.ok || !parsedSpec.spec) continue;
    const spec = parsedSpec.spec;
    const recordedFp = currentEntrySnapshots[entry.entryId];

    if (spec.effectivePin === 'sha') {
      // sha-pinned: ref movement upstream DOES NOT produce an update candidate
      if (recordedFp) {
        candidateEntrySnapshots[entry.entryId] = recordedFp;
      } else {
        const acq = await acquireGitEntry({ spec, entryId: entry.entryId, executor: opts.executor, cache });
        if (acq.ok && acq.snapshot) {
          candidateEntrySnapshots[entry.entryId] = acq.snapshot.fingerprint;
          if (acq.entryRootPath) candidateEntryRoots.set(entry.entryId, acq.entryRootPath);
          if (acq.acquiredPath && acq.createdTemp) {
            cleanups.push(() => cleanupAcquisition(acq.acquiredPath!));
          }
          if (checkEntryDrift(acq.snapshot.fingerprint, recordedFp ?? '')) {
            anyMoved = true;
          }
        }
      }
    } else {
      // Movable ref or default selector: resolve upstream revision
      const res = await resolveGitRevision(spec.locator, spec.selector, { executor: opts.executor });
      if (res.ok) {
        const resolvedSha = res.sha;
        let needAcquire = true;
        if (recordedFp) {
          const hit = await cache.hitExact(recordedFp);
          if (hit) {
            const verified = buildGitSnapshot(hit.path, gitSourceKey(spec.locator, spec.selector), {
              canonicalLocator: spec.locator.canonicalUrl,
              resolvedRevision: resolvedSha,
              selectorCanonical: spec.selector.canonical,
            });
            if (verified.ok && verified.snapshot!.fingerprint === recordedFp) {
              candidateEntrySnapshots[entry.entryId] = recordedFp;
              candidateEntryRoots.set(entry.entryId, hit.path);
              needAcquire = false;
            }
          }
        }

        if (needAcquire) {
          const acq = await acquireGitEntry({ spec, entryId: entry.entryId, executor: opts.executor, cache });
          if (acq.ok && acq.snapshot) {
            candidateEntrySnapshots[entry.entryId] = acq.snapshot.fingerprint;
            if (acq.entryRootPath) candidateEntryRoots.set(entry.entryId, acq.entryRootPath);
            if (acq.acquiredPath && acq.createdTemp) {
              cleanups.push(() => cleanupAcquisition(acq.acquiredPath!));
            }
            if (!recordedFp || checkEntryDrift(acq.snapshot.fingerprint, recordedFp)) {
              anyMoved = true;
            }
          }
        }
      }
    }
  }

  return { anyMoved, candidateEntrySnapshots, candidateEntryRoots, cleanups };
}

function blocked(registrationId: string, revision: string, findings: ValidationFinding[], snapshot?: string): RefreshOutcome {
  return {
    status: 'blocked',
    findings: sortFindings(findings),
    receipt: createReceipt({
      operation: OPERATION,
      trigger: `refresh ${registrationId}`,
      expectedStateRevision: revision,
      validationSnapshot: snapshot,
      summary: 'Blocked',
      findings,
    }),
  };
}

/** Marketplace name embedded in an inspection Marketplace ID ('<registrationId>/<name>'). */
export function marketplaceNameOf(registrationId: string, marketplaceId: string | undefined): string {
  return marketplaceId && marketplaceId.startsWith(`${registrationId}/`)
    ? marketplaceId.slice(registrationId.length + 1)
    : '';
}

/** Reconstruct a selector input from a persisted canonical Git Selector. */
export function selectorInputFromStored(gs: NonNullable<Registration['gitSelector']>): GitSelectorInput {
  switch (gs.kind) {
    case 'default':
      return { kind: 'default' };
    case 'branch':
      return { kind: 'branch', value: gs.canonical.replace(/^refs\/heads\//, '') };
    case 'tag':
      return { kind: 'tag', value: gs.canonical.replace(/^refs\/tags\//, '') };
    case 'commit':
      return { kind: 'commit', value: gs.canonical };
  }
}

function readStateForRefresh(opts: LifecycleFlowOptions) {
  return readBridgeState({ agentDir: opts.agentDir });
}

/**
 * Explicit, non-mutating inspection of the current Marketplace Source for one Registration.
 * Local sources re-walk the live tree; Git sources re-resolve the selector — a changed
 * Resolved Revision requires new validation (a full-commit selector cannot move, so ref
 * movement alone never produces an Update Candidate). Bridge State is never written.
 */
export async function refreshRegistration(
  registrationId: string,
  opts: LifecycleFlowOptions = {},
): Promise<RefreshOutcome> {
  const read = await readStateForRefresh(opts);
  if (read.status !== 'ok' && read.status !== 'missing') {
    return blocked(
      registrationId,
      '?',
      [finding(CODE.PERSISTENCE_INDETERMINATE, 'PERSIST-01', 'attempt', '', read.error ?? 'Bridge State is not readable; neither previous nor target verifiable')],
    );
  }
  const state = read.state!;
  const revision = state.stateRevision;
  const registration = state.registrations.find((item) => item.id === registrationId);
  if (!registration) {
    return blocked(registrationId, revision, [
      finding(CODE.REGISTRATION_NOT_FOUND, RULE.REGISTRATION_NOT_FOUND, 'registration', '', `Registration '${registrationId}' is not in Bridge State`),
    ]);
  }

  if (registration.sourceKind === 'git') {
    return refreshGitRegistration(registration, revision, opts);
  }
  return refreshLocalRegistration(registration, revision, opts);
}

async function refreshLocalRegistration(
  registration: Registration,
  revision: string,
  opts: LifecycleFlowOptions,
): Promise<RefreshOutcome> {
  if (!registration.sourceKey || !registration.source) {
    return blocked(registration.id, revision, [
      finding(CODE.SOURCE_REACQUISITION_REQUIRED, RULE.SOURCE_REACQUISITION_REQUIRED, 'registration', '', 'Registration has no retained local Source Key to revalidate'),
    ], registration.validationSnapshot);
  }

  const snap = buildLocalSnapshot(registration.source, registration.sourceKey);
  if (!snap.ok || !snap.snapshot) {
    return blocked(registration.id, revision, snap.findings, registration.validationSnapshot);
  }

  const liveFormat = detectMarketplaceFormat(registration.source);
  const contract = catalogContractFor(liveFormat ?? registration.format ?? 'codex');
  const catalogPath = join(registration.source, ...contract.relPath.split('/'));
  let catalogRaw: string | undefined;
  let parsedCatalog: unknown;
  try {
    catalogRaw = readFileSync(catalogPath, 'utf8');
    parsedCatalog = JSON.parse(catalogRaw);
  } catch {
    // Handled by inspectMarketplaceEntries
  }
  const parsed = parsedCatalog ? contract.parse(parsedCatalog) : undefined;
  const entries = parsed?.catalog?.entries ?? [];

  const cache = opts.cache ?? new SourceCache({ agentDir: opts.agentDir });
  const { anyMoved, candidateEntrySnapshots, candidateEntryRoots, cleanups } = await refreshGitEntries(
    entries,
    registration.entrySnapshots ?? {},
    opts,
    cache,
  );

  const rootMoved = !registration.validationSnapshot || snap.snapshot.fingerprint !== registration.validationSnapshot;

  try {
    if (rootMoved || anyMoved) {
      // The candidate's own format is detected fresh from the live tree — a flipped root can only
      // reach the Registration through this Update Candidate plus an explicit Apply Update.
      const inspection = inspectMarketplaceEntries(registration, {
        ignoreRecordedDrift: true,
        format: liveFormat ?? undefined,
        cache,
        entryRoots: candidateEntryRoots,
        entrySnapshots: candidateEntrySnapshots,
      });
      const name = marketplaceNameOf(registration.id, inspection.marketplaceId) || registration.marketplaceName || '';
      const candidate: UpdateCandidate = {
        registrationId: registration.id,
        stateRevision: revision,
        recordedFingerprint: registration.validationSnapshot,
        recordedResolvedRevision: registration.resolvedRevision,
        snapshot: snap.snapshot,
        marketplaceName: name,
        format: liveFormat ?? undefined,
        catalog: { name, entries: inspection.entries.map((item) => item.entry) },
        inspection,
        sourceKey: registration.sourceKey,
        entrySnapshots: candidateEntrySnapshots,
      };
      for (const fp of Object.values(candidateEntrySnapshots)) {
        cache.recordPendingUpdate({ registrationId: registration.id, fingerprint: fp });
      }
      return {
        status: 'update-candidate',
        candidate,
        receipt: createReceipt({
          operation: OPERATION,
          trigger: `refresh ${registration.id}`,
          expectedStateRevision: revision,
          validationSnapshot: snap.snapshot.fingerprint,
          summary: 'Completed',
          findings: inspection.findings,
          stateChanged: false,
        }),
      };
    }

    return {
      status: 'no-change',
      receipt: createReceipt({
        operation: OPERATION,
        trigger: `refresh ${registration.id}`,
        expectedStateRevision: revision,
        validationSnapshot: registration.validationSnapshot,
        summary: 'Completed',
        stateChanged: false,
      }),
    };
  } finally {
    for (const cleanup of cleanups) cleanup();
  }
}

/** Reconstruct the full Source Key for a Registration at an exact Resolved Revision. */
function sourceKeyAt(registration: Registration, resolvedRevision: string): SourceKey {
  return { ...registration.sourceKey!, resolvedRevision };
}

async function refreshGitRegistration(
  registration: Registration,
  revision: string,
  opts: LifecycleFlowOptions,
): Promise<RefreshOutcome> {
  if (!registration.canonicalLocator || !registration.gitSelector || !registration.sourceKey) {
    return blocked(registration.id, revision, [
      finding(CODE.SOURCE_REACQUISITION_REQUIRED, RULE.SOURCE_REACQUISITION_REQUIRED, 'registration', '', 'Registration has no retained Canonical Git Locator / Git Selector to revalidate'),
    ], registration.validationSnapshot);
  }

  const locRes = normalizeGitLocator(registration.canonicalLocator);
  if (!locRes.ok) return blocked(registration.id, revision, locRes.findings, registration.validationSnapshot);
  const selRes = normalizeGitSelector(selectorInputFromStored(registration.gitSelector));
  if (!selRes.ok) return blocked(registration.id, revision, selRes.findings, registration.validationSnapshot);
  const locator = locRes.locator!;
  const selector = selRes.selector!;
  const cache = opts.cache ?? new SourceCache({ agentDir: opts.agentDir });

  const noChangeReceipt = () =>
    createReceipt({
      operation: OPERATION,
      trigger: `refresh ${registration.id}`,
      expectedStateRevision: revision,
      validationSnapshot: registration.validationSnapshot,
      summary: 'Completed',
      findings: [],
      stateChanged: false,
    });

  // Cheap resolution first — a hit path never needs a clone.
  const resolution = await resolveGitRevision(locator, selector, { executor: opts.executor });

  if (!resolution.ok) {
    // Offline / unreachable remote: only an exact fingerprint hit may be reused. The cached
    // tree is re-hashed and must equal the recorded Validation Snapshot exactly — any mismatch
    // is Source Drift (Blocking Finding); a Stale Snapshot is never converted into success.
    const offline = registration.validationSnapshot
      ? await cache.offlineHit(locator.canonicalUrl, selector.canonical, registration.validationSnapshot)
      : null;
    if (offline) {
      const verified = buildGitSnapshot(offline.path, sourceKeyAt(registration, registration.resolvedRevision!), {
        canonicalLocator: locator.canonicalUrl,
        resolvedRevision: registration.resolvedRevision!,
        selectorCanonical: selector.canonical,
      });
      if (verified.ok && verified.snapshot!.fingerprint === registration.validationSnapshot) {
        return { status: 'no-change', receipt: noChangeReceipt() };
      }
      return blocked(registration.id, revision, [
        finding(CODE.SOURCE_DRIFT, RULE.SOURCE_DRIFT, 'registration', '', `Source Drift: cached tree at fingerprint ${String(registration.validationSnapshot).slice(0, 16)}… no longer hashes to the recorded Validation Snapshot; Marketplace Refresh against a reachable source is required`),
      ], registration.validationSnapshot);
    }
    return blocked(registration.id, revision, resolution.findings, registration.validationSnapshot);
  }

  const resolvedRevision = resolution.sha;

  let root: string | undefined;
  let acqToCleanup: string | undefined;
  let snap: ReturnType<typeof buildGitSnapshot> | undefined;

  if (resolvedRevision === registration.resolvedRevision && registration.validationSnapshot) {
    // Same Resolved Revision: exact-fingerprint cache hit avoids a full acquisition.
    const hit = await cache.hitExact(registration.validationSnapshot);
    if (hit) {
      const verified = buildGitSnapshot(hit.path, sourceKeyAt(registration, resolvedRevision), {
        canonicalLocator: locator.canonicalUrl,
        resolvedRevision,
        selectorCanonical: selector.canonical,
      });
      if (verified.ok && verified.snapshot!.fingerprint === registration.validationSnapshot) {
        root = hit.path;
        snap = verified;
      }
    }
  }

  if (!root) {
    // Full non-executing acquisition (clone).
    const acq = await acquireGitSource({
      locator,
      selector,
      executor: opts.executor,
    });
    if (!acq.ok) return blocked(registration.id, revision, acq.findings, registration.validationSnapshot);
    root = acq.acquiredPath!;
    acqToCleanup = root;
    const newSourceKey: SourceKey = { ...registration.sourceKey, resolvedRevision };
    snap = buildGitSnapshot(root, newSourceKey, {
      canonicalLocator: locator.canonicalUrl,
      resolvedRevision,
      selectorCanonical: selector.canonical,
    });
  }

  try {
    if (!snap || !snap.ok || !snap.snapshot) {
      return blocked(registration.id, revision, snap?.findings ?? [], registration.validationSnapshot);
    }

    const liveFormat = detectMarketplaceFormat(root);
    const contract = catalogContractFor(liveFormat ?? registration.format ?? 'codex');
    const catalogPath = join(root, ...contract.relPath.split('/'));
    let catalogRaw: string | undefined;
    let parsedCatalog: unknown;
    try {
      catalogRaw = readFileSync(catalogPath, 'utf8');
      parsedCatalog = JSON.parse(catalogRaw);
    } catch {
      // Handled by inspectMarketplaceEntries
    }
    const parsed = parsedCatalog ? contract.parse(parsedCatalog) : undefined;
    const entries = parsed?.catalog?.entries ?? [];

    const { anyMoved, candidateEntrySnapshots, candidateEntryRoots, cleanups } = await refreshGitEntries(
      entries,
      registration.entrySnapshots ?? {},
      opts,
      cache,
    );

    try {
      const rootChanged = resolvedRevision !== registration.resolvedRevision || snap.snapshot.fingerprint !== registration.validationSnapshot;

      if (rootChanged || anyMoved) {
        const inspection = inspectMarketplaceEntries(registration, {
          root,
          baseSnapshot: snap.snapshot,
          ignoreRecordedDrift: true,
          format: liveFormat ?? undefined,
          cache,
          entryRoots: candidateEntryRoots,
          entrySnapshots: candidateEntrySnapshots,
        });
        const name = marketplaceNameOf(registration.id, inspection.marketplaceId) || registration.marketplaceName || '';
        const candidate: UpdateCandidate = {
          registrationId: registration.id,
          stateRevision: revision,
          recordedFingerprint: registration.validationSnapshot,
          recordedResolvedRevision: registration.resolvedRevision,
          snapshot: snap.snapshot,
          marketplaceName: name,
          format: liveFormat ?? undefined,
          catalog: { name, entries: inspection.entries.map((item) => item.entry) },
          inspection,
          sourceKey: { ...registration.sourceKey, resolvedRevision },
          canonicalLocator: locator.canonicalUrl,
          resolvedRevision,
          selectorCanonical: selector.canonical,
          entrySnapshots: candidateEntrySnapshots,
        };
        await cache.storeTree(root, snap.snapshot.fingerprint);
        cache.recordIndex({
          fingerprint: snap.snapshot.fingerprint,
          resolvedRevision,
          canonicalLocator: locator.canonicalUrl,
          selectorCanonical: selector.canonical,
        });
        cache.recordPendingUpdate({ registrationId: registration.id, fingerprint: snap.snapshot.fingerprint });
        for (const fp of Object.values(candidateEntrySnapshots)) {
          cache.recordPendingUpdate({ registrationId: registration.id, fingerprint: fp });
        }
        return {
          status: 'update-candidate',
          candidate,
          receipt: createReceipt({
            operation: OPERATION,
            trigger: `refresh ${registration.id}`,
            expectedStateRevision: revision,
            validationSnapshot: snap.snapshot.fingerprint,
            summary: 'Completed',
            findings: inspection.findings,
            stateChanged: false,
          }),
        };
      }

      if (registration.validationSnapshot) {
        await cache.storeTree(root, registration.validationSnapshot);
        cache.recordIndex({
          fingerprint: registration.validationSnapshot,
          resolvedRevision,
          canonicalLocator: locator.canonicalUrl,
          selectorCanonical: selector.canonical,
        });
      }
      return {
        status: 'no-change',
        receipt: noChangeReceipt(),
      };
    } finally {
      for (const cleanup of cleanups) cleanup();
    }
  } finally {
    if (acqToCleanup) cleanupAcquisition(acqToCleanup);
  }
}
