import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { acquireLockSync, releaseLock } from '../../../src/bridge-state/atomic.js';
import { getFencePath, getGlobalStatePath, getReceiptsJournalPath } from '../../../src/bridge-state/paths.js';
import { commitBridgeState, readBridgeState } from '../../../src/bridge-state/store.js';
import { appendReceipt, readReceiptJournal } from '../../../src/journal/journal.js';
import type { UpdateCandidate } from '../../../src/lifecycle/refresh.js';
import { acquireAttemptFence } from '../../../src/registration/fence.js';
import { createReceipt } from '../../../src/registration/receipt.js';
import {
  confirmPluginInstallation,
  preflightPluginInstallation,
} from '../../../src/installation/flow.js';
import {
  runReceiptJournalView,
  runRepairStateFlow,
  runRetryApplicationFlow,
} from '../../../extensions/pi/journal.js';
import {
  TRANSACTION_STEPS,
  type TransactionStep,
} from '../../../extensions/pi/transaction-sheet.js';
import { runRefreshFlow, runRemovalFlow, runUpdatePlanChecklist } from '../../../extensions/pi/lifecycle.js';
import { transactionStepLabel, uiText, verdictText } from '../../../extensions/pi/ui-strings.js';

const FIRST_REGISTRATION_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_REGISTRATION_ID = '22222222-2222-4222-8222-222222222222';

const identityTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_token: string, text: string) => text,
  bold: (text: string) => text,
};

interface UiHarnessOptions {
  cancelAt?: string;
  confirm?: boolean;
  expandValidation?: boolean;
  onStep?: (step: string) => void | Promise<void>;
  select?: (prompt: string, values: string[]) => string | undefined;
  width?: number;
}

function makeUiHarness(options: UiHarnessOptions = {}) {
  const selects: string[] = [];
  const confirms: string[] = [];
  const notifications: string[] = [];
  const sheets: string[] = [];
  const renders: string[] = [];
  let cancellationUsed = false;

  const ui = {
    select: async (prompt: string, values: string[]) => {
      selects.push(prompt);
      return options.select?.(prompt, values);
    },
    input: async () => undefined,
    confirm: async (title: string) => {
      confirms.push(title);
      return options.confirm ?? true;
    },
    notify: (message: string) => { notifications.push(message); },
    custom: async (factory: Function) => {
      let resolveSheet!: (value: unknown) => void;
      const completed = new Promise((resolve) => { resolveSheet = resolve; });
      const component = factory({ requestRender: () => {} }, identityTheme, {}, resolveSheet);
      const rendered = component.render(options.width ?? 120).join('\n');
      renders.push(rendered);
      // Canonical step ids are detected through their localized presentation markers.
      const active = TRANSACTION_STEPS.find((step: TransactionStep, index: number) =>
        rendered.includes(`▸ ${index + 1} ${transactionStepLabel(step)}（${uiText('step.activeSuffix')}）`));
      if (active) {
        sheets.push(active);
        await options.onStep?.(active);
      }
      if (active === 'Validation' && options.expandValidation) {
        component.handleInput('d');
        renders.push(component.render(options.width ?? 120).join('\n'));
      }
      const shouldCancel = !cancellationUsed && active === options.cancelAt;
      if (shouldCancel) cancellationUsed = true;
      component.handleInput(shouldCancel ? '\x1b' : '\r');
      return await completed;
    },
  };

  return { ui, selects, confirms, notifications, sheets, renders };
}

function updateCandidate(registrationId: string, pluginId: string, stateRevision: string): UpdateCandidate {
  const marketplaceId = `${registrationId}/acme-marketplace`;
  const sourceKey = { kind: 'local' as const, key: 'local:/market', canonicalPath: '/market' };
  return {
    scope: 'global',
    registrationId,
    stateRevision,
    recordedFingerprint: 'a'.repeat(64),
    snapshot: {
      fingerprint: 'b'.repeat(64),
      scope: 'global',
      entries: [],
      sourceKey,
      profile: 'profile-v1',
      ruleset: 'ruleset-v1',
      budget: 'budget-v1',
    },
    marketplaceName: 'acme-marketplace',
    catalog: { name: 'acme-marketplace', entries: [] },
    inspection: {
      entries: [{
        entry: { entryId: '/plugins/0', ordinal: 0, type: 'local', available: true },
        plugin: {
          id: pluginId,
          manifestName: 'release-helper',
          marketplaceEntryId: `${marketplaceId}/plugins/0`,
          skills: [],
        },
        findings: [],
      }],
      findings: [],
      marketplaceId,
    },
    sourceKey,
  };
}

