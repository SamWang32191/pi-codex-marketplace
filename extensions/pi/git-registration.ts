/**
 * Git Marketplace Registration — interactive TUI flow (Issue #18).
 * Mirrors local registration contract: Git locator + Git Selector
 * → normalization (Canonical Locator + selector canonical) + Acquisition Trust Base + snapshot
 * → Validation Disclosure → Registration Confirmation (Snapshot+Revision bound, Default No) → atomic commit → Attempt Receipt.
 *
 * Global-only (#61): the flow acts on the single Global document only.
 *
 * All user-visible strings come from the centralized ui-strings module (Issue #41).
 */

import type { ExtensionCommandContext, ExtensionUIContext } from '@earendil-works/pi-coding-agent';

import {
  preflightGitRegistration,
  confirmGitRegistration,
  type GitRegistrationFlowOptions,
} from '../../src/registration/git-flow.js';
import type { GitSelectorInput } from '../../src/registration/git-selector.js';
import { marketplaceFormatText, uiText } from './ui-strings.js';
import {
  fullValidationDisclosureLines,
  reportOutcome,
  reportTerminalPreflightOutcome,
} from './registration.js';
import { quoteTerminalText } from './terminal-presentation.js';
import { openTransactionSheet, type TransactionSheetModel } from './transaction-sheet.js';

async function transactionStep(
  ctx: ExtensionCommandContext,
  model: TransactionSheetModel,
  cancel?: () => void | Promise<void>,
): Promise<boolean> {
  if (await openTransactionSheet(ctx, model) === 'continue') return true;
  if (cancel) await cancel();
  else ctx.ui.notify(uiText('common.cancelled.transaction'), 'info');
  return false;
}

/**
 * One interactive git registration flow invocation.
 * The optional flow options thread the Acquisition Trust Base seams (executor / trust / cache)
 * for tests and embedders; production callers rely on the real Git executor.
 */
