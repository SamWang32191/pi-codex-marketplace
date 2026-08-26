import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CURRENT_SCHEMA_VERSION, type BridgeState } from '../../../src/bridge-state/types.js';
import {
  commitMigratedState,
  isDowngradeAttempt,
  migrateForward,
  recoverWalIfNeeded,
  _internal,
} from '../../../src/bridge-state/migrate.js';
import { CODE, RULE } from '../../../src/registration/findings.js';

describe('WAL Migration — schemaVersion binding & v1→v2 migration (Issue #63)', () => {
  let tmpRoot: string;
  let statePath: string;

  beforeEach(() => {
    tmpRoot = join(tmpdir(), `migrate-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    statePath = join(tmpRoot, 'state.json');
    mkdirSync(tmpRoot, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  });

  it('schemaVersion is bound to package version (CURRENT_SCHEMA_VERSION is 2)', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(2);
  });

  it('migrateForward: CURRENT (v2) is no-op (no WAL)', () => {
    const state: BridgeState = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      stateRevision: '1',
      registrations: [],
      installations: [],
    };
    const res = migrateForward(state);
    expect(res.ok).toBe(true);
    expect(res.migrated).toBe(false);
    expect(res.fromVersion).toBe(2);
    expect(res.toVersion).toBe(2);
    expect(res.findings).toEqual([]);
  });

  it('migrateForward: v1 with empty scopeOverrides migrates forward to v2 without findings', () => {
    const v1State = {
      schemaVersion: 1,
      stateRevision: '5',
      registrations: [{ id: 'reg-1', alias: 'marketplace-1' }],
      installations: [{ id: 'inst-1', pluginId: 'inst-1', installationState: 'enabled' }],
      scopeOverrides: [],
    } as any;

    const res = migrateForward(v1State);
    expect(res.ok).toBe(true);
    expect(res.migrated).toBe(true);
    expect(res.fromVersion).toBe(1);
    expect(res.toVersion).toBe(2);
    expect(res.state?.schemaVersion).toBe(2);
    expect(res.state?.stateRevision).toBe('5');
    expect(res.state?.registrations).toEqual([{ id: 'reg-1', alias: 'marketplace-1' }]);
    expect(res.state?.installations).toEqual([{ id: 'inst-1', pluginId: 'inst-1', installationState: 'enabled' }]);
    expect((res.state as any).scopeOverrides).toBeUndefined();
    expect(res.findings).toEqual([]);
  });

  it('migrateForward: v1 with non-empty scopeOverrides strips overrides and records diagnostic finding', () => {
    const v1State = {
      schemaVersion: 1,
      stateRevision: '3',
      registrations: [{ id: 'reg-1', alias: 'marketplace-1' }],
      installations: [{ id: 'inst-1', pluginId: 'inst-1', installationState: 'enabled' }],
      scopeOverrides: [
        { kind: 'registration', targetId: 'reg-old' },
        { kind: 'installation', targetId: 'inst-old' },
      ],
    } as any;

    const res = migrateForward(v1State);
    expect(res.ok).toBe(true);
    expect(res.migrated).toBe(true);
    expect(res.fromVersion).toBe(1);
    expect(res.toVersion).toBe(2);
    expect(res.state?.schemaVersion).toBe(2);
    expect(res.state?.stateRevision).toBe('3');
    expect((res.state as any).scopeOverrides).toBeUndefined();

    // Verify non-blocking warning finding
    expect(res.findings).toHaveLength(1);
    const finding = res.findings![0];
    expect(finding.code).toBe(CODE.SCOPE_OVERRIDES_STRIPPED);
    expect(finding.rule).toBe(RULE.SCOPE_OVERRIDES_STRIPPED);
    expect(finding.classification).toBe('warning');
    expect(finding.phase).toBe('persistence');
    expect(finding.pointer).toBe('/scopeOverrides');
    expect(finding.outcome).toContain('Stripped 2 legacy scopeOverride(s)');
  });

  it('migrateForward: v1 with legacy global/ prefixed installation ID normalizes to pluginId', () => {
    const v1State = {
      schemaVersion: 1,
      stateRevision: '4',
      registrations: [{ id: 'reg-1', alias: 'marketplace-1' }],
      installations: [
        { id: 'global/market-1/tool-a', pluginId: 'market-1/tool-a', installationState: 'enabled' },
        { id: 'market-1/tool-b', pluginId: 'market-1/tool-b', installationState: 'disabled' },
      ],
      scopeOverrides: [],
    } as any;

    const res = migrateForward(v1State);
    expect(res.ok).toBe(true);
    expect(res.state?.installations).toEqual([
      { id: 'market-1/tool-a', pluginId: 'market-1/tool-a', installationState: 'enabled' },
      { id: 'market-1/tool-b', pluginId: 'market-1/tool-b', installationState: 'disabled' },
    ]);
  });

  it('migrateForward: newer version (> 2) is incompatible (fail-closed, no auto-migrate)', () => {
    const state = {
      schemaVersion: CURRENT_SCHEMA_VERSION + 1,
      stateRevision: '1',
      registrations: [],
      installations: [],
    } as any;
    const res = migrateForward(state);
    expect(res.ok).toBe(false);
    expect(res.code).toBe('INCOMPATIBLE_NEWER');
    expect(res.error).toMatch(/requires newer Bridge Package/);
  });

  it('migrateForward: invalid schemaVersion 0 is treated as corrupted', () => {
    const state = {
      schemaVersion: 0,
      stateRevision: '0',
      registrations: [],
      installations: [],
    } as any;
    const res = migrateForward(state);
    expect(res.ok).toBe(false);
    expect(res.code).toBe('CORRUPTED');
  });

  it('isDowngradeAttempt: older target over newer durable is blocked (never write back)', () => {
    expect(isDowngradeAttempt(2, 1)).toBe(true);
    expect(isDowngradeAttempt(3, 2)).toBe(true);
    expect(isDowngradeAttempt(2, 2)).toBe(false);
    expect(isDowngradeAttempt(1, 2)).toBe(false);
  });

  it('commitMigratedState writes WAL, updates state file atomically, and cleans WAL', () => {
    const migratedState: BridgeState = {
      schemaVersion: 2,
      stateRevision: '10',
      registrations: [{ id: 'reg-1', alias: 'm1' }],
      installations: [],
    };

    const committed = commitMigratedState(statePath, migratedState, 1, '10');
    expect(committed).toBe(true);
    expect(existsSync(statePath)).toBe(true);
    expect(existsSync(`${statePath}.wal`)).toBe(false);

    const written = JSON.parse(readFileSync(statePath, 'utf-8'));
    expect(written.schemaVersion).toBe(2);
    expect(written.stateRevision).toBe('10');
  });

  it('recoverWalIfNeeded replays WAL when state file still holds old version after crash', () => {
    const oldState = {
      schemaVersion: 1,
      stateRevision: '3',
      registrations: [],
      installations: [],
    } as any;
    const targetState: BridgeState = {
      schemaVersion: 2,
      stateRevision: '3',
      registrations: [],
      installations: [],
    };

    writeFileSync(statePath, JSON.stringify(oldState), 'utf-8');
    _internal.writeWalSync(statePath, {
      fromVersion: 1,
      toVersion: 2,
      fromRevision: '3',
      targetState,
      createdAt: new Date().toISOString(),
    });

    const rec = recoverWalIfNeeded(statePath, oldState);
    expect(rec.recovered).toBe(true);
    expect(rec.state?.schemaVersion).toBe(2);
    expect(existsSync(`${statePath}.wal`)).toBe(false);

    const written = JSON.parse(readFileSync(statePath, 'utf-8'));
    expect(written.schemaVersion).toBe(2);
  });

  it('recoverWalIfNeeded cleans WAL when state file was already committed', () => {
    const targetState: BridgeState = {
      schemaVersion: 2,
      stateRevision: '4',
      registrations: [],
      installations: [],
    };

    writeFileSync(statePath, JSON.stringify(targetState), 'utf-8');
    _internal.writeWalSync(statePath, {
      fromVersion: 1,
      toVersion: 2,
      fromRevision: '4',
      targetState,
      createdAt: new Date().toISOString(),
    });

    const rec = recoverWalIfNeeded(statePath, targetState);
    expect(rec.recovered).toBe(false);
    expect(existsSync(`${statePath}.wal`)).toBe(false);
  });
});

