/**
 * TUI flow for Scope Override management and the Effective State / projection view.
 *
 * Scope Overrides suppress inherited Global Scope records without modifying them: a
 * Registration override suppresses its marketplace subtree, an Installation override
 * suppresses only that single Plugin, and removing either reveals the inherited record again.
 * The Effective State view marks every record's participating source and suppression reason,
 * and lists Projected Skills with their collision outcome and Skill Availability.
 *
 * All user-visible strings come from the centralized ui-strings module (Issue #41).
 */

import type { ExtensionCommandContext, ExtensionUIContext } from '@earendil-works/pi-coding-agent';

import { readBridgeState } from '../../src/bridge-state/store.js';
import type { BridgeState } from '../../src/bridge-state/types.js';
import { computeEffectiveState, type EffectiveState } from '../../src/projection/effective-state.js';
import { createScopeOverride, removeScopeOverride, type OverrideKind } from '../../src/projection/overrides.js';
import { projectEffectiveState } from '../../src/projection/project.js';
import { createReceipt } from '../../src/registration/receipt.js';
import { reportOutcome, validationDisclosureLines } from './registration.js';
import { appendAndReportReceipt } from './journal.js';
import { uiText } from './ui-strings.js';
import { quoteTerminalText } from './terminal-presentation.js';
import { openTransactionSheet, type TransactionSheetModel } from './transaction-sheet.js';

function quote(value: string): string {
  return quoteTerminalText(value);
}

/** One row of the inherited-Global listing shown before creating an override. */
export interface InheritedRecordRow {
  label: string;
  kind: OverrideKind;
  targetId: string;
  /** true when a Project Scope Override currently suppresses this record. */
  suppressedByOverride: boolean;
  /** true when an enabled project Installation supersedes this record by precedence. */
  supersededByProject: boolean;
  selectable: boolean;
}

/**
 * Build the inherited Global Scope listing: every global Registration and enabled global
 * Installation annotated with why it is not participating in Effective State.
 */
export function inheritedRecordRows(
  global: BridgeState,
  project: BridgeState,
  projectTrusted: boolean,
): InheritedRecordRow[] {
  const effective = computeEffectiveState(global, project, { projectTrusted });
  const suppressedKinds = new Map(effective.suppressed.map((item) => [`${item.kind}/${item.targetId}`, item.reason]));
  const rows: InheritedRecordRow[] = [];
  for (const registration of global.registrations) {
    const reason = suppressedKinds.get(`registration/${registration.id}`);
    rows.push({
      kind: 'registration',
      targetId: registration.id,
      label: `${quote(registration.alias ?? registration.marketplaceName ?? registration.id)} · Registration ${registration.id.slice(0, 8)}…${
        reason === 'scope-override-registration' ? uiText('ovr.suppressed.subtree') : ''
      }`,
      suppressedByOverride: reason === 'scope-override-registration',
      supersededByProject: false,
      selectable: true,
    });
  }
  for (const installation of global.installations) {
    if (installation.installationState !== 'enabled') continue; // disabled never participates
    const reason = suppressedKinds.get(`installation/${installation.id}`);
    rows.push({
      kind: 'installation',
      targetId: installation.id,
      label: `${quote(installation.manifestName ?? installation.pluginId)} · Installation ${installation.id.slice(0, 8)}…${
        reason === 'scope-override-installation' ? uiText('ovr.suppressed.single')
          : reason === 'scope-override-registration' ? uiText('ovr.suppressed.byRegistration')
            : reason === 'project-precedence' ? uiText('ovr.supersededByProject') : ''
      }`,
      suppressedByOverride: reason === 'scope-override-installation' || reason === 'scope-override-registration',
      supersededByProject: reason === 'project-precedence',
      selectable: true,
    });
  }
  return rows;
}

