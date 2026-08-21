/**
 * Bridge State — Authoritative durable desired state.
 * See CONTEXT.md: Bridge State, State Revision, Registration ID, Installation ID, Scope Override
 *
 * Persistence is split into two scope-local documents (global + project).
 * Only authoritative fields are persisted; Effective State, catalogs, compatibility
 * results, diagnostics are recomputed at read time.
 */

export const CURRENT_SCHEMA_VERSION = 1;

/** Opaque monotonic identifier per scope. Stored as decimal string, incremented on each successful commit. */
export type StateRevision = string;

/** Minimal shape for scaffold — later tickets extend with Source Key, Validation Snapshot, etc. */
export interface Registration {
  /** Immutable lowercase UUIDv4, allocated before preflight */
  id: string;
  /** Scope-local alias, derived from marketplace name */
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
  };
  /** Validation Snapshot fingerprint bound to Registration Confirmation */
  validationSnapshot?: string;
  /** Bound Compatibility Profile / Ruleset / Budget ids at confirmation time */
  snapshotBinds?: { profile?: string; ruleset?: string; budget?: string };
}

export interface Installation {
  /** Canonical Installation ID = scope + Plugin ID (stable across version/path changes) */
  id: string;
  /** Canonical Plugin ID = Marketplace ID + manifest name */
  pluginId: string;
  /** Durable enabled/disabled condition */
  installationState: 'enabled' | 'disabled';
}

export interface ScopeOverride {
  /** Project-only suppression of inherited global record */
  kind: 'registration' | 'installation';
  /** Canonical Registration ID or Installation ID being suppressed */
  targetId: string;
}

export interface BridgeState {
  /** Versioned JSON schema */
  schemaVersion: number;
  /** Opaque monotonic per-scope revision */
  stateRevision: StateRevision;
  /** Scope-local registrations */
  registrations: Registration[];
  /** Scope-local installations (with Installation State) */
  installations: Installation[];
  /** Project-only — empty for global scope */
  scopeOverrides: ScopeOverride[];
}

export type Scope = 'global' | 'project';

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
}

export interface WriteResult {
  success: boolean;
  /** The new State Revision after successful commit */
  newRevision?: StateRevision;
  error?: string;
  /** Whether the file was previously corrupted/incompatible and write was rejected as indeterminate */
  isIndeterminate?: boolean;
}

/** Findings-like error codes for store diagnostics (closed set for scaffold) */
export type StoreErrorCode =
  | 'CORRUPTED_JSON'
  | 'INVALID_SCHEMA'
  | 'INCOMPATIBLE_SCHEMA_VERSION'
  | 'PERSISTENCE_INDETERMINATE'
  | 'PERSISTENCE_FAILED';

/** Create an empty state for a scope at revision "0" */
export function createEmptyState(): BridgeState {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    stateRevision: '0',
    registrations: [],
    installations: [],
    scopeOverrides: [],
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
    Array.isArray(o.installations) &&
    Array.isArray(o.scopeOverrides)
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
