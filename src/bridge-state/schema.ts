/**
 * Versioned JSON schema validation for Bridge State.
 * Closed handling: corrupted or unknown new schemaVersion => treat as
 * Indeterminate / incompatible, never auto-rollback or auto-migrate forward beyond known versions.
 */

import { CURRENT_SCHEMA_VERSION, type BridgeState, isBridgeState } from './types.js';

export interface SchemaValidation {
  ok: boolean;
  error?: string;
  code?: 'CORRUPTED_JSON' | 'INVALID_SCHEMA' | 'INCOMPATIBLE_SCHEMA_VERSION';
}

/** Validate parsed JSON as BridgeState; check schemaVersion compatibility. */
export function validateSchema(parsed: unknown): SchemaValidation {
  if (!isBridgeState(parsed)) {
    return {
      ok: false,
      code: 'INVALID_SCHEMA',
      error:
        'Invalid Bridge State: expected { schemaVersion:number, stateRevision:string, registrations:[], installations:[], scopeOverrides:[] }',
    };
  }

  const state = parsed as BridgeState;

  if (!Number.isInteger(state.schemaVersion) || state.schemaVersion < 1) {
    return {
      ok: false,
      code: 'INVALID_SCHEMA',
      error: `Invalid schemaVersion: ${state.schemaVersion}`,
    };
  }

  if (state.schemaVersion > CURRENT_SCHEMA_VERSION) {
    return {
      ok: false,
      code: 'INCOMPATIBLE_SCHEMA_VERSION',
      error: `Incompatible schemaVersion ${state.schemaVersion} > supported ${CURRENT_SCHEMA_VERSION} — requires newer Bridge Package`,
    };
  }

  // monotonic revision must be numeric string
  try {
    BigInt(state.stateRevision);
  } catch {
    return {
      ok: false,
      code: 'INVALID_SCHEMA',
      error: `Invalid stateRevision (not numeric opaque): ${state.stateRevision}`,
    };
  }

  // scopeOverrides only meaningful for project, but global may have empty — allow both
  // registrations/installations elements are not deeply validated at scaffold level

  return { ok: true };
}

/** Check if raw file content parses as JSON, return parsed or error */
export function parseJson(content: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    const value = JSON.parse(content);
    return { ok: true, value };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Corrupted JSON: ${msg}` };
  }
}