/** Compact multi-line summary of one projection result for disclosure / notification. */
export function formatProjectionSummary(state: EffectiveState, plugins: ReturnType<typeof projectEffectiveState>['plugins'], findings: ReturnType<typeof projectEffectiveState>['findings']): string {
  const lines = [
    uiText('ovr.projection.header', {
      registrations: state.registrations.length,
      installations: state.installations.length,
    }),
    ...state.suppressed.map((item) => uiText('ovr.projection.suppressed', {
      kind: item.kind,
      targetId: `${item.targetId.slice(0, 8)}…`,
      reason: item.reason,
    })),
  ];
  if (plugins.length === 0) lines.push(uiText('ovr.projection.noPlugins'));
  for (const plugin of plugins) {
    lines.push(`▸ ${quote(plugin.pluginId)} · ${plugin.sourceScope}`);
    for (const skill of plugin.skills) {
      lines.push('    ' + uiText('ovr.projection.skill', {
        name: quote(skill.name),
        status: skill.status === 'projected'
          ? uiText('ovr.projection.skillProjected')
          : uiText('ovr.projection.skillUnavailable'),
        availability: skill.availability,
      }));
    }
  }
  if (findings.length > 0) {
    lines.push(uiText('ovr.projection.findings', {
      findings: findings.map((f) => `${f.classification} ${f.code}`).join(' | '),
    }));
  }
  return lines.join('\n');
}

async function readBoth(ctx: { cwd?: string; agentDir?: string }): Promise<{ ok: boolean; global?: BridgeState; project?: BridgeState; error?: string }> {
  const opts = { cwd: ctx.cwd, agentDir: ctx.agentDir };
  const [globalRead, projectRead] = await Promise.all([readBridgeState('global', opts), readBridgeState('project', opts)]);
  const bad = [globalRead, projectRead].find((read) => read.status !== 'ok' && read.status !== 'missing');
  if (bad) return { ok: false, error: bad.error ?? 'Bridge State is not readable (Persistence Indeterminate)' };
  return { ok: true, global: globalRead.state!, project: projectRead.state! };
}

export interface ScopeOverrideTarget {
  targetKind?: OverrideKind;
  targetId?: string;
  expectedStateRevision?: string;
}

async function showTransactionStep(ctx: ExtensionCommandContext, model: TransactionSheetModel): Promise<boolean> {
  return await openTransactionSheet(ctx, model) === 'continue';
}

async function reportDeclinedOverride(
  ctx: ExtensionCommandContext,
  model: Omit<TransactionSheetModel, 'step'> & { authority: 'project'; stateRevision: string },
): Promise<void> {
  const receipt = createReceipt({
    operation: model.actionLabel,
    scope: 'project',
    trigger: `declined ${model.actionLabel} ${model.target ?? ''}`,
    expectedStateRevision: model.stateRevision,
    summary: 'Declined',
    stateChanged: false,
  });
  await appendAndReportReceipt(ctx, receipt);
}

async function pickInheritedRow(
  ui: ExtensionUIContext,
  rows: InheritedRecordRow[],
  target: ScopeOverrideTarget,
): Promise<InheritedRecordRow | undefined> {
  if (target.targetId) {
    return rows.find((row) =>
      row.targetId === target.targetId && (!target.targetKind || row.kind === target.targetKind));
  }
  const candidates = target.targetKind ? rows.filter((row) => row.kind === target.targetKind) : rows;
  const labels = candidates.map((row) => `${row.label} · ${quote(row.targetId)}`);
  const chosen = await ui.select(uiText('ovr.select.create'), labels);
  if (!chosen) return undefined;
  return candidates[labels.indexOf(chosen)];
}

async function pickExistingOverride(
  ui: ExtensionUIContext,
  overrides: BridgeState['scopeOverrides'],
  target: ScopeOverrideTarget,
): Promise<BridgeState['scopeOverrides'][number] | undefined> {
  if (target.targetId) {
    return overrides.find((item) =>
      item.targetId === target.targetId && (!target.targetKind || item.kind === target.targetKind));
  }
  const candidates = target.targetKind ? overrides.filter((item) => item.kind === target.targetKind) : overrides;
  const labels = candidates.map((item) => uiText('ovr.pick.existing', { kind: item.kind, targetId: quote(item.targetId) }));
  const chosen = await ui.select(uiText('ovr.select.remove'), labels);
  if (!chosen) return undefined;
  return candidates[labels.indexOf(chosen)];
}

