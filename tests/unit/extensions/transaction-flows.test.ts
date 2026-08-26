import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { commitBridgeState, readBridgeState } from '../../../src/bridge-state/store.js';
import { declinePluginDisable, preflightPluginDisable } from '../../../src/installation/flow.js';
import { inspectMarketplaceEntries } from '../../../src/installation/inspection.js';
import { appendReceipt, readReceiptJournal } from '../../../src/journal/journal.js';
import { dispatchLedgerAction, formatStartupReceipt } from '../../../extensions/pi/index.js';
import { TRANSACTION_STEPS } from '../../../extensions/pi/transaction-sheet.js';
import { transactionStepLabel, uiText, verdictText, findingOutcomeText } from '../../../extensions/pi/ui-strings.js';
import { quoteTerminalText } from '../../../extensions/pi/terminal-presentation.js';
import {
  fullValidationDisclosureLines,
  reportOutcome,
  runLocalRegistrationFlow,
} from '../../../extensions/pi/registration.js';
import { runGitRegistrationFlow } from '../../../extensions/pi/git-registration.js';
import { runPluginInstallationFlow, runPluginStateFlow } from '../../../extensions/pi/installation.js';
import { createReceipt } from '../../../src/registration/receipt.js';

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_token: string, text: string) => text,
  bold: (text: string) => text,
};

function sheetCustom(
  events: string[],
  decide: (step: string) => 'continue' | 'cancel' = () => 'continue',
) {
  return async (factory: any): Promise<unknown> => new Promise((resolve) => {
    const component = factory({}, theme, {}, resolve);
    const rendered = component.render(120).join('\n');
    const active = TRANSACTION_STEPS.find((step, index) =>
      rendered.includes(`▸ ${index + 1} ${transactionStepLabel(step)}（${uiText('step.activeSuffix')}）`));
    if (active) events.push(active);
    component.handleInput?.(active && decide(active) === 'cancel' ? '\u001b' : '\r');
  });
}

function terminalPreflightSheetCustom(
  events: string[],
  renderedByStep: Map<string, string>,
  cancelValidation = false,
) {
  return async (factory: any): Promise<unknown> => new Promise((resolve) => {
    const component = factory({ requestRender: () => {} }, theme, {}, resolve);
    let rendered = component.render(120).join('\n');
    const active = TRANSACTION_STEPS.find((step, index) =>
      rendered.includes(`▸ ${index + 1} ${transactionStepLabel(step)}（${uiText('step.activeSuffix')}）`));
    if (active) {
      events.push(active);
      if (active === 'Validation') {
        component.handleInput?.('d');
        rendered = component.render(120).join('\n');
      }
      renderedByStep.set(active, rendered);
    }
    component.handleInput?.(active === 'Validation' && cancelValidation ? '\u001b' : '\r');
  });
}

function makeMarketplace(root: string, marketplaceName = 'acme-marketplace', pluginName = 'release-helper'): void {
  mkdirSync(join(root, '.agents', 'plugins'), { recursive: true });
  mkdirSync(join(root, 'plugins', pluginName, '.codex-plugin'), { recursive: true });
  mkdirSync(join(root, 'plugins', pluginName, 'skills', 'release-notes'), { recursive: true });
  writeFileSync(
    join(root, '.agents', 'plugins', 'marketplace.json'),
    JSON.stringify({
      name: marketplaceName,
      plugins: [{ source: { source: 'local', path: `./plugins/${pluginName}` } }],
    }),
  );
  writeFileSync(
    join(root, 'plugins', pluginName, '.codex-plugin', 'plugin.json'),
    JSON.stringify({ name: pluginName, skills: './skills/' }),
  );
  writeFileSync(
    join(root, 'plugins', pluginName, 'skills', 'release-notes', 'SKILL.md'),
    '---\nname: release-notes\ndescription: Release notes\n---\n\nWrite release notes.\n',
  );
}

