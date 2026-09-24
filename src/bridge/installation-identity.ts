/**
 * Installation identity — the one predicate and display name the command surface resolves an
 * Installed Plugin by (manifestName → pluginId → id). Shared by the command dispatch and the
 * completion surface so one token means the same Installation everywhere, and an ambiguous
 * token is never silently picked.
 */

import type { MinimalBridgeState, MinimalInstallation } from './state.js';

/** Whether a token names this Installation on the command surface (manifestName → pluginId → id). */
export function matchesInstallation(installation: MinimalInstallation, token: string): boolean {
  return installation.manifestName === token || installation.pluginId === token || installation.id === token;
}

/** The Installation's user-visible name: manifestName, else pluginId, else id. */
export function installationDisplayName(installation: MinimalInstallation): string {
  return installation.manifestName || installation.pluginId || installation.id;
}

/**
 * The one Installation a token resolves to, or undefined when it names none or more than one —
 * the command rejects an ambiguous token instead of picking a target.
 */
export function resolveInstallation(state: MinimalBridgeState, token: string): MinimalInstallation | undefined {
  const matches = state.installations.filter((installation) => matchesInstallation(installation, token));
  return matches.length === 1 ? matches[0] : undefined;
}
