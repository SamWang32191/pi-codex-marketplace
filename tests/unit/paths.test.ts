import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getAgentDir, getGlobalStatePath, getProjectStatePath, getLockPath } from '../../src/bridge-state/paths.js';

describe('paths', () => {
  it('getAgentDir defaults to ~/.pi/agent', () => {
    delete process.env.PI_CODING_AGENT_DIR;
    delete process.env.PI_AGENT_DIR;
    expect(getAgentDir()).toBe(join(homedir(), '.pi', 'agent'));
  });

  it('getAgentDir honors PI_CODING_AGENT_DIR', () => {
    process.env.PI_CODING_AGENT_DIR = '/tmp/custom-agent';
    expect(getAgentDir()).toBe('/tmp/custom-agent');
    delete process.env.PI_CODING_AGENT_DIR;
  });

  it('global path under agentDir', () => {
    expect(getGlobalStatePath('/tmp/agent')).toBe(join('/tmp/agent', 'codex-marketplace', 'state.json'));
  });

  it('project path under cwd/.pi', () => {
    expect(getProjectStatePath('/tmp/myproject')).toBe(join('/tmp/myproject', '.pi', 'codex-marketplace', 'state.json'));
  });

  it('lock path is state + .lock', () => {
    expect(getLockPath('/tmp/agent/codex-marketplace/state.json')).toBe(
      '/tmp/agent/codex-marketplace/state.json.lock',
    );
  });
});
