/** Read-only Marketplace Entry inspection.
 *
 * This is deliberately separate from lifecycle preflight: it never acquires an Attempt Fence,
 * creates a receipt, or reads Bridge State.  One bounded snapshot and one catalog parse produce
 * all browse results for a Marketplace.
 */

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

import {
  classifyPlugin,
  type CompatiblePlugin,
  type PluginClassification,
} from '../compatibility/profile.js';
import type { Registration, Scope } from '../bridge-state/types.js';
import type { MarketplaceEntry } from '../registration/catalog.js';
import { parseCatalog } from '../registration/catalog.js';
import { resolveContained } from '../registration/contained.js';
import { CODE, RULE, blocking, hasBlocking, sortFindings, type ValidationFinding } from '../registration/findings.js';
import { SourceCache } from '../cache/source-cache.js';
import { localSourceKey, type SourceKey } from '../registration/source-key.js';
import { bindCapturedMaterial, buildGitSnapshot, buildLocalSnapshot, type ValidationSnapshot } from '../registration/snapshot.js';
import { BUDGET } from '../registration/budget.js';

export interface InspectedMarketplaceEntry {
  entry: MarketplaceEntry;
  /** Read-only Compatibility Profile result retained for the Plugins ledger IA. */
  classification?: PluginClassification;
  plugin?: CompatiblePlugin;
  findings: ValidationFinding[];
  unavailableReason?: string;
}

export interface MarketplaceInspection {
  entries: InspectedMarketplaceEntry[];
  findings: ValidationFinding[];
  marketplaceId?: string;
  snapshot?: ValidationSnapshot;
  /** Fingerprint of the inspected source tree alone, before activation-material binding.
   *  Registrations persist exactly this value at confirmation (their preflight snapshot is
   *  the unbound tree fingerprint from buildLocalSnapshot); Source Drift compares against it. */
  treeFingerprint?: string;
}

export interface InspectionOptions {
  /** Inspect this explicit root with this caller-bound base Validation Snapshot (e.g. a Git acquisition tree) instead of deriving a local one from the Registration. */
  root?: string;
  baseSnapshot?: ValidationSnapshot;
  /** Suppress the recorded-snapshot drift Blocking Finding — Refresh compares fingerprints explicitly instead. */
  ignoreRecordedDrift?: boolean;
  agentDir?: string;
  cache?: SourceCache;
}

function inspectionFinding(scope: Scope, code: string, rule: string, target: ValidationFinding['target'], outcome: string): ValidationFinding {
  return blocking({ code, rule, target, pointer: '', outcome, scope, phase: 'validation' });
}

