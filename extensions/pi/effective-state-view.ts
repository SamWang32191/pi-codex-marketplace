/**
 * Read-only Effective State / Projected Skills diagnostics view (Observe section).
 *
 * Global-only (#61): Effective State is computed directly from the single Global Bridge State.
 *
 * All user-visible strings come from the centralized ui-strings module (Issue #41).
 */

import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';

import { readBridgeState } from '../../src/bridge-state/store.js';
import {
  computeEffectiveState,
  type EffectiveState,
} from '../../src/projection/effective-state.js';
import { projectEffectiveState } from '../../src/projection/runtime.js';
import { uiText } from './ui-strings.js';
import { quoteTerminalText } from './terminal-presentation.js';

function quote(value: string): string {
  return quoteTerminalText(value);
}

/** Compact multi-line summary of one projection result for disclosure / notification. */
export function formatProjectionSummary(
  state: EffectiveState,
  plugins: ReturnType<typeof projectEffectiveState>['plugins'],
  findings: ReturnType<typeof projectEffectiveState>['findings'],
): string {
  const lines = [
    uiText('eff.projection.header', {
      registrations: state.registrations.length,
      installations: state.installations.length,
    }),
  ];
  if (plugins.length === 0) lines.push(uiText('eff.projection.noPlugins'));
  for (const plugin of plugins) {
    lines.push(`▸ ${quote(plugin.pluginId)} · global`);
    for (const skill of plugin.skills) {
      lines.push('    ' + uiText('eff.projection.skill', {
        name: quote(skill.name),
        status: skill.status === 'projected'
          ? uiText('eff.projection.skillProjected')
          : uiText('eff.projection.skillUnavailable'),
        availability: skill.availability,
      }));
    }
  }
  if (findings.length > 0) {
    lines.push(uiText('eff.projection.findings', {
      findings: findings.map((f: { classification: string; code: string }) => `${f.classification} ${f.code}`).join(' | '),
    }));
  }
  return lines.join('\n');
}

/** Read-only Effective State + Projected Skills / collision diagnostics view. */
export async function runEffectiveStateView(ctx: ExtensionCommandContext): Promise<void> {
  const ui = ctx.ui;
  const read = await readBridgeState({ agentDir: undefined });
  if (read.status !== 'ok' && read.status !== 'missing') {
    return void ui.notify(uiText('common.bridgeState.unreadable', { error: quote(read.error ?? 'Persistence Indeterminate') }), 'error');
  }
  const effective = computeEffectiveState(read.state!);
  const projection = projectEffectiveState(read.state!);
  ui.notify(
    `${formatProjectionSummary(effective, projection.plugins, projection.findings)}${uiText('eff.projection.availableNote')}`,
    projection.findings.length > 0 ? 'warning' : 'info',
  );
}
