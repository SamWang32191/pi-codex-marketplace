/**
 * Credentialed Acquisition approval (#109) — env-var allowlist parsing.
 * See CONTEXT.md: Credentialed Acquisition; docs/adr/0006-credentialed-acquisition-approval.md.
 *
 * Per-invocation approval of git credential helpers via
 * `PI_CODEX_MARKETPLACE_CREDENTIAL_HELPERS` (comma-separated `credential.helper`
 * strings). Empty/unset means "not approved" — behavior identical to today.
 * This module only parses; the resulting allowlist travels through
 * AcquisitionTrustOptions and never touches Bridge State, snapshots, or cache identity.
 */

export const CREDENTIAL_HELPERS_ENV = 'PI_CODEX_MARKETPLACE_CREDENTIAL_HELPERS';

/**
 * Parse the approval env var into a helper allowlist.
 * Comma-separated, each entry trimmed, empty entries ignored.
 * Empty/unset → no approval ([]).
 */
export function parseCredentialHelpers(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}