export async function runGitRegistrationFlow(
  ctx: ExtensionCommandContext,
  flowOpts: Pick<GitRegistrationFlowOptions, 'executor' | 'trust' | 'cache'> = {},
): Promise<void> {
  const ui: ExtensionUIContext = ctx.ui;

  const locator = await ui.input(uiText('reg.git.locator.prompt'), 'https://github.com/owner/repo.git');
  if (!locator) {
    ui.notify(uiText('reg.git.cancelled'), 'info');
    return;
  }

  const selectorKinds = new Map<string, GitSelectorInput['kind']>([
    [uiText('reg.git.selector.default'), 'default'],
    [uiText('reg.git.selector.branch'), 'branch'],
    [uiText('reg.git.selector.tag'), 'tag'],
    [uiText('reg.git.selector.commit'), 'commit'],
  ]);
  const selectorKindChoice = await ui.select(uiText('reg.git.selector.prompt'), [...selectorKinds.keys()]);
  if (!selectorKindChoice) {
    ui.notify(uiText('reg.git.cancelled'), 'info');
    return;
  }
  const selectorKind = selectorKinds.get(selectorKindChoice);
  if (!selectorKind) return;
  let selectorInput: GitSelectorInput;
  if (selectorKind === 'default') {
    selectorInput = { kind: 'default' };
  } else if (selectorKind === 'branch') {
    const branch = await ui.input(uiText('reg.git.branch.prompt'), 'main');
    if (!branch) {
      ui.notify(uiText('reg.git.cancelled'), 'info');
      return;
    }
    selectorInput = { kind: 'branch', value: branch };
  } else if (selectorKind === 'tag') {
    const tag = await ui.input(uiText('reg.git.tag.prompt'), 'v1.0.0');
    if (!tag) {
      ui.notify(uiText('reg.git.cancelled'), 'info');
      return;
    }
    selectorInput = { kind: 'tag', value: tag };
  } else {
    const commit = await ui.input(uiText('reg.git.commit.prompt'), 'abc123def456abc123def456abc123def456abcd12');
    if (!commit) {
      ui.notify(uiText('reg.git.cancelled'), 'info');
      return;
    }
    selectorInput = { kind: 'commit', value: commit };
  }

  const actionLabel = 'Git Marketplace Registration';
  const intentTarget = `${locator}#${selectorInput.kind === 'default' ? 'default' : selectorInput.value}`;
  if (!await transactionStep(ctx, {
    step: 'Intent',
    actionLabel,
    authority: 'global',
    target: intentTarget,
    details: [
      uiText('reg.git.detail.locator', { locator: quoteTerminalText(locator) }),
      uiText('reg.git.detail.selectorValue', { selector: quoteTerminalText(selectorInput.kind === 'default' ? 'default' : selectorInput.value) }),
    ],
  })) return;

  const opts: GitRegistrationFlowOptions = { ...flowOpts };
  const res = await preflightGitRegistration(locator, selectorInput, opts);
  if (!res.ok) {
    await reportTerminalPreflightOutcome(ctx, res.outcome);
    return;
  }

  const pf = res.preflight;
  const validationDetails = [
    uiText('reg.detail.registrationId', { id: quoteTerminalText(pf.registrationId) }),
    uiText('reg.git.detail.canonicalLocator', { locator: quoteTerminalText(pf.locator.canonicalUrl) }),
    uiText('reg.git.detail.transport', { transport: quoteTerminalText(pf.locator.transport) }),
    uiText('reg.git.detail.host', { host: quoteTerminalText(pf.locator.host) }),
    uiText('reg.git.detail.port', { port: quoteTerminalText(pf.locator.port ?? `(${uiText('common.none')})`) }),
    uiText('reg.git.detail.path', { path: quoteTerminalText(pf.locator.path) }),
    uiText('reg.git.detail.user', { user: quoteTerminalText(pf.locator.user ?? `(${uiText('common.none')})`) }),
    uiText('reg.git.detail.selector', {
      kind: quoteTerminalText(pf.selector.kind),
      canonical: quoteTerminalText(pf.selector.canonical),
    }),
    uiText('reg.git.detail.resolvedRevision', { revision: quoteTerminalText(pf.resolvedRevision) }),
    uiText('reg.detail.marketplace', { name: quoteTerminalText(pf.marketplaceName) }),
    uiText('reg.detail.format', { format: marketplaceFormatText(pf.format) }),
    uiText('reg.detail.entries', {
      total: pf.catalog.entries.length,
      locatable: pf.catalog.entries.filter((entry) => entry.available).length,
      unavailable: pf.catalog.entries.filter((entry) => !entry.available).length,
    }),
    uiText('reg.detail.profile', { profile: quoteTerminalText(pf.snapshot.profile) }),
    uiText('reg.detail.ruleset', { ruleset: quoteTerminalText(pf.snapshot.ruleset) }),
    uiText('reg.detail.budget', { budget: quoteTerminalText(pf.snapshot.budget) }),
    uiText('reg.git.detail.acquisitionSafety'),
    ...fullValidationDisclosureLines(pf.findings),
    ...pf.catalog.entries.map((entry) =>
      uiText('reg.detail.entry', {
        entryId: quoteTerminalText(entry.entryId),
        name: quoteTerminalText(entry.name ?? `(${uiText('common.none')})`),
        status: entry.available
          ? uiText('reg.entry.locatable')
          : uiText('reg.entry.unavailable', { reason: quoteTerminalText(entry.unavailableReason ?? uiText('common.unavailable')) }),
      }),
    ),
  ];
  const boundModel = {
    actionLabel,
    authority: 'global' as const,
    target: pf.registrationId,
    stateRevision: pf.stateRevision,
    validationSnapshot: pf.snapshot.fingerprint,
  };
  const cancel = async () => {
    await reportOutcome(ctx, await confirmGitRegistration(pf, false, opts));
  };
  if (!await transactionStep(ctx, {
    ...boundModel,
    step: 'Validation',
    details: validationDetails,
  }, cancel)) return;
  if (!await transactionStep(ctx, {
    ...boundModel,
    step: 'Consent',
    details: [uiText('reg.consent.details')],
  }, cancel)) return;

  const yes = await ui.confirm(
    uiText('reg.consent.title'),
    uiText('reg.git.consent.body', {
      registrationId: quoteTerminalText(pf.registrationId),
      locator: quoteTerminalText(pf.locator.canonicalUrl),
      selector: quoteTerminalText(pf.selector.canonical),
      revision: pf.resolvedRevision.slice(0, 8),
      scope: 'global',
      disclosure: validationDetails.join('\n'),
    }),
  );

  if (yes) {
    if (!await transactionStep(ctx, {
      ...boundModel,
      step: 'Plan',
      details: [uiText('reg.plan.details')],
    }, cancel)) return;
    if (!await transactionStep(ctx, {
      ...boundModel,
      step: 'Commit',
      details: [
        uiText('reg.commit.persist', { id: quoteTerminalText(pf.registrationId) }),
        uiText('reg.commit.authority', { scope: 'global', revision: quoteTerminalText(pf.stateRevision) }),
      ],
    }, cancel)) return;
  }

  const outcome = await confirmGitRegistration(pf, yes, opts);
  await reportOutcome(ctx, outcome);
}
