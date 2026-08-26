import { describe, expect, it } from 'vitest';
import type { Theme } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BridgeLedgerComponent,
  buildBridgeLedgerModel,
  loadBridgeLedgerSnapshot,
  mapMarketplaceInspectionToLedgerItems,
  type BridgeLedgerSnapshot,
  type LedgerActionId,
} from '../../../extensions/pi/bridge-ledger.js';
import { attemptSummaryText, findingOutcomeText, uiText } from '../../../extensions/pi/ui-strings.js';

const identityTheme = {
  fg: (_token: string, text: string) => text,
  bg: (_token: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
  strikethrough: (text: string) => text,
  inverse: (text: string) => text,
} as unknown as Theme;

function component(model = buildBridgeLedgerModel(snapshot())) {
  const requests: number[] = [];
  const results: unknown[] = [];
  const instance = new BridgeLedgerComponent(
    model,
    identityTheme,
    { requestRender: () => requests.push(1) },
    (intent) => results.push(intent),
  );
  return { instance, requests, results };
}

function emptyJournal() {
  return {
    revision: 'missing' as const,
    receipts: [],
    activeChains: [],
    allChains: [],
    corruptedLineCount: 0,
    isDegraded: false,
    findings: [],
  };
}

const REG_ID = '11111111-1111-4111-8111-111111111111';

function snapshot(): BridgeLedgerSnapshot {
  const registration = {
    id: REG_ID,
    alias: 'global-market',
    marketplaceName: 'global-market',
    sourceKind: 'local' as const,
    source: '/marketplaces/global',
  };
  const installation = {
    id: 'global-market/global-tool',
    pluginId: `${REG_ID}/global-market/global-tool`,
    registrationId: REG_ID,
    installationState: 'enabled' as const,
  };
  const disabledInstallation = {
    id: 'global-market/disabled-tool',
    pluginId: `${REG_ID}/global-market/disabled-tool`,
    registrationId: REG_ID,
    installationState: 'disabled' as const,
  };
  const receipt = {
    id: 'rcpt_33333333-3333-4333-8333-333333333333',
    kind: 'Marketplace Refresh' as const,
    operation: 'Marketplace Refresh',
    trigger: 'user',
    startedAt: '2026-08-23T00:00:00.000Z',
    completedAt: '2026-08-23T00:00:01.000Z',
    expectedStateRevision: '12',
    durableOutcome: 'unchanged' as const,
    findings: [],
    runtimeOutcome: 'none' as const,
    summary: 'Blocked' as const,
    recoveryActions: ['Inspect' as const],
    stateChanged: false,
    createdAt: '2026-08-23T00:00:01.000Z',
  };
  const marketplaceEntryId = `${REG_ID}/global-market/plugins/0`;
  return {
    global: {
      status: 'ok',
      state: {
        schemaVersion: 1,
        stateRevision: '12',
        registrations: [registration],
        installations: [installation, disabledInstallation],
        scopeOverrides: [],
      },
    },
    journal: { ...emptyJournal(), receipts: [receipt] },
    marketplaceEntries: [{
      registrationId: REG_ID,
      entryPointer: '/plugins/0',
      marketplaceEntryId,
      validationSnapshot: 'snapshot-global-entry',
      name: 'global-tool',
      classification: 'compatible',
      plugin: {
        id: `${REG_ID}/global-market/global-tool`,
        manifestName: 'global-tool',
        marketplaceEntryId,
        skills: [{
          id: `${REG_ID}/global-market/global-tool/build`,
          name: 'build',
          path: '/marketplaces/global/plugins/global-tool/skills/build',
          invocationPolicy: 'explicit',
          resources: ['references/guide.md'],
        }],
      },
      findings: [],
    }],
    effective: {
      registrations: [registration],
      installations: [installation],
    },
  };
}

describe('Bridge Ledger presentation model', () => {
  it('organizes all existing management capabilities into four reachable sections', () => {
    const model = buildBridgeLedgerModel(snapshot());

    expect(model.sections.map((section) => section.id)).toEqual([
      'observe',
      'sources',
      'plugins',
      'recovery-receipts',
    ]);

    const reachable = new Set<LedgerActionId>(
      model.sections.flatMap((section) =>
        section.rows.flatMap((row) => row.actions.map((action) => action.intent.actionId)),
      ),
    );
    expect(reachable).toEqual(new Set<LedgerActionId>([
      'observe-authority',
      'observe-effective-state',
      'register-local',
      'register-git',
      'refresh-registration',
      'rebind-registration',
      'remove-registration',
      'install-disabled',
      'install-and-enable',
      'enable-installation',
      'disable-installation',
      'remove-installation',
      'view-receipt-journal',
      'repair-state',
      'inspect-receipt',
    ]));

    const recovery = model.sections.find((section) => section.id === 'recovery-receipts')!;
    expect(recovery.rows.find((row) => row.id === 'journal:global')?.detail).toBe(
      uiText('ledger.row.journal.detail', { receipts: 1, chains: 0, degraded: uiText('common.no') }),
    );
  });

  it('makes Marketplace Entries the stable Plugins objects and binds both install paths directly', () => {
    const plugins = buildBridgeLedgerModel(snapshot()).sections.find(
      (section) => section.id === 'plugins',
    )!;
    const compatible = plugins.rows.find((row) =>
      row.id === `marketplace-entry:${REG_ID}/global-market/plugins/0`);

    expect(compatible).toMatchObject({
      targetKind: 'marketplace-entry',
      targetId: `${REG_ID}/global-market/plugins/0`,
      detail: expect.stringMatching(/compatible.*build.*explicit.*references\/guide\.md/i),
    });
    expect(compatible?.actions.map((entry) => entry.intent)).toEqual([
      expect.objectContaining({
        actionId: 'install-disabled',
        registrationId: REG_ID,
        entryPointer: '/plugins/0',
        targetKind: 'marketplace-entry',
        targetId: `${REG_ID}/global-market/plugins/0`,
        stateRevision: '12',
        validationSnapshot: 'snapshot-global-entry',
      }),
      expect.objectContaining({
        actionId: 'install-and-enable',
        desiredInstallationState: 'enabled',
      }),
    ]);
  });

  it('fails closed when a compatible Marketplace Entry has no presentation Validation Snapshot', () => {
    const unbound = snapshot();
    unbound.global.state!.installations = [];
    const entry = unbound.marketplaceEntries[0]!;
    if (!('marketplaceEntryId' in entry)) throw new Error('fixture requires a Marketplace Entry');
    delete entry.validationSnapshot;

    const row = buildBridgeLedgerModel(unbound).sections
      .find((section) => section.id === 'plugins')?.rows
      .find((candidate) => candidate.id === `marketplace-entry:${entry.marketplaceEntryId}`);

    expect(row?.actions).toEqual([
      expect.objectContaining({
        enabled: false,
        disabledReason: expect.stringContaining('Validation Snapshot'),
      }),
      expect.objectContaining({
        enabled: false,
        disabledReason: expect.stringContaining('Validation Snapshot'),
      }),
    ]);
  });

  it('maps the presentation inspection fingerprint into Marketplace Entry intents', () => {
    const value = snapshot();
    const registration = value.global.state!.registrations[0]!;
    const fixture = value.marketplaceEntries[0]!;
    if (!('marketplaceEntryId' in fixture) || !fixture.plugin) {
      throw new Error('fixture requires a compatible Marketplace Entry');
    }
    const mapped = mapMarketplaceInspectionToLedgerItems(registration, {
      marketplaceId: `${registration.id}/global-market`,
      snapshot: { fingerprint: 'fresh-presentation-snapshot' } as never,
      entries: [{
        entry: { ordinal: 0, entryId: '/plugins/0', name: 'global-tool', available: true, type: 'local' },
        classification: 'compatible',
        plugin: fixture.plugin,
        findings: [],
      }],
      findings: [],
    });

    expect(mapped[0]).toEqual(expect.objectContaining({
      marketplaceEntryId: fixture.marketplaceEntryId,
      validationSnapshot: 'fresh-presentation-snapshot',
    }));
  });

  it.each([
    [
      'Git cache miss',
      'SOURCE_REACQUISITION_REQUIRED',
      'INSTALL-04',
      "Git Source Cache miss: Validation Snapshot '0123456789abcdef…' is not retained in Source Cache; Marketplace Refresh or re-acquisition is required",
      'registration',
    ],
    [
      'source drift',
      'SOURCE_DRIFT',
      'DRIFT-01',
      'Source Drift: cached tree at fingerprint 0123456789abcdef… no longer hashes to the recorded Validation Snapshot; Marketplace Refresh is required',
      'registration',
    ],
    [
      'unsupported source',
      'SOURCE_REACQUISITION_REQUIRED',
      'INSTALL-04',
      "Unknown or unsupported sourceKind 'archive'",
      'registration',
    ],
    [
      'source snapshot budget failure',
      'BUDGET_EXCEEDED',
      'BUDG-01',
      'Validation Budget exceeded: 10001 files > 10000',
      'source',
    ],
    [
      'missing catalog',
      'CATALOG_MISSING',
      'CAT-01',
      'Marketplace Catalog cannot be read',
      'catalog',
    ],
    [
      'malformed catalog',
      'CATALOG_MALFORMED',
      'CAT-02',
      'marketplace.json is not an object',
      'catalog',
    ],
  ] as const)(
    'keeps an empty-entry %s finding as a non-installable Registration diagnostic',
    (_case, code, rule, outcome, target) => {
      const unavailable = snapshot();
      const registration = unavailable.global.state!.registrations[0]!;
      const finding = {
        code,
        classification: 'blocking' as const,
        phase: 'validation' as const,
        target,
        pointer: '',
        rule,
        outcome,
      };

      unavailable.marketplaceEntries = mapMarketplaceInspectionToLedgerItems(
        registration,
        { entries: [], findings: [finding] },
      );

      const diagnostic = buildBridgeLedgerModel(unavailable).sections
        .find((section) => section.id === 'plugins')?.rows
        .find((row) => row.id === `marketplace-diagnostic:${registration.id}`);

      expect(unavailable.marketplaceEntries[0]).not.toHaveProperty('marketplaceEntryId');
      expect(unavailable.marketplaceEntries[0]?.findings).toEqual([finding]);
      expect(diagnostic).toMatchObject({
        label: 'global-market',
        detail: `Unavailable（無法使用）· ${code} · ${rule} · ${findingOutcomeText({ rule, outcome })}`,
        targetKind: 'registration',
        targetId: registration.id,
        actions: [],
      });
      expect(diagnostic?.actions.some((entry) =>
        entry.intent.actionId === 'install-disabled' || entry.intent.actionId === 'install-and-enable')).toBe(false);
    },
  );

  it('renders actionless Marketplace diagnostics without dispatching them', () => {
    const unavailable = snapshot();
    unavailable.global.state!.installations = [];
    unavailable.marketplaceEntries = mapMarketplaceInspectionToLedgerItems(
      unavailable.global.state!.registrations[0]!,
      {
        entries: [],
        findings: [{
          code: 'SOURCE_DRIFT',
          classification: 'blocking',
          phase: 'validation',
          target: 'registration',
          pointer: '',
          rule: 'DRIFT-01',
          outcome: 'Source Drift requires Marketplace Refresh',
        }],
      },
    );
    const rendered = component(buildBridgeLedgerModel(unavailable));
    rendered.instance.render(240);
    rendered.instance.handleInput('\x1b[C'); // Sources
    rendered.instance.handleInput('\x1b[C'); // Plugins

    const screen = rendered.instance.render(240).join('\n');
    const driftOutcome = findingOutcomeText({ rule: 'DRIFT-01', outcome: 'Source Drift requires Marketplace Refresh' });
    expect(screen).toContain(`SOURCE_DRIFT · DRIFT-01 · ${driftOutcome}`);
    // The diagnostic row exposes no actions, so Enter cannot dispatch anything.
    rendered.instance.handleInput('\r');
    expect(rendered.results).toEqual([]);
  });

  it('uses compatible Plugin identity, not Marketplace Entry provenance, to detect Installations', () => {
    const findMarketplaceRow = (value: BridgeLedgerSnapshot, marketplaceEntryId: string) =>
      buildBridgeLedgerModel(value).sections
        .find((section) => section.id === 'plugins')?.rows
        .find((row) => row.id === `marketplace-entry:${marketplaceEntryId}`);

    const moved = snapshot();
    const movedEntry = moved.marketplaceEntries[0]!;
    if (!('marketplaceEntryId' in movedEntry) || !movedEntry.plugin) {
      throw new Error('fixture requires a compatible Marketplace Entry');
    }
    moved.global.state!.installations[0]!.marketplaceEntryId = movedEntry.marketplaceEntryId;
    movedEntry.entryPointer = '/plugins/7';
    movedEntry.marketplaceEntryId = `${REG_ID}/global-market/plugins/7`;
    movedEntry.plugin.marketplaceEntryId = movedEntry.marketplaceEntryId;

    const movedRow = findMarketplaceRow(moved, movedEntry.marketplaceEntryId);
    expect(movedRow?.actions.every((entry) => !entry.enabled)).toBe(true);
    expect(movedRow?.actions[0]?.disabledReason).toContain('Installation');

    const replacement = snapshot();
    const replacementEntry = replacement.marketplaceEntries[0]!;
    if (!('marketplaceEntryId' in replacementEntry) || !replacementEntry.plugin) {
      throw new Error('fixture requires a compatible Marketplace Entry');
    }
    replacement.global.state!.installations[0]!.marketplaceEntryId = replacementEntry.marketplaceEntryId;
    replacementEntry.name = 'replacement-tool';
    replacementEntry.plugin = {
      ...replacementEntry.plugin,
      id: `${REG_ID}/global-market/replacement-tool`,
      manifestName: 'replacement-tool',
    };

    const replacementRow = findMarketplaceRow(replacement, replacementEntry.marketplaceEntryId);
    expect(replacementRow?.actions.map((entry) => entry.enabled)).toEqual([true, true]);

    const unavailable = snapshot();
    const unavailableEntryId = `${REG_ID}/global-market/plugins/0`;
    unavailable.global.state!.installations[0]!.marketplaceEntryId = unavailableEntryId;
    unavailable.marketplaceEntries = [{
      registrationId: REG_ID,
      entryPointer: '/plugins/0',
      marketplaceEntryId: unavailableEntryId,
      name: 'broken-tool',
      classification: 'unavailable',
      findings: [],
      unavailableReason: 'Plugin manifest is unavailable',
    }];

    const unavailableRow = findMarketplaceRow(unavailable, unavailableEntryId);
    expect(unavailableRow?.actions[0]).toMatchObject({
      enabled: false,
      disabledReason: 'Plugin manifest is unavailable',
    });
  });

  it('offers Retry Application for an exact active Pending Application chain', () => {
    const pending = snapshot();
    const receipt = {
      ...pending.journal.receipts[0]!,
      summary: 'Pending Application' as const,
      runtimeOutcome: 'pending-application' as const,
      validationSnapshot: 'snapshot-runtime-12',
      recoveryActions: ['Retry Application' as const],
    };
    const chain = {
      rootReceiptId: receipt.id,
      condition: 'pending-application' as const,
      stateRevision: '12',
      receipts: [receipt],
      resolved: false,
      superseded: false,
    };
    pending.journal = {
      ...pending.journal,
      receipts: [receipt],
      activeChains: [chain],
      allChains: [chain],
    };

    const recovery = buildBridgeLedgerModel(pending).sections.find(
      (section) => section.id === 'recovery-receipts',
    )!;
    const retry = recovery.rows.find((row) => row.id === `retry-application:${receipt.id}`);

    expect(retry?.actions[0]).toMatchObject({
      enabled: true,
      intent: {
        actionId: 'retry-application',
        mode: 'mutation',
        targetKind: 'receipt',
        targetId: receipt.id,
        stateRevision: '12',
      },
    });
    expect(recovery.rows.find((row) => row.id === 'repair:global')?.actions[0]).toMatchObject({
      enabled: false,
      disabledReason: expect.stringContaining('Pending Application'),
    });
  });

  it('keeps an unbound Pending Application visible but disables unsafe Retry', () => {
    const pending = snapshot();
    const receipt = {
      ...pending.journal.receipts[0]!,
      summary: 'Pending Application' as const,
      runtimeOutcome: 'pending-application' as const,
      recoveryActions: ['Retry Application' as const],
    };
    const chain = {
      rootReceiptId: receipt.id,
      condition: 'pending-application' as const,
      stateRevision: '12',
      receipts: [receipt],
      resolved: false,
      superseded: false,
    };
    pending.journal = {
      ...pending.journal,
      receipts: [receipt],
      activeChains: [chain],
      allChains: [chain],
    };

    const recovery = buildBridgeLedgerModel(pending).sections.find(
      (section) => section.id === 'recovery-receipts',
    )!;
    const retry = recovery.rows.find((row) => row.id === `retry-application:${receipt.id}`);

    expect(retry?.actions[0]).toMatchObject({
      enabled: false,
      disabledReason: expect.stringContaining(uiText('ledger.disabledReason.retryNoSnapshot')),
    });
  });

  it.each([120, 80, 60])('renders a usable authority workspace at %i columns without overflow', (width) => {
    const { instance } = component();
    const lines = instance.render(width);
    const screen = lines.join('\n');

    expect(lines.length).toBeGreaterThan(8);
    expect(screen).toContain('CODEX MARKETPLACE / BRIDGE LEDGER');
    expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    expect(screen).toContain(uiText('ledger.rail.revision', { revision: '"12"' }));
    // Global-only (#62): one authority rail, no G/P markers, no trust indicator anywhere.
    expect(screen.match(new RegExp(uiText('ledger.badge.healthy'), 'g'))).toHaveLength(1);
    expect(screen).not.toMatch(/PROJECT|\bP\b/);
    expect(screen).not.toContain('Project Trust');
    expect(screen).not.toMatch(/\bG\b/);
    expect(screen).toContain('狀態：');
    expect(screen).toContain('Esc/q');
    expect(screen).toContain(width >= 96 ? uiText('ledger.panel.navigation') : uiText('ledger.panel.sections'));
  });

  it.each([120, 80, 60])('presents the authority rail as a bordered panel at every width %i', (width) => {
    const { instance } = component();
    const lines = instance.render(width);
    const screen = lines.join('\n');

    expect(screen).toContain('┌─ Global Scope');
    expect(screen).not.toContain('┌─ Project Scope');
    expect(lines.filter((line) => line.includes('│')).length).toBeGreaterThanOrEqual(4);
  });

  it('highlights the selected action row with the selected background token and a text cursor', () => {
    const backgrounds: string[] = [];
    const model = buildBridgeLedgerModel(snapshot());
    const spyingTheme = {
      ...identityTheme,
      bg: (token: string, text: string) => {
        backgrounds.push(token);
        return text;
      },
    } as unknown as Theme;
    const instance = new BridgeLedgerComponent(
      model,
      spyingTheme,
      { requestRender: () => {} },
      () => {},
    );

    instance.render(120); // establish wide workspace
    instance.handleInput('\x1b[C'); // Sources
    const idle = instance.render(120);
    const baselineWashes = backgrounds.filter((token) => token === 'selectedBg').length;
    expect(idle.some((line) => line.includes(`● ${uiText('ledger.availability.ready')} ${uiText('ledger.action.register-local')}`))).toBe(true);

    instance.handleInput('j'); // move onto the registration row's actions
    instance.render(120);
    expect(backgrounds.filter((token) => token === 'selectedBg').length).toBeGreaterThan(baselineWashes);

    const screen = instance.render(120).join('\n');
    expect(screen).not.toContain('[available]');
    expect(screen).not.toContain('[Unavailable]');
  });

  it.each([120, 80, 60])('keeps CJK double-width content within %i columns without overflow or frame damage', (width) => {
    const cjk = snapshot();
    cjk.global.state!.registrations[0]!.alias = '全球市集（相當長的雙寬字元名稱測試）';
    const { instance } = component(buildBridgeLedgerModel(cjk));
    instance.render(width);
    if (width >= 96) {
      instance.handleInput('\x1b[C'); // 寬版：右切到「來源」
    } else {
      instance.handleInput('j'); // 窄版：選到「來源」分區
      instance.handleInput('\r'); // 進入分區詳情
    }
    const lines = instance.render(width);
    const screen = lines.join('\n');

    // No line exceeds the terminal width even with double-width characters.
    expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    // Panel frames stay intact: every framed content row still closes with a right border.
    for (const line of lines.filter((candidate) => candidate.includes('│'))) {
      expect(line.trimEnd().endsWith('│')).toBe(true);
    }
    expect(screen).toContain('全球市集');
  });

  it('activates register-local directly from the Sources section without any partition browsing', () => {
    const { instance, requests, results } = component();
    instance.render(120);

    instance.handleInput('\x1b[C'); // Sources
    instance.render(120);
    expect(instance.render(120).join('\n')).toContain(uiText('ledger.row.registrationActions'));
    // The retired g/p partition-focus keys are inert: no re-render, no dispatch.
    instance.handleInput('p');
    instance.handleInput('g');
    expect(instance.render(120).join('\n')).toContain(uiText('ledger.row.registrationActions'));
    instance.handleInput('\r');

    expect(results).toEqual([{
      actionId: 'register-local',
      mode: 'mutation',
      targetKind: 'scope',
      targetId: 'global',
      stateRevision: '12',
    }]);
    expect(requests.length).toBeGreaterThanOrEqual(1);
  });

  it('keeps canonical object identities in structured action intents', () => {
    const model = buildBridgeLedgerModel(snapshot());
    const rows = model.sections.flatMap((section) => section.rows);
    const actions = rows.flatMap((row) => row.actions);

    expect(rows.find((row) => row.id === `registration:${REG_ID}`)).toMatchObject({
      targetKind: 'registration',
      targetId: REG_ID,
    });
    expect(rows.find((row) => row.id === 'installation:global-market/global-tool')).toMatchObject({
      targetKind: 'installation',
      targetId: 'global-market/global-tool',
    });
    expect(rows.find((row) => row.id === 'receipt:rcpt_33333333-3333-4333-8333-333333333333')).toMatchObject({
      targetKind: 'receipt',
      targetId: 'rcpt_33333333-3333-4333-8333-333333333333',
    });
    expect(actions.filter((entry) => entry.intent.mode === 'mutation').every((entry) => entry.intent.stateRevision !== undefined)).toBe(true);
  });

  it('binds mutation intents to the observed State Revision of the single authority', () => {
    const model = buildBridgeLedgerModel(snapshot());
    const mutations = model.sections.flatMap((section) => section.rows)
      .flatMap((row) => row.actions)
      .filter((entry) => entry.intent.mode === 'mutation');
    expect(mutations.length).toBeGreaterThan(0);
    for (const entry of mutations) {
      expect(entry.intent.stateRevision).toBe('12');
    }
  });

  it('keeps repair available while disabling ordinary mutations for an unreadable document', () => {
    const unreadableSnapshot = snapshot();
    unreadableSnapshot.global = {
      status: 'corrupted',
      error: 'invalid JSON',
    };
    const model = buildBridgeLedgerModel(unreadableSnapshot);
    const actions = model.sections.flatMap((section) => section.rows).flatMap((row) => row.actions);
    const registerLocal = actions.find((entry) =>
      entry.intent.actionId === 'register-local')!;
    const repairState = actions.find((entry) =>
      entry.intent.actionId === 'repair-state')!;

    expect(registerLocal).toMatchObject({
      enabled: false,
      disabledReason: expect.stringContaining('Persistence Indeterminate'),
    });
    expect(repairState.enabled).toBe(true);
  });

  it('offers State Repair only for a repairable persistence-indeterminate chain', () => {
    const repairable = snapshot();
    const root = {
      ...repairable.journal.receipts[0]!,
      summary: 'Persistence Indeterminate' as const,
      durableOutcome: 'indeterminate' as const,
      recoveryActions: ['Repair State' as const, 'Inspect' as const],
    };
    const chain = {
      rootReceiptId: root.id,
      condition: 'persistence-indeterminate' as const,
      stateRevision: '12',
      receipts: [root],
      resolved: false,
      superseded: false,
    };
    repairable.journal = {
      ...repairable.journal,
      receipts: [root],
      activeChains: [chain],
      allChains: [chain],
    };

    const action = buildBridgeLedgerModel(repairable).sections
      .flatMap((section) => section.rows)
      .flatMap((row) => row.actions)
      .find((entry) => entry.intent.actionId === 'repair-state');

    expect(action?.enabled).toBe(true);
  });

  it('offers State Repair when corrupted Receipt Journal lines activate recovery without a chain', () => {
    const degraded = snapshot();
    degraded.journal = {
      ...degraded.journal,
      isDegraded: true,
      corruptedLineCount: 1,
    };

    const repair = buildBridgeLedgerModel(degraded).sections
      .flatMap((section) => section.rows)
      .find((row) => row.id === 'repair:global')?.actions[0];

    expect(repair).toMatchObject({ enabled: true });
  });

  it('loads Plugin inspections lazily once per snapshot and refreshes them on reload', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bridge-ledger-'));
    const agentDir = join(root, 'agent');
    const inspections: string[] = [];
    const inspector = (registration: { id: string }) => {
      inspections.push(registration.id);
      return { entries: [], findings: [] };
    };
    try {
      const globalDir = join(agentDir, 'codex-marketplace');
      mkdirSync(globalDir, { recursive: true });
      writeFileSync(join(globalDir, 'state.json'), JSON.stringify({
        schemaVersion: 1,
        stateRevision: '3',
        registrations: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', marketplaceName: 'g' }],
        installations: [],
        scopeOverrides: [],
      }));

      const loaded = await loadBridgeLedgerSnapshot({
        agentDir,
        inspectMarketplaceEntries: inspector,
      });

      expect(loaded.global.state?.stateRevision).toBe('3');
      expect(loaded.journal.receipts).toEqual([]);
      expect(loaded.effective?.registrations.map((registration) => registration.id)).toEqual(['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']);
      expect(inspections).toEqual([]);

      const first = component(buildBridgeLedgerModel(loaded));
      first.instance.render(120); // Observe
      expect(inspections).toEqual([]);
      first.instance.handleInput('\x1b[C'); // Sources
      first.instance.render(120);
      expect(inspections).toEqual([]);
      first.instance.handleInput('\x1b[C'); // Plugins
      first.instance.render(120);
      expect(inspections).toEqual(['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']);

      first.instance.render(120);
      buildBridgeLedgerModel(loaded).sections.find((section) => section.id === 'plugins')!.rows;
      expect(inspections).toHaveLength(1);

      const reloaded = await loadBridgeLedgerSnapshot({
        agentDir,
        inspectMarketplaceEntries: inspector,
      });
      expect(inspections).toHaveLength(1);
      buildBridgeLedgerModel(reloaded).sections.find((section) => section.id === 'plugins')!.rows;
      expect(inspections).toEqual([
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('supports arrows, j/k, Enter, Esc, q, Ctrl-C, help, and metadata expansion in the wide workspace', () => {
    const wide = component();
    wide.instance.render(120);
    wide.instance.handleInput('\x1b[57418u'); // Kitty right
    expect(wide.instance.render(120).join('\n')).toContain(`> ${uiText('ledger.section.sources.label')}`);
    wide.instance.handleInput('j');
    wide.instance.handleInput('\x1b[57420u'); // Kitty down
    wide.instance.handleInput('\x1b[57419u'); // Kitty up
    wide.instance.handleInput('k');
    wide.instance.handleInput('?');
    expect(wide.instance.render(120).join('\n')).toContain(uiText('ledger.panel.help'));
    wide.instance.handleInput('\x1b[27u'); // Kitty Escape closes help
    expect(wide.results).toEqual([]);

    // The structured dump is hidden until expanded, then fully retrievable.
    const collapsed = wide.instance.render(120).join('\n');
    expect(collapsed).not.toContain('模式 ');
    expect(collapsed).not.toContain('詳情 ');
    wide.instance.handleInput('i');
    const expanded = wide.instance.render(120).join('\n');
    expect(expanded).toContain('模式 mutation');
    expect(expanded).toContain('目標 scope "global"');
    wide.instance.handleInput('i');
    expect(wide.instance.render(120).join('\n')).not.toContain('模式 mutation');

    wide.instance.handleInput('\x1b[13u'); // Kitty Enter activates first Global action
    expect(wide.results[0]).toMatchObject({ actionId: 'register-local', stateRevision: '12' });

    const ctrlC = component();
    ctrlC.instance.handleInput('\x1b[99;5u');
    expect(ctrlC.results).toEqual([undefined]);

    const escape = component();
    escape.instance.handleInput('\x1b');
    expect(escape.results).toEqual([undefined]);
  });

  it.each([80, 60])('drills down through single-column sections at %i columns', (width) => {
    const narrow = component();
    narrow.instance.render(width);
    expect(narrow.instance.render(width).join('\n')).toContain(uiText('ledger.panel.sections'));

    narrow.instance.handleInput('\r');
    const detail = narrow.instance.render(width).join('\n');
    expect(detail).toContain(uiText('ledger.section.observe.label'));
    expect(detail).toContain(`● ${uiText('ledger.availability.ready')} ${uiText('ledger.action.observe-authority')}`);

    narrow.instance.handleInput('\x1b');
    expect(narrow.instance.render(width).join('\n')).toContain(uiText('ledger.panel.sections'));

    narrow.instance.handleInput('q');
    expect(narrow.results).toEqual([undefined]);
  });

  it('does not return an intent when Enter activates a disabled row and reveals its reason by selection', () => {
    const blockedSnapshot = snapshot();
    blockedSnapshot.global = {
      status: 'corrupted',
      error: 'Persistence Indeterminate: invalid JSON',
    };
    const blocked = component(buildBridgeLedgerModel(blockedSnapshot));
    blocked.instance.render(120);
    blocked.instance.handleInput('\x1b[C'); // Sources
    const screen = blocked.instance.render(120).join('\n');

    expect(screen).toContain(`○ ${uiText('ledger.availability.blocked')} ${uiText('ledger.action.register-local')}`);
    expect(screen).toContain('Persistence Indeterminate：Persistence Indeterminate: invalid JSON')
    expect(screen).not.toContain('[available]');
    expect(screen).not.toContain('[Unavailable]');
    expect(screen).not.toContain('disabled:');

    blocked.instance.handleInput('\r');

    expect(blocked.results).toEqual([]);
  });

  it('quotes hostile marketplace names, paths, and receipt outcomes without injecting rows', () => {
    const hostile = snapshot();
    hostile.global.state!.registrations[0]!.alias = 'market\nFORGED-MARKET';
    hostile.global.state!.registrations[0]!.source = '/tmp/source\nFORGED-PATH';
    hostile.journal.receipts[0]!.summary = 'Blocked\nFORGED-RECEIPT' as never;
    const rendered = component(buildBridgeLedgerModel(hostile));
    rendered.instance.render(120);
    rendered.instance.handleInput('\x1b[C'); // Sources
    rendered.instance.handleInput('j'); // onto Register Git (same create row)
    rendered.instance.handleInput('j'); // onto the hostile registration row's Refresh action
    rendered.instance.handleInput('i'); // expand its metadata layer
    const sourceLines = rendered.instance.render(120);
    rendered.instance.handleInput('\x1b[C');
    rendered.instance.handleInput('\x1b[C');
    const receiptLines = rendered.instance.render(120);
    const lines = [...sourceLines, ...receiptLines];
    const screen = lines.join('\n');

    expect(screen).toContain('market\\nFORGED-MARKET');
    expect(screen).toContain('source\\nFORGED-PATH');
    expect(screen).toContain('Blocked\\nFORGED-RECEIPT');
    expect(lines.some((line) => line.trim().startsWith('FORGED-'))).toBe(false);
  });
});
