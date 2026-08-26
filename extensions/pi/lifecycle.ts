/**
 * TUI flows for the #21 lifecycle: Marketplace Refresh → Update Candidate → Update Plan
 * Checklist → Apply Update, plus Registration Rebind and Registration / Installation Removal.
 *
 * All consent surfaces Default No and are bound to Validation Snapshot + State Revision by the
 * underlying src/lifecycle seams; this layer only collects explicit user outcomes and reports
 * Attempt Summary receipts. All user-visible strings come from the centralized ui-strings
 * module (Issue #41).
 */

import type { ExtensionCommandContext, ExtensionUIContext } from '@earendil-works/pi-coding-agent';

import { readBridgeState } from '../../src/bridge-state/store.js';
import type { Installation } from '../../src/bridge-state/types.js';
import { appendReceipt } from '../../src/journal/journal.js';
import {
  applyUpdate,
  preflightRebind,
  refreshRegistration,
  confirmRegistrationRemoval,
  confirmInstallationRemoval,
  preflightRegistrationRemoval,
  preflightInstallationRemoval,
  type LifecycleFlowOptions,
  type RebindTarget,
  type UpdateCandidate,
  type RegistrationRemovalPreflight,
  type InstallationRemovalPreflight,
} from '../../src/lifecycle/index.js';
import { buildUpdatePlan, compatibleCandidateIds, type InstallationChoice } from '../../src/lifecycle/update-plan.js';
import { createReceipt, type AttemptReceipt } from '../../src/registration/receipt.js';
import {
  fullValidationDisclosureLines,
  reportOutcome,
  validationDisclosureLines,
} from './registration.js';
import { attemptSummaryText, uiText } from './ui-strings.js';
import { quoteTerminalText } from './terminal-presentation.js';
import { openTransactionSheet, type TransactionSheetModel } from './transaction-sheet.js';

function quote(value: string): string {
  return quoteTerminalText(value);
}

/** Pure helper: per-installation choice options, 'update' only when a Compatible candidate exists. */
export function planChoicesFor(
  installations: Installation[],
  candidate: UpdateCandidate,
): { installation: Installation; options: { label: string; value: InstallationChoice; enabled: boolean }[] }[] {
  const compatible = compatibleCandidateIds(candidate);
  return installations.map((installation) => ({
    installation,
    options: [
      {
        label: uiText('life.plan.choice.update', {
          detail: compatible.has(installation.pluginId)
            ? uiText('life.plan.choice.update.compatible')
            : uiText('life.plan.choice.update.incompatible'),
        }),
        value: 'update',
        enabled: compatible.has(installation.pluginId),
      },
      { label: uiText('life.plan.choice.disable'), value: 'disable', enabled: true },
      { label: uiText('life.plan.choice.remove'), value: 'remove', enabled: true },
    ],
  }));
}

/** Pure helper: candidate disclosure summary for the checklist surface. */
export function candidateSummary(candidate: UpdateCandidate): string {
  const findings = [...new Map(
    [
      ...candidate.inspection.findings,
      ...candidate.inspection.entries.flatMap((entry) => entry.findings),
    ].map((finding) => [
      [
        finding.classification,
        finding.phase,
        finding.target,
        finding.pointer,
        finding.code,
        finding.rule,
        finding.outcome,
      ].join('\u001f'),
      finding,
    ]),
  ).values()];
  const lines = [
    uiText('life.candidate.registration', { id: `${candidate.registrationId.slice(0, 8)}…` }),
    uiText('reg.detail.marketplace', { name: quote(candidate.marketplaceName || `(${uiText('common.none')})`) }),
    uiText('life.candidate.newSnapshot', { snapshot: candidate.snapshot.fingerprint.slice(0, 16) }),
    uiText('life.candidate.recordedSnapshot', { snapshot: (candidate.recordedFingerprint ?? uiText('common.none')).slice(0, 16) }),
  ];
  if (candidate.resolvedRevision) {
    lines.push(uiText('life.candidate.resolvedRevision', {
      from: candidate.recordedResolvedRevision ?? uiText('common.none'),
      to: candidate.resolvedRevision,
    }));
  }
  const available = candidate.inspection.entries.filter((item) => item.plugin && !item.unavailableReason).length;
  lines.push(uiText('life.candidate.entries', { total: candidate.inspection.entries.length, available }));
  lines.push(...fullValidationDisclosureLines(findings));
  for (const entry of candidate.inspection.entries) {
    lines.push(`  ${quote(entry.entry.entryId)} ${entry.plugin ? `· ${quote(entry.plugin.manifestName)} ` : ''}— ${
      entry.unavailableReason
        ? uiText('common.unavailable') + `（${quote(entry.unavailableReason)}）`
        : uiText('inst.entry.available')
    }`);
  }
  return lines.join('\n');
}

