import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { commitBridgeState, readBridgeState } from '../../../src/bridge-state/store.js';
import { readReceiptJournal } from '../../../src/journal/journal.js';
import { dispatchLedgerAction, formatStartupReceipt } from '../../../extensions/pi/index.js';
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
  bold: (text: string) => text,
};

function sheetCustom(
  events: string[],
  decide: (step: string) => 'continue' | 'cancel' = () => 'continue',
) {
  return async (factory: any): Promise<unknown> => new Promise((resolve) => {
    const component = factory({}, theme, {}, resolve);
    const rendered = component.render(120).join('\n');
    const active = rendered.match(/\b(Intent|Validation|Consent|Plan|Commit|Receipt) ACTIVE\b/)?.[1];
    if (active) events.push(active);
    component.handleInput?.(active && decide(active) === 'cancel' ? '\u001b' : '\r');
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
      scope: 'project',
      pointer: '/skills/build',
      rule: 'RULE-01',
      outcome: 'blocked by policy',
    }])).toEqual([
      'Verdict Blocked',
      'Findings 1 blocking · 0 warning · 0 notice',
      'Finding classification blocking | scope project | phase validation | target skill | ' +
        'pointer "/skills/build" | code "RULE_CODE" | rule "RULE-01" | outcome "blocked by policy"',
    ]);
  });

  it('uses an explicit canonical scope without asking the host scope selector', async () => {
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

    await runLocalRegistrationFlow(ctx as never, { scope: 'project' });

    expect(selectPrompts).toEqual([]);
    const project = await readBridgeState('project', { cwd, agentDir });
    expect(project.state?.registrations).toEqual([]);
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

    await runLocalRegistrationFlow(ctx as never, { scope: 'global' });

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
        scope: 'global',
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
      scope: 'global',
      trigger: 'startup',
      expectedStateRevision: '1',
      summary: 'Blocked',
      findings: [{
        code: 'STARTUP_TEST',
        classification: 'blocking',
        phase: 'post-commit',
        target: 'attempt',
        scope: 'global',
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
    await commitBridgeState('global', (state) => ({
      ...state,
      registrations: [
        { id: firstId, marketplaceName: 'acme-marketplace', sourceKind: 'local', source: firstRoot },
        { id: secondId, marketplaceName: 'second-marketplace', sourceKind: 'local', source: secondRoot },
      ],
    }), { cwd, agentDir });

    const selectPrompts: string[] = [];
    const confirms: string[] = [];
    const ctx = {
      cwd,
      mode: 'tui',
      isProjectTrusted: () => true,
      ui: {
        select: async (prompt: string, options: string[]) => {
          selectPrompts.push(prompt);
          if (prompt.startsWith('Marketplace Entries')) return options[0];
          if (prompt === 'Installation path') return 'Install Disabled';
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

    await runPluginInstallationFlow(ctx as never, { scope: 'global', registrationId: secondId });

    expect(selectPrompts).toEqual([
      'Marketplace Entries（顯示 Marketplace Entry ID 與可安裝/Unavailable 原因）',
      'Installation path',
    ]);
    expect(confirms).toEqual([]);
    const state = await readBridgeState('global', { cwd, agentDir });
    expect(state.state?.installations).toEqual([
      expect.objectContaining({
        registrationId: secondId,
        pluginId: `${secondId}/second-marketplace/second-helper`,
        installationState: 'disabled',
      }),
    ]);
  });

  it('installs a Ledger-selected Marketplace Entry without reopening native Entry or path selectors', async () => {
    const marketplace = join(root, 'marketplace');
    const registrationId = '11111111-1111-4111-8111-111111111111';
    await commitBridgeState('global', (state) => ({
      ...state,
      registrations: [{
        id: registrationId,
        marketplaceName: 'acme-marketplace',
        sourceKind: 'local',
        source: marketplace,
      }],
    }), { cwd, agentDir });
    const selectPrompts: string[] = [];
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
        custom: sheetCustom([]),
        confirm: async () => { throw new Error('Install Disabled must not ask Activation Confirmation'); },
        notify: () => {},
      },
    };

    await dispatchLedgerAction(ctx as never, {
      actionId: 'install-disabled',
      mode: 'mutation',
      scope: 'global',
      targetKind: 'marketplace-entry',
      targetId: `${registrationId}/acme-marketplace/plugins/0`,
      registrationId,
      entryPointer: '/plugins/0',
      desiredInstallationState: 'disabled',
      stateRevision: '1',
    });

    expect(selectPrompts).toEqual([]);
    expect((await readBridgeState('global', { cwd, agentDir })).state?.installations).toEqual([
      expect.objectContaining({
        registrationId,
        marketplaceEntryId: `${registrationId}/acme-marketplace/plugins/0`,
        installationState: 'disabled',
      }),
    ]);
  });

  it('uses an explicit canonical scope for Git Registration', async () => {
    const selectPrompts: string[] = [];
    const ctx = {
      cwd,
      mode: 'tui',
      isProjectTrusted: () => true,
      ui: {
        select: async (prompt: string) => {
          selectPrompts.push(prompt);
          if (prompt.startsWith('Git Selector')) return 'default (跟隨遠端預設分支 HEAD)';
          return undefined;
        },
        input: async () => 'not-a-git-locator',
        custom: async (_factory: unknown) => undefined,
        confirm: async () => false,
        notify: () => {},
      },
    };

    await runGitRegistrationFlow(ctx as never, { scope: 'project' });

    expect(selectPrompts).toEqual(['Git Selector — 選擇型別']);
    const project = await readBridgeState('project', { cwd, agentDir });
    expect(project.state?.registrations).toEqual([]);
  });

  it('uses an explicit Installation ID without selecting a display label', async () => {
    const firstId = 'global/first-market/plugin-a';
    const secondId = 'global/second-market/plugin-b';
    await commitBridgeState('global', (state) => ({
      ...state,
      installations: [
        { id: firstId, pluginId: 'first-market/plugin-a', installationState: 'enabled' },
        { id: secondId, pluginId: 'second-market/plugin-b', installationState: 'enabled' },
      ],
    }), { cwd, agentDir });
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

    await runPluginStateFlow(ctx as never, { scope: 'global', installationId: secondId });

    expect(selectPrompts).toEqual([]);
    const state = await readBridgeState('global', { cwd, agentDir });
    expect(state.state?.installations).toEqual([
      expect.objectContaining({ id: firstId, installationState: 'enabled' }),
      expect.objectContaining({ id: secondId, installationState: 'disabled' }),
    ]);
  });

  it('rejects a stale disable intent instead of inferring and running the opposite enable action', async () => {
    const installationId = 'global/acme-market/plugin-a';
    const first = await commitBridgeState('global', (state) => ({
      ...state,
      installations: [{
        id: installationId,
        pluginId: 'acme-market/plugin-a',
        installationState: 'enabled',
      }],
    }), { cwd, agentDir });
    await commitBridgeState('global', (state) => ({
      ...state,
      installations: state.installations.map((installation) => ({
        ...installation,
        installationState: 'disabled',
      })),
    }), { cwd, agentDir });
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
      scope: 'global',
      targetKind: 'installation',
      targetId: installationId,
      stateRevision: first.newRevision,
    } as never);

    const state = await readBridgeState('global', { cwd, agentDir });
    expect(state.state?.stateRevision).toBe('2');
    expect(state.state?.installations[0]?.installationState).toBe('disabled');
    expect(events).toEqual(['Receipt']);
    expect((await readReceiptJournal('global', { cwd, agentDir })).receipts.at(-1)).toEqual(
      expect.objectContaining({ summary: 'Rejected as Stale' }),
    );
  });

  it('shows the fixed transaction sequence and marks Activation Consent N/A for Install Disabled', async () => {
    const marketplace = join(root, 'marketplace');
    const registrationId = '11111111-1111-4111-8111-111111111111';
    await commitBridgeState('global', (state) => ({
      ...state,
      registrations: [{
        id: registrationId,
        marketplaceName: 'acme-marketplace',
        sourceKind: 'local',
        source: marketplace,
      }],
    }), { cwd, agentDir });
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
          if (prompt.startsWith('Marketplace Entries')) return options[0];
          if (prompt === 'Installation path') return 'Install Disabled';
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

    await runPluginInstallationFlow(ctx as never, { scope: 'global', registrationId });

    expect(events).toEqual(['Intent', 'Validation', 'Consent', 'Plan', 'Commit', 'Receipt']);
    expect(confirms).toEqual([]);
    expect(renderedSheets.find((sheet) => sheet.includes('Validation ACTIVE'))).toMatch(
      /Verdict.*Passed.*Findings.*blocking.*warning.*notice/s,
    );
    expect(renderedSheets.find((sheet) => sheet.includes('Consent ACTIVE'))).toMatch(/N\/A/);
  });

  it('expands the complete Plugin disclosure with source, precedence, skills, policy, and resources', async () => {
    const marketplace = join(root, 'marketplace');
    const registrationId = '11111111-1111-4111-8111-111111111111';
    writeFileSync(
      join(marketplace, 'plugins', 'release-helper', 'skills', 'release-notes', 'guide.md'),
      'Safe resource.\n',
    );
    await commitBridgeState('global', (state) => ({
      ...state,
      registrations: [{
        id: registrationId,
        marketplaceName: 'acme-marketplace',
        sourceKind: 'local',
        source: marketplace,
      }],
    }), { cwd, agentDir });
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
          if (first.includes('Validation ACTIVE')) {
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
      scope: 'global',
      registrationId,
      entryPointer: '/plugins/0',
      targetState: 'disabled',
    });

    expect(expandedValidation).toMatch(/Source:.*marketplace/s);
    expect(expandedValidation).toContain('Projected precedence: Pi');
    expect(expandedValidation).toContain('Skills: 1');
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

    await runLocalRegistrationFlow(ctx as never, { scope: 'global' });
    await runLocalRegistrationFlow(ctx as never, { scope: 'global' });

    expect(confirmations).toBe(2);
    const state = await readBridgeState('global', { cwd, agentDir });
    expect(state.state?.registrations).toEqual([]);
    const receipts = (await readReceiptJournal('global', { cwd, agentDir })).receipts;
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
    await commitBridgeState('global', (state) => ({
      ...state,
      registrations: [{
        id: registrationId,
        marketplaceName: 'acme-marketplace',
        sourceKind: 'local',
        source: marketplace,
      }],
    }), { cwd, agentDir });
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
      scope: 'global',
      registrationId,
      entryPointer: '/plugins/0',
      targetState: 'disabled',
    });

    expect((await readBridgeState('global', { cwd, agentDir })).state?.installations).toEqual([]);
    expect(events).toEqual(['Intent', 'Validation', 'Consent', 'Plan', 'Commit', 'Receipt']);
    expect((await readReceiptJournal('global', { cwd, agentDir })).receipts.at(-1)).toEqual(
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
          if (prompt.startsWith('Marketplace Entries')) return options[0];
          if (prompt === 'Installation path') return 'Install and Enable';
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

    await runLocalRegistrationFlow(ctx as never, { scope: 'global' });
    const registered = await readBridgeState('global', { cwd, agentDir });
    const registrationId = registered.state?.registrations[0]?.id;
    expect(registrationId).toBeDefined();

    await runPluginInstallationFlow(ctx as never, { scope: 'global', registrationId });

    expect(confirmationTitles).toHaveLength(2);
    expect(confirmationTitles[0]).toMatch(/^Registration Confirmation/);
    expect(confirmationTitles[1]).toMatch(/^Activation Confirmation/);
    const installed = await readBridgeState('global', { cwd, agentDir });
    expect(installed.state?.installations[0]?.installationState).toBe('enabled');
  });
});
