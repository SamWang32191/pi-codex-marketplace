import { describe, it, expect } from 'vitest';
import {
  createReceipt,
  deriveAttemptSummary,
  deriveRecoveryActions,
  formatThreeOrthogonalReport,
  type AttemptReceipt,
  type AttemptSummary,
  type RecoveryAction,
} from '../../../src/registration/receipt.js';
import { blocking, warning, notice, CODE, RULE } from '../../../src/registration/findings.js';

describe('Attempt Receipt — Three Orthogonal Axes & Derivations', () => {
  it('derives Persistence Indeterminate when durable outcome is indeterminate', () => {
    const summary = deriveAttemptSummary('indeterminate', [], 'none');
    expect(summary).toBe('Persistence Indeterminate');
  });

  it('derives Persistence Failed when durable outcome is failed', () => {
    const summary = deriveAttemptSummary('failed', [], 'none');
    expect(summary).toBe('Persistence Failed');
  });

  it('derives Declined when explicitly declined', () => {
    const summary = deriveAttemptSummary('unchanged', [], 'none', { declined: true });
    expect(summary).toBe('Declined');
  });

  it('derives Rejected as Stale when stale findings are present', () => {
    const findings = [
      blocking({
        code: CODE.REJECTED_AS_STALE,
        phase: 'persistence',
        target: 'attempt',
        pointer: '',
        rule: RULE.REJECTED_AS_STALE,
        outcome: 'stale revision',
      }),
    ];
    const summary = deriveAttemptSummary('unchanged', findings, 'none');
    expect(summary).toBe('Rejected as Stale');
  });

  it('derives Blocked when pre-commit blocking findings exist', () => {
    const findings = [
      blocking({
        code: CODE.ATTEMPT_IN_PROGRESS,
        phase: 'admission',
        target: 'attempt',
        pointer: '',
        rule: RULE.ATTEMPT_IN_PROGRESS,
        outcome: 'in progress',
      }),
    ];
    const summary = deriveAttemptSummary('unchanged', findings, 'none');
    expect(summary).toBe('Blocked');
  });

  it('derives Pending Application when durable committed but runtime is pending', () => {
    const summary = deriveAttemptSummary('committed', [], 'pending-application');
    expect(summary).toBe('Pending Application');
  });

  it('derives Completed when committed, no blocking, and applied', () => {
    const summary = deriveAttemptSummary('committed', [], 'applied');
    expect(summary).toBe('Completed');
  });

  it('derives Completed with diagnostics when committed, applied, but has warnings or notices', () => {
    const findings = [
      warning({
        code: CODE.INERT_METADATA_IGNORED,
        phase: 'validation',
        target: 'plugin',
        pointer: '',
        rule: 'COMP-05',
        outcome: 'ignored metadata',
      }),
    ];
    const summary = deriveAttemptSummary('committed', findings, 'applied');
    expect(summary).toBe('Completed with diagnostics');
  });

  it('derives closed Recovery Actions matching failure conditions', () => {
    // Indeterminate -> Repair State, Inspect
    expect(deriveRecoveryActions('Persistence Indeterminate', [])).toEqual(['Repair State', 'Inspect']);
    // Failed -> Retry
    expect(deriveRecoveryActions('Persistence Failed', [])).toEqual(['Retry']);
    // Rejected as Stale -> Revalidate
    expect(deriveRecoveryActions('Rejected as Stale', [])).toEqual(['Revalidate']);
    // Pending Application -> Retry Application
    expect(deriveRecoveryActions('Pending Application', [])).toEqual(['Retry Application']);
    // Source Drift -> Refresh
    const driftFinding = [
      blocking({
        code: CODE.SOURCE_DRIFT,
        phase: 'validation',
        target: 'registration',
        pointer: '',
        rule: RULE.SOURCE_DRIFT,
        outcome: 'drift',
      }),
    ];
    expect(deriveRecoveryActions('Blocked', driftFinding)).toEqual(['Refresh']);
    // Fence collision -> Inspect
    const fenceFinding = [
      blocking({
        code: CODE.ATTEMPT_IN_PROGRESS,
        phase: 'admission',
        target: 'attempt',
        pointer: '',
        rule: RULE.ATTEMPT_IN_PROGRESS,
        outcome: 'fence held',
      }),
    ];
    expect(deriveRecoveryActions('Blocked', fenceFinding)).toEqual(['Inspect']);
  });

  it('createReceipt freezes the receipt and redacts secrets/paths', () => {
    const rcpt = createReceipt({
      operation: 'Marketplace Registration',
      trigger: 'register local /Users/sam/secret/path',
      expectedStateRevision: '0',
      targetStateRevision: '1',
      observedStateRevision: '1',
      durableOutcome: 'committed',
      runtimeOutcome: 'applied',
    });

    expect(rcpt.id).toMatch(/^rcpt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(rcpt.summary).toBe('Completed');
    expect(rcpt.recoveryActions).toEqual([]);
    expect(rcpt.stateChanged).toBe(true);
    expect(Object.isFrozen(rcpt)).toBe(true);
  });

  it('formatThreeOrthogonalReport produces a formatted three-part report with summary & recovery', () => {
    const rcpt = createReceipt({
      operation: 'Marketplace Registration',
      trigger: 'register local /repo',
      expectedStateRevision: '0',
      targetStateRevision: '1',
      observedStateRevision: '1',
      durableOutcome: 'committed',
      runtimeOutcome: 'applied',
      findings: [
        notice({
          code: 'TEST_NOTICE',
          phase: 'post-commit',
          target: 'plugin',
          pointer: '',
          rule: 'TEST-01',
          outcome: 'operational notice',
        }),
      ],
    });

    const report = formatThreeOrthogonalReport(rcpt);
    expect(report).toContain('【持久化 / Persistence】');
    expect(report).toContain('【診斷 / Findings】');
    expect(report).toContain('【運行時 / Runtime】');
    expect(report).toContain('Attempt Summary: Completed with diagnostics');
  });
});