export async function attemptReport(
  ctx: ExtensionCommandContext,
  outcome: { receipt: AttemptReceipt },
): Promise<void> {
  const journal = await appendReceipt(outcome.receipt);
  await reportOutcome(ctx, outcome);
  if (!journal.success) {
    ctx.ui.notify(uiText('journal.appendFailed', { error: quote(journal.error ?? uiText('common.unknown')) }), 'warning');
  }
}

async function showTransactionStep(ctx: ExtensionCommandContext, model: TransactionSheetModel): Promise<boolean> {
  return await openTransactionSheet(ctx, model) === 'continue';
}

function lifecycleOptions(_ctx: ExtensionCommandContext): LifecycleFlowOptions {
  return {};
}

async function pickRegistration(
  ctx: ExtensionCommandContext,
  registrationId?: string,
): Promise<{
  registrationId: string;
  stateRevision: string;
  validationSnapshot?: string;
  opts: LifecycleFlowOptions;
} | undefined> {
  const ui = ctx.ui;
  const opts = lifecycleOptions(ctx);
  const state = await readBridgeState(opts);
  if (state.status !== 'ok' && state.status !== 'missing') {
    ui.notify(uiText('common.bridgeState.unreadable', { error: quote(state.error ?? 'Persistence Indeterminate') }), 'error');
    return undefined;
  }
  const registrations = state.state?.registrations ?? [];
  if (registrationId) {
    return {
      registrationId,
      stateRevision: state.state?.stateRevision ?? '?',
      validationSnapshot: registrations.find((registration) => registration.id === registrationId)?.validationSnapshot,
      opts,
    };
  }
  if (registrations.length === 0) {
    ui.notify(uiText('common.registration.none'), 'info');
    return undefined;
  }
  const labels = registrations.map((r) => `${quote(r.alias ?? r.marketplaceName ?? r.id)} · ${r.sourceKind ?? '?'} · ${r.id}`);
  const chosen = await ui.select(uiText('life.pick.registration'), labels);
  if (!chosen) return undefined;
  const registration = registrations[labels.indexOf(chosen)]!;
  return {
    registrationId: registration.id,
    stateRevision: state.state!.stateRevision,
    validationSnapshot: registration.validationSnapshot,
    opts,
  };
}

/**
 * Localized presentation of the Registration Removal cascade disclosure.
 * Mirrors src/lifecycle/removal.ts disclosure content in the presentation language.
 */
export function localizedRegistrationRemovalDisclosure(pf: RegistrationRemovalPreflight): string {
  const lines = [
    pf.registrationSource
      ? uiText('life.removal.disclosure.registration', {
          id: `${pf.registrationId.slice(0, 8)}…`,
          source: quote(JSON.stringify(pf.registrationSource)),
        })
      : uiText('life.removal.disclosure.registration.noSource', { id: `${pf.registrationId.slice(0, 8)}…` }),
    uiText('life.removal.disclosure.revision', { revision: pf.stateRevision }),
    uiText('life.removal.disclosure.cascade', { count: pf.affectedInstallations.length }),
  ];
  for (const installation of pf.affectedInstallations) {
    lines.push('  ' + quote(JSON.stringify(installation.id)) + ' · ' +
      quote(JSON.stringify(installation.pluginId)) + ' · ' + installation.installationState);
  }
  return lines.join('\n');
}

