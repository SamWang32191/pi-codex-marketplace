/**
 * Attempt Fence — exclusivity boundary for Lifecycle Operations.
 * See CONTEXT.md: Attempt Fence, Blocking Finding.
 *
 * Admits only one attempt at a time. The fence is acquired before preflight and held
 * until the attempt reaches a terminal outcome (committed / declined / blocked / stale). A second
 * concurrent attempt is denied with an ATTEMPT_IN_PROGRESS Blocking Finding.
 *
 * Cross-process: a lock file sibling to the state document is used (O_EXCL advisory lock).
 */

import { acquireLock, releaseLock } from '../bridge-state/atomic.js';
import { getFencePath, getGlobalStatePath } from '../bridge-state/paths.js';
import { CODE, RULE, blocking, type ValidationFinding } from './findings.js';

export interface AttemptFenceHandle {
  release(): void;
  released: boolean;
}

export interface AttemptFenceResult {
  ok: boolean;
  handle?: AttemptFenceHandle;
  finding?: ValidationFinding;
}

const FENCE_LOCK_TIMEOUT_MS = 300;

/** Acquire the Attempt Fence (lock file). Denied when another attempt holds it. */
export async function acquireAttemptFence(
  opts: { agentDir?: string; fenceTimeoutMs?: number } = {},
): Promise<AttemptFenceResult> {
  const statePath = getGlobalStatePath(opts.agentDir);
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
        pointer: '',
        rule: RULE.ATTEMPT_IN_PROGRESS,
        outcome: 'another attempt is in progress; only one attempt at a time (no queue)',
      }),
    };
  }

  let released = false;
  const handle: AttemptFenceHandle = {
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