/** Inspect every Marketplace Entry once. All filesystem work occurs after a bounded snapshot. */
export function inspectMarketplaceEntries(registration: Registration, scope: Scope, opts: InspectionOptions = {}): MarketplaceInspection {
  const override = Boolean(opts.root && opts.baseSnapshot);
  let root: string;
  let snapshotResult: { ok: boolean; snapshot?: ValidationSnapshot; findings: ValidationFinding[] };
  if (override) {
    try {
      root = realpathSync.native(opts.root!);
    } catch {
      root = opts.root!;
    }
    snapshotResult = { ok: true, snapshot: opts.baseSnapshot, findings: [] };
  } else if (registration.sourceKind === 'git') {
    if (!registration.validationSnapshot) {
      return {
        entries: [],
        findings: [inspectionFinding(scope, CODE.SOURCE_REACQUISITION_REQUIRED, RULE.SOURCE_REACQUISITION_REQUIRED, 'registration', 'Git Registration has no retained Validation Snapshot; re-registration or Marketplace Refresh is required')],
      };
    }
    const cache = opts.cache ?? new SourceCache({ agentDir: opts.agentDir });
    const hit = cache.hitExactSync(registration.validationSnapshot);
    if (!hit) {
      return {
        entries: [],
        findings: [inspectionFinding(scope, CODE.SOURCE_REACQUISITION_REQUIRED, RULE.SOURCE_REACQUISITION_REQUIRED, 'registration', `Git Source Cache miss: Validation Snapshot '${registration.validationSnapshot.slice(0, 16)}…' is not retained in Source Cache; Marketplace Refresh or re-acquisition is required`)],
      };
    }
    try {
      root = realpathSync.native(hit.path);
    } catch {
      root = hit.path;
    }
    const canonicalLocator = registration.canonicalLocator ?? registration.source ?? '';
    const selectorCanonical = registration.gitSelector?.canonical ?? '';
    const resolvedRevision = registration.resolvedRevision ?? '';
    const sourceKey: SourceKey = registration.sourceKey ?? {
      kind: 'git',
      key: `git:${canonicalLocator}#${selectorCanonical}`,
      canonicalUrl: canonicalLocator,
      selector: selectorCanonical,
      resolvedRevision,
    };
    const snapResult = buildGitSnapshot(root, sourceKey, scope, {
      canonicalLocator,
      resolvedRevision,
      selectorCanonical,
    });
    if (!snapResult.ok || !snapResult.snapshot) {
      return { entries: [], findings: snapResult.findings };
    }
    if (snapResult.snapshot.fingerprint !== registration.validationSnapshot) {
      return {
        entries: [],
        findings: [inspectionFinding(scope, CODE.SOURCE_DRIFT, RULE.SOURCE_DRIFT, 'registration', `Source Drift: cached tree at fingerprint ${registration.validationSnapshot.slice(0, 16)}… no longer hashes to the recorded Validation Snapshot; Marketplace Refresh is required`)],
      };
    }
    snapshotResult = snapResult;
  } else if (registration.sourceKind === 'local' || (!registration.sourceKind && registration.source && !registration.canonicalLocator)) {
    if (!registration.source) {
      return { entries: [], findings: [inspectionFinding(scope, CODE.SOURCE_REACQUISITION_REQUIRED, RULE.SOURCE_REACQUISITION_REQUIRED, 'registration', 'Local Registration has no source path')] };
    }
    const key = localSourceKey(registration.source);
    if (!key.ok) return { entries: [], findings: [inspectionFinding(scope, CODE.SOURCE_REACQUISITION_REQUIRED, RULE.SOURCE_REACQUISITION_REQUIRED, 'registration', key.error ?? 'Marketplace Root cannot be revalidated')] };
    root = key.sourceKey!.canonicalPath!;
    const catalogPath = join(root, '.agents', 'plugins', 'marketplace.json');
    try {
      if (lstatSync(catalogPath).size > BUDGET.maxCatalogBytes) {
        return { entries: [], findings: [inspectionFinding(scope, CODE.BUDGET_EXCEEDED, RULE.BUDGET_EXCEEDED, 'catalog', `Validation Budget exceeded: catalog exceeds ${BUDGET.maxCatalogBytes} bytes`)] };
      }
    } catch {
      // The catalog read below provides the stable catalog-missing finding.
    }
    snapshotResult = buildLocalSnapshot(root, key.sourceKey!, scope);
    if (!snapshotResult.ok) return { entries: [], findings: snapshotResult.findings };
  } else {
    return {
      entries: [],
      findings: [inspectionFinding(scope, CODE.SOURCE_REACQUISITION_REQUIRED, RULE.SOURCE_REACQUISITION_REQUIRED, 'registration', `Unknown or unsupported sourceKind '${registration.sourceKind}'`)],
    };
  }

  const catalogPath = join(root, '.agents', 'plugins', 'marketplace.json');

  let catalogRaw: string;
  let catalogValue: unknown;
  try {
    const bytes = readFileSync(catalogPath);
    if (bytes.length > BUDGET.maxCatalogBytes) return { entries: [], snapshot: snapshotResult.snapshot, findings: [inspectionFinding(scope, CODE.BUDGET_EXCEEDED, RULE.BUDGET_EXCEEDED, 'catalog', `Validation Budget exceeded: catalog exceeds ${BUDGET.maxCatalogBytes} bytes`)] };
    catalogRaw = bytes.toString('utf8');
    catalogValue = JSON.parse(catalogRaw);
  } catch {
    return { entries: [], snapshot: snapshotResult.snapshot, findings: [inspectionFinding(scope, CODE.CATALOG_MISSING, RULE.CATALOG_MISSING, 'catalog', 'Marketplace Catalog cannot be read')] };
  }
  const parsed = parseCatalog(catalogValue, { scope });
  if (!parsed.catalog) return { entries: [], snapshot: snapshotResult.snapshot, findings: parsed.findings };
  const marketplaceId = `${registration.id}/${parsed.catalog.name}`;
  const drift = !opts.ignoreRecordedDrift && registration.validationSnapshot && registration.validationSnapshot !== snapshotResult.snapshot!.fingerprint
    ? [inspectionFinding(scope, CODE.REJECTED_AS_STALE, RULE.REJECTED_AS_STALE_SNAPSHOT, 'registration', 'Registered Validation Snapshot no longer matches the source tree; Marketplace Refresh is required')]
    : [];
  const material = createHash('sha256');
  material.update('catalog\u001f').update(catalogRaw).update('\u001e');
  const classifications = new Map<string, ReturnType<typeof classifyPlugin>>();
  const draft = parsed.catalog.entries.map((entry) => {
    if (!entry.available || entry.type !== 'local' || !entry.path) return { entry, findings: [], unavailableReason: entry.unavailableReason ?? 'unsupported source kind' };
    const contained = resolveContained(root, entry.path, 'directory');
    if (contained.outcome.kind !== 'ok') return { entry, findings: [], unavailableReason: 'cannot resolve Plugin' };
    let baseClassification = classifications.get(contained.outcome.canonicalPath);
    if (!baseClassification) {
      baseClassification = classifyPlugin(contained.outcome.canonicalPath, { scope, marketplaceId, marketplaceEntryId: `${marketplaceId}${entry.entryId}` });
      classifications.set(contained.outcome.canonicalPath, baseClassification);
    }
    const classification = baseClassification.plugin
      ? { ...baseClassification, plugin: { ...baseClassification.plugin, marketplaceEntryId: `${marketplaceId}${entry.entryId}` } }
      : baseClassification;
    material.update(`entry:${entry.entryId}\u001f`).update(classification.captureFingerprint).update('\u001e');
    return {
      entry,
      classification: classification.classification,
      plugin: classification.plugin,
      identity: classification.identity,
      findings: classification.findings,
    };
  });
  const snapshot = bindCapturedMaterial(snapshotResult.snapshot!, material.digest('hex'));
  const identities = new Map<string, number>();
  for (const item of draft) if (item.identity) identities.set(item.identity, (identities.get(item.identity) ?? 0) + 1);
  const entries = draft.map((item): InspectedMarketplaceEntry => {
    const collision = item.identity && (identities.get(item.identity) ?? 0) > 1
      ? [inspectionFinding(scope, CODE.PLUGIN_ID_COLLISION, RULE.PLUGIN_ID_COLLISION, 'plugin', `Plugin ID '${item.identity}' collides with another Marketplace Entry; neither entry is activatable`)]
      : [];
    const catalogFindings = parsed.findings.filter((finding) => finding.target !== 'entry' || finding.pointer === item.entry.entryId);
    const findings = sortFindings([...catalogFindings, ...item.findings, ...collision, ...drift, ...snapshotResult.findings]);
    const unavailableReason = item.unavailableReason
      ?? (hasBlocking(findings) || !item.plugin ? findings.find((finding) => finding.classification === 'blocking')?.outcome ?? 'incompatible' : undefined);
    return {
      entry: item.entry,
      classification: item.classification,
      plugin: item.plugin,
      findings,
      unavailableReason,
    };
  });
  return { entries, findings: sortFindings([...parsed.findings, ...drift, ...snapshotResult.findings]), marketplaceId, snapshot, treeFingerprint: snapshotResult.snapshot!.fingerprint };
}