/** Localized presentation of the Installation Removal disclosure. */
export function localizedInstallationRemovalDisclosure(pf: InstallationRemovalPreflight): string {
  const lines = [
    uiText('life.removal.disclosure.installationLine', {
      id: quote(JSON.stringify(pf.installation.id)),
      pluginId: quote(JSON.stringify(pf.installation.pluginId)),
      state: pf.installation.installationState,
    }),
    pf.registrationId
      ? uiText('life.removal.disclosure.retainedRegistration', { id: pf.registrationId.slice(0, 8) + '…' })
      : uiText('life.removal.disclosure.retainedNone'),
    uiText('life.removal.disclosure.revision', { revision: pf.stateRevision }),
  ];
  return lines.join('\n');
}

/**
 * Update Plan Checklist — collects fresh Registration Confirmation, one explicit outcome per
 * existing Installation, and an Activation Confirmation per enabled installation that remains
 * enabled. Submits only when the complete plan validates.
 */
export async function runUpdatePlanChecklist(
  ctx: ExtensionCommandContext,
  candidate: UpdateCandidate,
  stateRevision: string,
  kind: 'apply-update' | 'rebind',
  rebindSource?: Parameters<typeof buildUpdatePlan>[3] extends never ? never : NonNullable<Parameters<typeof buildUpdatePlan>[3]['rebindSource']>,
  transaction: { intentShown?: boolean } = {},
): Promise<void> {
  const ui = ctx.ui;
  const opts = lifecycleOptions(ctx);
  const state = await readBridgeState(opts);
  if (state.status !== 'ok' && state.status !== 'missing') {
    return void ui.notify(uiText('common.bridgeState.unreadable', { error: quote(state.error ?? 'Persistence Indeterminate') }), 'error');
  }

  // Strictly this Registration's own Installations — independent Registrations and
  // Installations are never combined into a batch (CONTEXT.md: Lifecycle Operation).
  const installations = (state.state?.installations ?? []).filter((i) => i.registrationId === candidate.registrationId);

  const actionLabel = kind === 'rebind' ? uiText('life.actionLabel.rebind') : uiText('life.actionLabel.applyUpdate');
  // Receipts store the canonical operation identity; display labels stay presentation-local.
  const operation = kind === 'rebind' ? 'Registration Rebind' : 'Apply Update';
  const commonModel = {
    actionLabel,
    authority: 'global',
    target: candidate.registrationId,
    stateRevision,
    validationSnapshot: candidate.snapshot.fingerprint,
  } satisfies Omit<TransactionSheetModel, 'step'>;

  const concludeWithoutCommit = async (
    summary: 'Declined' | 'Blocked',
    findings: AttemptReceipt['findings'] = [],
  ): Promise<void> => {
    await attemptReport(ctx, {
      receipt: createReceipt({
        operation,
        trigger: `${kind} ${candidate.registrationId}`,
        expectedStateRevision: stateRevision,
        validationSnapshot: candidate.snapshot.fingerprint,
        summary,
        findings,
        stateChanged: false,
      }),
    });
  };

  if (!transaction.intentShown && !await showTransactionStep(ctx, {
    ...commonModel,
    step: 'Intent',
    details: [kind === 'rebind'
      ? uiText('life.updatePlan.intent.rebind')
      : uiText('life.updatePlan.intent.apply')],
  })) {
    await concludeWithoutCommit('Declined');
    return;
  }

  if (!await showTransactionStep(ctx, {
    ...commonModel,
    step: 'Validation',
    details: candidateSummary(candidate).split('\n'),
  })) {
    await concludeWithoutCommit('Declined');
    return;
  }

  ui.notify(uiText('life.updatePlan.notifyDisclosure', { summary: candidateSummary(candidate) }), 'info');

  if (!await showTransactionStep(ctx, {
    ...commonModel,
    step: 'Consent',
    details: [uiText('life.updatePlan.consent.details')],
  })) {
    await concludeWithoutCommit('Declined');
    return;
  }

  // Fresh Registration Confirmation — Default No, bound to the candidate snapshot + revision.
  const registrationConfirmed = await ui.confirm(
    uiText('life.updatePlan.confirmRegistration.title'),
    uiText('life.updatePlan.confirmRegistration.body', { id: candidate.registrationId.slice(0, 8) }),
  );
  if (!registrationConfirmed) {
    await concludeWithoutCommit('Declined');
    return;
  }

  if (!await showTransactionStep(ctx, {
    ...commonModel,
    step: 'Plan',
    details: [uiText('life.updatePlan.plan.details', { count: installations.length })],
  })) {
    await concludeWithoutCommit('Declined');
    return;
  }

  // One explicit outcome per existing Installation — never batched, no default.
  const choices: Record<string, InstallationChoice> = {};
  const activationConfirmations: Record<string, boolean> = {};
  for (const { installation, options } of planChoicesFor(installations, candidate)) {
    const selectable = options.filter((o) => o.enabled);
    const picked = await ui.select(
      uiText('life.updatePlan.pick.title', {
        name: quote(installation.manifestName ?? installation.pluginId),
        state: installation.installationState,
      }),
      selectable.map((o) => o.label),
    );
    if (!picked) {
      await concludeWithoutCommit('Declined');
      return;
    }
    choices[installation.id] = selectable.find((o) => o.label === picked)!.value;
  }

  // Activation Confirmation per enabled installation that remains enabled — Default No.
  for (const installation of installations) {
    const willStayEnabled = installation.installationState === 'enabled' && choices[installation.id] === 'update';
    if (!willStayEnabled) continue;
    const confirmed = await ui.confirm(
      uiText('life.updatePlan.activation.title'),
      uiText('life.updatePlan.activation.body', { name: quote(installation.manifestName ?? installation.pluginId) }),
    );
    activationConfirmations[installation.id] = confirmed;
    if (!confirmed) {
      await concludeWithoutCommit('Declined');
      return;
    }
  }

  const plan = buildUpdatePlan(candidate, installations, stateRevision, {
    registrationConfirmed,
    kind,
    rebindSource,
    choices,
    activationConfirmations,
  });
  if (!plan.ok) {
    await concludeWithoutCommit('Blocked', plan.problems);
    return;
  }

  // Final checklist review before the single atomic commit.
  const checklist = plan.plan.entries
    .map((entry) => uiText('life.updatePlan.checklist.entry', {
      installationId: `${entry.installationId.slice(0, 16)}…`,
      choice: entry.choice,
      state: entry.choice === 'update' ? `（${entry.installationState}）` : '',
    }))
    .join('\n');

  if (!await showTransactionStep(ctx, {
    ...commonModel,
    step: 'Commit',
    details: [
      uiText('life.updatePlan.commit.details'),
      ...(checklist ? checklist.split('\n') : [uiText('life.updatePlan.commit.noConsequences')]),
    ],
  })) {
    await concludeWithoutCommit('Declined');
    return;
  }

  const proceed = await ui.confirm(
    kind === 'rebind' ? uiText('life.updatePlan.commit.confirm.rebind.title') : uiText('life.updatePlan.commit.confirm.apply.title'),
    uiText('life.updatePlan.commit.confirm.body', {
      checklist: checklist || uiText('life.updatePlan.commit.confirm.empty'),
    }),
  );
  if (!proceed) {
    await concludeWithoutCommit('Declined');
    return;
  }

  await attemptReport(ctx, await applyUpdate(plan.plan, opts));
}