/** Create fine-grained Scope Overrides against inherited Global registrations / installations. */
export async function runScopeOverrideFlow(
  ctx: ExtensionCommandContext,
  target: ScopeOverrideTarget = {},
): Promise<void> {
  const ui: ExtensionUIContext = ctx.ui;
  const docs = await readBoth({ cwd: ctx.cwd });
  if (!docs.ok) {
    return void ui.notify(uiText('common.bridgeState.unreadable', { error: quote(docs.error ?? 'Persistence Indeterminate') }), 'error');
  }
  const expectedStateRevision = target.expectedStateRevision ?? docs.project!.stateRevision;
  const opts = {
    cwd: ctx.cwd,
    agentDir: undefined,
    projectTrusted: ctx.isProjectTrusted(),
    expectedStateRevision,
  };

  const rows = inheritedRecordRows(docs.global!, docs.project!, ctx.isProjectTrusted());
  const row = await pickInheritedRow(ui, rows, target);
  if (!row) return void ui.notify(uiText('ovr.notFound.inherited'), 'warning');

  const model = {
    actionLabel: uiText('ovr.create.actionLabel'),
    authority: 'project' as const,
    target: row.targetId,
    stateRevision: expectedStateRevision,
  } satisfies Omit<TransactionSheetModel, 'step'>;
  if (!await showTransactionStep(ctx, {
    ...model,
    step: 'Intent',
    details: [uiText('ovr.create.intent', { kind: row.kind })],
  })) return void await reportDeclinedOverride(ctx, model);

  if (!await showTransactionStep(ctx, {
    ...model,
    step: 'Validation',
    details: [
      ...validationDisclosureLines([]),
      uiText('ovr.create.targetKind', { kind: row.kind }),
      uiText('ovr.create.targetId', { targetId: quote(row.targetId) }),
      uiText('ovr.create.alreadySuppressed', {
        value: row.suppressedByOverride ? uiText('common.yes') : uiText('common.no'),
      }),
      uiText('ovr.create.trustObserved', {
        value: ctx.isProjectTrusted() ? uiText('ovr.create.trust.granted') : uiText('ovr.create.trust.notGranted'),
      }),
    ],
  })) return void await reportDeclinedOverride(ctx, model);

  const cascade = row.kind === 'registration'
    ? uiText('ovr.create.cascade.registration')
    : uiText('ovr.create.cascade.installation');
  if (!await showTransactionStep(ctx, {
    ...model,
    step: 'Consent',
    details: [uiText('ovr.create.consent.details')],
  })) return void await reportDeclinedOverride(ctx, model);
  const confirmed = await ui.confirm(
    uiText('ovr.create.consent.title'),
    uiText('ovr.create.consent.body', {
      kind: row.kind,
      targetId: quote(row.targetId),
      cascade,
    }),
  );
  if (!confirmed) return void await reportDeclinedOverride(ctx, model);

  if (!await showTransactionStep(ctx, {
    ...model,
    step: 'Plan',
    details: [uiText(row.kind === 'registration' ? 'ovr.create.plan.registration' : 'ovr.create.plan.installation')],
  })) return void await reportDeclinedOverride(ctx, model);
  if (!await showTransactionStep(ctx, {
    ...model,
    step: 'Commit',
    details: [uiText('ovr.create.commit')],
  })) return void await reportDeclinedOverride(ctx, model);

  const outcome = await createScopeOverride(row.kind, row.targetId, opts);
  await reportOutcome(ctx, outcome);
}

