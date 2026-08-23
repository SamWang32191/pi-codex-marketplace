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
    receipts: [],
    activeChains: [],
    allChains: [],
    corruptedLineCount: 0,
    isDegraded: false,
    findings: [],
  };
}

function snapshot(): BridgeLedgerSnapshot {
  const globalRegistration = {
    id: '11111111-1111-4111-8111-111111111111',
    alias: 'global-market',
    marketplaceName: 'global-market',
    sourceKind: 'local' as const,
    source: '/marketplaces/global',
  };
  const projectRegistration = {
    id: '22222222-2222-4222-8222-222222222222',
    alias: 'project-market',
    marketplaceName: 'project-market',
    sourceKind: 'git' as const,
    source: 'https://example.test/project.git',
  };
  const globalInstallation = {
    id: 'global/plugin/global-tool',
    pluginId: `${globalRegistration.id}/global-market/global-tool`,
    registrationId: globalRegistration.id,
    installationState: 'enabled' as const,
  };
  const projectInstallation = {
    id: 'project/plugin/project-tool',
    pluginId: `${projectRegistration.id}/project-market/project-tool`,
    registrationId: projectRegistration.id,
    installationState: 'disabled' as const,
  };
  const receipt = {
    id: 'rcpt_33333333-3333-4333-8333-333333333333',
    kind: 'Marketplace Refresh' as const,
    operation: 'Marketplace Refresh',
    scope: 'global' as const,
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
  const globalMarketplaceEntryId = `${globalRegistration.id}/global-market/plugins/0`;
  const projectMarketplaceEntryId = `${projectRegistration.id}/project-market/plugins/0`;
  return {
    global: {
      status: 'ok',
      state: {
        schemaVersion: 1,
        stateRevision: '12',
        registrations: [globalRegistration],
        installations: [globalInstallation],
        scopeOverrides: [],
      },
    },
    project: {
      status: 'ok',
      state: {
        schemaVersion: 1,
        stateRevision: '7',
        registrations: [projectRegistration],
        installations: [projectInstallation],
        scopeOverrides: [{ kind: 'registration', targetId: globalRegistration.id }],
      },
    },
    projectTrusted: true,
    barrier: { active: false },
    journals: {
      global: { ...emptyJournal(), receipts: [receipt] },
      project: emptyJournal(),
    },
    marketplaceEntries: {
      global: [{
        scope: 'global',
        registrationId: globalRegistration.id,
        entryPointer: '/plugins/0',
        marketplaceEntryId: globalMarketplaceEntryId,
        validationSnapshot: 'snapshot-global-entry',
        name: 'global-tool',
        classification: 'compatible',
        plugin: {
          id: `${globalRegistration.id}/global-market/global-tool`,
          manifestName: 'global-tool',
          marketplaceEntryId: globalMarketplaceEntryId,
          skills: [{
            id: `${globalRegistration.id}/global-market/global-tool/build`,
            name: 'build',
            path: '/marketplaces/global/plugins/global-tool/skills/build',
            invocationPolicy: 'explicit',
            resources: ['references/guide.md'],
          }],
        },
        findings: [],
      }],
      project: [{
        scope: 'project',
        registrationId: projectRegistration.id,
        entryPointer: '/plugins/0',
        marketplaceEntryId: projectMarketplaceEntryId,
        validationSnapshot: 'snapshot-project-entry',
        name: 'project-tool',
        classification: 'incompatible',
        findings: [{
          code: 'UNSUPPORTED_ACTIVE_COMPONENT',
          classification: 'blocking',
          phase: 'validation',
          target: 'plugin',
          scope: 'project',
          pointer: '.codex-plugin/plugin.json#/extensions',
          rule: 'COMP-02',
          outcome: 'unsupported active component',
        }],
        unavailableReason: 'unsupported active component',
      }],
    },
    effective: {
      registrations: [{ ...projectRegistration, sourceScope: 'project' }],
      installations: [],
      suppressed: [
        { kind: 'registration', targetId: globalRegistration.id, reason: 'scope-override-registration' },
        {
          kind: 'installation',
          targetId: globalInstallation.id,
          pluginId: globalInstallation.pluginId,
          reason: 'scope-override-registration',
        },
      ],
      excluded: [],
    },
  };
}

describe('Bridge Ledger presentation model', () => {
  it('organizes all existing management capabilities into five reachable sections', () => {
    const model = buildBridgeLedgerModel(snapshot());

    expect(model.sections.map((section) => section.id)).toEqual([
      'observe',
      'sources',
      'plugins',
      'scope-inheritance',
      'recovery-receipts',
    ]);

    const reachable = new Set<LedgerActionId>(
      model.sections.flatMap((section) =>
        section.rows.flatMap((row) => row.actions.map((action) => action.intent.actionId)),
      ),
    );
    expect(reachable).toEqual(new Set<LedgerActionId>([
      'observe-partitions',
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
      'create-scope-override',
      'remove-scope-override',
      'view-receipt-journal',
      'repair-state',
      'inspect-receipt',
    ]));

    const recovery = model.sections.find((section) => section.id === 'recovery-receipts')!;
    expect(recovery.rows.find((row) => row.id === 'journal:global')?.detail).toContain(
      '1 receipt',
    );
    expect(recovery.rows.find((row) => row.id === 'journal:project')?.detail).toContain(
      '0 active recovery chains',
    );
  });

  it('makes Marketplace Entries the stable Plugins objects and binds both install paths directly', () => {
    const plugins = buildBridgeLedgerModel(snapshot()).sections.find(
      (section) => section.id === 'plugins',
    )!;
    const compatible = plugins.rows.find((row) =>
      row.id === 'marketplace-entry:global:11111111-1111-4111-8111-111111111111/global-market/plugins/0');
    const incompatible = plugins.rows.find((row) =>
      row.id === 'marketplace-entry:project:22222222-2222-4222-8222-222222222222/project-market/plugins/0');

    expect(compatible).toMatchObject({
      targetKind: 'marketplace-entry',
      targetId: '11111111-1111-4111-8111-111111111111/global-market/plugins/0',
      detail: expect.stringMatching(/compatible.*build.*explicit.*references\/guide\.md/i),
    });
    expect(compatible?.actions.map((entry) => entry.intent)).toEqual([
      expect.objectContaining({
        actionId: 'install-disabled',
        scope: 'global',
        registrationId: '11111111-1111-4111-8111-111111111111',
        entryPointer: '/plugins/0',
        targetKind: 'marketplace-entry',
        targetId: '11111111-1111-4111-8111-111111111111/global-market/plugins/0',
        stateRevision: '12',
        validationSnapshot: 'snapshot-global-entry',
      }),
      expect.objectContaining({
        actionId: 'install-and-enable',
        desiredInstallationState: 'enabled',
      }),
    ]);
    expect(incompatible?.detail).toMatch(/incompatible/i);
    expect(incompatible?.actions.every((entry) => !entry.enabled)).toBe(true);
    expect(incompatible?.actions[0]?.disabledReason).toContain('unsupported active component');
  });

  it('fails closed when a compatible Marketplace Entry has no presentation Validation Snapshot', () => {
    const unbound = snapshot();
    unbound.global.state!.installations = [];
    const entry = unbound.marketplaceEntries.global[0]!;
    if (!('marketplaceEntryId' in entry)) throw new Error('fixture requires a Marketplace Entry');
    delete entry.validationSnapshot;

    const row = buildBridgeLedgerModel(unbound).sections
      .find((section) => section.id === 'plugins')?.rows
      .find((candidate) => candidate.id === `marketplace-entry:global:${entry.marketplaceEntryId}`);

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
    const fixture = value.marketplaceEntries.global[0]!;
    if (!('marketplaceEntryId' in fixture) || !fixture.plugin) {
      throw new Error('fixture requires a compatible Marketplace Entry');
    }
    const mapped = mapMarketplaceInspectionToLedgerItems('global', registration, {
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
        scope: 'global' as const,
        pointer: '',
        rule,
        outcome,
      };

      unavailable.marketplaceEntries.global = mapMarketplaceInspectionToLedgerItems(
        'global',
        registration,
        { entries: [], findings: [finding] },
      );

      const diagnostic = buildBridgeLedgerModel(unavailable).sections
        .find((section) => section.id === 'plugins')?.rows
        .find((row) => row.id === `marketplace-diagnostic:global:${registration.id}`);

      expect(unavailable.marketplaceEntries.global[0]).not.toHaveProperty('marketplaceEntryId');
      expect(unavailable.marketplaceEntries.global[0]?.findings).toEqual([finding]);
      expect(diagnostic).toMatchObject({
        label: 'global-market',
        detail: `Unavailable · ${code} · ${rule} · ${outcome}`,
        scope: 'global',
        targetKind: 'registration',
        targetId: registration.id,
        actions: [],
      });
      expect(diagnostic?.actions.some((entry) =>
        entry.intent.actionId === 'install-disabled' || entry.intent.actionId === 'install-and-enable')).toBe(false);
    },
  );

  it('renders actionless Marketplace diagnostics only in their focused scope without dispatching them', () => {
    const unavailable = snapshot();
    const globalRegistration = unavailable.global.state!.registrations[0]!;
    const projectRegistration = unavailable.project.state!.registrations[0]!;
    unavailable.global.state!.installations = [];
    unavailable.project.state!.installations = [];
    unavailable.marketplaceEntries.global = mapMarketplaceInspectionToLedgerItems(
      'global',
      globalRegistration,
      {
        entries: [],
        findings: [{
          code: 'SOURCE_DRIFT',
          classification: 'blocking',
          phase: 'validation',
          target: 'registration',
          scope: 'global',
          pointer: '',
          rule: 'DRIFT-01',
          outcome: 'Source Drift requires Marketplace Refresh',
        }],
      },
    );
    unavailable.marketplaceEntries.project = mapMarketplaceInspectionToLedgerItems(
      'project',
      projectRegistration,
      {
        entries: [],
        findings: [{
          code: 'CATALOG_MALFORMED',
          classification: 'blocking',
          phase: 'validation',
          target: 'catalog',
          scope: 'project',
          pointer: '/',
          rule: 'CAT-02',
          outcome: 'marketplace.json is not an object',
        }],
      },
    );
    const rendered = component(buildBridgeLedgerModel(unavailable));
    rendered.instance.render(240);
    rendered.instance.handleInput('\x1b[C'); // Sources
    rendered.instance.handleInput('\x1b[C'); // Plugins

    const globalScreen = rendered.instance.render(240).join('\n');
    expect(globalScreen).toContain(
      'SOURCE_DRIFT · DRIFT-01 · Source Drift requires Marketplace Refresh',
    );
    expect(globalScreen).not.toContain(
      'CATALOG_MALFORMED · CAT-02 · marketplace.json is not an object',
    );
    rendered.instance.handleInput('\r');
    expect(rendered.results).toEqual([]);

    rendered.instance.handleInput('p');
    const projectScreen = rendered.instance.render(240).join('\n');
    expect(projectScreen).toContain(
      'CATALOG_MALFORMED · CAT-02 · marketplace.json is not an object',
    );
    expect(projectScreen).not.toContain(
      'SOURCE_DRIFT · DRIFT-01 · Source Drift requires Marketplace Refresh',
    );
    rendered.instance.handleInput('\r');
    expect(rendered.results).toEqual([]);
  });

  it('uses compatible Plugin identity, not Marketplace Entry provenance, to detect scope-local Installations', () => {
    const findMarketplaceRow = (value: BridgeLedgerSnapshot, marketplaceEntryId: string) =>
      buildBridgeLedgerModel(value).sections
        .find((section) => section.id === 'plugins')?.rows
        .find((row) => row.id === `marketplace-entry:global:${marketplaceEntryId}`);

    const moved = snapshot();
    const movedEntry = moved.marketplaceEntries.global[0]!;
    if (!('marketplaceEntryId' in movedEntry) || !movedEntry.plugin) {
      throw new Error('fixture requires a compatible Marketplace Entry');
    }
    moved.global.state!.installations[0]!.marketplaceEntryId = movedEntry.marketplaceEntryId;
    movedEntry.entryPointer = '/plugins/7';
    movedEntry.marketplaceEntryId = '11111111-1111-4111-8111-111111111111/global-market/plugins/7';
    movedEntry.plugin.marketplaceEntryId = movedEntry.marketplaceEntryId;

    const movedRow = findMarketplaceRow(moved, movedEntry.marketplaceEntryId);
    expect(movedRow?.actions.every((entry) => !entry.enabled)).toBe(true);
    expect(movedRow?.actions[0]?.disabledReason).toContain('scope-local Installation');

    const replacement = snapshot();
    const replacementEntry = replacement.marketplaceEntries.global[0]!;
    if (!('marketplaceEntryId' in replacementEntry) || !replacementEntry.plugin) {
      throw new Error('fixture requires a compatible Marketplace Entry');
    }
    replacement.global.state!.installations[0]!.marketplaceEntryId = replacementEntry.marketplaceEntryId;
    replacementEntry.name = 'replacement-tool';
    replacementEntry.plugin = {
      ...replacementEntry.plugin,
      id: '11111111-1111-4111-8111-111111111111/global-market/replacement-tool',
      manifestName: 'replacement-tool',
    };

    const replacementRow = findMarketplaceRow(replacement, replacementEntry.marketplaceEntryId);
    expect(replacementRow?.actions.map((entry) => entry.enabled)).toEqual([true, true]);

    const unavailable = snapshot();
    const unavailableEntryId = '11111111-1111-4111-8111-111111111111/global-market/plugins/0';
    unavailable.global.state!.installations[0]!.marketplaceEntryId = unavailableEntryId;
    unavailable.marketplaceEntries.global = [{
      scope: 'global',
      registrationId: '11111111-1111-4111-8111-111111111111',
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
      ...pending.journals.global.receipts[0]!,
      summary: 'Pending Application' as const,
      runtimeOutcome: 'pending-application' as const,
      validationSnapshot: 'snapshot-runtime-12',
      recoveryActions: ['Retry Application' as const],
    };
    const chain = {
      rootReceiptId: receipt.id,
      scope: 'global' as const,
      condition: 'pending-application' as const,
      stateRevision: '12',
      receipts: [receipt],
      resolved: false,
      superseded: false,
    };
    pending.journals.global = {
      ...pending.journals.global,
      receipts: [receipt],
      activeChains: [chain],
      allChains: [chain],
    };

    const recovery = buildBridgeLedgerModel(pending).sections.find(
      (section) => section.id === 'recovery-receipts',
    )!;
    const retry = recovery.rows.find((row) => row.id === `retry-application:global:${receipt.id}`);

    expect(retry?.actions[0]).toMatchObject({
      enabled: true,
      intent: {
        actionId: 'retry-application',
        mode: 'mutation',
        scope: 'global',
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
      ...pending.journals.global.receipts[0]!,
      summary: 'Pending Application' as const,
      runtimeOutcome: 'pending-application' as const,
      recoveryActions: ['Retry Application' as const],
    };
    const chain = {
      rootReceiptId: receipt.id,
      scope: 'global' as const,
      condition: 'pending-application' as const,
      stateRevision: '12',
      receipts: [receipt],
      resolved: false,
      superseded: false,
    };
    pending.journals.global = {
      ...pending.journals.global,
      receipts: [receipt],
      activeChains: [chain],
      allChains: [chain],
    };

    const recovery = buildBridgeLedgerModel(pending).sections.find(
      (section) => section.id === 'recovery-receipts',
    )!;
    const retry = recovery.rows.find((row) => row.id === `retry-application:global:${receipt.id}`);

    expect(retry?.actions[0]).toMatchObject({
      enabled: false,
      disabledReason: expect.stringContaining('no bound Validation Snapshot'),
    });
  });

  it.each([120, 80, 60])('renders a usable authority workspace at %i columns without overflow', (width) => {
    const { instance } = component();
    const lines = instance.render(width);
    const screen = lines.join('\n');

    expect(lines.length).toBeGreaterThan(8);
    expect(screen).toContain('CODEX MARKETPLACE / BRIDGE LEDGER');
    expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    expect(screen).toContain('G rev "12"');
    expect(screen).toContain('P rev "7"');
    expect(screen.match(/health healthy/g)).toHaveLength(2);
    expect(screen).toContain('Project Trust: granted');
    expect(screen).toContain('Barrier: Clear');
    expect(screen).toContain('Status:');
    expect(screen).toContain('Esc/q');
    expect(screen).toContain(width >= 64 ? 'Navigation' : 'Sections');
  });

  it('changes g/p browsing focus while keeping the visible action authority explicit', () => {
    const { instance, requests, results } = component();
    instance.render(120);

    instance.handleInput('\x1b[C'); // Sources
    instance.handleInput('p');
    const projectScreen = instance.render(120).join('\n');
    expect(projectScreen).toContain('Status: browsing P');
    expect(projectScreen).toContain('Project registration actions');
    expect(projectScreen).not.toContain('Global registration actions');
    instance.handleInput('\r');

    expect(results).toEqual([{
      actionId: 'register-local',
      mode: 'mutation',
      scope: 'project',
      targetKind: 'scope',
      targetId: 'project',
      stateRevision: '7',
    }]);
    expect(requests.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps canonical object identities and explicit scopes in structured action intents', () => {
    const model = buildBridgeLedgerModel(snapshot());
    const rows = model.sections.flatMap((section) => section.rows);
    const actions = rows.flatMap((row) => row.actions);

    expect(rows.find((row) => row.id === 'registration:global:11111111-1111-4111-8111-111111111111')).toMatchObject({
      targetKind: 'registration',
      targetId: '11111111-1111-4111-8111-111111111111',
    });
    expect(rows.find((row) => row.id === 'installation:global:global/plugin/global-tool')).toMatchObject({
      targetKind: 'installation',
      targetId: 'global/plugin/global-tool',
    });
    expect(rows.find((row) => row.id === 'scope-override:registration/11111111-1111-4111-8111-111111111111')).toMatchObject({
      targetKind: 'scope-override',
      targetId: 'registration/11111111-1111-4111-8111-111111111111',
    });
    expect(rows.find((row) => row.id === 'receipt:global:rcpt_33333333-3333-4333-8333-333333333333')).toMatchObject({
      targetKind: 'receipt',
      targetId: 'rcpt_33333333-3333-4333-8333-333333333333',
    });
    expect(actions.filter((entry) => entry.intent.mode === 'mutation').every((entry) => entry.intent.scope !== undefined)).toBe(true);
  });

  it('offers Scope Overrides only for inherited records that can participate', () => {
    const mixed = snapshot();
    mixed.global.state!.installations.push({
      id: 'global/plugin/disabled-tool',
      pluginId: '11111111-1111-4111-8111-111111111111/global-market/disabled-tool',
      registrationId: '11111111-1111-4111-8111-111111111111',
      installationState: 'disabled',
    });

    const inheritance = buildBridgeLedgerModel(mixed).sections.find(
      (section) => section.id === 'scope-inheritance',
    )!;

    expect(inheritance.rows.some((row) => row.targetId === 'global/plugin/global-tool')).toBe(true);
    expect(inheritance.rows.some((row) => row.targetId === 'global/plugin/disabled-tool')).toBe(false);
    expect(inheritance.rows.some((row) =>
      row.id === 'inherited:registration:11111111-1111-4111-8111-111111111111')).toBe(false);
  });

  it('applies Project Trust and Global Pending Barrier only to Project mutations', () => {
    const findAction = (model: ReturnType<typeof buildBridgeLedgerModel>, actionId: LedgerActionId, scope: 'global' | 'project') =>
      model.sections.flatMap((section) => section.rows).flatMap((row) => row.actions)
        .find((entry) => entry.intent.actionId === actionId && entry.intent.scope === scope)!;

    const clear = buildBridgeLedgerModel(snapshot());
    expect(findAction(clear, 'register-local', 'project').enabled).toBe(true);
    expect(findAction(clear, 'repair-state', 'project')).toMatchObject({
      enabled: false,
      disabledReason: expect.stringContaining('no eligible Persistence Indeterminate'),
    });

    const barrierSnapshot = snapshot();
    barrierSnapshot.barrier = { active: true, reason: 'global recovery pending' };
    const barrier = buildBridgeLedgerModel(barrierSnapshot);
    expect(findAction(barrier, 'register-local', 'project')).toMatchObject({
      enabled: false,
      disabledReason: expect.stringContaining('Global Pending Barrier'),
    });
    expect(findAction(barrier, 'repair-state', 'project').enabled).toBe(false);
    expect(findAction(barrier, 'refresh-registration', 'project').enabled).toBe(true);
    expect(findAction(barrier, 'view-receipt-journal', 'project').enabled).toBe(true);
    expect(findAction(barrier, 'repair-state', 'global')).toMatchObject({
      enabled: false,
      disabledReason: expect.stringContaining('no eligible Persistence Indeterminate'),
    });

    const untrustedSnapshot = snapshot();
    untrustedSnapshot.projectTrusted = false;
    const untrusted = buildBridgeLedgerModel(untrustedSnapshot);
    expect(findAction(untrusted, 'register-git', 'project')).toMatchObject({
      enabled: false,
      disabledReason: expect.stringContaining('Project Trust'),
    });
    expect(findAction(untrusted, 'refresh-registration', 'project').enabled).toBe(true);
    expect(findAction(untrusted, 'view-receipt-journal', 'project').enabled).toBe(true);
    expect(findAction(untrusted, 'register-local', 'global').enabled).toBe(true);
  });

  it('keeps repair available while disabling ordinary mutations for an unreadable scope', () => {
    const unreadableSnapshot = snapshot();
    unreadableSnapshot.global = {
      status: 'corrupted',
      error: 'invalid JSON',
    };
    const model = buildBridgeLedgerModel(unreadableSnapshot);
    const actions = model.sections.flatMap((section) => section.rows).flatMap((row) => row.actions);
    const globalRegistration = actions.find((entry) =>
      entry.intent.actionId === 'register-local' && entry.intent.scope === 'global')!;
    const globalRepair = actions.find((entry) =>
      entry.intent.actionId === 'repair-state' && entry.intent.scope === 'global')!;

    expect(globalRegistration).toMatchObject({
      enabled: false,
      disabledReason: expect.stringContaining('Persistence Indeterminate'),
    });
    expect(globalRepair.enabled).toBe(true);
  });

  it('offers State Repair only for a repairable persistence-indeterminate chain', () => {
    const repairable = snapshot();
    const root = {
      ...repairable.journals.global.receipts[0]!,
      summary: 'Persistence Indeterminate' as const,
      durableOutcome: 'indeterminate' as const,
      recoveryActions: ['Repair State' as const, 'Inspect' as const],
    };
    const chain = {
      rootReceiptId: root.id,
      scope: 'global' as const,
      condition: 'persistence-indeterminate' as const,
      stateRevision: '12',
      receipts: [root],
      resolved: false,
      superseded: false,
    };
    repairable.journals.global = {
      ...repairable.journals.global,
      receipts: [root],
      activeChains: [chain],
      allChains: [chain],
    };

    const action = buildBridgeLedgerModel(repairable).sections
      .flatMap((section) => section.rows)
      .flatMap((row) => row.actions)
      .find((entry) => entry.intent.actionId === 'repair-state' && entry.intent.scope === 'global');

    expect(action?.enabled).toBe(true);
  });

  it('offers State Repair when corrupted Receipt Journal lines activate recovery without a chain', () => {
    const degraded = snapshot();
    degraded.journals.global = {
      ...degraded.journals.global,
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
    const cwd = join(root, 'project');
    const inspections: string[] = [];
    const inspector = (registration: { id: string }, scope: 'global' | 'project') => {
      inspections.push(`${scope}:${registration.id}`);
      return { entries: [], findings: [] };
    };
    try {
      const globalDir = join(agentDir, 'codex-marketplace');
      const projectDir = join(cwd, '.pi', 'codex-marketplace');
      mkdirSync(globalDir, { recursive: true });
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(globalDir, 'state.json'), JSON.stringify({
        schemaVersion: 1,
        stateRevision: '3',
        registrations: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', marketplaceName: 'g' }],
        installations: [],
        scopeOverrides: [],
      }));
      writeFileSync(join(projectDir, 'state.json'), JSON.stringify({
        schemaVersion: 1,
        stateRevision: '4',
        registrations: [{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', marketplaceName: 'p' }],
        installations: [],
        scopeOverrides: [],
      }));

      const loaded = await loadBridgeLedgerSnapshot({
        cwd,
        agentDir,
        projectTrusted: true,
        inspectMarketplaceEntries: inspector,
      });

      expect(loaded.global.state?.stateRevision).toBe('3');
      expect(loaded.project.state?.stateRevision).toBe('4');
      expect(loaded.journals.global.receipts).toEqual([]);
      expect(loaded.journals.project.receipts).toEqual([]);
      expect(loaded.barrier.active).toBe(false);
      expect(loaded.effective?.registrations.map((registration) => registration.sourceScope)).toEqual(['global', 'project']);
      expect(inspections).toEqual([]);

      const first = component(buildBridgeLedgerModel(loaded));
      first.instance.render(80); // Observe
      expect(inspections).toEqual([]);
      first.instance.handleInput('\x1b[C'); // Sources
      first.instance.render(80);
      expect(inspections).toEqual([]);
      first.instance.handleInput('\x1b[C'); // Plugins
      first.instance.render(80);
      expect(inspections).toEqual([
        'global:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'project:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      ]);

      first.instance.render(80);
      buildBridgeLedgerModel(loaded).sections.find((section) => section.id === 'plugins')!.rows;
      expect(inspections).toHaveLength(2);

      const reloaded = await loadBridgeLedgerSnapshot({
        cwd,
        agentDir,
        projectTrusted: true,
        inspectMarketplaceEntries: inspector,
      });
      expect(inspections).toHaveLength(2);
      buildBridgeLedgerModel(reloaded).sections.find((section) => section.id === 'plugins')!.rows;
      expect(inspections).toEqual([
        'global:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'project:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        'global:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'project:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('supports arrows, j/k, Enter, Esc, q, Ctrl-C, help, and narrow back navigation', () => {
    const wide = component();
    wide.instance.render(80);
    wide.instance.handleInput('\x1b[57418u'); // Kitty right
    expect(wide.instance.render(80).join('\n')).toContain('> Sources');
    wide.instance.handleInput('j');
    wide.instance.handleInput('\x1b[57420u'); // Kitty down
    wide.instance.handleInput('\x1b[57419u'); // Kitty up
    wide.instance.handleInput('k');
    wide.instance.handleInput('?');
    expect(wide.instance.render(80).join('\n')).toContain('Help');
    wide.instance.handleInput('\x1b[27u'); // Kitty Escape closes help
    expect(wide.results).toEqual([]);
    wide.instance.handleInput('\x1b[13u'); // Kitty Enter activates first Global action
    expect(wide.results[0]).toMatchObject({ actionId: 'register-local', scope: 'global' });

    const narrow = component();
    narrow.instance.render(60);
    narrow.instance.handleInput('\r');
    expect(narrow.instance.render(60).join('\n')).toContain('Section: Observe');
    narrow.instance.handleInput('\x1b');
    expect(narrow.instance.render(60).join('\n')).toContain('Sections');
    narrow.instance.handleInput('q');
    expect(narrow.results).toEqual([undefined]);

    const ctrlC = component();
    ctrlC.instance.handleInput('\x1b[99;5u');
    expect(ctrlC.results).toEqual([undefined]);

    const escape = component();
    escape.instance.handleInput('\x1b');
    expect(escape.results).toEqual([undefined]);
  });

  it('does not return an intent when Enter activates a disabled row', () => {
    const blockedSnapshot = snapshot();
    blockedSnapshot.global.state!.registrations = [];
    blockedSnapshot.global.state!.installations = [];
    blockedSnapshot.project.state!.registrations = [];
    blockedSnapshot.project.state!.installations = [];
    blockedSnapshot.barrier = { active: true, reason: 'global application pending' };
    const blocked = component(buildBridgeLedgerModel(blockedSnapshot));
    blocked.instance.render(80);
    blocked.instance.handleInput('\x1b[C'); // Sources
    blocked.instance.handleInput('p'); // Project register-local
    expect(blocked.instance.render(80).join('\n')).toContain('disabled:');

    blocked.instance.handleInput('\r');

    expect(blocked.results).toEqual([]);
  });

  it('quotes hostile marketplace names, paths, and receipt outcomes without injecting rows', () => {
    const hostile = snapshot();
    hostile.global.state!.registrations[0]!.alias = 'market\nFORGED-MARKET';
    hostile.global.state!.registrations[0]!.source = '/tmp/source\nFORGED-PATH';
    hostile.journals.global.receipts[0]!.summary = 'Blocked\nFORGED-RECEIPT' as never;
    const rendered = component(buildBridgeLedgerModel(hostile));
    rendered.instance.render(120);
    rendered.instance.handleInput('\x1b[C');
    const sourceLines = rendered.instance.render(120);
    rendered.instance.handleInput('\x1b[C');
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