/** Marketplace Refresh on a single Registration — non-mutating; produces an Update Candidate or reports no change. */
export async function runRefreshFlow(
  ctx: ExtensionCommandContext,
  target: { registrationId?: string } = {},
): Promise<void> {
  const ui = ctx.ui;
  const picked = await pickRegistration(ctx, target.registrationId);
  if (!picked) return;

  const model = {
    actionLabel: uiText('life.actionLabel.refresh'),
    authority: 'global',
    target: picked.registrationId,
    stateRevision: picked.stateRevision,
    validationSnapshot: picked.validationSnapshot,
  } satisfies Omit<TransactionSheetModel, 'step'>;
  if (!await showTransactionStep(ctx, {
    ...model,
    step: 'Intent',
    details: [
      uiText('life.refresh.intent.inspectionOnly'),
      uiText('life.refresh.intent.noWrite'),
    ],
  })) return;

  const outcome = await refreshRegistration(picked.registrationId, picked.opts);
  const validationDetails = outcome.status === 'update-candidate'
    ? candidateSummary(outcome.candidate).split('\n')
    : [
        uiText('life.refresh.outcome', { status: outcome.status }),
        ...fullValidationDisclosureLines(outcome.receipt.findings),
      ];
  const validationContinued = await showTransactionStep(ctx, {
    ...model,
    stateRevision: outcome.receipt.expectedStateRevision,
    validationSnapshot: outcome.receipt.validationSnapshot,
    step: 'Validation',
    details: validationDetails,
  });
  await attemptReport(ctx, outcome);
  if (!validationContinued) return;
  if (outcome.status === 'no-change') {
    return;
  }
  if (outcome.status === 'blocked') {
    return;
  }
  ui.notify(uiText('life.refresh.candidateReady'), 'info');
  // Bind the plan to the exact State Revision the candidate was validated against.
  await runUpdatePlanChecklist(ctx, outcome.candidate, outcome.candidate.stateRevision, 'apply-update');
}