describe('Bridge Ledger lifecycle flow adapters', () => {
  let root: string;
  let cwd: string;
  let agentDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ledger-flow-adapters-'));
    cwd = join(root, 'project');
    agentDir = join(root, 'agent');
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_AGENT_DIR = agentDir;
  });

  async function seedRuntimeSnapshot(
    scope: 'global' | 'project' = 'global',
  ): Promise<{ stateRevision: string; validationSnapshot: string; skillPath: string }> {
    const marketplace = join(root, 'runtime-marketplace');
    const pluginRoot = join(marketplace, 'plugins', 'runtime-helper');
    const skillPath = join(pluginRoot, 'skills', 'runtime-skill', 'SKILL.md');
    mkdirSync(join(marketplace, '.agents', 'plugins'), { recursive: true });
    mkdirSync(join(pluginRoot, '.codex-plugin'), { recursive: true });
    mkdirSync(join(pluginRoot, 'skills', 'runtime-skill'), { recursive: true });
    writeFileSync(join(marketplace, '.agents', 'plugins', 'marketplace.json'), JSON.stringify({
      name: 'runtime-marketplace',
      plugins: [{ source: { source: 'local', path: './plugins/runtime-helper' } }],
    }));
    writeFileSync(join(pluginRoot, '.codex-plugin', 'plugin.json'), JSON.stringify({
      name: 'runtime-helper',
      skills: './skills/',
    }));
    writeFileSync(
      skillPath,
      '---\nname: runtime-skill\ndescription: Runtime skill\n---\n\nRuntime body.\n',
    );
    const registrationId = '33333333-3333-4333-8333-333333333333';
    await commitBridgeState(scope, (state) => ({
      ...state,
      registrations: [{
        id: registrationId,
        marketplaceName: 'runtime-marketplace',
        sourceKind: 'local',
        source: marketplace,
      }],
    }), { cwd, agentDir });
    const preflight = await preflightPluginInstallation(
      scope,
      registrationId,
      '/plugins/0',
      { cwd, agentDir, projectTrusted: true },
    );
    if (!preflight.ok) throw new Error('runtime snapshot fixture preflight failed');
    const validationSnapshot = preflight.preflight.snapshot.fingerprint;
    const installed = await confirmPluginInstallation(
      preflight.preflight,
      'disabled',
      { cwd, agentDir, projectTrusted: true },
    );
    if (installed.status !== 'completed') throw new Error('runtime snapshot fixture install failed');
    return { stateRevision: installed.newRevision, validationSnapshot, skillPath };
  }

  afterEach(() => {
    delete process.env.PI_CODING_AGENT_DIR;
    delete process.env.PI_AGENT_DIR;
    rmSync(root, { recursive: true, force: true });
  });

  it('uses an explicit Registration target and a Commit-sheet cancel releases the fence without committing', async () => {
    await commitBridgeState('global', (state) => ({
      ...state,
      registrations: [
        { id: FIRST_REGISTRATION_ID, alias: 'same-label' },
        { id: SECOND_REGISTRATION_ID, alias: 'same-label' },
      ],
    }), { cwd, agentDir });
    const harness = makeUiHarness({ cancelAt: 'Commit' });
    const ctx = {
      cwd,
      mode: 'tui',
      hasUI: true,
      isProjectTrusted: () => true,
      ui: harness.ui,
    };

    await runRemovalFlow(ctx as never, {
      scope: 'global',
      targetKind: 'registration',
      targetId: SECOND_REGISTRATION_ID,
    });

    expect(harness.selects).toEqual([]);
    expect(harness.sheets).toEqual(['Intent', 'Validation', 'Consent', 'Plan', 'Commit', 'Receipt']);
    const state = await readBridgeState('global', { cwd, agentDir });
    expect(state.state?.registrations.map((item) => item.id)).toEqual([
      FIRST_REGISTRATION_ID,
      SECOND_REGISTRATION_ID,
    ]);
    expect(existsSync(getFencePath(getGlobalStatePath(agentDir)))).toBe(false);
  });

  it('shows Update Plan steps in order while Registration and Activation confirmations stay separate', async () => {
    const pluginId = `${FIRST_REGISTRATION_ID}/acme-marketplace/release-helper`;
    const installationId = `global/${pluginId}`;
    const committed = await commitBridgeState('global', (state) => ({
      ...state,
      registrations: [{ id: FIRST_REGISTRATION_ID, alias: 'acme-marketplace' }],
      installations: [{
        id: installationId,
        pluginId,
        registrationId: FIRST_REGISTRATION_ID,
        installationState: 'enabled',
        manifestName: 'release-helper',
      }],
    }), { cwd, agentDir });
    const harness = makeUiHarness({
      cancelAt: 'Commit',
      select: (_prompt, values) => values[0],
    });
    const ctx = {
      cwd,
      mode: 'tui',
      hasUI: true,
      isProjectTrusted: () => true,
      ui: harness.ui,
    };

    await runUpdatePlanChecklist(
      ctx as never,
      'global',
      updateCandidate(FIRST_REGISTRATION_ID, pluginId, committed.newRevision!),
      committed.newRevision!,
      'apply-update',
    );

    expect(harness.sheets).toEqual(['Intent', 'Validation', 'Consent', 'Plan', 'Commit', 'Receipt']);
    expect(harness.confirms).toEqual([
      expect.stringContaining('Registration Confirmation'),
      expect.stringContaining('Activation Confirmation'),
    ]);
    expect(harness.selects).toEqual([
      expect.stringContaining('Installation "release-helper"'),
    ]);
    const state = await readBridgeState('global', { cwd, agentDir });
    expect(state.state?.stateRevision).toBe(committed.newRevision);
    const journal = await readReceiptJournal('global', { cwd, agentDir });
    expect(journal.receipts.at(-1)).toEqual(expect.objectContaining({
      operation: 'Apply Update',
      summary: 'Declined',
      stateChanged: false,
    }));
  });

  it('records and presents a Declined Receipt when Registration Confirmation stays at Default No', async () => {
    const committed = await commitBridgeState('global', (state) => ({
      ...state,
      registrations: [{ id: FIRST_REGISTRATION_ID, alias: 'acme-marketplace' }],
    }), { cwd, agentDir });
    const harness = makeUiHarness({ confirm: false });
    const ctx = {
      cwd,
      mode: 'tui',
      hasUI: true,
      isProjectTrusted: () => true,
      ui: harness.ui,
    };

    await runUpdatePlanChecklist(
      ctx as never,
      'global',
      updateCandidate(FIRST_REGISTRATION_ID, `${FIRST_REGISTRATION_ID}/acme-marketplace/release-helper`, committed.newRevision!),
      committed.newRevision!,
      'apply-update',
    );

    expect(harness.sheets).toEqual(['Intent', 'Validation', 'Consent', 'Receipt']);
    const journal = await readReceiptJournal('global', { cwd, agentDir });
    expect(journal.receipts).toHaveLength(1);
    expect(journal.receipts[0]).toEqual(expect.objectContaining({
      operation: 'Apply Update',
      expectedStateRevision: committed.newRevision,
      validationSnapshot: 'b'.repeat(64),
      summary: 'Declined',
      stateChanged: false,
    }));
  });

  it('opens the exact structured Receipt ID without a scope or truncated-label selector', async () => {
    const first = createReceipt({
      id: 'rcpt_33333333-3333-4333-8333-333333333331',
      operation: 'First Receipt',
      scope: 'global',
      trigger: 'first',
      expectedStateRevision: '1',
      summary: 'Completed',
    });
    const selected = createReceipt({
      id: 'rcpt_33333333-3333-4333-8333-333333333332',
      operation: 'Selected Receipt',
      scope: 'global',
      trigger: 'selected',
      expectedStateRevision: '2',
      summary: 'Completed',
    });
    await appendReceipt('global', first, { cwd, agentDir });
    await appendReceipt('global', selected, { cwd, agentDir });
    const harness = makeUiHarness({ width: 180 });
    const ctx = {
      cwd,
      mode: 'tui',
      hasUI: true,
      isProjectTrusted: () => true,
      ui: harness.ui,
    };

    await runReceiptJournalView(ctx as never, {
      scope: 'global',
      receiptId: selected.id,
    });

    expect(harness.selects).toEqual([]);
    expect(harness.sheets).toEqual(['Receipt']);
    const rendered = harness.renders.join('\n');
    expect(rendered).toContain(selected.id);
    expect(harness.renders.join('\n')).toContain('Selected Receipt');
    expect(rendered).not.toContain(first.id);
  });

  it('runs Repair State for an explicit scope without the scope selector', async () => {
    const harness = makeUiHarness();
    const ctx = {
      cwd,
      mode: 'tui',
      hasUI: true,
      isProjectTrusted: () => true,
      ui: harness.ui,
    };

    await runRepairStateFlow(ctx as never, { scope: 'project' });

    expect(harness.selects).toEqual([]);
    expect(harness.sheets).toEqual(['Intent', 'Validation', 'Consent', 'Plan', 'Commit', 'Receipt']);
    const journal = await readReceiptJournal('project', { cwd, agentDir });
    expect(journal.receipts.at(-1)).toEqual(expect.objectContaining({
      operation: 'Repair State',
      scope: 'project',
      summary: 'Completed',
    }));
  });

  it('rejects Repair State when State Revision drifts after its sheet was presented', async () => {
    const harness = makeUiHarness({
      onStep: async (step) => {
        if (step === 'Commit') {
          await commitBridgeState('project', (state) => ({ ...state }), { cwd, agentDir });
        }
      },
    });
    const ctx = {
      cwd,
      mode: 'tui',
      hasUI: true,
      isProjectTrusted: () => true,
      ui: harness.ui,
    };

    await runRepairStateFlow(ctx as never, { scope: 'project' });

    expect((await readBridgeState('project', { cwd, agentDir })).state?.stateRevision).toBe('1');
    expect((await readReceiptJournal('project', { cwd, agentDir })).receipts.at(-1)).toEqual(
      expect.objectContaining({
        operation: 'Repair State',
        expectedStateRevision: '0',
        observedStateRevision: '1',
        summary: 'Rejected as Stale',
      }),
    );
  });

  it('rejects Repair State when the Journal observation drifts after its sheet was presented', async () => {
    const concurrent = createReceipt({
      id: 'rcpt_33333333-3333-4333-8333-333333333339',
      operation: 'Concurrent Inspection',
      scope: 'project',
      trigger: 'concurrent inspection',
      expectedStateRevision: '0',
      summary: 'Completed',
    });
    const harness = makeUiHarness({
      onStep: async (step) => {
        if (step === 'Commit') await appendReceipt('project', concurrent, { cwd, agentDir });
      },
    });
    const ctx = {
      cwd,
      mode: 'tui',
      hasUI: true,
      isProjectTrusted: () => true,
      ui: harness.ui,
    };

    await runRepairStateFlow(ctx as never, { scope: 'project' });

    const journal = await readReceiptJournal('project', { cwd, agentDir });
    expect(journal.receipts.map((receipt) => receipt.id)).toContain(concurrent.id);
    expect(journal.receipts.at(-1)).toEqual(expect.objectContaining({
      operation: 'Repair State',
      summary: 'Rejected as Stale',
    }));
  });

  it('records and presents a Declined Receipt when State Repair consent stays at Default No', async () => {
    const harness = makeUiHarness({ confirm: false });
    const ctx = {
      cwd,
      mode: 'tui',
      hasUI: true,
      isProjectTrusted: () => true,
      ui: harness.ui,
    };

    await runRepairStateFlow(ctx as never, { scope: 'global' });

    expect(harness.sheets).toEqual(['Intent', 'Validation', 'Consent', 'Receipt']);
    expect(harness.renders.find((rendered) => rendered.includes(`▸ 2 ${transactionStepLabel('Validation')}（${uiText('step.activeSuffix')}）`))).toMatch(
      new RegExp(`${uiText('verdict.label')}：${verdictText('Passed')}.*${uiText('findings.count.label')}：${uiText('findings.count.line', { blocking: 0, warning: 0, notice: 0 })}`, 's'),
    );
    expect((await readReceiptJournal('global', { cwd, agentDir })).receipts.at(-1)).toEqual(
      expect.objectContaining({ kind: 'State Repair', operation: 'Repair State', summary: 'Declined' }),
    );
  });

  it('reports Receipt persistence failure when a declined State Repair Receipt cannot be appended', async () => {
    const journalPath = getReceiptsJournalPath('global', { cwd, agentDir });
    const lockPath = `${journalPath}.lock`;
    const lockFd = acquireLockSync(lockPath);
    const harness = makeUiHarness({ confirm: false });
    const ctx = {
      cwd,
      mode: 'tui',
      hasUI: true,
      isProjectTrusted: () => true,
      ui: harness.ui,
    };
    vi.useFakeTimers();

    try {
      const flow = runRepairStateFlow(ctx as never, { scope: 'global' });
      await vi.advanceTimersByTimeAsync(5_100);
      await flow;

      const receiptSheet = harness.renders.at(-1) ?? '';
      expect(harness.notifications.at(-1)).toContain('Attempt Summary：Persistence Failed（持久化失敗）');
      expect(receiptSheet).toMatch(/Attempt Summary:\s*"Persistence Failed"/s);
      expect(receiptSheet).toMatch(/RECEIPT_PERSISTENCE_FAILED.*JOURNAL-01/s);
      expect(receiptSheet).toContain('Repair State');
      expect((await readReceiptJournal('global', { cwd, agentDir })).receipts).toEqual([]);
    } finally {
      vi.useRealTimers();
      releaseLock(lockFd, lockPath);
    }
  });

  it('preserves Retry terminal findings while reporting its Receipt persistence failure', async () => {
    const missingReceiptId = 'rcpt_44444444-4444-4444-8444-444444444449';
    const journalPath = getReceiptsJournalPath('global', { cwd, agentDir });
    const lockPath = `${journalPath}.lock`;
    const lockFd = acquireLockSync(lockPath);
    const harness = makeUiHarness();
    const ctx = {
      cwd,
      mode: 'tui',
      hasUI: true,
      isProjectTrusted: () => true,
      reload: async () => {},
      ui: harness.ui,
    };
    vi.useFakeTimers();

    try {
      const flow = runRetryApplicationFlow(ctx as never, {
        scope: 'global',
        receiptId: missingReceiptId,
      });
      await vi.advanceTimersByTimeAsync(5_100);
      await flow;

      const receiptSheet = harness.renders.at(-1) ?? '';
      expect(harness.notifications.at(-1)).toContain('Attempt Summary：Persistence Failed（持久化失敗）');
      expect(receiptSheet).toMatch(/Attempt Summary:\s*"Persistence Failed"/s);
      expect(receiptSheet).toMatch(/REJECTED_AS_STALE.*STALE-01/s);
      expect(receiptSheet).toMatch(/RECEIPT_PERSISTENCE_FAILED.*JOURNAL-01/s);
      expect(receiptSheet).toContain(missingReceiptId);
      expect((await readReceiptJournal('global', { cwd, agentDir })).receipts).toEqual([]);
    } finally {
      vi.useRealTimers();
      releaseLock(lockFd, lockPath);
    }
  });

  it('retries the exact Pending Application chain and resolves it through a host reload', async () => {
    const seeded = await seedRuntimeSnapshot();
    const pending = createReceipt({
      id: 'rcpt_44444444-4444-4444-8444-444444444441',
      kind: 'Runtime Application',
      operation: 'Runtime Application',
      scope: 'global',
      trigger: 'initial runtime application',
      expectedStateRevision: seeded.stateRevision,
      validationSnapshot: seeded.validationSnapshot,
      runtimeOutcome: 'pending-application',
      summary: 'Pending Application',
      stateChanged: false,
    });
    await appendReceipt('global', pending, { cwd, agentDir });
    const harness = makeUiHarness();
    let reloads = 0;
    const ctx = {
      cwd,
      mode: 'tui',
      hasUI: true,
      isProjectTrusted: () => true,
      reload: async () => { reloads += 1; },
      ui: harness.ui,
    };

    await runRetryApplicationFlow(ctx as never, {
      scope: 'global',
      receiptId: pending.id,
    });

    expect(reloads).toBe(1);
    expect(harness.sheets).toEqual(['Intent', 'Validation', 'Consent', 'Plan', 'Commit', 'Receipt']);
    const journal = await readReceiptJournal('global', { cwd, agentDir });
    expect(journal.activeChains).toEqual([]);
    expect(journal.receipts.at(-1)).toEqual(expect.objectContaining({
      operation: 'Runtime Application',
      summary: 'Completed',
      runtimeOutcome: 'applied',
      recoversReceiptId: pending.id,
    }));
  });

  it('holds the scope Attempt Fence through Retry Application confirmation and host verification', async () => {
    const seeded = await seedRuntimeSnapshot();
    const pending = createReceipt({
      id: 'rcpt_44444444-4444-4444-8444-444444444442',
      kind: 'Runtime Application',
      operation: 'Runtime Application',
      scope: 'global',
      trigger: 'initial runtime application',
      expectedStateRevision: seeded.stateRevision,
      validationSnapshot: seeded.validationSnapshot,
      runtimeOutcome: 'pending-application',
      summary: 'Pending Application',
      stateChanged: false,
    });
    await appendReceipt('global', pending, { cwd, agentDir });
    let competingAttemptBlocked = false;
    const harness = makeUiHarness({
      onStep: async (step) => {
        if (step !== 'Intent') return;
        const competing = await acquireAttemptFence('global', {
          cwd,
          agentDir,
          fenceTimeoutMs: 5,
        });
        competingAttemptBlocked = !competing.ok;
        competing.handle?.release();
      },
    });

    await runRetryApplicationFlow({
      cwd,
      mode: 'tui',
      hasUI: true,
      isProjectTrusted: () => true,
      reload: async () => {},
      ui: harness.ui,
    } as never, { scope: 'global', receiptId: pending.id });

    expect(competingAttemptBlocked).toBe(true);
    expect(existsSync(getFencePath(getGlobalStatePath(agentDir)))).toBe(false);
  });

  it('blocks Project Retry Application when Project Trust is revoked during the Commit sheet', async () => {
    const seeded = await seedRuntimeSnapshot('project');
    const pending = createReceipt({
      id: 'rcpt_55555555-5555-4555-8555-555555555551',
      kind: 'Runtime Application',
      operation: 'Runtime Application',
      scope: 'project',
      trigger: 'initial runtime application',
      expectedStateRevision: seeded.stateRevision,
      validationSnapshot: seeded.validationSnapshot,
      runtimeOutcome: 'pending-application',
      summary: 'Pending Application',
      stateChanged: false,
    });
    await appendReceipt('project', pending, { cwd, agentDir });
    let projectTrusted = true;
    let reloads = 0;
    const harness = makeUiHarness({
      onStep: (step) => {
        if (step === 'Commit') projectTrusted = false;
      },
    });

    await runRetryApplicationFlow({
      cwd,
      mode: 'tui',
      hasUI: true,
      isProjectTrusted: () => projectTrusted,
      reload: async () => { reloads += 1; },
      ui: harness.ui,
    } as never, { scope: 'project', receiptId: pending.id });

    expect(reloads).toBe(0);
    expect(harness.sheets).toEqual(['Intent', 'Validation', 'Consent', 'Plan', 'Commit', 'Receipt']);
    const journal = await readReceiptJournal('project', { cwd, agentDir });
    expect(journal.activeChains.map((chain) => chain.rootReceiptId)).toContain(pending.id);
    expect(journal.receipts.at(-1)).toEqual(expect.objectContaining({
      summary: 'Blocked',
      runtimeOutcome: 'none',
      recoversReceiptId: pending.id,
      findings: [expect.objectContaining({
        code: 'PROJECT_TRUST_DENIED',
        rule: 'TRUST-01',
      })],
    }));
  });

  it('blocks Project Retry Application when the Global Pending Barrier activates during the Commit sheet', async () => {
    const seeded = await seedRuntimeSnapshot('project');
    const pending = createReceipt({
      id: 'rcpt_55555555-5555-4555-8555-555555555552',
      kind: 'Runtime Application',
      operation: 'Runtime Application',
      scope: 'project',
      trigger: 'initial runtime application',
      expectedStateRevision: seeded.stateRevision,
      validationSnapshot: seeded.validationSnapshot,
      runtimeOutcome: 'pending-application',
      summary: 'Pending Application',
      stateChanged: false,
    });
    await appendReceipt('project', pending, { cwd, agentDir });
    let barrierActivated = false;
    let reloads = 0;
    const harness = makeUiHarness({
      onStep: async (step) => {
        if (step !== 'Commit' || barrierActivated) return;
        barrierActivated = true;
        await appendReceipt('global', createReceipt({
          id: 'rcpt_66666666-6666-4666-8666-666666666661',
          kind: 'Runtime Application',
          operation: 'Runtime Application',
          scope: 'global',
          trigger: 'concurrent global runtime application',
          expectedStateRevision: '0',
          runtimeOutcome: 'pending-application',
          summary: 'Pending Application',
          stateChanged: false,
        }), { cwd, agentDir });
      },
    });

    await runRetryApplicationFlow({
      cwd,
      mode: 'tui',
      hasUI: true,
      isProjectTrusted: () => true,
      reload: async () => { reloads += 1; },
      ui: harness.ui,
    } as never, { scope: 'project', receiptId: pending.id });

    expect(reloads).toBe(0);
    expect(harness.sheets).toEqual(['Intent', 'Validation', 'Consent', 'Plan', 'Commit', 'Receipt']);
    const journal = await readReceiptJournal('project', { cwd, agentDir });
    expect(journal.activeChains.map((chain) => chain.rootReceiptId)).toContain(pending.id);
    expect(journal.receipts.at(-1)).toEqual(expect.objectContaining({
      summary: 'Blocked',
      runtimeOutcome: 'none',
      recoversReceiptId: pending.id,
      findings: [expect.objectContaining({
        code: 'GLOBAL_PENDING_BARRIER',
        rule: 'BARRIER-01',
      })],
    }));
  });

  it('keeps the Project recovery chain active when a guard activates during host reload re-entry', async () => {
    const seeded = await seedRuntimeSnapshot('project');
    const pending = createReceipt({
      id: 'rcpt_55555555-5555-4555-8555-555555555553',
      kind: 'Runtime Application',
      operation: 'Runtime Application',
      scope: 'project',
      trigger: 'initial runtime application',
      expectedStateRevision: seeded.stateRevision,
      validationSnapshot: seeded.validationSnapshot,
      runtimeOutcome: 'pending-application',
      summary: 'Pending Application',
      stateChanged: false,
    });
    await appendReceipt('project', pending, { cwd, agentDir });
    let reloads = 0;
    const harness = makeUiHarness();

    await runRetryApplicationFlow({
      cwd,
      mode: 'tui',
      hasUI: true,
      isProjectTrusted: () => true,
      reload: async () => {
        reloads += 1;
        await appendReceipt('global', createReceipt({
          id: 'rcpt_66666666-6666-4666-8666-666666666662',
          kind: 'Runtime Application',
          operation: 'Runtime Application',
          scope: 'global',
          trigger: 'global recovery activated during project reload',
          expectedStateRevision: '0',
          runtimeOutcome: 'pending-application',
          summary: 'Pending Application',
          stateChanged: false,
        }), { cwd, agentDir });
      },
      ui: harness.ui,
    } as never, { scope: 'project', receiptId: pending.id });

    expect(reloads).toBe(1);
    const journal = await readReceiptJournal('project', { cwd, agentDir });
    expect(journal.activeChains.map((chain) => chain.rootReceiptId)).toContain(pending.id);
    const recoveryReceipts = journal.receipts.filter((receipt) => receipt.recoversReceiptId === pending.id);
    expect(recoveryReceipts).toEqual([expect.objectContaining({
      summary: 'Blocked',
      runtimeOutcome: 'none',
      recoversReceiptId: pending.id,
      findings: [expect.objectContaining({
        code: 'GLOBAL_PENDING_BARRIER',
        rule: 'BARRIER-01',
      })],
    })]);
    expect(recoveryReceipts).not.toContainEqual(expect.objectContaining({
      summary: 'Completed',
      runtimeOutcome: 'applied',
    }));
  });

  it('records Pending Application and releases the fence when the host reload throws', async () => {
    const seeded = await seedRuntimeSnapshot();
    const pending = createReceipt({
      id: 'rcpt_44444444-4444-4444-8444-444444444443',
      kind: 'Runtime Application',
      operation: 'Runtime Application',
      scope: 'global',
      trigger: 'initial runtime application',
      expectedStateRevision: seeded.stateRevision,
      validationSnapshot: seeded.validationSnapshot,
      runtimeOutcome: 'pending-application',
      summary: 'Pending Application',
      stateChanged: false,
    });
    await appendReceipt('global', pending, { cwd, agentDir });
    const harness = makeUiHarness();

    await expect(runRetryApplicationFlow({
      cwd,
      mode: 'tui',
      hasUI: true,
      isProjectTrusted: () => true,
      reload: async () => { throw new Error('host reload failed'); },
      ui: harness.ui,
    } as never, { scope: 'global', receiptId: pending.id })).resolves.toBeUndefined();

    const journal = await readReceiptJournal('global', { cwd, agentDir });
    expect(journal.activeChains).toHaveLength(1);
    expect(journal.receipts.at(-1)).toEqual(expect.objectContaining({
      summary: 'Pending Application',
      runtimeOutcome: 'pending-application',
      validationSnapshot: seeded.validationSnapshot,
      recoversReceiptId: pending.id,
    }));
    expect(existsSync(getFencePath(getGlobalStatePath(agentDir)))).toBe(false);
  });

  it('fails Retry Application closed when the active root has no Validation Snapshot', async () => {
    const committed = await commitBridgeState('global', (state) => state, { cwd, agentDir });
    const pending = createReceipt({
      id: 'rcpt_44444444-4444-4444-8444-444444444444',
      kind: 'Runtime Application',
      operation: 'Runtime Application',
      scope: 'global',
      trigger: 'initial runtime application',
      expectedStateRevision: committed.newRevision!,
      runtimeOutcome: 'pending-application',
      summary: 'Pending Application',
      stateChanged: false,
    });
    await appendReceipt('global', pending, { cwd, agentDir });
    const harness = makeUiHarness();
    let reloads = 0;

    await runRetryApplicationFlow({
      cwd,
      mode: 'tui',
      hasUI: true,
      isProjectTrusted: () => true,
      reload: async () => { reloads += 1; },
      ui: harness.ui,
    } as never, { scope: 'global', receiptId: pending.id });

    expect(reloads).toBe(0);
    expect(harness.sheets).toEqual(['Receipt']);
    const journal = await readReceiptJournal('global', { cwd, agentDir });
    expect(journal.activeChains).toHaveLength(1);
    expect(journal.receipts.at(-1)).toEqual(expect.objectContaining({
      summary: 'Rejected as Stale',
      recoversReceiptId: pending.id,
    }));
  });

  it('fails Retry Application closed when the bound live source snapshot drifted', async () => {
    const seeded = await seedRuntimeSnapshot();
    const pending = createReceipt({
      id: 'rcpt_44444444-4444-4444-8444-444444444445',
      kind: 'Runtime Application',
      operation: 'Runtime Application',
      scope: 'global',
      trigger: 'initial runtime application',
      expectedStateRevision: seeded.stateRevision,
      validationSnapshot: seeded.validationSnapshot,
      runtimeOutcome: 'pending-application',
      summary: 'Pending Application',
      stateChanged: false,
    });
    await appendReceipt('global', pending, { cwd, agentDir });
    writeFileSync(
      seeded.skillPath,
      '---\nname: runtime-skill\ndescription: Runtime skill\n---\n\nDrifted body.\n',
    );
    const harness = makeUiHarness();
    let reloads = 0;

    await runRetryApplicationFlow({
      cwd,
      mode: 'tui',
      hasUI: true,
      isProjectTrusted: () => true,
      reload: async () => { reloads += 1; },
      ui: harness.ui,
    } as never, { scope: 'global', receiptId: pending.id });

    expect(reloads).toBe(0);
    expect(harness.sheets).toEqual(['Receipt']);
    const journal = await readReceiptJournal('global', { cwd, agentDir });
    expect(journal.activeChains).toHaveLength(1);
    expect(journal.receipts.at(-1)).toEqual(expect.objectContaining({
      summary: 'Rejected as Stale',
      validationSnapshot: seeded.validationSnapshot,
      recoversReceiptId: pending.id,
    }));
  });

  it('revalidates the bound snapshot after consent and rejects interaction-time drift before reload', async () => {
    const seeded = await seedRuntimeSnapshot();
    const pending = createReceipt({
      id: 'rcpt_44444444-4444-4444-8444-444444444446',
      kind: 'Runtime Application',
      operation: 'Runtime Application',
      scope: 'global',
      trigger: 'initial runtime application',
      expectedStateRevision: seeded.stateRevision,
      validationSnapshot: seeded.validationSnapshot,
      runtimeOutcome: 'pending-application',
      summary: 'Pending Application',
      stateChanged: false,
    });
    await appendReceipt('global', pending, { cwd, agentDir });
    let drifted = false;
    const harness = makeUiHarness({
      onStep: (step) => {
        if (step !== 'Commit' || drifted) return;
        drifted = true;
        writeFileSync(
          seeded.skillPath,
          '---\nname: runtime-skill\ndescription: Runtime skill\n---\n\nDrifted during consent.\n',
        );
      },
    });
    let reloads = 0;

    await runRetryApplicationFlow({
      cwd,
      mode: 'tui',
      hasUI: true,
      isProjectTrusted: () => true,
      reload: async () => { reloads += 1; },
      ui: harness.ui,
    } as never, { scope: 'global', receiptId: pending.id });

    expect(reloads).toBe(0);
    expect(harness.sheets).toEqual(['Intent', 'Validation', 'Consent', 'Plan', 'Commit', 'Receipt']);
    const journal = await readReceiptJournal('global', { cwd, agentDir });
    expect(journal.activeChains).toHaveLength(1);
    expect(journal.receipts.at(-1)).toEqual(expect.objectContaining({
      summary: 'Rejected as Stale',
      validationSnapshot: seeded.validationSnapshot,
      recoversReceiptId: pending.id,
    }));
  });

  it('revalidates State Revision after consent and rejects an interaction-time commit before reload', async () => {
    const seeded = await seedRuntimeSnapshot();
    const pending = createReceipt({
      id: 'rcpt_44444444-4444-4444-8444-444444444447',
      kind: 'Runtime Application',
      operation: 'Runtime Application',
      scope: 'global',
      trigger: 'initial runtime application',
      expectedStateRevision: seeded.stateRevision,
      validationSnapshot: seeded.validationSnapshot,
      runtimeOutcome: 'pending-application',
      summary: 'Pending Application',
      stateChanged: false,
    });
    await appendReceipt('global', pending, { cwd, agentDir });
    let committed = false;
    const harness = makeUiHarness({
      onStep: async (step) => {
        if (step !== 'Commit' || committed) return;
        committed = true;
        await commitBridgeState('global', (state) => ({ ...state }), { cwd, agentDir });
      },
    });
    let reloads = 0;

    await runRetryApplicationFlow({
      cwd,
      mode: 'tui',
      hasUI: true,
      isProjectTrusted: () => true,
      reload: async () => { reloads += 1; },
      ui: harness.ui,
    } as never, { scope: 'global', receiptId: pending.id });

    expect(reloads).toBe(0);
    expect(harness.sheets).toEqual(['Intent', 'Validation', 'Consent', 'Plan', 'Commit', 'Receipt']);
    const journal = await readReceiptJournal('global', { cwd, agentDir });
    expect(journal.activeChains).toHaveLength(1);
    expect(journal.receipts.at(-1)).toEqual(expect.objectContaining({
      summary: 'Rejected as Stale',
      validationSnapshot: seeded.validationSnapshot,
      recoversReceiptId: pending.id,
    }));
  });

  it('derives Retry Validation from the root Receipt findings and expands every canonical field', async () => {
    const seeded = await seedRuntimeSnapshot();
    const pending = createReceipt({
      id: 'rcpt_44444444-4444-4444-8444-444444444448',
      kind: 'Runtime Application',
      operation: 'Runtime Application',
      scope: 'global',
      trigger: 'initial runtime application',
      expectedStateRevision: seeded.stateRevision,
      validationSnapshot: seeded.validationSnapshot,
      runtimeOutcome: 'pending-application',
      summary: 'Pending Application',
      stateChanged: false,
      findings: [{
        code: 'WHOLE_PLUGIN_BLOCKED',
        classification: 'blocking',
        phase: 'post-commit',
        target: 'plugin',
        scope: 'global',
        pointer: '/plugins/0',
        rule: 'RUNTIME-01',
        outcome: 'host cannot apply this plugin',
      }],
    });
    await appendReceipt('global', pending, { cwd, agentDir });
    const harness = makeUiHarness({ expandValidation: true });
    let reloads = 0;
    const ctx = {
      cwd,
      mode: 'tui',
      hasUI: true,
      isProjectTrusted: () => true,
      reload: async () => { reloads += 1; },
      ui: harness.ui,
    };

    await runRetryApplicationFlow(ctx as never, {
      scope: 'global',
      receiptId: pending.id,
    });

    const disclosure = harness.renders.join('\n');
    expect(disclosure).toContain(`${uiText('verdict.label')}：${verdictText('Blocked')}`);
    expect(disclosure).toContain(uiText('findings.count.line', { blocking: 1, warning: 0, notice: 0 }));
    // Detail lines pass through quoteTerminalText, so embedded quotes surface as \".
    expect(disclosure).toMatch(/分類 blocking.*Scope global.*階段 post-commit.*目標 plugin.*指標.*plugins\/0.*代碼.*WHOLE_PLUGIN_BLOCKED.*規則.*RUNTIME-01.*結果 \\\"host cannot apply this plugin\\\"/s);
    expect(reloads).toBe(0);
    expect((await readReceiptJournal('global', { cwd, agentDir })).activeChains).toHaveLength(1);
  });

  it('keeps explicit Marketplace Refresh read-only and presents its blocked Receipt without selectors', async () => {
    const harness = makeUiHarness();
    const ctx = {
      cwd,
      mode: 'tui',
      hasUI: true,
      isProjectTrusted: () => true,
      ui: harness.ui,
    };

    await runRefreshFlow(ctx as never, {
      scope: 'global',
      registrationId: SECOND_REGISTRATION_ID,
    });

    expect(harness.selects).toEqual([]);
    expect(harness.sheets).toEqual(['Intent', 'Validation', 'Receipt']);
    expect(harness.renders.join('\n')).toContain('Marketplace Refresh');
    expect(harness.renders.join('\n')).toContain('Blocked');
    expect(harness.renders.join('\n')).toContain(`${uiText('verdict.label')}：${verdictText('Blocked')}`);
    const state = await readBridgeState('global', { cwd, agentDir });
    expect(state.status).toBe('missing');
    expect(state.state?.stateRevision).toBe('0');
  });
});
