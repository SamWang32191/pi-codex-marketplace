import { describe, it, expect } from 'vitest';
import { findActiveRecoveryChains } from '../../../src/journal/active-chains.js';
import { createReceipt, type AttemptReceipt } from '../../../src/registration/receipt.js';

describe('Receipt Journal — Active Recovery Chains', () => {
  it('identifies Pending Application as an active recovery root', () => {
    const r1 = createReceipt({
      id: 'rcpt_1',
      operation: 'Marketplace Registration',
      trigger: 'register',
      expectedStateRevision: '0',
      targetStateRevision: '1',
      observedStateRevision: '1',
      durableOutcome: 'committed',
      runtimeOutcome: 'pending-application',
      summary: 'Pending Application',
    });

    const result = findActiveRecoveryChains([r1]);
    expect(result.activeChains).toHaveLength(1);
    expect(result.activeChains[0].rootReceiptId).toBe('rcpt_1');
    expect(result.activeChains[0].condition).toBe('pending-application');
    expect(result.activeChains[0].resolved).toBe(false);
  });

  it('resolves an active chain when a later receipt recovers it with Completed', () => {
    const r1 = createReceipt({
      id: 'rcpt_1',
      operation: 'Marketplace Registration',
      trigger: 'register',
      expectedStateRevision: '0',
      targetStateRevision: '1',
      observedStateRevision: '1',
      durableOutcome: 'committed',
      runtimeOutcome: 'pending-application',
      summary: 'Pending Application',
    });

    const r2 = createReceipt({
      id: 'rcpt_2',
      operation: 'Runtime Application',
      trigger: 'retry application',
      expectedStateRevision: '1',
      observedStateRevision: '1',
      durableOutcome: 'unchanged',
      runtimeOutcome: 'applied',
      summary: 'Completed',
      recoversReceiptId: 'rcpt_1',
    });

    const result = findActiveRecoveryChains([r1, r2]);
    expect(result.activeChains).toHaveLength(0);
    expect(result.allChains).toHaveLength(1);
    expect(result.allChains[0].resolved).toBe(true);
    expect(result.allChains[0].resolvedByReceiptId).toBe('rcpt_2');
  });

  it('keeps active chain open when a recovery attempt fails', () => {
    const r1 = createReceipt({
      id: 'rcpt_1',
      operation: 'Marketplace Registration',
      trigger: 'register',
      expectedStateRevision: '0',
      targetStateRevision: '1',
      observedStateRevision: '1',
      durableOutcome: 'committed',
      runtimeOutcome: 'pending-application',
      summary: 'Pending Application',
    });

    const r2 = createReceipt({
      id: 'rcpt_2',
      operation: 'Runtime Application',
      trigger: 'retry application',
      expectedStateRevision: '1',
      durableOutcome: 'unchanged',
      runtimeOutcome: 'pending-application',
      summary: 'Pending Application',
      recoversReceiptId: 'rcpt_1',
    });

    const result = findActiveRecoveryChains([r1, r2]);
    expect(result.activeChains).toHaveLength(1);
    expect(result.activeChains[0].rootReceiptId).toBe('rcpt_1');
    expect(result.activeChains[0].resolved).toBe(false);
    expect(result.activeChains[0].receipts).toHaveLength(2);
  });

  it('supersedes an active chain when a replacement State Revision is committed', () => {
    const r1 = createReceipt({
      id: 'rcpt_1',
      operation: 'Marketplace Registration',
      trigger: 'register',
      expectedStateRevision: '0',
      targetStateRevision: '1',
      observedStateRevision: '1',
      durableOutcome: 'committed',
      runtimeOutcome: 'pending-application',
      summary: 'Pending Application',
    });

    const r2 = createReceipt({
      id: 'rcpt_2',
      operation: 'Marketplace Registration',
      trigger: 'register another',
      expectedStateRevision: '1',
      targetStateRevision: '2',
      observedStateRevision: '2',
      durableOutcome: 'committed',
      runtimeOutcome: 'applied',
      summary: 'Completed',
    });

    const result = findActiveRecoveryChains([r1, r2]);
    expect(result.activeChains).toHaveLength(0);
    expect(result.allChains[0].superseded).toBe(true);
    expect(result.allChains[0].supersededByReceiptId).toBe('rcpt_2');
  });

  it('tracks Persistence Indeterminate as active recovery root until State Repair', () => {
    const r1 = createReceipt({
      id: 'rcpt_indet',
      operation: 'Marketplace Registration',
      trigger: 'register',
      expectedStateRevision: '0',
      durableOutcome: 'indeterminate',
      summary: 'Persistence Indeterminate',
    });

    const result1 = findActiveRecoveryChains([r1]);
    expect(result1.activeChains).toHaveLength(1);
    expect(result1.activeChains[0].condition).toBe('persistence-indeterminate');

    // State Repair resolves it
    const r2 = createReceipt({
      id: 'rcpt_repair',
      kind: 'State Repair',
      operation: 'Repair State',
      trigger: 'repair state',
      expectedStateRevision: '0',
      observedStateRevision: '0',
      durableOutcome: 'unchanged',
      summary: 'Completed',
      recoversReceiptId: 'rcpt_indet',
    });

    const result2 = findActiveRecoveryChains([r1, r2]);
    expect(result2.activeChains).toHaveLength(0);
    expect(result2.allChains[0].resolved).toBe(true);
  });
});