/** Remove existing Scope Overrides; inheritance restores immediately via recomputation. */
export async function runRemoveScopeOverrideFlow(
  ctx: ExtensionCommandContext,
  targetOptions: ScopeOverrideTarget = {},
): Promise<void> {
  const ui: ExtensionUIContext = ctx.ui;
  const docs = await readBoth({ cwd: ctx.cwd });
  if (!docs.ok) {
    return void ui.notify(uiText('common.bridgeState.unreadable', { error: quote(docs.error ?? 'Persistence Indeterminate') }), 'error');
  }
  const expectedStateRevision = targetOptions.expectedStateRevision ?? docs.project!.stateRevision;
  const opts = {
    cwd: ctx.cwd,
    agentDir: undefined,
    projectTrusted: ctx.isProjectTrusted(),
    expectedStateRevision,
  };
  const overrides = docs.project!.scopeOverrides;
  if (overrides.length === 0) return void ui.notify(uiText('ovr.none'), 'info');

  const target = await pickExistingOverride(ui, overrides, targetOptions);
  if (!target) return void ui.notify(uiText('ovr.notFound.override'), 'warning');

  const model = {
    actionLabel: uiText('ovr.remove.actionLabel'),
    authority: 'project' as const,
    target: target.targetId,
    stateRevision: expectedStateRevision,
  } satisfies Omit<TransactionSheetModel, 'step'>;
  if (!await showTransactionStep(ctx, {
    ...model,
    step: 'Intent',
    details: [uiText('ovr.remove.intent', { kind: target.kind })],
  })) return void await reportDeclinedOverride(ctx, model);
  if (!await showTransactionStep(ctx, {
    ...model,
    step: 'Validation',
    details: [
      ...validationDisclosureLines([]),
      uiText('ovr.create.targetKind', { kind: target.kind }),
      uiText('ovr.create.targetId', { targetId: quote(target.targetId) }),
      uiText('ovr.create.trustObserved', {
        value: ctx.isProjectTrusted() ? uiText('ovr.create.trust.granted') : uiText('ovr.create.trust.notGranted'),
      }),
    ],
  })) return void await reportDeclinedOverride(ctx, model);

  if (!await showTransactionStep(ctx, {
    ...model,
    step: 'Consent',
    details: [uiText('ovr.remove.consent.details')],
  })) return void await reportDeclinedOverride(ctx, model);
  const confirmed = await ui.confirm(
    uiText('ovr.remove.consent.title'),
    uiText('ovr.remove.consent.body', { kind: target.kind }),
  );
  if (!confirmed) return void await reportDeclinedOverride(ctx, model);

  if (!await showTransactionStep(ctx, {
    ...model,
    step: 'Plan',
    details: [uiText('ovr.remove.plan')],
  })) return void await reportDeclinedOverride(ctx, model);
  if (!await showTransactionStep(ctx, {
    ...model,
    step: 'Commit',
    details: [uiText('ovr.create.commit')],
  })) return void await reportDeclinedOverride(ctx, model);

  const outcome = await removeScopeOverride(target.kind, target.targetId, opts);
  await reportOutcome(ctx, outcome);
}

/** Read-only Effective State + Projected Skills / collision diagnostics view. */
export async function runEffectiveStateView(ctx: ExtensionCommandContext): Promise<void> {
  const ui: ExtensionUIContext = ctx.ui;
  const trusted = ctx.isProjectTrusted();
  const docs = await readBoth({ cwd: ctx.cwd });
  if (!docs.ok) {
    return void ui.notify(uiText('common.bridgeState.unreadable', { error: quote(docs.error ?? 'Persistence Indeterminate') }), 'error');
  }
  const effective = computeEffectiveState(docs.global!, docs.project!, { projectTrusted: trusted });
  const projection = projectEffectiveState(docs.global!, docs.project!, { projectTrusted: trusted });
  const trustNote = trusted ? '' : uiText('ovr.projection.trustNote');
  ui.notify(
    `${formatProjectionSummary(effective, projection.plugins, projection.findings)}${trustNote}${uiText('ovr.projection.availableNote')}`,
    projection.findings.length > 0 ? 'warning' : 'info',
  );
}
