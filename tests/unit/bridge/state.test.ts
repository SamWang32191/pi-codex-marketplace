import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readMinimalBridgeState,
  writeMinimalBridgeState,
  createEmptyMinimalState,
  type MinimalBridgeState,
} from '../../../src/bridge/state.js';

describe('Minimal Bridge State (#88)', () => {
  let tmpDir: string;
  let statePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bridge-state-test-'));
    statePath = join(tmpDir, 'state.json');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('starts from an empty state when state.json is missing', () => {
    const result = readMinimalBridgeState({ statePath });
    expect(result.wasReset).toBe(false);
    expect(result.state).toEqual({
      schemaVersion: 1,
      registrations: [],
      installations: [],
    });
  });

  it('reads a valid state document accurately', () => {
    const initial: MinimalBridgeState = {
      schemaVersion: 1,
      registrations: [
        {
          id: 'reg-1',
          marketplaceName: 'samwang-skills',
          alias: 'samwang-skills',
          format: 'codex',
          sourceKind: 'local',
          source: '/path/to/local',
        },
      ],
      installations: [
        {
          id: 'samwang-skills/cmd',
          pluginId: 'samwang-skills/cmd',
          enabled: true,
          installationState: 'enabled',
          registrationId: 'reg-1',
          manifestName: 'cmd',
          sourceKind: 'local',
          source: '/path/to/local',
          skills: ['a', 'b'],
        },
      ],
    };

    writeMinimalBridgeState(initial, { statePath });
    const result = readMinimalBridgeState({ statePath });

    expect(result.wasReset).toBe(false);
    expect(result.state.registrations).toHaveLength(1);
    expect(result.state.registrations[0].marketplaceName).toBe('samwang-skills');
    expect(result.state.installations).toHaveLength(1);
    expect(result.state.installations[0].pluginId).toBe('samwang-skills/cmd');
    expect(result.state.installations[0].enabled).toBe(true);
  });

  it('writes state atomically and creates parent directories if needed', () => {
    const nestedStatePath = join(tmpDir, 'nested', 'deep', 'state.json');
    const state: MinimalBridgeState = {
      schemaVersion: 1,
      registrations: [
        {
          id: 'reg-2',
          marketplaceName: 'mattpocock',
          format: 'claude',
          sourceKind: 'git',
          source: 'https://github.com/mattpocock/skills',
        },
      ],
      installations: [],
    };

    writeMinimalBridgeState(state, { statePath: nestedStatePath });
    expect(existsSync(nestedStatePath)).toBe(true);

    const content = JSON.parse(readFileSync(nestedStatePath, 'utf-8'));
    expect(content.registrations[0].marketplaceName).toBe('mattpocock');
  });

  it('resets to empty state when file contains invalid JSON', () => {
    writeFileSync(statePath, '{ malformed json: not valid ...', 'utf-8');

    const result = readMinimalBridgeState({ statePath });
    expect(result.wasReset).toBe(true);
    expect(result.resetReason).toBeDefined();
    expect(result.state).toEqual(createEmptyMinimalState());

    // File on disk has been reset to valid empty JSON
    const onDisk = JSON.parse(readFileSync(statePath, 'utf-8'));
    expect(onDisk).toEqual(createEmptyMinimalState());
  });

  it('resets to empty state when file is empty (0 bytes or whitespace)', () => {
    writeFileSync(statePath, '   \n  ', 'utf-8');

    const result = readMinimalBridgeState({ statePath });
    expect(result.wasReset).toBe(true);
    expect(result.state).toEqual(createEmptyMinimalState());
  });

  it('resets to empty state when schema is invalid (not object / bad fields)', () => {
    writeFileSync(statePath, JSON.stringify({ unknownField: true }), 'utf-8');

    const result = readMinimalBridgeState({ statePath });
    expect(result.wasReset).toBe(true);
    expect(result.state).toEqual(createEmptyMinimalState());
  });

  it('allows normal state mutation after a corruption reset', () => {
    writeFileSync(statePath, 'CORRUPTED', 'utf-8');

    const read = readMinimalBridgeState({ statePath });
    expect(read.wasReset).toBe(true);

    const newState: MinimalBridgeState = {
      ...read.state,
      registrations: [
        {
          id: 'reg-recovered',
          marketplaceName: 'recovered-market',
          format: 'codex',
          sourceKind: 'local',
          source: '/recovered/path',
        },
      ],
    };

    writeMinimalBridgeState(newState, { statePath });
    const afterWrite = readMinimalBridgeState({ statePath });
    expect(afterWrite.wasReset).toBe(false);
    expect(afterWrite.state.registrations).toHaveLength(1);
    expect(afterWrite.state.registrations[0].marketplaceName).toBe('recovered-market');
  });
});