/** Registration Rebind — replace locator/selector under the preserved Registration ID. */
export async function runRebindFlow(
  ctx: ExtensionCommandContext,
  targetOptions: { registrationId?: string } = {},
): Promise<void> {
  const ui = ctx.ui;
  const picked = await pickRegistration(ctx, targetOptions.registrationId);
  if (!picked) return;

  if (!await showTransactionStep(ctx, {
    step: 'Intent',
    actionLabel: uiText('life.actionLabel.rebind'),
    authority: 'global',
    target: picked.registrationId,
    details: [uiText('life.rebind.intent.details')],
  })) return;

  const sourceKinds = new Map<string, RebindTarget['kind']>([
    [uiText('life.rebind.sourceKind.local'), 'local'],
    [uiText('life.rebind.sourceKind.git'), 'git'],
  ]);
  const kindChoice = await ui.select(uiText('life.rebind.sourceKind.prompt'), [...sourceKinds.keys()]);
  if (!kindChoice) return;
  const sourceKind = sourceKinds.get(kindChoice);
  if (!sourceKind) return;

  let target: RebindTarget;
  if (sourceKind === 'local') {
    const rootPath = await ui.input(uiText('life.rebind.localRoot.prompt'), '/path/to/marketplace');
    if (!rootPath) return void ui.notify(uiText('life.rebind.cancelled'), 'info');
    target = { kind: 'local', rootPath };
  } else {
    const locator = await ui.input(uiText('life.rebind.locator.prompt'), 'https://github.com/owner/repo.git');
    if (!locator) return void ui.notify(uiText('life.rebind.cancelled'), 'info');
    const selectorKind = await ui.select(uiText('life.rebind.selectorKind.prompt'), ['default', 'branch', 'tag', 'commit']);
    if (!selectorKind) return void ui.notify(uiText('life.rebind.cancelled'), 'info');
    let selector: Extract<RebindTarget, { kind: 'git' }>['selector'] = 'default';
    if (selectorKind === 'branch' || selectorKind === 'tag' || selectorKind === 'commit') {
      const placeholder = selectorKind === 'commit'
        ? uiText('life.rebind.selectorPlaceholder.commit')
        : selectorKind === 'tag' ? uiText('life.rebind.selectorPlaceholder.tag') : uiText('life.rebind.selectorPlaceholder.branch');
      const value = await ui.input(uiText('life.rebind.selectorValue.prompt', { kind: selectorKind, placeholder }), placeholder);
      if (!value) return void ui.notify(uiText('life.rebind.cancelled'), 'info');
      selector = { kind: selectorKind, value };
    }
    target = { kind: 'git', locator, selector };
  }

  const pf = await preflightRebind(picked.registrationId, target, picked.opts);
  if (!pf.ok) {
    await showTransactionStep(ctx, {
      step: 'Validation',
      actionLabel: uiText('life.actionLabel.rebind'),
      authority: 'global',
      target: picked.registrationId,
      stateRevision: pf.outcome.receipt.expectedStateRevision,
      validationSnapshot: pf.outcome.receipt.validationSnapshot,
      details: fullValidationDisclosureLines(pf.outcome.receipt.findings),
    });
    await attemptReport(ctx, pf.outcome);
    return;
  }
  ui.notify(uiText('life.rebind.revalidated'), 'info');
  // Rebind binds to the revision observed while validating the replacement source.
  await runUpdatePlanChecklist(
    ctx,
    pf.preflight.candidate,
    pf.preflight.stateRevision,
    'rebind',
    pf.preflight.rebindSource,
    { intentShown: true },
  );
}

