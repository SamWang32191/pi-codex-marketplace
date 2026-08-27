/**
 * Bridge State — Authoritative durable desired state.
 * See CONTEXT.md: Bridge State, State Revision, Registration ID, Installation ID
 *
 * Persistence is a single Global document (~/.pi/agent/codex-marketplace/state.json).
 * Only authoritative fields are persisted; Effective State, catalogs, compatibility
 * results, diagnostics are recomputed at read time.
 *
 * Scope Overrides are retired (issue #59 / #63): schema v2 stripped the field entirely.
 */

import type { ValidationFinding } from '../registration/findings.js';

export const CURRENT_SCHEMA_VERSION = 3;

/** Opaque monotonic identifier. Stored as decimal string, incremented on each successful commit. */
export type StateRevision = string;

/** Marketplace Format — codex | claude (persistence foundation, issue #44).
 *  Format detection / claude parsing is delivered by later tickets; the persistence
 *  layer carries the value through and legacy registrations are backfilled to 'codex'
 *  by the v2→v3 migration. Absence (pre-v3) always reads back as 'codex' after migration. */
export type MarketplaceFormat = 'codex' | 'claude';

/** Minimal shape for scaffold — later tickets extend with Source Key, Validation Snapshot, etc. */
export interface Registration {
  /** Immutable lowercase UUIDv4, allocated before preflight */
  id: string;
  /** Marketplace Format carried by this Registration. v2→v3 migration backfills 'codex' for legacy records. */
  format?: MarketplaceFormat;
  /** Human-readable alias, derived from marketplace name */
  alias?: string;
  /** Declared marketplace name (kebab-case) */
  marketplaceName?: string;
  /** Source kind for duplicate detection */
  sourceKind?: 'local' | 'git';
  /** Canonical source locator (credential-free) */
  source?: string;
  /** Typed Source Key for duplicate detection / repeated registration (not identity) */
  sourceKey?: {
    kind: 'local' | 'git';
    key: string;
    canonicalPath?: string;
    /** Canonical Git URL (for git kind) */
    canonicalUrl?: string;
    /** Canonical selector string (for git kind), e.g. refs/heads/main or 40 hex */
    selector?: string;
    /** Resolved full commit at confirmation time (for git) */
    resolvedRevision?: string;
  };
  /** Canonical Git Locator (credential-free) — git-only, same as source for git kind */
  canonicalLocator?: string;
  /** Normalized Git Selector (git-only) */
  gitSelector?: {
    kind: 'default' | 'branch' | 'tag' | 'commit';
    /** Canonical selector value: 'default' | 'refs/heads/*' | 'refs/tags/*' | lower 40/64 hex */
    canonical: string;
    /** Original display value before canonicalization */
    raw?: string;
  };
  /** Resolved Revision: full commit bound to validation (git-only) */
  resolvedRevision?: string;
  /** Validation Snapshot fingerprint bound to Registration Confirmation */
  validationSnapshot?: string;
  /** Per-entry Validation Snapshot fingerprints bound to Registration Confirmation (issue #50). */
  entrySnapshots?: Record<string, string>;
  /** Bound Compatibility Profile / Ruleset / Budget ids at confirmation time */
  snapshotBinds?: { profile?: string; ruleset?: string; budget?: string };
}

export interface Installation {
  /** Canonical Installation ID = Plugin ID itself (stable across version/path changes).
   *  Legacy documents may still carry the retired 'global/<pluginId>' form; normalized in v2. */
  id: string;
  /** Canonical Plugin ID = Marketplace ID + manifest name */
  pluginId: string;
  /** Durable enabled/disabled condition */
  installationState: 'enabled' | 'disabled';
  /** Registration that supplied this Plugin; retained for source provenance and revalidation. */
  registrationId?: string;
  /** Snapshot-scoped Marketplace Entry identity that selected this Plugin. */
  marketplaceEntryId?: string;
  /** Validation Snapshot fingerprint accepted for this Installation. */
  validationSnapshot?: string;
  /** Compatibility Profile / Ruleset / Budget bound during installation. */
  snapshotBinds?: { profile?: string; ruleset?: string; budget?: string };
  /** Exact manifest name, retained independently of the Marketplace Entry display name. */
  manifestName?: string;
}

export interface ScopeOverride {
  /** Retired (issue #59 / #63) — legacy type kept for v1 migration parsing. */
  kind: 'registration' | 'installation';
  /** Canonical Registration ID or Installation ID being suppressed */
  targetId: string;
}

export interface BridgeState {
  /** Versioned JSON schema */
  schemaVersion: number;
  /** Opaque monotonic revision */
  stateRevision: StateRevision;
  registrations: Registration[];
  installations: Installation[];
}

export type ReadStatus = 'ok' | 'corrupted' | 'incompatible' | 'missing';

export interface ReadResult {
  status: ReadStatus;
  /** Present when status is ok or missing (missing returns empty state) */
  state?: BridgeState;
  /** Human-readable diagnostic for corrupted/incompatible */
  error?: string;
  /** Raw parsed content when available (for diagnostics) */
  raw?: unknown;
  /** Whether state was reconstructed as empty due to missing file */
  isEmptyInit?: boolean;
  /** Migration diagnostics / findings if any */
  findings?: ValidationFinding[];
}

export interface WriteResult {
  success: boolean;
  /** The new State Revision after successful commit */
  newRevision?: StateRevision;
  error?: string;
  /** Whether the file was previously corrupted/incompatible and write was rejected as indeterminate */
  isIndeterminate?: boolean;
  /** The commit was safely refused because the caller's exact revision was no longer current. */
  isStale?: boolean;
  /** Current revision observed under the atomic store lock when a CAS refusal occurs. */
  observedRevision?: StateRevision;
}

/** Findings-like error codes for store diagnostics (closed set for scaffold) */
export type StoreErrorCode =
  | 'CORRUPTED_JSON'
  | 'INVALID_SCHEMA'
  | 'INCOMPATIBLE_SCHEMA_VERSION'
  | 'PERSISTENCE_INDETERMINATE'
  | 'PERSISTENCE_FAILED';

/** Create an empty state at revision "0" */
export function createEmptyState(): BridgeState {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    stateRevision: '0',
    registrations: [],
    installations: [],
  };
}

/** Check if a value looks like a BridgeState (structural) */
export function isBridgeState(value: unknown): value is BridgeState {
  if (typeof value !== 'object' || value === null) return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.schemaVersion === 'number' &&
    typeof o.stateRevision === 'string' &&
    Array.isArray(o.registrations) &&
    Array.isArray(o.installations)
  );
}

/** Increment an opaque revision string numerically (monotonic). "0" -> "1" -> "2" ... */
export function nextRevision(current: StateRevision): StateRevision {
  const n = BigInt(current);
  return (n + 1n).toString();
}

/** Compare revisions as numeric opaque values: -1 if a<b, 0 if equal, 1 if a>b */
export function compareRevision(a: StateRevision, b: StateRevision): number {
  const an = BigInt(a);
  const bn = BigInt(b);
  if (an < bn) return -1;
  if (an > bn) return 1;
  return 0;
}
