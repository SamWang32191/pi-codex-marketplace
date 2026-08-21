/**
 * Read-only Marketplace Entry inspection.
 *
 * This is deliberately separate from lifecycle preflight: it never acquires an Attempt Fence,
 * creates a receipt, or reads Bridge State.  One bounded snapshot and one catalog parse produce
 * all browse results for a Marketplace.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { classifyPlugin, type CompatiblePlugin } from '../compatibility/profile.js';
import type { Registration, Scope } from '../bridge-state/types.js';
import type { MarketplaceEntry } from '../registration/catalog.js';
import { parseCatalog } from '../registration/catalog.js';
import { resolveContained } from '../registration/contained.js';
import { CODE, RULE, blocking, hasBlocking, sortFindings, type ValidationFinding } from '../registration/findings.js';
import { localSourceKey } from '../registration/source-key.js';
import { bindCapturedMaterial, buildLocalSnapshot, type ValidationSnapshot } from '../registration/snapshot.js';

export interface InspectedMarketplaceEntry {
  entry: MarketplaceEntry;
  plugin?: CompatiblePlugin;
  findings: ValidationFinding[];
  unavailableReason?: string;
}

export interface MarketplaceInspection {
  entries: InspectedMarketplaceEntry[];
  findings: ValidationFinding[];
  marketplaceId?: string;
  snapshot?: ValidationSnapshot;
}

function inspectionFinding(scope: Scope, code: string, rule: string, target: ValidationFinding['target'], outcome: string): ValidationFinding {
  return blocking({ code, rule, target, pointer: '', outcome, scope, phase: 'validation' });
}

/** Inspect every Marketplace Entry once. All filesystem work occurs after a bounded snapshot. */
export function inspectMarketplaceEntries(registration: Registration, scope: Scope): MarketplaceInspection {
  if (registration.sourceKind !== 'local' || !registration.source) {
    return { entries: [], findings: [inspectionFinding(scope, CODE.SOURCE_REACQUISITION_REQUIRED, RULE.SOURCE_REACQUISITION_REQUIRED, 'registration', 'Git Source Cache lifecycle is not available yet')] };
  }
  const key = localSourceKey(registration.source);
  if (!key.ok) return { entries: [], findings: [inspectionFinding(scope, CODE.SOURCE_REACQUISITION_REQUIRED, RULE.SOURCE_REACQUISITION_REQUIRED, 'registration', key.error ?? 'Marketplace Root cannot be revalidated')] };
  const root = key.sourceKey!.canonicalPath!;
  const snapshotResult = buildLocalSnapshot(root, key.sourceKey!, scope);
  if (!snapshotResult.ok) return { entries: [], findings: snapshotResult.findings };

  let catalogRaw: string;
  let catalogValue: unknown;
  try {
    catalogRaw = readFileSync(join(root, '.agents', 'plugins', 'marketplace.json'), 'utf8');
    catalogValue = JSON.parse(catalogRaw);
  } catch {
    return { entries: [], snapshot: snapshotResult.snapshot, findings: [inspectionFinding(scope, CODE.CATALOG_MISSING, RULE.CATALOG_MISSING, 'catalog', 'Marketplace Catalog cannot be read')] };
  }
  const parsed = parseCatalog(catalogValue, { scope });
  if (!parsed.catalog) return { entries: [], snapshot: snapshotResult.snapshot, findings: parsed.findings };
  const marketplaceId = `${registration.id}/${parsed.catalog.name}`;
  const drift = registration.validationSnapshot && registration.validationSnapshot !== snapshotResult.snapshot!.fingerprint
    ? [inspectionFinding(scope, CODE.REJECTED_AS_STALE, RULE.REJECTED_AS_STALE_SNAPSHOT, 'registration', 'Registered Validation Snapshot no longer matches the source tree; Marketplace Refresh is required')]
    : [];
  const material = createHash('sha256');
  material.update('catalog\u001f').update(catalogRaw).update('\u001e');
  const draft = parsed.catalog.entries.map((entry) => {
    if (!entry.available || entry.type !== 'local' || !entry.path) return { entry, findings: [], unavailableReason: entry.unavailableReason ?? 'unsupported source kind' };
    const contained = resolveContained(root, entry.path, 'directory');
    if (contained.outcome.kind !== 'ok') return { entry, findings: [], unavailableReason: 'cannot resolve Plugin' };
    const classification = classifyPlugin(contained.outcome.canonicalPath, { scope, marketplaceId, marketplaceEntryId: `${marketplaceId}${entry.entryId}` });
    material.update(`entry:${entry.entryId}\u001f`).update(classification.captureFingerprint).update('\u001e');
    return { entry, plugin: classification.plugin, identity: classification.identity, findings: classification.findings };
  });
  const snapshot = bindCapturedMaterial(snapshotResult.snapshot!, material.digest('hex'));
  const identities = new Map<string, number>();
  for (const item of draft) if (item.identity) identities.set(item.identity, (identities.get(item.identity) ?? 0) + 1);
  const entries = draft.map((item): InspectedMarketplaceEntry => {
    const collision = item.identity && (identities.get(item.identity) ?? 0) > 1
      ? [inspectionFinding(scope, CODE.PLUGIN_ID_COLLISION, RULE.PLUGIN_ID_COLLISION, 'plugin', `Plugin ID '${item.identity}' collides with another Marketplace Entry; neither entry is activatable`)]
      : [];
    const findings = sortFindings([...parsed.findings, ...item.findings, ...collision, ...drift, ...snapshotResult.findings]);
    const unavailableReason = item.unavailableReason
      ?? (hasBlocking(findings) || !item.plugin ? findings.find((finding) => finding.classification === 'blocking')?.outcome ?? 'incompatible' : undefined);
    return { entry: item.entry, plugin: item.plugin, findings, unavailableReason };
  });
  return { entries, findings: sortFindings([...parsed.findings, ...drift, ...snapshotResult.findings]), marketplaceId, snapshot };
}