describe('Bridge Ledger transaction flow adapters', () => {
  let root: string;
  let cwd: string;
  let agentDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'transaction-flow-'));
    cwd = join(root, 'project');
    agentDir = join(root, 'agent');
    makeMarketplace(join(root, 'marketplace'));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_AGENT_DIR = agentDir;
  });

  afterEach(() => {
    delete process.env.PI_CODING_AGENT_DIR;
    delete process.env.PI_AGENT_DIR;
    rmSync(root, { recursive: true, force: true });
  });

  it('formats every canonical Validation Finding field for expandable disclosures', () => {
    expect(fullValidationDisclosureLines([{
      code: 'RULE_CODE',
      classification: 'blocking',
      phase: 'validation',
      target: 'skill',
      pointer: '/skills/build',
      rule: 'RULE-01',
      outcome: 'blocked by policy',
    }])).toEqual([
      `${uiText('verdict.label')}：${verdictText('Blocked')}`,
      `${uiText('findings.count.label')}：${uiText('findings.count.line', { blocking: 1, warning: 0, notice: 0 })}`,
      // Unknown rule codes (RULE-01 is test-local) fall back to the canonical outcome text.
      uiText('finding.line', {
        classification: 'blocking',
        phase: 'validation',
        target: 'skill',
        pointer: '"/skills/build"',
        code: '"RULE_CODE"',
        rule: '"RULE-01"',
        outcome: quoteTerminalText(findingOutcomeText({ rule: 'RULE-01', outcome: 'blocked by policy' })),
      }),
    ]);
  });

  it('never opens a host scope selector — the single Global authority is implicit', async () => {
    const selectPrompts: string[] = [];
    const ctx = {
      cwd,
      mode: 'tui',
      isProjectTrusted: () => true,
      ui: {
        select: async (prompt: string) => {
          selectPrompts.push(prompt);
          return undefined;
        },
        input: async () => join(root, 'marketplace'),
        custom: async (_factory: unknown) => undefined,
        confirm: async () => false,
        notify: () => {},
      },
    };

    await runLocalRegistrationFlow(ctx as never);

    // Global-only (#61): no scope selection surface exists anywhere in the flow.
    expect(selectPrompts).toEqual([]);
    const state = await readBridgeState({ agentDir });
    expect(state.state?.registrations).toEqual([]);
  });

  it('shows Local Registration terminal preflight findings before its existing Receipt', async () => {
    const events: string[] = [];
    const renderedByStep = new Map<string, string>();
    const ctx = {
      cwd,
      mode: 'tui',
      hasUI: true,
      isProjectTrusted: () => false,
      ui: {
        select: async () => { throw new Error('no selector may open for a direct local registration'); },
        input: async () => join(root, 'missing-marketplace'),
        custom: terminalPreflightSheetCustom(events, renderedByStep, true),
        confirm: async () => { throw new Error('blocked preflight must not request Registration Confirmation'); },
        notify: () => {},
      },
    };

    await runLocalRegistrationFlow(ctx as never);

    expect(events).toEqual(['Intent', 'Validation', 'Receipt']);
    expect(renderedByStep.get('Validation')).toMatch(
      /State Revision:.*0.*Verdict.*Blocked.*SOURCE_NOT_EXISTS.*SRC-01/s,
    );
    expect(events).not.toContain('Consent');
    expect(events).not.toContain('Plan');
    expect(events).not.toContain('Commit');
    expect((await readReceiptJournal({ agentDir })).receipts).toEqual([
      expect.objectContaining({ summary: 'Blocked', expectedStateRevision: '0' }),
    ]);
  });

  it('does not let a Marketplace Entry name forge Registration Confirmation rows', async () => {
    const marketplace = join(root, 'marketplace');
    writeFileSync(
      join(marketplace, '.agents', 'plugins', 'marketplace.json'),
      JSON.stringify({
        name: 'acme-marketplace',
        plugins: [{
          name: 'safe\nFORGED-DISCLOSURE',
          source: { source: 'local', path: './plugins/release-helper' },
        }],
      }),
    );
    let confirmation = '';
    const ctx = {
      cwd,
      mode: 'tui',
      hasUI: true,
      isProjectTrusted: () => true,
      ui: {
        select: async () => undefined,
        input: async () => marketplace,
        custom: sheetCustom([]),
        confirm: async (_title: string, message: string) => {
          confirmation = message;
          return false;
        },
        notify: () => {},
      },
    };

    await runLocalRegistrationFlow(ctx as never);

    expect(confirmation).toContain('Registration ID');
    expect(confirmation).toContain('safe\\nFORGED-DISCLOSURE');
    expect(confirmation.split('\n').some((line) => line.trimStart().startsWith('FORGED-'))).toBe(false);
  });

  it('quotes an untrusted Receipt ID in the final outcome notification', async () => {
    const notifications: string[] = [];
    await reportOutcome({
      mode: 'print',
      hasUI: false,
      ui: {
        notify: (message: string) => { notifications.push(message); },
      },
    } as never, {
      receipt: createReceipt({
        id: 'rcpt-safe\nFORGED-RECEIPT\u001b[31m',
        operation: 'Test Receipt',
        trigger: 'test',
        expectedStateRevision: '0',
        summary: 'Completed',
      }),
    });

    const finalNotification = notifications.at(-1)!;
    expect(finalNotification).toContain('rcpt-safe\\nFORGED-RECEIPT\\u001b[31m');
    expect(finalNotification.split('\n').some((line) => line.startsWith('FORGED-'))).toBe(false);
    expect(finalNotification).not.toContain('\u001b[31m');
  });

  it('renders startup reconciliation Receipts without terminal-controlled finding rows', () => {
    const output = formatStartupReceipt(createReceipt({
      operation: 'Startup Reconciliation',
      trigger: 'startup',
      expectedStateRevision: '1',
      summary: 'Blocked',
      findings: [{
        code: 'STARTUP_TEST',
        classification: 'blocking',
        phase: 'post-commit',
        target: 'attempt',
        pointer: '/safe\nFORGED-POINTER',
        rule: 'TEST-01',
        outcome: 'safe\nFORGED-FINDING\u001b[31m',
      }],
    }));

    expect(output).toContain('\\nFORGED-FINDING');
    expect(output).toContain('\\u0');
    expect(output).toContain('\\nFORGED-POINTER');
    expect(output.split('\n').some((line) => line.startsWith('FORGED-'))).toBe(false);
    expect(output).not.toContain('\u001b[31m');
  });

  it('uses an explicit Registration ID without selecting a display label', async () => {
    const firstRoot = join(root, 'marketplace');
    const secondRoot = join(root, 'second-marketplace');
    const firstId = '11111111-1111-4111-8111-111111111111';
    const secondId = '22222222-2222-4222-8222-222222222222';
    makeMarketplace(secondRoot, 'second-marketplace', 'second-helper');
    await commitBridgeState((state) => ({
      ...state,
      registrations: [
        { id: firstId, marketplaceName: 'acme-marketplace', sourceKind: 'local', source: firstRoot },
        { id: secondId, marketplaceName: 'second-marketplace', sourceKind: 'local', source: secondRoot },
      ],
    }), { agentDir });

    const selectPrompts: string[] = [];
    const confirms: string[] = [];
    const ctx = {
      cwd,
      mode: 'tui',
      isProjectTrusted: () => true,
      ui: {
        select: async (prompt: string, options: string[]) => {
          selectPrompts.push(prompt);
          if (prompt.startsWith(uiText('inst.select.entry'))) return options[0];
          if (prompt === uiText('inst.select.path')) return uiText('inst.path.disabled');
          return undefined;
        },
        input: async () => undefined,
        custom: async (_factory: unknown) => undefined,
        confirm: async (title: string) => {
          confirms.push(title);
          return true;
        },
        notify: () => {},
      },
    };

    await runPluginInstallationFlow(ctx as never, { registrationId: secondId });

    expect(selectPrompts).toEqual([
      uiText('inst.select.entry'),
      uiText('inst.select.path'),
    ]);
    expect(confirms).toEqual([]);
    const state = await readBridgeState({ agentDir });
    expect(state.state?.installations).toEqual([
      expect.objectContaining({
        registrationId: secondId,
        pluginId: `${secondId}/second-marketplace/second-helper`,
        installationState: 'disabled',
      }),
    ]);
  });

  it('binds the legacy Entry selection State Revision before opening the Intent sheet', async () => {
    const marketplace = join(root, 'marketplace');
    const registrationId = '11111111-1111-4111-8111-111111111111';
    const selected = await commitBridgeState((state) => ({
      ...state,
      registrations: [{
        id: registrationId,
        marketplaceName: 'acme-marketplace',
        sourceKind: 'local',
        source: marketplace,
      }],
    }), { agentDir });
    const events: string[] = [];
    let revisionAdvanced = false;
    const ctx = {
      cwd,
      mode: 'tui',
      hasUI: true,
      isProjectTrusted: () => true,
      ui: {
        select: async (prompt: string, options: string[]) =>
          prompt === 'Installation path' ? 'Install Disabled' : options[0],
        input: async () => undefined,
        custom: async (factory: any): Promise<unknown> => new Promise((resolve) => {
          const component = factory({ requestRender: () => {} }, theme, {}, resolve);
          const rendered = component.render(120).join('\n');
          const active = TRANSACTION_STEPS.find((step, index) =>
      rendered.includes(`▸ ${index + 1} ${transactionStepLabel(step)}（${uiText('step.activeSuffix')}）`));
          if (active) events.push(active);
          void (async () => {
            if (active === 'Intent' && !revisionAdvanced) {
              revisionAdvanced = true;
              await commitBridgeState((state) => ({ ...state }), { agentDir });
            }
            component.handleInput?.('\r');
          })();
        }),
        confirm: async () => { throw new Error('stale legacy selection must not request Activation Confirmation'); },
        notify: () => {},
      },
    };

    await runPluginInstallationFlow(ctx as never, { registrationId });

    expect(events).toEqual(['Intent', 'Validation', 'Receipt']);
    expect((await readReceiptJournal({ agentDir })).receipts.at(-1)).toEqual(
      expect.objectContaining({
        summary: 'Rejected as Stale',
        expectedStateRevision: selected.newRevision,
        observedStateRevision: '2',
      }),
    );
    expect((await readBridgeState({ agentDir })).state?.installations).toEqual([]);
  });

  it('installs a Ledger-selected Marketplace Entry without reopening native Entry or path selectors', async () => {
    const marketplace = join(root, 'marketplace');
    const registrationId = '11111111-1111-4111-8111-111111111111';
    const registration = {
      id: registrationId,
      marketplaceName: 'acme-marketplace',
      sourceKind: 'local' as const,
      source: marketplace,
    };
    await commitBridgeState((state) => ({
      ...state,
      registrations: [registration],
    }), { agentDir });
    const selectPrompts: string[] = [];
    const events: string[] = [];
    const renderedByStep = new Map<string, string>();
    const targetId = `${registrationId}/acme-marketplace/plugins/0`;
    const validationSnapshot = inspectMarketplaceEntries(registration).snapshot!.fingerprint;
    const ctx = {
      cwd,
      mode: 'tui',
      hasUI: true,
      isProjectTrusted: () => true,
      ui: {
        select: async (prompt: string) => {
          selectPrompts.push(prompt);
          return undefined;
        },
        input: async () => undefined,
        custom: terminalPreflightSheetCustom(events, renderedByStep),
        confirm: async () => { throw new Error('Install Disabled must not ask Activation Confirmation'); },
        notify: () => {},
      },
    };

    await dispatchLedgerAction(ctx as never, {
      actionId: 'install-disabled',
      mode: 'mutation',
      targetKind: 'marketplace-entry',
      targetId,
      registrationId,
      entryPointer: '/plugins/0',
      desiredInstallationState: 'disabled',
      stateRevision: '1',
      validationSnapshot,
    });

    expect(selectPrompts).toEqual([]);
    expect(events).toEqual(['Intent', 'Validation', 'Consent', 'Plan', 'Commit', 'Receipt']);
    for (const step of events) expect(renderedByStep.get(step)).toContain(targetId);
    expect((await readBridgeState({ agentDir })).state?.installations).toEqual([
      expect.objectContaining({
        registrationId,
        marketplaceEntryId: `${registrationId}/acme-marketplace/plugins/0`,
        installationState: 'disabled',
      }),
    ]);
    expect((await readReceiptJournal({ agentDir })).receipts.at(-1)).toEqual(
      expect.objectContaining({ trigger: `install ${targetId}` }),
    );
  });

  it('reports the canonical Ledger installation Intent and terminal receipt when its target disappears', async () => {
    const marketplace = join(root, 'marketplace');
    const registrationId = '11111111-1111-4111-8111-111111111111';
    const registration = {
      id: registrationId,
      marketplaceName: 'acme-marketplace',
      sourceKind: 'local' as const,
      source: marketplace,
    };
    const selected = await commitBridgeState((state) => ({
      ...state,
      registrations: [registration],
    }), { agentDir });
    const validationSnapshot = inspectMarketplaceEntries(registration).snapshot!.fingerprint;
    await commitBridgeState((state) => ({
      ...state,
      registrations: [],
    }), { agentDir });
    const events: string[] = [];
    const renderedByStep = new Map<string, string>();
    const targetId = `${registrationId}/acme-marketplace/plugins/0`;
    const ctx = {
      cwd,
      mode: 'tui',
      hasUI: true,
      isProjectTrusted: () => true,
      ui: {
        select: async () => { throw new Error('structured stale target must not open selectors'); },
        input: async () => { throw new Error('structured stale target must not request input'); },
        custom: terminalPreflightSheetCustom(events, renderedByStep),
        confirm: async () => { throw new Error('stale target must not request Activation Confirmation'); },
        notify: () => {},
      },
    };

    await dispatchLedgerAction(ctx as never, {
      actionId: 'install-disabled',
      mode: 'mutation',
      targetKind: 'marketplace-entry',
      targetId,
      registrationId,
      entryPointer: '/plugins/0',
      desiredInstallationState: 'disabled',
      stateRevision: selected.newRevision,
      validationSnapshot,
    });

    expect(events).toEqual(['Intent', 'Validation', 'Receipt']);
    expect(renderedByStep.get('Intent')).toMatch(
      new RegExp(`目標:.*${registrationId}/acme-marketplace/plugins/0.*State Revision:.*${selected.newRevision}`, 's'),
    );
    expect(renderedByStep.get('Validation')).toMatch(/Verdict.*Blocked.*REJECTED_AS_STALE/s);
    expect((await readReceiptJournal({ agentDir })).receipts.at(-1)).toEqual(
      expect.objectContaining({
        operation: 'Plugin Installation',
        summary: 'Rejected as Stale',
        expectedStateRevision: selected.newRevision,
        observedStateRevision: '2',
      }),
    );
  });

  it('preserves the complete Ledger Marketplace Entry target through domain preflight', async () => {
    const marketplace = join(root, 'marketplace');
    const registrationId = '11111111-1111-4111-8111-111111111111';
    const registration = {
      id: registrationId,
      marketplaceName: 'acme-marketplace',
      sourceKind: 'local' as const,
      source: marketplace,
    };
    const selected = await commitBridgeState((state) => ({
      ...state,
      registrations: [registration],
    }), { agentDir });
    const validationSnapshot = inspectMarketplaceEntries(registration).snapshot!.fingerprint;
    const events: string[] = [];
    const renderedByStep = new Map<string, string>();
    const selectedTargetId = `${registrationId}/previous-marketplace/plugins/0`;
    const ctx = {
      cwd,
      mode: 'tui',
      hasUI: true,
      isProjectTrusted: () => true,
      ui: {
        select: async () => { throw new Error('structured identity must not open selectors'); },
        input: async () => { throw new Error('structured identity must not request input'); },
        custom: terminalPreflightSheetCustom(events, renderedByStep),
        confirm: async () => { throw new Error('stale identity must not request Activation Confirmation'); },
        notify: () => {},
      },
    };

    await dispatchLedgerAction(ctx as never, {
      actionId: 'install-disabled',
      mode: 'mutation',
      targetKind: 'marketplace-entry',
      targetId: selectedTargetId,
      registrationId,
      entryPointer: '/plugins/0',
      desiredInstallationState: 'disabled',
      stateRevision: selected.newRevision,
      validationSnapshot,
    });

    expect(events).toEqual(['Intent', 'Validation', 'Receipt']);
    expect(renderedByStep.get('Intent')).toContain(selectedTargetId);
    expect(renderedByStep.get('Validation')).toMatch(/REJECTED_AS_STALE.*STALE-01/s);
    expect((await readReceiptJournal({ agentDir })).receipts.at(-1)).toEqual(
      expect.objectContaining({
        summary: 'Rejected as Stale',
        expectedStateRevision: selected.newRevision,
        observedStateRevision: selected.newRevision,
      }),
    );
    expect((await readBridgeState({ agentDir })).state?.installations).toEqual([]);
  });

  it('blocks a same-revision Ledger installation when catalog reorder redirects its Entry pointer', async () => {
    const marketplace = join(root, 'marketplace');
    const registrationId = '11111111-1111-4111-8111-111111111111';
    mkdirSync(join(marketplace, 'plugins', 'second-helper', '.codex-plugin'), { recursive: true });
    mkdirSync(join(marketplace, 'plugins', 'second-helper', 'skills', 'second-notes'), { recursive: true });
    writeFileSync(
      join(marketplace, 'plugins', 'second-helper', '.codex-plugin', 'plugin.json'),
      JSON.stringify({ name: 'second-helper', skills: './skills/' }),
    );
    writeFileSync(
      join(marketplace, 'plugins', 'second-helper', 'skills', 'second-notes', 'SKILL.md'),
      '---\nname: second-notes\ndescription: Second notes\n---\n\nWrite second notes.\n',
    );
    const initialCatalog = {
      name: 'acme-marketplace',
      plugins: [
        { source: { source: 'local', path: './plugins/release-helper' } },
        { source: { source: 'local', path: './plugins/second-helper' } },
      ],
    };
    writeFileSync(
      join(marketplace, '.agents', 'plugins', 'marketplace.json'),
      JSON.stringify(initialCatalog),
    );
    const registration = {
      id: registrationId,
      marketplaceName: 'acme-marketplace',
      sourceKind: 'local' as const,
      source: marketplace,
    };
    const selectedSnapshot = inspectMarketplaceEntries(registration).snapshot!.fingerprint;
    const selected = await commitBridgeState((state) => ({
      ...state,
      registrations: [registration],
    }), { agentDir });
    writeFileSync(
      join(marketplace, '.agents', 'plugins', 'marketplace.json'),
      JSON.stringify({ ...initialCatalog, plugins: [...initialCatalog.plugins].reverse() }),
    );
    const events: string[] = [];
    const renderedByStep = new Map<string, string>();
    const targetId = `${registrationId}/acme-marketplace/plugins/0`;
    const ctx = {
      cwd,
      mode: 'tui',
      hasUI: true,
      isProjectTrusted: () => true,
      ui: {
        select: async () => { throw new Error('structured stale target must not open selectors'); },
        input: async () => { throw new Error('structured stale target must not request input'); },
        custom: terminalPreflightSheetCustom(events, renderedByStep),
        confirm: async () => { throw new Error('source-drift target must not request Activation Confirmation'); },
        notify: () => {},
      },
    };

    await dispatchLedgerAction(ctx as never, {
      actionId: 'install-disabled',
      mode: 'mutation',
      targetKind: 'marketplace-entry',
      targetId,
      registrationId,
      entryPointer: '/plugins/0',
      desiredInstallationState: 'disabled',
      stateRevision: selected.newRevision,
      validationSnapshot: selectedSnapshot,
    });

    expect(events).toEqual(['Intent', 'Validation', 'Receipt']);
    expect(renderedByStep.get('Validation')).toMatch(/REJECTED_AS_STALE.*STALE-01/s);
    expect((await readReceiptJournal({ agentDir })).receipts.at(-1)).toEqual(
      expect.objectContaining({
        operation: 'Plugin Installation',
        summary: 'Rejected as Stale',
        expectedStateRevision: selected.newRevision,
      }),
    );
    expect((await readBridgeState({ agentDir })).state?.installations).toEqual([]);
  });

  it('reports an exact terminal finding when a same-revision Ledger Entry becomes Unavailable', async () => {
    const marketplace = join(root, 'marketplace');
    const registrationId = '11111111-1111-4111-8111-111111111111';
    const registration = {
      id: registrationId,
      marketplaceName: 'acme-marketplace',
      sourceKind: 'local' as const,
      source: marketplace,
    };
    const selected = await commitBridgeState((state) => ({
      ...state,
      registrations: [registration],
    }), { agentDir });
    const validationSnapshot = inspectMarketplaceEntries(registration).snapshot!.fingerprint;
    writeFileSync(
      join(marketplace, '.agents', 'plugins', 'marketplace.json'),
      JSON.stringify({
        name: 'acme-marketplace',
        plugins: [{ name: 'release-helper', type: 'git' }],
      }),
    );
    const events: string[] = [];
    const renderedByStep = new Map<string, string>();
    const targetId = `${registrationId}/acme-marketplace/plugins/0`;
    const ctx = {
      cwd,
      mode: 'tui',
      hasUI: true,
      isProjectTrusted: () => true,
      ui: {
        select: async () => { throw new Error('structured unavailable target must not open selectors'); },
        input: async () => { throw new Error('structured unavailable target must not request input'); },
        custom: terminalPreflightSheetCustom(events, renderedByStep),
        confirm: async () => { throw new Error('unavailable target must not request Activation Confirmation'); },
        notify: () => {},
      },
    };

    await dispatchLedgerAction(ctx as never, {
      actionId: 'install-disabled',
      mode: 'mutation',
      targetKind: 'marketplace-entry',
      targetId,
      registrationId,
      entryPointer: '/plugins/0',
      desiredInstallationState: 'disabled',
      stateRevision: selected.newRevision,
      validationSnapshot,
    });

    expect(events).toEqual(['Intent', 'Validation', 'Receipt']);
    expect(renderedByStep.get('Validation')).toMatch(
      new RegExp(`Verdict.*Blocked.*INSTALLATION_NOT_FOUND.*INSTALL-01.*${findingOutcomeText({ rule: 'INSTALL-01', outcome: 'unsupported source kind' })}`, 's'),
    );
    expect((await readReceiptJournal({ agentDir })).receipts.at(-1)).toEqual(
      expect.objectContaining({
        summary: 'Blocked',
        findings: expect.arrayContaining([
          expect.objectContaining({ code: 'INSTALLATION_NOT_FOUND', target: 'entry' }),
        ]),
      }),
    );
  });

  it('asks only the Git Selector — no scope selector exists (Global-only)', async () => {
    const selectPrompts: string[] = [];
    const ctx = {
      cwd,
      mode: 'tui',
      isProjectTrusted: () => true,
      ui: {
        select: async (prompt: string) => {
          selectPrompts.push(prompt);
          if (prompt.startsWith(uiText('reg.git.selector.prompt').split(' — ')[0]!)) return uiText('reg.git.selector.default');
          return undefined;
        },
        input: async () => 'not-a-git-locator',
        custom: async (_factory: unknown) => undefined,
        confirm: async () => false,
        notify: () => {},
      },
    };

    await runGitRegistrationFlow(ctx as never);

    expect(selectPrompts).toEqual(['Git Selector — 選擇型別']);
    const project = await readBridgeState({ agentDir });
    expect(project.state?.registrations).toEqual([]);
  });

  it('shows Git Registration terminal preflight findings before its existing Receipt', async () => {
    const events: string[] = [];
    const renderedByStep = new Map<string, string>();
    const ctx = {
      cwd,
      mode: 'tui',
      hasUI: true,
      isProjectTrusted: () => true,
      ui: {
        select: async (prompt: string) => {
          if (prompt.startsWith(uiText('reg.git.selector.prompt').split(' — ')[0]!)) return uiText('reg.git.selector.default');
          throw new Error('explicit scope must not open another selector');
        },
        input: async () => 'not-a-git-locator',
        custom: terminalPreflightSheetCustom(events, renderedByStep),
        confirm: async () => { throw new Error('blocked preflight must not request Registration Confirmation'); },
        notify: () => {},
      },
    };

    await runGitRegistrationFlow(ctx as never);

    expect(events).toEqual(['Intent', 'Validation', 'Receipt']);
    expect(renderedByStep.get('Validation')).toMatch(
      /State Revision:.*0.*Verdict.*Blocked.*GIT_LOCATOR_INVALID.*GIT-01/s,
    );
    expect(events).not.toContain('Consent');
    expect(events).not.toContain('Plan');
    expect(events).not.toContain('Commit');
    expect((await readReceiptJournal({ agentDir })).receipts).toEqual([
      expect.objectContaining({ summary: 'Blocked', expectedStateRevision: '0' }),
    ]);
  });

  it('uses an explicit Installation ID without selecting a display label', async () => {
    const firstId = 'global/first-market/plugin-a';
    const secondId = 'global/second-market/plugin-b';
    await commitBridgeState((state) => ({
      ...state,
      installations: [
        { id: firstId, pluginId: 'first-market/plugin-a', installationState: 'enabled' },
        { id: secondId, pluginId: 'second-market/plugin-b', installationState: 'enabled' },
      ],
    }), { agentDir });
    const selectPrompts: string[] = [];
    const ctx = {
      cwd,
      mode: 'tui',
      isProjectTrusted: () => true,
      ui: {
        select: async (prompt: string) => {
          selectPrompts.push(prompt);
          return undefined;
        },
        input: async () => undefined,
        custom: async (_factory: unknown) => undefined,
        confirm: async () => false,
        notify: () => {},
      },
    };

    await runPluginStateFlow(ctx as never, { installationId: secondId });

    expect(selectPrompts).toEqual([]);
    const state = await readBridgeState({ agentDir });
    expect(state.state?.installations).toEqual([
      expect.objectContaining({ id: firstId, installationState: 'enabled' }),
      expect.objectContaining({ id: secondId, installationState: 'disabled' }),
    ]);
  });

  it('shows Plugin Enablement terminal preflight findings before its existing Receipt', async () => {
    const installationId = 'global/acme-market/plugin-a';
    const initial = await commitBridgeState((state) => ({
      ...state,
      installations: [{
        id: installationId,
        pluginId: 'acme-market/plugin-a',
        installationState: 'disabled',
        validationSnapshot: 'snapshot-bound-to-disabled-installation',
      }],
    }), { agentDir });
    const events: string[] = [];
    const renderedByStep = new Map<string, string>();
    const ctx = {
      cwd,
      mode: 'tui',
      hasUI: true,
      isProjectTrusted: () => true,
      ui: {
        select: async () => { throw new Error('explicit enablement target must not open selectors'); },
        input: async () => { throw new Error('explicit enablement target must not request input'); },
        custom: terminalPreflightSheetCustom(events, renderedByStep),
        confirm: async () => { throw new Error('blocked preflight must not request Activation Confirmation'); },
        notify: () => {},
      },
    };

    await runPluginStateFlow(ctx as never, {
      installationId,
      desiredState: 'enabled',
      expectedStateRevision: initial.newRevision,
    });

    expect(events).toEqual(['Intent', 'Validation', 'Receipt']);
    expect(renderedByStep.get('Validation')).toMatch(
      /State Revision:.*1.*Verdict.*Blocked.*INSTALLATION_NOT_FOUND.*INSTALL-01/s,
    );
    expect(events).not.toContain('Consent');
    expect(events).not.toContain('Plan');
    expect(events).not.toContain('Commit');
    expect((await readReceiptJournal({ agentDir })).receipts).toEqual([
      expect.objectContaining({
        operation: 'Plugin Enablement',
        summary: 'Blocked',
        expectedStateRevision: '1',
      }),
    ]);
  });

  it('reports a structured Plugin Enablement receipt when the selected Installation is missing', async () => {
    const installationId = 'global/acme-market/missing-plugin';
    const events: string[] = [];
    const renderedByStep = new Map<string, string>();
    const ctx = {
      cwd,
      mode: 'tui',
      hasUI: true,
      isProjectTrusted: () => true,
      ui: {
        select: async () => { throw new Error('structured missing target must not open selectors'); },
        input: async () => { throw new Error('structured missing target must not request input'); },
        custom: terminalPreflightSheetCustom(events, renderedByStep),
        confirm: async () => { throw new Error('missing target must not request Activation Confirmation'); },
        notify: () => {},
      },
    };

    await dispatchLedgerAction(ctx as never, {
      actionId: 'enable-installation',
      mode: 'mutation',
      targetKind: 'installation',
      targetId: installationId,
      stateRevision: '0',
    });

    expect(events).toEqual(['Intent', 'Validation', 'Receipt']);
    expect(renderedByStep.get('Intent')).toMatch(
      /動作:.*Plugin Enablement.*目標:.*global\/acme-market\/missing-plugin.*State Revision:.*0/s,
    );
    expect(renderedByStep.get('Validation')).toMatch(/INSTALLATION_NOT_FOUND.*INSTALL-01/s);
    expect((await readReceiptJournal({ agentDir })).receipts).toEqual([
      expect.objectContaining({
        operation: 'Plugin Enablement',
        summary: 'Blocked',
        expectedStateRevision: '0',
      }),
    ]);
  });

  it('reports a structured Plugin Disablement receipt when the selected Installation is missing', async () => {
    const installationId = 'global/acme-market/missing-plugin';
    const events: string[] = [];
    const renderedByStep = new Map<string, string>();
    const ctx = {
      cwd,
      mode: 'tui',
      hasUI: true,
      isProjectTrusted: () => true,
      ui: {
        select: async () => { throw new Error('structured missing target must not open selectors'); },
        input: async () => { throw new Error('structured missing target must not request input'); },
        custom: terminalPreflightSheetCustom(events, renderedByStep),
        confirm: async () => { throw new Error('missing target must not request Activation Confirmation'); },
        notify: () => {},
      },
    };

    await dispatchLedgerAction(ctx as never, {
      actionId: 'disable-installation',
      mode: 'mutation',
      targetKind: 'installation',
      targetId: installationId,
      stateRevision: '0',
    });

    expect(events).toEqual(['Intent', 'Validation', 'Receipt']);
    expect(renderedByStep.get('Intent')).toMatch(
      /動作:.*Plugin Disablement.*目標:.*global\/acme-market\/missing-plugin.*State Revision:.*0/s,
    );
    expect(renderedByStep.get('Validation')).toMatch(/INSTALLATION_NOT_FOUND.*INSTALL-01/s);
    expect((await readReceiptJournal({ agentDir })).receipts).toEqual([
      expect.objectContaining({
        operation: 'Plugin Disablement',
        summary: 'Blocked',
        expectedStateRevision: '0',
      }),
    ]);
  });

  it('reports Attempt Fence denial before Plugin Disablement Validation can proceed', async () => {
    const installationId = 'global/acme-market/plugin-a';
    const selected = await commitBridgeState((state) => ({
      ...state,
      installations: [{
        id: installationId,
        pluginId: 'acme-market/plugin-a',
        installationState: 'enabled',
      }],
    }), { agentDir });
    const held = await preflightPluginDisable(installationId, { agentDir });
    expect(held.ok).toBe(true);
    if (!held.ok) return;
    const events: string[] = [];
    const renderedByStep = new Map<string, string>();
    const ctx = {
      cwd,
      mode: 'tui',
      hasUI: true,
      isProjectTrusted: () => true,
      ui: {
        select: async () => { throw new Error('structured fenced target must not open selectors'); },
        input: async () => { throw new Error('structured fenced target must not request input'); },
        custom: terminalPreflightSheetCustom(events, renderedByStep),
        confirm: async () => { throw new Error('fenced target must not request Activation Confirmation'); },
        notify: () => {},
      },
    };

    try {
      await dispatchLedgerAction(ctx as never, {
        actionId: 'disable-installation',
        mode: 'mutation',
        targetKind: 'installation',
        targetId: installationId,
        stateRevision: selected.newRevision,
      });

      expect(events).toEqual(['Intent', 'Validation', 'Receipt']);
      expect(renderedByStep.get('Validation')).toMatch(/ATTEMPT_IN_PROGRESS.*FENCE-01/s);
      expect(events).not.toContain('Consent');
      expect((await readReceiptJournal({ agentDir })).receipts.at(-1)).toEqual(
        expect.objectContaining({
          operation: 'Plugin Disablement',
          summary: 'Blocked',
          findings: expect.arrayContaining([
            expect.objectContaining({ code: 'ATTEMPT_IN_PROGRESS' }),
          ]),
        }),
      );
    } finally {
      await declinePluginDisable(held.preflight, { agentDir });
    }
  });

  it('completes Plugin Disablement even while Global has an active recovery chain (Barrier retired)', async () => {
    const installationId = 'project/11111111-1111-4111-8111-111111111111/acme-marketplace/release-helper';
    const selected = await commitBridgeState((state) => ({
      ...state,
      installations: [{
        id: installationId,
        pluginId: '11111111-1111-4111-8111-111111111111/acme-marketplace/release-helper',
        installationState: 'enabled',
      }],
    }), { agentDir });
    await appendReceipt(createReceipt({
      operation: 'Runtime Application',
      trigger: 'concurrent global runtime application',
      expectedStateRevision: '0',
      runtimeOutcome: 'pending-application',
      summary: 'Pending Application',
      stateChanged: false,
    }), { agentDir });
    const events: string[] = [];
    const renderedByStep = new Map<string, string>();
    const ctx = {
      cwd,
      mode: 'tui',
      hasUI: true,
      isProjectTrusted: () => true,
      ui: {
        select: async () => { throw new Error('structured disablement target must not open selectors'); },
        input: async () => { throw new Error('structured disablement target must not request input'); },
        custom: terminalPreflightSheetCustom(events, renderedByStep),
        confirm: async () => true,
        notify: () => {},
      },
    };

    await runPluginStateFlow(ctx as never, {
      installationId,
      desiredState: 'disabled',
      expectedStateRevision: selected.newRevision,
    });

    expect(events).toEqual(['Intent', 'Validation', 'Consent', 'Plan', 'Commit', 'Receipt']);
    expect((await readBridgeState({ agentDir })).state?.installations).toEqual([
      expect.objectContaining({ id: installationId, installationState: 'disabled' }),
    ]);
    expect((await readReceiptJournal({ agentDir })).receipts.at(-1)).toEqual(
      expect.objectContaining({ operation: 'Plugin Disablement', summary: 'Completed' }),
    );
  });

  it('rejects a Ledger-selected Repair after State drifted before dispatch', async () => {
    const selected = await commitBridgeState((state) => ({ ...state }), { agentDir });
    await commitBridgeState((state) => ({ ...state }), { agentDir });
    const events: string[] = [];
    const renderedByStep = new Map<string, string>();
    const ctx = {
      cwd,
      mode: 'tui',
      hasUI: true,
      isProjectTrusted: () => true,
      ui: {
        select: async () => { throw new Error('structured repair scope must not open selectors'); },
        input: async () => { throw new Error('structured repair target must not request input'); },
        custom: terminalPreflightSheetCustom(events, renderedByStep),
        confirm: async () => true,
        notify: () => {},
      },
    };

    await dispatchLedgerAction(ctx as never, {
      actionId: 'repair-state',
      mode: 'mutation',
      targetKind: 'scope',
      targetId: 'global',
      stateRevision: selected.newRevision,
    });

    expect(events).toEqual(['Intent', 'Validation', 'Consent', 'Plan', 'Commit', 'Receipt']);
    expect(renderedByStep.get('Intent')).toMatch(
      new RegExp(`目標:.*Global Bridge State.*State Revision:.*${selected.newRevision}`, 's'),
    );
    expect((await readBridgeState({ agentDir })).state?.stateRevision).toBe('2');
    expect((await readReceiptJournal({ agentDir })).receipts.at(-1)).toEqual(
      expect.objectContaining({
        operation: 'Repair State',
        expectedStateRevision: selected.newRevision,
        observedStateRevision: '2',
        summary: 'Rejected as Stale',
      }),
    );
  });

  it('rejects a stale disable intent instead of inferring and running the opposite enable action', async () => {
    const installationId = 'global/acme-market/plugin-a';
    const first = await commitBridgeState((state) => ({
      ...state,
      installations: [{
        id: installationId,
        pluginId: 'acme-market/plugin-a',
        installationState: 'enabled',
      }],
    }), { agentDir });
    await commitBridgeState((state) => ({
      ...state,
      installations: state.installations.map((installation) => ({
        ...installation,
        installationState: 'disabled',
      })),
    }), { agentDir });
    const events: string[] = [];
    const ctx = {
      cwd,
      mode: 'tui',
      hasUI: true,
      isProjectTrusted: () => true,
      ui: {
        select: async () => { throw new Error('stale intent must not open enable selectors'); },
        input: async () => { throw new Error('stale intent must not request input'); },
        custom: sheetCustom(events),
        confirm: async () => { throw new Error('stale intent must not request Activation Confirmation'); },
        notify: () => {},
      },
    };

    await dispatchLedgerAction(ctx as never, {
      actionId: 'disable-installation',
      mode: 'mutation',
      targetKind: 'installation',
      targetId: installationId,
      stateRevision: first.newRevision,
    } as never);

    const state = await readBridgeState({ agentDir });
    expect(state.state?.stateRevision).toBe('2');
    expect(state.state?.installations[0]?.installationState).toBe('disabled');
    expect(events).toEqual(['Intent', 'Validation', 'Receipt']);
    expect((await readReceiptJournal({ agentDir })).receipts.at(-1)).toEqual(
      expect.objectContaining({ summary: 'Rejected as Stale' }),
    );
  });

  it('rejects Plugin Disablement when State Revision drifts while the Commit sheet is open', async () => {
    const installationId = 'global/acme-market/plugin-a';
    const initial = await commitBridgeState((state) => ({
      ...state,
      installations: [{
        id: installationId,
        pluginId: 'acme-market/plugin-a',
        installationState: 'enabled',
      }],
    }), { agentDir });
    const events: string[] = [];
    let drifted = false;
    const ctx = {
      cwd,
      mode: 'tui',
      hasUI: true,
      isProjectTrusted: () => true,
      ui: {
        select: async () => { throw new Error('explicit disablement must not open selectors'); },
        input: async () => { throw new Error('explicit disablement must not request input'); },
        custom: async (factory: any) => {
          let finish!: (value: unknown) => void;
          const result = new Promise<unknown>((resolve) => { finish = resolve; });
          const component = factory({}, theme, {}, finish);
          const rendered = component.render(120).join('\n');
          const active = TRANSACTION_STEPS.find((step, index) =>
      rendered.includes(`▸ ${index + 1} ${transactionStepLabel(step)}（${uiText('step.activeSuffix')}）`));
          if (active) events.push(active);
          if (active === 'Commit' && !drifted) {
            drifted = true;
            await commitBridgeState((state) => ({ ...state }), { agentDir });
          }
          component.handleInput('\r');
          return result;
        },
        confirm: async () => { throw new Error('disablement must not request Activation Confirmation'); },
        notify: () => {},
      },
    };

    await runPluginStateFlow(ctx as never, {
      installationId,
      desiredState: 'disabled',
      expectedStateRevision: initial.newRevision,
    });

    const state = await readBridgeState({ agentDir });
    expect(state.state?.stateRevision).toBe('2');
    expect(state.state?.installations[0]?.installationState).toBe('enabled');
    expect(events).toEqual(['Intent', 'Validation', 'Consent', 'Plan', 'Commit', 'Receipt']);
    expect((await readReceiptJournal({ agentDir })).receipts.at(-1)).toEqual(
      expect.objectContaining({
        operation: 'Plugin Disablement',
        expectedStateRevision: '1',
        observedStateRevision: '2',
        summary: 'Rejected as Stale',
        findings: expect.arrayContaining([
          expect.objectContaining({ code: 'REJECTED_AS_STALE', rule: 'STALE-01' }),
        ]),
      }),
    );
  });

  it.each(['disabled', 'enabled'] as const)(
    'guards Plugin Installation (%s) against an entirely Unavailable Marketplace before any sheet',
    async (targetState) => {
      const marketplace = join(root, 'marketplace');
      const registrationId = '11111111-1111-4111-8111-111111111111';
      // Every Entry resolves as Unavailable (non-local source kind), so no selectable
      // pointer exists and the flow must refuse before opening any transaction sheet.
      writeFileSync(
        join(marketplace, '.agents', 'plugins', 'marketplace.json'),
        JSON.stringify({
          name: 'acme-marketplace',
          plugins: [{ name: 'release-helper', type: 'git' }],
        }),
      );
      await commitBridgeState((state) => ({
        ...state,
        registrations: [{
          id: registrationId,
          marketplaceName: 'acme-marketplace',
          sourceKind: 'local',
          source: marketplace,
        }],
      }), { agentDir });
      const notifications: string[] = [];
      const ctx = {
        cwd,
        mode: 'tui',
        hasUI: true,
        isProjectTrusted: () => true,
        ui: {
          select: async () => { throw new Error('unavailable entries must not open selectors'); },
          input: async () => { throw new Error('unavailable entries must not request input'); },
          custom: async () => { throw new Error('unavailable entries must not open a transaction sheet'); },
          confirm: async () => { throw new Error('unavailable entries must not request confirmation'); },
          notify: (message: string) => { notifications.push(message); },
        },
      };

      await runPluginInstallationFlow(ctx as never, {
        registrationId,
        entryPointer: '/plugins/0',
        targetState,
      });

      expect(notifications.join('\n')).toMatch(/無法使用|Unavailable|無法安裝/);
      expect((await readBridgeState({ agentDir })).state?.installations).toEqual([]);
      expect(await readReceiptJournal({ agentDir })).toEqual(
        expect.objectContaining({ receipts: [] }),
      );
    },
  );

  it('shows the fixed transaction sequence and marks Activation Consent N/A for Install Disabled', async () => {
    const marketplace = join(root, 'marketplace');
    const registrationId = '11111111-1111-4111-8111-111111111111';
    await commitBridgeState((state) => ({
      ...state,
      registrations: [{
        id: registrationId,
        marketplaceName: 'acme-marketplace',
        sourceKind: 'local',
        source: marketplace,
      }],
    }), { agentDir });
    const events: string[] = [];
    const confirms: string[] = [];
    const renderedSheets: string[] = [];
    const driveSheet = sheetCustom(events);
    const ctx = {
      cwd,
      mode: 'tui',
      hasUI: true,
      isProjectTrusted: () => true,
      ui: {
        select: async (prompt: string, options: string[]) => {
          if (prompt.startsWith(uiText('inst.select.entry'))) return options[0];
          if (prompt === uiText('inst.select.path')) return uiText('inst.path.disabled');
          return undefined;
        },
        input: async () => undefined,
        custom: async (factory: any) => {
          const captureFactory = (...args: any[]) => {
            const component = factory(...args);
            const originalRender = component.render.bind(component);
            component.render = (width: number) => {
              const lines = originalRender(width);
              renderedSheets.push(lines.join('\n'));
              return lines;
            };
            return component;
          };
          return driveSheet(captureFactory);
        },
        confirm: async (title: string) => {
          confirms.push(title);
          return true;
        },
        notify: () => {},
      },
    };

    await runPluginInstallationFlow(ctx as never, { registrationId });

    expect(events).toEqual(['Intent', 'Validation', 'Consent', 'Plan', 'Commit', 'Receipt']);
    expect(confirms).toEqual([]);
    expect(renderedSheets.find((sheet) => sheet.includes(`▸ 2 ${transactionStepLabel('Validation')}（${uiText('step.activeSuffix')}）`))).toMatch(
      /Verdict.*Passed.*Findings.*blocking.*warning.*notice/s,
    );
    expect(renderedSheets.find((sheet) => sheet.includes(`▸ 3 ${transactionStepLabel('Consent')}（${uiText('step.activeSuffix')}）`))).toMatch(new RegExp(uiText('common.notApplicable')));
  });

  it('expands the complete Plugin disclosure with source, precedence, skills, policy, and resources', async () => {
    const marketplace = join(root, 'marketplace');
    const registrationId = '11111111-1111-4111-8111-111111111111';
    writeFileSync(
      join(marketplace, 'plugins', 'release-helper', 'skills', 'release-notes', 'guide.md'),
      'Safe resource.\n',
    );
    await commitBridgeState((state) => ({
      ...state,
      registrations: [{
        id: registrationId,
        marketplaceName: 'acme-marketplace',
        sourceKind: 'local',
        source: marketplace,
      }],
    }), { agentDir });
    let expandedValidation = '';
    const ctx = {
      cwd,
      mode: 'tui',
      hasUI: true,
      isProjectTrusted: () => true,
      ui: {
        select: async () => undefined,
        input: async () => undefined,
        custom: async (factory: any) => new Promise((resolve) => {
          const component = factory({ requestRender: () => {} }, theme, {}, resolve);
          const first = component.render(120).join('\n');
          if (first.includes(`▸ 2 ${transactionStepLabel('Validation')}（${uiText('step.activeSuffix')}）`)) {
            component.handleInput('d');
            expandedValidation = component.render(120).join('\n');
            component.handleInput('\u001b');
            return;
          }
          component.handleInput('\r');
        }),
        confirm: async () => false,
        notify: () => {},
      },
    };

    await runPluginInstallationFlow(ctx as never, {
      registrationId,
      entryPointer: '/plugins/0',
      targetState: 'disabled',
    });

    expect(expandedValidation).toMatch(/來源 .*marketplace/s);
    expect(expandedValidation).toContain('投影優先序：Pi');
    expect(expandedValidation).toContain('Skills：1');
    expect(expandedValidation).toMatch(/release-notes.*implicit.*guide\.md/s);
  });

  it('cancels before Commit without writing and releases the preflight fence', async () => {
    let cancelCommit = true;
    const events: string[] = [];
    let confirmations = 0;
    const ctx = {
      cwd,
      mode: 'tui',
      hasUI: true,
      isProjectTrusted: () => true,
      ui: {
        select: async () => undefined,
        input: async () => join(root, 'marketplace'),
        custom: sheetCustom(events, (step) => {
          if (step === 'Commit' && cancelCommit) {
            cancelCommit = false;
            return 'cancel';
          }
          return 'continue';
        }),
        confirm: async () => {
          confirmations += 1;
          return confirmations === 1;
        },
        notify: () => {},
      },
    };

    await runLocalRegistrationFlow(ctx as never);
    await runLocalRegistrationFlow(ctx as never);

    expect(confirmations).toBe(2);
    const state = await readBridgeState({ agentDir });
    expect(state.state?.registrations).toEqual([]);
    const receipts = (await readReceiptJournal({ agentDir })).receipts;
    expect(receipts).toHaveLength(2);
    expect(receipts[0]).toEqual(expect.objectContaining({
      summary: 'Declined',
      durableOutcome: 'unchanged',
      runtimeOutcome: 'none',
      stateChanged: false,
      validationSnapshot: expect.any(String),
    }));
    expect(events.slice(0, 6)).toEqual(['Intent', 'Validation', 'Consent', 'Plan', 'Commit', 'Receipt']);
  });

  it('turns an Esc after Plugin preflight into a Declined Receipt without committing Install Disabled', async () => {
    const marketplace = join(root, 'marketplace');
    const registrationId = '11111111-1111-4111-8111-111111111111';
    await commitBridgeState((state) => ({
      ...state,
      registrations: [{
        id: registrationId,
        marketplaceName: 'acme-marketplace',
        sourceKind: 'local',
        source: marketplace,
      }],
    }), { agentDir });
    const events: string[] = [];
    const ctx = {
      cwd,
      mode: 'tui',
      hasUI: true,
      isProjectTrusted: () => true,
      ui: {
        select: async () => undefined,
        input: async () => undefined,
        custom: sheetCustom(events, (step) => step === 'Commit' ? 'cancel' : 'continue'),
        confirm: async () => { throw new Error('Install Disabled must not ask Activation Confirmation'); },
        notify: () => {},
      },
    };

    await runPluginInstallationFlow(ctx as never, {
      registrationId,
      entryPointer: '/plugins/0',
      targetState: 'disabled',
    });

    expect((await readBridgeState({ agentDir })).state?.installations).toEqual([]);
    expect(events).toEqual(['Intent', 'Validation', 'Consent', 'Plan', 'Commit', 'Receipt']);
    expect((await readReceiptJournal({ agentDir })).receipts.at(-1)).toEqual(
      expect.objectContaining({
        operation: 'Plugin Installation',
        summary: 'Declined',
        durableOutcome: 'unchanged',
        runtimeOutcome: 'none',
        stateChanged: false,
      }),
    );
  });

  it('keeps Registration Confirmation separate from Activation Confirmation', async () => {
    const confirmationTitles: string[] = [];
    const ctx = {
      cwd,
      mode: 'tui',
      hasUI: true,
      isProjectTrusted: () => true,
      ui: {
        select: async (prompt: string, options: string[]) => {
          if (prompt.startsWith(uiText('inst.select.entry'))) return options[0];
          if (prompt === uiText('inst.select.path')) return uiText('inst.path.enabled');
          return undefined;
        },
        input: async () => join(root, 'marketplace'),
        custom: sheetCustom([]),
        confirm: async (title: string) => {
          confirmationTitles.push(title);
          return true;
        },
        notify: () => {},
      },
    };

    await runLocalRegistrationFlow(ctx as never);
    const registered = await readBridgeState({ agentDir });
    const registrationId = registered.state?.registrations[0]?.id;
    expect(registrationId).toBeDefined();

    await runPluginInstallationFlow(ctx as never, { registrationId });

    expect(confirmationTitles).toHaveLength(2);
    expect(confirmationTitles[0]).toMatch(/^Registration Confirmation/);
    expect(confirmationTitles[1]).toMatch(/^Activation Confirmation/);
    const installed = await readBridgeState({ agentDir });
    expect(installed.state?.installations[0]?.installationState).toBe('enabled');
  });
});
