/**
 * Attempt Fence — per-scope exclusivity boundary for Lifecycle Operations.
 * See CONTEXT.md: Attempt Fence, Global Pending Barrier, Blocking Finding.
 *
 * Admits only one attempt at a time per scope. The fence is acquired before preflight and held
 * until the attempt reaches a terminal outcome (committed / declined / blocked / stale). A second
 * concurrent attempt on the same scope is denied with an ATTEMPT_IN_PROGRESS Blocking Finding.
 *
 * For Project Scope: Global Pending Barrier is checked prior to fence acquisition. If active,
 * the attempt is blocked with GLOBAL_PENDING_BARRIER.
 *
 * Cross-process: a lock file sibling to the scope's state document is used (O_EXCL advisory lock).
 */

import { acquireLock, releaseLock } from '../bridge-state/atomic.js';
import { getFencePath, getStatePath } from '../bridge-state/paths.js';
import type { Scope } from '../bridge-state/types.js';
import { checkGlobalPendingBarrier } from '../barrier/global-barrier.js';
import { CODE, RULE, blocking, type ValidationFinding } from './findings.js';

export interface AttemptFenceHandle {
  scope: Scope;
  release(): void;
  released: boolean;
}

export interface AttemptFenceResult {
  ok: boolean;
  handle?: AttemptFenceHandle;
  finding?: ValidationFinding;
}

const FENCE_LOCK_TIMEOUT_MS = 300;

/** Acquire the per-scope Attempt Fence (lock file). Denied when another attempt holds it or Global Barrier active. */
export async function acquireAttemptFence(
  scope: Scope,
  opts: { cwd?: string; agentDir?: string; fenceTimeoutMs?: number; projectTrusted?: boolean } = {},
): Promise<AttemptFenceResult> {
  // Global Pending Barrier: blocks Project Scope attempts
  if (scope === 'project') {
    const barrier = await checkGlobalPendingBarrier(opts);
    if (barrier.active) {
      return {
        ok: false,
        finding: barrier.finding,
      };
    }
  }

  const statePath = getStatePath(scope, opts);
  const fencePath = getFencePath(statePath);
  const timeout = opts.fenceTimeoutMs ?? FENCE_LOCK_TIMEOUT_MS;

  let fd: number;
  try {
    fd = await acquireLock(fencePath, timeout);
  } catch {
    return {
      ok: false,
      finding: blocking({
        code: CODE.ATTEMPT_IN_PROGRESS,
        phase: 'admission',
        target: 'attempt',
        scope,
        pointer: '',
        rule: RULE.ATTEMPT_IN_PROGRESS,
        outcome: `another ${scope} attempt is in progress; only one attempt at a time per scope (no queue)`,
      }),
    };
  }

  let released = false;
  const handle: AttemptFenceHandle = {
    scope,
    get released(): boolean {
      return released;
    },
    release(): void {
      if (released) return;
      released = true;
      releaseLock(fd, fencePath);
    },
  };
  return { ok: true, handle };
}