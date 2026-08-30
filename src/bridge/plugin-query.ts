/**
 * Read-only Marketplace Plugin enumeration query.
 *
 * This is the shared read model for command surfaces that need to select or display catalog
 * entries. It owns registration material resolution, format-bound bounded catalog reads,
 * global numbering, candidate naming, structural installability, Installation matching/state,
 * Unavailable reasons, and disclosed diagnostics. It never mutates Bridge State or source data.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

import { getCacheDir, getCacheEntriesDir } from '../cache/paths.js';
import { BUDGET } from '../registration/budget.js';
import {
  GIT_FAMILY_UNAVAILABLE_REASON,
  type Catalog,
  type MarketplaceEntry,
} from '../registration/catalog.js';
import type { ValidationFinding } from '../registration/findings.js';
import { catalogContractFor } from '../registration/format.js';
import {
  isInstallationEnabled,
  type MarketplaceFormat,
  type MinimalBridgeState,
  type MinimalInstallation,
  type MinimalRegistration,
} from './state.js';

export interface MarketplacePluginQueryOptions {
  agentDir?: string;
}

export interface MarketplaceCatalogReadResult {
  /** Parsed catalog on success; also present for structural parser failures that retain entries. */
  catalog?: Catalog;
  /** Structural findings from the registration's fixed Marketplace Format parser. */
  findings: ValidationFinding[];
  /** Existing command-surface diagnostic wording for a denied catalog read. */
  error?: string;
}

export type MarketplacePluginInstallationState = 'not-installed' | 'enabled' | 'disabled';

export interface MarketplacePluginCandidate {
  /** Global 1-based number across registrations and entries in their original order. */
  number: number;
  registration: MinimalRegistration;
  entry: MarketplaceEntry;
  /** Entry-declared name, then local path basename, then ordinal fallback. */
  candidateName: string;
  marketplaceName: string;
  marketplaceSource: string;
  /** Live local Marketplace Root or the registration's pinned Git Source Cache material. */
  marketplaceRoot: string;
  structurallyInstallable: boolean;
  installation?: MinimalInstallation;
  installationState: MarketplacePluginInstallationState;
  unavailableReason?: string;
}

export interface MarketplacePluginDiagnostic {
  registration: MinimalRegistration;
  marketplace: string;
  marketplaceSource: string;
  marketplaceRoot?: string;
  findings: ValidationFinding[];
  error: string;
}

export interface MarketplacePluginQueryResult {
  plugins: MarketplacePluginCandidate[];
  diagnostics: MarketplacePluginDiagnostic[];
}

/**
 * Budget-bounded, format-bound Marketplace Catalog read used by the query and existing lifecycle
 * rereads. Error literals intentionally retain the command grammar established by #91.
 */