/** Removal flows with full cascade disclosure, Default No. */
export async function runRemovalFlow(
  ctx: ExtensionCommandContext,
  target: {
    targetKind?: 'registration' | 'installation';
    targetId?: string;
  } = {},
): Promise<void> {
  const ui = ctx.ui;
  const opts: { agentDir?: string } = {};
  let targetKind = target.targetKind;

  if (!targetKind && target.targetId) {
    const state = await readBridgeState(opts);
    if (state.status !== 'ok' && state.status !== 'missing') {
      return void ui.notify(uiText('common.bridgeState.unreadable', { error: quote(state.error ?? 'Persistence Indeterminate') }), 'error');
    }
    if (state.state?.registrations.some((registration) => registration.id === target.targetId)) targetKind = 'registration';
    if (state.state?.installations.some((installation) => installation.id === target.targetId)) targetKind = 'installation';
    if (!targetKind) return void ui.notify(uiText('life.removal.notFound', { targetId: quote(target.targetId) }), 'warning');
  }

  if (!targetKind) {
    const removalKinds = new Map<string, 'registration' | 'installation'>([
      [uiText('life.removal.kind.registration'), 'registration'],
      [uiText('life.removal.kind.installation'), 'installation'],
    ]);
    const what = await ui.select(uiText('life.removal.pick.kind'), [...removalKinds.keys()]);
    if (!what) return;
    targetKind = removalKinds.get(what);
    if (!targetKind) return;
  }

  if (targetKind === 'registration') {
    const picked = await pickRegistration(ctx, target.targetId);
    if (!picked) return;

    const model = {
      actionLabel: uiText('life.actionLabel.registrationRemoval'),
      authority: 'global',
      target: picked.registrationId,
    } satisfies Omit<TransactionSheetModel, 'step'>;
    if (!await showTransactionStep(ctx, {
      ...model,
      step: 'Intent',
      details: [uiText('life.removal.reg.intent')],
    })) return;

    const pf = await preflightRegistrationRemoval(picked.registrationId, opts);
    if (!pf.ok) {
      await showTransactionStep(ctx, {
        ...model,
        step: 'Validation',
        stateRevision: pf.outcome.receipt.expectedStateRevision,
        details: fullValidationDisclosureLines(pf.outcome.receipt.findings),
      });
      await attemptReport(ctx, pf.outcome);
      return;
    }

    const boundModel = { ...model, stateRevision: pf.preflight.stateRevision };
    const decline = async (): Promise<void> => {
      await attemptReport(ctx, await confirmRegistrationRemoval(pf.preflight, false, opts));
    };
    if (!await showTransactionStep(ctx, {
      ...boundModel,
      step: 'Validation',
      details: [
        ...validationDisclosureLines([]),
        ...localizedRegistrationRemovalDisclosure(pf.preflight).split('\n'),
      ],
    })) return decline();
    if (!await showTransactionStep(ctx, {
      ...boundModel,
      step: 'Consent',
      details: [uiText('life.removal.reg.consent.details')],
    })) return decline();
    const proceed = await ui.confirm(
      uiText('life.removal.reg.consent.title'),
      quote(localizedRegistrationRemovalDisclosure(pf.preflight)),
    );
    if (!proceed) return decline();
    if (!await showTransactionStep(ctx, {
      ...boundModel,
      step: 'Plan',
      details: localizedRegistrationRemovalDisclosure(pf.preflight).split('\n'),
    })) return decline();
    if (!await showTransactionStep(ctx, {
      ...boundModel,
      step: 'Commit',
      details: [uiText('life.removal.reg.commit')],
    })) return decline();
    await attemptReport(ctx, await confirmRegistrationRemoval(pf.preflight, true, opts));
    return;
  }

  let installationId = target.targetId;
  if (!installationId) {
    const state = await readBridgeState(opts);
    if (state.status !== 'ok' && state.status !== 'missing') {
      return void ui.notify(uiText('common.bridgeState.unreadable', { error: quote(state.error ?? 'Persistence Indeterminate') }), 'error');
    }
    const installations = state.state?.installations ?? [];
    if (installations.length === 0) return void ui.notify(uiText('common.installation.none'), 'info');
    const labels = installations.map((installation) =>
      `${quote(installation.manifestName ?? installation.pluginId)} · ${installation.installationState} · ${quote(installation.id)}`);
    const chosen = await ui.select(uiText('life.removal.pick.installation'), labels);
    if (!chosen) return;
    installationId = installations[labels.indexOf(chosen)]!.id;
  }

  const model = {
    actionLabel: uiText('life.actionLabel.installationRemoval'),
    authority: 'global',
    target: installationId,
  } satisfies Omit<TransactionSheetModel, 'step'>;
  if (!await showTransactionStep(ctx, {
    ...model,
    step: 'Intent',
    details: [uiText('life.removal.inst.intent')],
  })) return;

  const pf = await preflightInstallationRemoval(installationId, opts);
  if (!pf.ok) {
    await showTransactionStep(ctx, {
      ...model,
      step: 'Validation',
      stateRevision: pf.outcome.receipt.expectedStateRevision,
      details: fullValidationDisclosureLines(pf.outcome.receipt.findings),
    });
    await attemptReport(ctx, pf.outcome);
    return;
  }
  const boundModel = { ...model, stateRevision: pf.preflight.stateRevision };
  const decline = async (): Promise<void> => {
    await attemptReport(ctx, await confirmInstallationRemoval(pf.preflight, false, opts));
  };
  if (!await showTransactionStep(ctx, {
    ...boundModel,
    step: 'Validation',
    details: [
      ...validationDisclosureLines([]),
      ...localizedInstallationRemovalDisclosure(pf.preflight).split('\n'),
    ],
  })) return decline();
  if (!await showTransactionStep(ctx, {
    ...boundModel,
    step: 'Consent',
    details: [uiText('life.removal.inst.consent.details')],
  })) return decline();
  const proceed = await ui.confirm(
    uiText('life.removal.inst.consent.title'),
    quote(localizedInstallationRemovalDisclosure(pf.preflight)),
  );
  if (!proceed) return decline();
  if (!await showTransactionStep(ctx, {
    ...boundModel,
    step: 'Plan',
    details: localizedInstallationRemovalDisclosure(pf.preflight).split('\n'),
  })) return decline();
  if (!await showTransactionStep(ctx, {
    ...boundModel,
    step: 'Commit',
    details: [uiText('life.removal.inst.commit')],
  })) return decline();
  await attemptReport(ctx, await confirmInstallationRemoval(pf.preflight, true, opts));
}
