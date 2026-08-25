/**
 * Read-only Effective State / Projected Skills diagnostics view (Observe section).
 *
 * Scope Override management is retired (issue #59); this module retains only the observe-only
 * projection summary that was previously hosted by the scope-overrides flow adapter.
 *
 * All user-visible strings come from the centralized ui-strings module (Issue #41).
 */

import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';

import { readBridgeState } from '../../src/bridge-state/store.js';
import type { BridgeState } from '../../src/bridge-state/types.js';
import { computeEffectiveState, type EffectiveState } from '../../src/projection/effective-state.js';
import { projectEffectiveState } from '../../src/projection/project.js';
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
    ...state.suppressed.map((item) => uiText('eff.projection.suppressed', {
      kind: item.kind,
      targetId: `${item.targetId.slice(0, 8)}…`,
      reason: item.reason,
    })),
  ];
  if (plugins.length === 0) lines.push(uiText('eff.projection.noPlugins'));
  for (const plugin of plugins) {
    lines.push(`▸ ${quote(plugin.pluginId)} · ${plugin.sourceScope}`);
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
      findings: findings.map((f) => `${f.classification} ${f.code}`).join(' | '),
    }));
  }
  return lines.join('\n');
}

async function readBoth(ctx: { cwd?: string; agentDir?: string }): Promise<{
  ok: boolean;
  global?: BridgeState;
  project?: BridgeState;
  error?: string;
}> {
  const opts = { cwd: ctx.cwd, agentDir: ctx.agentDir };
  const [globalRead, projectRead] = await Promise.all([readBridgeState('global', opts), readBridgeState('project', opts)]);
  const bad = [globalRead, projectRead].find((read) => read.status !== 'ok' && read.status !== 'missing');
  if (bad) return { ok: false, error: bad.error ?? 'Persistence Indeterminate' };
  return { ok: true, global: globalRead.state!, project: projectRead.state! };
}

/** Read-only Effective State + Projected Skills / collision diagnostics view. */
export async function runEffectiveStateView(ctx: ExtensionCommandContext): Promise<void> {
  const ui = ctx.ui;
  const trusted = ctx.isProjectTrusted();
  const docs = await readBoth({ cwd: ctx.cwd });
  if (!docs.ok) {
    return void ui.notify(uiText('common.bridgeState.unreadable', { error: quote(docs.error ?? 'Persistence Indeterminate') }), 'error');
  }
  const effective = computeEffectiveState(docs.global!, docs.project!, { projectTrusted: trusted });
  const projection = projectEffectiveState(docs.global!, docs.project!, { projectTrusted: trusted });
  const trustNote = trusted ? '' : uiText('eff.projection.trustNote');
  ui.notify(
    `${formatProjectionSummary(effective, projection.plugins, projection.findings)}${trustNote}${uiText('eff.projection.availableNote')}`,
    projection.findings.length > 0 ? 'warning' : 'info',
  );
}