export function readMarketplaceCatalog(
  root: string,
  format: MarketplaceFormat,
): MarketplaceCatalogReadResult {
  const contract = catalogContractFor(format);
  const catalogPath = join(root, ...contract.relPath.split('/'));
  let raw: string;
  try {
    if (!existsSync(catalogPath)) {
      return { findings: [], error: `catalog 缺失（${contract.relPath}）` };
    }
    // Preserve the established command behavior exactly: the stat supplies the Validation Budget
    // diagnostic, while readFileSync retains native diagnostics for directories/special files.
    const size = statSync(catalogPath).size;
    if (size > BUDGET.maxCatalogBytes) {
      return {
        findings: [],
        error: `catalog 檔案過大（${size} bytes > ${BUDGET.maxCatalogBytes}）— 超過 Validation Budget 上限，catalog 無法解析`,
      };
    }
    raw = readFileSync(catalogPath, 'utf-8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { findings: [], error: `catalog 無法讀取：${message}` };
  }

  if (!raw.trim()) {
    return { findings: [], error: 'catalog 解析失敗：檔案為空 — catalog malformed' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { findings: [], error: `catalog 解析失敗：${message} — catalog malformed` };
  }

  const result = contract.parse(parsed);
  if (!result.ok) {
    const codes = result.findings.map((finding) => finding.code).join(', ');
    return {
      catalog: result.catalog,
      findings: result.findings,
      error: `catalog 解析失敗${codes ? ` (${codes})` : ''} — catalog malformed`,
    };
  }
  return { catalog: result.catalog, findings: result.findings };
}

function marketplaceName(registration: MinimalRegistration): string {
  return registration.marketplaceName || registration.alias || registration.id;
}

export function resolveMarketplaceRoot(
  registration: MinimalRegistration,
  options: MarketplacePluginQueryOptions = {},
): string | undefined {
  if (registration.sourceKind !== 'git') return registration.source;
  const snapshot = registration.snapshot;
  if (!snapshot || !/^[0-9a-f]{64}$/.test(snapshot)) return undefined;
  const root = join(getCacheEntriesDir(getCacheDir(options.agentDir)), snapshot);
  return existsSync(root) ? root : undefined;
}

function materialUnavailableReason(registration: MinimalRegistration): string {
  if (registration.sourceKind !== 'git') return 'catalog 根路徑無法解析';
  const snapshot = registration.snapshot;
  return !snapshot
    ? 'git marketplace 缺少 cache 指紋'
    : `cache 快照缺失（${snapshot.slice(0, 12)}…）`;
}

export function isMarketplaceEntryStructurallyInstallable(entry: MarketplaceEntry): boolean {
  return entry.type === 'local'
    && entry.available === true
    && typeof entry.path === 'string'
    && entry.path.length > 0;
}

export function marketplaceEntryUnavailableReason(entry: MarketplaceEntry): string {
  if (entry.type === 'git' && entry.available !== false) return GIT_FAMILY_UNAVAILABLE_REASON;
  return entry.unavailableReason ?? 'unsupported source kind';
}

/** Enumerate every readable Marketplace Catalog without mutating Bridge State or material. */
export function queryMarketplacePlugins(
  state: MinimalBridgeState,
  options: MarketplacePluginQueryOptions = {},
): MarketplacePluginQueryResult {
  const plugins: MarketplacePluginCandidate[] = [];
  const diagnostics: MarketplacePluginDiagnostic[] = [];
  let number = 1;

  for (const registration of state.registrations) {
    const name = marketplaceName(registration);
    const root = resolveMarketplaceRoot(registration, options);
    if (!root) {
      diagnostics.push({
        registration,
        marketplace: name,
        marketplaceSource: registration.source,
        marketplaceRoot: undefined,
        findings: [],
        error: materialUnavailableReason(registration),
      });
      continue;
    }

    const read = readMarketplaceCatalog(root, registration.format ?? 'codex');
    if (read.error) {
      diagnostics.push({
        registration,
        marketplace: name,
        marketplaceSource: registration.source,
        marketplaceRoot: root,
        findings: read.findings,
        error: read.error,
      });
      continue;
    }

    for (const entry of read.catalog?.entries ?? []) {
      const candidateName = entry.name ?? (entry.path ? basename(entry.path) : `plugin-${entry.ordinal}`);
      const installation = state.installations.find(
        (candidate) => candidate.registrationId === registration.id
          && (candidate.manifestName === candidateName || candidate.pluginId === candidateName),
      );
      const structurallyInstallable = isMarketplaceEntryStructurallyInstallable(entry);
      const installationState: MarketplacePluginInstallationState = !installation
        ? 'not-installed'
        : isInstallationEnabled(installation)
          ? 'enabled'
          : 'disabled';

      plugins.push({
        number,
        registration,
        entry,
        candidateName,
        marketplaceName: name,
        marketplaceSource: registration.source,
        marketplaceRoot: root,
        structurallyInstallable,
        installation,
        installationState,
        unavailableReason: structurallyInstallable ? undefined : marketplaceEntryUnavailableReason(entry),
      });
      number += 1;
    }
  }

  return { plugins, diagnostics };
}
