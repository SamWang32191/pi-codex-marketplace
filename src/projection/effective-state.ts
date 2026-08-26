/**
 * Effective State — computed view over the single Global Bridge State document.
 * See CONTEXT.md: Effective State, Installation State, Installed Plugin.
 *
 * This is a pure read-time computation over the one authoritative document.
 * Nothing here is persisted. Only enabled Installations participate; each record carries
 * exactly what its own persisted entry holds.
 */

import type { BridgeState, Installation, Registration } from '../bridge-state/types.js';

export interface EffectiveState {
  registrations: Registration[];
  installations: Installation[];
}

/**
 * Compute the Effective State from the Global Bridge State. Pure — never mutates the input
 * and never persists anything; callers recompute after every read or commit.
 */
export function computeEffectiveState(state: BridgeState): EffectiveState {
  return {
    registrations: state.registrations,
    installations: state.installations.filter(
      (installation) => installation.installationState === 'enabled',
    ),
  };
}
