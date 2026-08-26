/**
 * Centralized presentation-string module for the /codex-marketplace TUI (Issue #41).
 *
 * Every user-visible string on TUI surfaces is addressed by a stable message id and resolved
 * from the active locale dictionary (zh_TW). Components never hard-code display English;
 * remaining Latin text on screen is limited to canonical glossary terms, closed values,
 * rule codes, and target identities, exactly as required by Issue #41. The non-TUI
 * `list`/`inspect` plain-text output is explicitly out of scope and stays canonical English.
 *
 * Locale seam: switching dictionaries is intentionally out of scope, but the module
 * shape (locale-keyed dictionaries behind `uiText`) leaves that seam in place.
 *
 * Behavior rule: dispatch never matches on display strings. All intents remain
 * structured (LedgerActionIntent), and closed values are compared canonically.
 */

import type { AttemptSummary, RecoveryAction } from '../../src/registration/receipt.js';
import type { ValidationFinding } from '../../src/registration/findings.js';
import type { TransactionStep } from './transaction-sheet.js';

/** Supported presentation locales. Only zh_TW ships today; the seam stays explicit. */
export type UiLocale = 'zh-TW';

export const activeLocale: UiLocale = 'zh-TW';

/**
 * The zh_TW dictionary. Keys are stable message ids; values are zh_TW templates with
 * optional `{param}` placeholders filled by `uiText`.
 */
const zhTW = {
  // --- index.ts: command surface -------------------------------------------
  'cmd.description': '於 Global / Project Bridge Ledger 工作區管理 Codex Marketplace',
  'cmd.state.empty':
    '{scope}：空白（初始狀態）· schema v{version} · State Revision {revision} · Registration 0 · Installation 0',
  'cmd.state.ok':
    '{scope}：State Revision {revision} · Registration {registrations} · 啟用 Installation {enabled} / 停用 {disabled}',
  'cmd.state.incompatible': '{scope}：不相容 — {error}（需更新 Bridge Package）',
  'cmd.state.corrupted': '{scope}：Persistence Indeterminate（無法判定）— {error}（不自動回滾）',

  // --- common ---------------------------------------------------------------
  'common.yes': '是',
  'common.no': '否',
  'common.none': '無',
  'common.notApplicable': '不適用',
  'common.unavailable': 'unavailable（無法使用）',
  'common.unknown': '未知',
  'common.cancelled.transaction': '已取消 Transaction；Bridge State 未變更。',
  'common.bridgeState.unreadable': 'Bridge State 不可讀：{error}',
  'common.scope.global': 'Global Scope',
  'common.scope.project': 'Project Scope',
  'common.scope.word.global': 'Global',
  'common.scope.word.project': 'Project',
  'common.installation.none': '此 Scope 尚無 Installed Plugin。',
  'common.registration.none': '此 Scope 尚無 Marketplace Registration。',

  // --- closed-value glosses (canonical always rendered first) ---------------
  'summary.gloss.Completed': '完成',
  'summary.gloss.Completed with diagnostics': '完成但有診斷',
  'summary.gloss.Declined': '已婉拒',
  'summary.gloss.Blocked': '受阻',
  'summary.gloss.Rejected as Stale': '已拒絕（過期）',
  'summary.gloss.Persistence Failed': '持久化失敗',
  'summary.gloss.Persistence Indeterminate': '持久化無法判定',
  'summary.gloss.Pending Application': '待套用',
  'summary.badge.diagnostics': '有診斷',
  'summary.badge.declined': '已婉拒',
  'summary.badge.blocked': '受阻',
  'summary.badge.stale': '過期',
  'summary.badge.persistenceFailed': '持久失敗',
  'summary.badge.pending': '待套用',
  'recovery.gloss.Retry': '重試',
  'recovery.gloss.Revalidate': '重新驗證',
  'recovery.gloss.Refresh': '重新整理（Marketplace Refresh）',
  'recovery.gloss.Rebind': '重新綁定（Registration Rebind）',
  'recovery.gloss.Retry Application': '重試運行時套用',
  'recovery.gloss.Disable': '停用',
  'recovery.gloss.Remove': '移除',
  'recovery.gloss.Repair State': '修復 Bridge State',
  'recovery.gloss.Inspect': '檢視',
  'step.gloss.Intent': '意圖',
  'step.gloss.Validation': '驗證',
  'step.gloss.Consent': '同意確認',
  'step.gloss.Plan': '計畫',
  'step.gloss.Commit': '提交',
  'step.gloss.Receipt': '收據',
  'step.activeSuffix': '進行中',

  // --- verdict (validation disclosure headline) ------------------------------
  'verdict.label': '判定 Verdict',
  'verdict.gloss.Passed': '通過',
  'verdict.gloss.Passed with diagnostics': '通過但有診斷',
  'verdict.gloss.Blocked': '受阻',
  'findings.count.label': 'Findings',
  'findings.count.line': '{blocking} blocking · {warning} warning · {notice} notice',

  // --- finding rendering -----------------------------------------------------
  'finding.line':
    'finding 分類 {classification}｜階段 {phase}｜目標 {target}｜指標 {pointer}｜代碼 {code}｜規則 {rule}｜結果 {outcome}',

  // --- transaction-sheet.ts --------------------------------------------------
  'sheet.title': 'Transaction Sheet 交易單',
  'sheet.field.action': '動作',
  'sheet.field.authority': '授權範圍',
  'sheet.field.target': '目標',
  'sheet.field.detail': '詳情',
  'sheet.field.outcome': '結果',
  'sheet.field.expectedRevision': '預期 State Revision',
  'sheet.field.targetRevision': '目標 State Revision',
  'sheet.field.observedRevision': '觀察 State Revision',
  'sheet.field.stateChanged': 'State 是否變更',
  'sheet.axis.durable': 'Durable（持久層）',
  'sheet.axis.findings': 'Findings（診斷）',
  'sheet.axis.runtime': 'Runtime（運行時）',
  'sheet.field.count': '總數',
  'sheet.field.receipt': 'Receipt',
  'sheet.field.kind': '種類',
  'sheet.field.operation': '操作',
  'sheet.field.trigger': '觸發',
  'sheet.attemptSummary': 'Attempt Summary',
  'sheet.recoveryActions': 'Recovery Actions（復原動作）',
  'sheet.keys': 'Enter：繼續｜Esc/q/Ctrl-C：取消',
  'sheet.disclosure.expanded': '完整 Validation Disclosure 已展開（按 d 收合）',
  'sheet.disclosure.collapsed': '完整 Validation Disclosure 已收合（共 {count} 行；按 d 展開）',

  // --- bridge-ledger.ts: model ------------------------------------------------
  'ledger.title': 'CODEX MARKETPLACE / BRIDGE LEDGER',
  'ledger.section.observe.label': '總覽',
  'ledger.section.observe.description': '檢視授權分割區與衍生的 Effective State',
  'ledger.section.sources.label': '來源',
  'ledger.section.sources.description': 'Marketplace Registration 與來源生命週期操作',
  'ledger.section.plugins.label': 'Plugins',
  'ledger.section.plugins.description': '相容候選與 scope-local Installation 狀態',
  'ledger.section.recovery-receipts.label': '復原與收據',
  'ledger.section.recovery-receipts.description': '非權威的 Attempt Receipt 歷史與明確的 State Repair',

  'ledger.action.observe-partitions': '檢視授權分割區',
  'ledger.action.observe-effective-state': '檢視 Effective State 與 Projected Skills',
  'ledger.action.register-local': '註冊本地 Marketplace',
  'ledger.action.register-git': '註冊 Git Marketplace',
  'ledger.action.refresh-registration': 'Marketplace Refresh（重整來源）',
  'ledger.action.rebind-registration': 'Registration Rebind（重綁來源）',
  'ledger.action.remove-registration': '移除 Registration',
  'ledger.action.install-disabled': 'Install Disabled（安裝但停用）',
  'ledger.action.install-and-enable': 'Install and Enable（安裝並啟用）',
  'ledger.action.enable-installation': '啟用 Installation',
  'ledger.action.disable-installation': '停用 Installation',
  'ledger.action.remove-installation': '移除 Installation',
  'ledger.action.view-receipt-journal': '檢視 Receipt Journal',
  'ledger.action.repair-state': 'Repair State（修復 Bridge State）',
  'ledger.action.retry-application': 'Retry Application（重試運行時套用）',
  'ledger.action.inspect-receipt': '檢視 Attempt Receipt',

  'ledger.rail.health.healthy': '健康',
  'ledger.rail.health.healthyEmpty': '健康（空白初始狀態）',
  'ledger.rail.health.incompatible': '不相容：{error}',
  'ledger.rail.health.indeterminate': 'Persistence Indeterminate（無法判定）：{error}',
  'ledger.rail.trust.notApplicable': 'Project Trust：不適用',
  'ledger.rail.trust.granted': 'Project Trust：已授予',
  'ledger.rail.trust.notGranted': 'Project Trust：未授予',
  'ledger.badge.healthy': '健康',
  'ledger.badge.incompatible': '不相容',
  'ledger.badge.indeterminate': '無法判定',
  'ledger.badge.trustGranted': '信任已授予',
  'ledger.badge.noTrust': '未授予 Project Trust',
  'ledger.rail.revision': '{marker} State Revision {revision}',
  'ledger.rail.registrations': 'Registration {count}',
  'ledger.rail.installations': 'Installation 啟用 {enabled} / 停用 {disabled}',

  'ledger.availability.ready': '可用',
  'ledger.availability.blocked': '受阻',
  'ledger.disabledReason.trust': '未授予 Project Trust；Project Scope 變異不可用',
  'ledger.disabledReason.retryNoSnapshot':
    'Pending Application 未綁定 Validation Snapshot；請改以全新的已驗證 Lifecycle Intent 開始，而非重放此嘗試',
  'ledger.disabledReason.repairIneligible': 'State Repair 不適用於 {conditions}；請使用確切宣告的 Recovery Action',
  'ledger.disabledReason.repairNothing': 'State Repair 沒有符合資格的 Persistence Indeterminate 復原鏈，也沒有不可讀狀態',
  'ledger.disabledReason.incompatible': 'Bridge State schema 不相容：{error}；請更新 Bridge Package',
  'ledger.disabledReason.incompatibleMutation': 'Bridge State 不相容：{error}；變更前請先更新 Bridge Package',
  'ledger.disabledReason.corrupted': 'Persistence Indeterminate：{error}；請使用 Repair State',
  'ledger.disabledReason.corruptState': 'Bridge State 無法讀取',
  'ledger.condition.pending-application': 'Pending Application',
  'ledger.condition.persistence-failed': 'Persistence Failed',

  'ledger.row.registrationActions': '{scopeWord} Registration 操作',
  'ledger.row.registration.sourceUnknown': '未知來源',
  'ledger.row.registration.sourceUnavailable': '（來源不可讀）',
  'ledger.row.diagnostic.unavailable': 'Unavailable（無法使用）· {findings}',
  'ledger.row.diagnostic.noEntries': '未回報任何 Marketplace Entry',
  'ledger.row.skills.resources': '{name} {policy} 資源 {resources}',
  'ledger.row.skills.none': '技能：無',
  'ledger.row.skills.noResources': '無',
  'ledger.row.install.alreadyInstalled': '此 Marketplace Entry 在此 Scope 已有 Installation',
  'ledger.row.install.snapshotMissing': 'Validation Snapshot 不可用；請在來源檢驗後重新開啟 Plugins 分區',
  'ledger.row.install.classification': '{classification} Marketplace Entry',
  'ledger.row.retry.label': '{scopeWord} Pending Application',
  'ledger.row.retry.detail': '進行中的復原鏈 {receiptId} · State Revision {revision}',
  'ledger.row.observe.partitions': 'Global / Project 授權分割區',
  'ledger.row.observe.partitionsDetail': 'Global State Revision {global} · Project State Revision {project}',
  'ledger.row.observe.effective': 'Effective State 與 Projected Skills',
  'ledger.row.observe.effectiveDetail':
    'Registration {registrations} · Installation {installations} · 已抑制 {suppressed} · 已排除 {excluded}',
  'ledger.row.journal.label': '{scopeWord} Receipt Journal',
  'ledger.row.journal.detail': 'Receipt {receipts} · 進行中復原鏈 {chains} · 降級 {degraded}',
  'ledger.row.repair.label': '{scopeWord} State Repair',
  'ledger.revision.unavailable': '無法讀取',

  // --- bridge-ledger.ts: component chrome ------------------------------------
  'ledger.panel.navigation': '導覽',
  'ledger.panel.sections': '分區',
  'ledger.panel.help': '說明',
  'ledger.rows.empty': '此分區沒有任何列',
  'ledger.entry.unavailableRow': 'Unavailable（無法使用）· {label}',
  'ledger.entry.noFindings': '（未回報 findings）',
  'ledger.entry.blocked': '受阻：{reason}',
  'ledger.meta.target': '目標 {kind} {target}',
  'ledger.meta.scope': 'Scope {scope}',
  'ledger.meta.mode': '模式 {mode}',
  'ledger.meta.detail': '詳情 {detail}',
  'ledger.status.browsing': '狀態：瀏覽 {marker}｜{section}｜{pane}',
  'ledger.status.pane.actions': '動作',
  'ledger.status.pane.sections': '分區',
  'ledger.keys.help': '按鍵：?/Esc 關閉說明｜q/Ctrl-C 離開｜Esc/q 取消情境',
  'ledger.keys.drilldown': '按鍵：Esc/q 取消｜Enter 進入分區｜j/k 移動｜g/p 切換 Scope｜? 說明',
  'ledger.keys.wide': '按鍵：Esc/q 取消｜Enter 執行｜j/k 或方向鍵移動｜i 詳情｜g/p 切換 Scope｜? 說明',
  'ledger.help.move': 'Up/Down 或 j/k：移動選取',
  'ledger.help.sections': 'Left/Right：切換分區（寬版面）或進入下層',
  'ledger.help.enter': 'Enter：開啟分區或執行可用的結構化動作',
  'ledger.help.metadata': 'i：展開或收合所選項目的中繼資料',
  'ledger.help.browse': 'g/p：僅瀏覽 Global／Project；變異授權仍須明確選擇',
  'ledger.help.close': 'Esc：返回/取消｜q 或 Ctrl-C：離開｜？：關閉說明',

  // --- registration.ts / git-registration.ts ---------------------------------
  'reg.select.scope': 'Marketplace Registration — 選擇 Scope',
  'reg.select.scope.git': 'Marketplace Registration (Git) — 選擇 Scope',
  'reg.cancelled': '已取消 Registration',
  'reg.git.cancelled': '已取消 Git Registration',
  'reg.input.localRoot': '本地 Marketplace Root（需含 .agents/plugins/marketplace.json）',
  'reg.detail.registrationId': 'Registration ID {id}',
  'reg.detail.source': '來源 {source}',
  'reg.detail.marketplace': 'Marketplace {name}',
  'reg.detail.entries': 'Entries {total}（可定位 {locatable} / 無法定位 {unavailable}）',
  'reg.detail.profile': 'Compatibility Profile {profile}',
  'reg.detail.ruleset': 'Validation Ruleset {ruleset}',
  'reg.detail.budget': 'Validation Budget {budget}',
  'reg.detail.snapshotShort': 'Validation Snapshot：{snapshot}…',
  'reg.detail.entry': 'Entry {entryId} {name} {status}',
  'reg.entry.locatable': '可定位',
  'reg.entry.unavailable': '無法使用：{reason}',
  'reg.git.locator.prompt': 'Git Marketplace Locator（https:// 或 ssh:// 或 scp-like user@host:path，無憑證、無 query/fragment）',
  'reg.git.selector.prompt': 'Git Selector — 選擇型別',
  'reg.git.selector.default': 'default（跟隨遠端預設分支 HEAD）',
  'reg.git.selector.branch': 'branch（→ refs/heads/*）',
  'reg.git.selector.tag': 'tag（→ refs/tags/*）',
  'reg.git.selector.commit': 'commit（小寫完整 40/64 hex）',
  'reg.git.branch.prompt': 'Branch 名稱（例：main / feature/foo，將正規化為 refs/heads/<name>）',
  'reg.git.tag.prompt': 'Tag 名稱（例：v1.2.3，將正規化為 refs/tags/<name>）',
  'reg.git.commit.prompt': 'Commit（完整 40 或 64 hex，將轉為小寫）',
  'reg.git.detail.canonicalLocator': 'Canonical Git Locator {locator}',
  'reg.git.detail.locator': 'Locator {locator}',
  'reg.git.detail.selectorValue': 'Git Selector {selector}',
  'reg.git.detail.transport': 'Locator 傳輸 {transport}',
  'reg.git.detail.host': 'Locator 主機 {host}',
  'reg.git.detail.port': 'Locator 連接埠 {port}',
  'reg.git.detail.path': 'Locator 路徑 {path}',
  'reg.git.detail.user': 'Locator 使用者 {user}',
  'reg.git.detail.selector': 'Git Selector {kind} → {canonical}',
  'reg.git.detail.resolvedRevision': 'Resolved Revision {revision}',
  'reg.git.detail.acquisitionSafety':
    '取得安全：隔離且無憑證的 Git Source Acquisition；遠端控制的 hooks 與 submodules 一律不執行。',
  'reg.consent.details': 'Registration Confirmation：獨立的 Default No 宿主閘門',
  'reg.consent.title': 'Registration Confirmation — 預設 No（綁定 State Revision + Validation Snapshot，不可記憶、不可批次）',
  'reg.local.consent.body': '確認 Registration ID {registrationId}：{source} 至 {scope}？\nValidation Disclosure:\n{disclosure}',
  'reg.git.consent.body':
    '確認 Registration ID {registrationId}：{locator}#{selector}（{revision}…）至 {scope}？\nValidation Disclosure:\n{disclosure}',
  'reg.plan.details': 'Update Plan：不適用——新 Registration 沒有替換計畫',
  'reg.commit.persist': '寫入 Registration ID {id}',
  'reg.commit.authority': '於 {scope} 以 State Revision {revision} 寫入授權文件',
  'reg.outcome.notify': 'Attempt Summary：{summary} · Receipt {receiptId}',

  // --- installation.ts ---------------------------------------------------------
  'inst.select.scope': 'Plugin Installation — 選擇 Scope',
  'inst.select.installedScope': 'Installed Plugin — 選擇 Scope',
  'inst.select.registered': '選擇已註冊 Marketplace',
  'inst.select.installed': '選擇 Installed Plugin',
  'inst.select.entry': 'Marketplace Entries（顯示 Marketplace Entry ID 與可安裝/unavailable 原因）',
  'inst.select.path': '安裝路徑（Installation path）',
  'inst.path.disabled': 'Install Disabled（安裝但停用）',
  'inst.path.enabled': 'Install and Enable（安裝並啟用）',
  'inst.entry.unavailable': '此 Marketplace Entry 為 Unavailable，無法安裝。',
  'inst.choice.unavailable': '{name} — Unavailable（{reason}）',
  'inst.choice.available': '{id} · {name} — 可安裝',
  'inst.choice.readFailure': 'Marketplace Catalog 無法讀取',
  'inst.entry.available': '可安裝',
  'inst.entry.unavailableNotice': '此 Marketplace Entry 為 Unavailable，無法安裝。',
  'inst.actionLabel.disabled': 'Install Disabled（安裝但停用）',
  'inst.actionLabel.enabled': 'Install and Enable（安裝並啟用）',
  'inst.actionLabel.enablement': 'Plugin Enablement（啟用 Plugin）',
  'inst.actionLabel.disablement': 'Plugin Disablement（停用 Plugin）',
  'inst.disclosure.scope': 'Scope：{scope}',
  'inst.detail.registration': 'Registration {id}',
  'inst.detail.entryPointer': 'Marketplace Entry {pointer}',
  'inst.detail.targetState': '目標狀態 {state}',
  'inst.detail.requestedState': '要求狀態 {state}',
  'inst.detail.currentState': '目前狀態 {state}',
  'inst.detail.installation': 'Installation {id}',
  'inst.notFound.registration': '找不到 Marketplace Registration {id}。',
  'inst.notFound.installation': '找不到 Installed Plugin {id}。',
  'inst.disclosure.plugin': 'Plugin：{name}（{id}）',
  'inst.disclosure.source': '來源 {source}',
  'inst.disclosure.marketplaceEntry': 'Marketplace Entry：{entryId}',
  'inst.disclosure.classification': '分類：Compatible',
  'inst.disclosure.precedence': '投影優先序：Pi → Project Scope → Global Scope',
  'inst.disclosure.skills': 'Skills：{count}',
  'inst.disclosure.skill': '{name} · {policy} · resources：{resources}',
  'inst.disclosure.findings': 'Findings：{findings}',
  'inst.activation.confirmTitle': 'Activation Confirmation — 預設 No（獨立於 Registration Confirmation）',
  'inst.activation.confirmBody': 'Validation Disclosure:\n{disclosure}\n\n確認安裝並啟用 {name}？',
  'inst.activation.reenableTitle': 'Activation Confirmation — 預設 No（重新驗證後才可 re-enable）',
  'inst.commit.authority': '於 {scope} 以 State Revision {revision} 寫入授權文件',
  'inst.plan.notApplicable': 'Update Plan：不適用——Plugin Installation 不會替換 Registration 快照',
  'inst.plan.stateOnly': 'Update Plan：不適用——僅變更 Installation 狀態的操作',
  'inst.consent.activationGate': 'Activation Confirmation：獨立的 Default No 宿主閘門',
  'inst.consent.na.disabled': 'Activation Confirmation：不適用——Install Disabled 不會啟用',
  'inst.consent.na.disablement': 'Activation Confirmation：不適用——disablement 不會啟用 Plugin',
  'inst.validation.noSnapshot': 'Validation Snapshot：不適用——disablement 移除運行時參與',

  // --- lifecycle.ts -------------------------------------------------------------
  'life.pick.scope': '選擇 Scope',
  'life.pick.registration': '選擇 Marketplace Registration',
  'life.plan.choice.update': 'update — 套用新快照（{detail}）',
  'life.plan.choice.update.compatible': '有 Compatible candidate',
  'life.plan.choice.update.incompatible': '無 candidate → 不可選',
  'life.plan.choice.disable': 'disable — 停用並保留 Installation ID',
  'life.plan.choice.remove': 'remove — 移除此 Installation',
  'life.candidate.scope': 'Scope：{scope}',
  'life.candidate.registration': 'Registration：{id}',
  'life.candidate.newSnapshot': '新 Validation Snapshot：{snapshot}…',
  'life.candidate.recordedSnapshot': '既有 Recorded Snapshot：{snapshot}…',
  'life.candidate.resolvedRevision': 'Resolved Revision：{from} → {to}',
  'life.candidate.entries': 'Entries：{total}（可安裝 {available}）',
  'life.actionLabel.refresh': 'Marketplace Refresh（重整來源）',
  'life.actionLabel.rebind': 'Registration Rebind（重綁來源）',
  'life.actionLabel.applyUpdate': 'Apply Update（套用更新）',
  'life.actionLabel.registrationRemoval': 'Registration Removal（移除 Registration）',
  'life.actionLabel.installationRemoval': 'Installation Removal（移除 Installation）',
  'life.rebind.selectorPlaceholder.branch': 'main',
  'life.rebind.selectorPlaceholder.tag': 'v1.2.3',
  'life.rebind.selectorPlaceholder.commit': '完整 40/64 hex commit',
  'life.updatePlan.intent.rebind': '在保留正典 Registration ID 的前提下替換其來源',
  'life.updatePlan.intent.apply': '於單一 Lifecycle Operation 中套用此 Update Candidate',
  'life.updatePlan.notifyDisclosure': 'Validation Disclosure（新快照）：\n{summary}',
  'life.updatePlan.consent.details': 'Registration Confirmation 與每項必要的 Activation Confirmation 皆是獨立的 Default No 決策',
  'life.updatePlan.confirmRegistration.title': 'Registration Confirmation — 預設 No（綁定新 Validation Snapshot + State Revision）',
  'life.updatePlan.confirmRegistration.body': '接受此新的 Validation Snapshot 作為 Registration {id}… 的授權來源？',
  'life.updatePlan.plan.details': '需要明確結果的 Installation 數量：{count}',
  'life.updatePlan.pick.title': 'Installation {name}（{state}）— 選擇更新結果',
  'life.updatePlan.activation.title': 'Activation Confirmation — 預設 No（舊同意不沿用）',
  'life.updatePlan.activation.body': '啟用的 {name} 將在新快照下保持啟用。確認其 Activation？',
  'life.updatePlan.checklist.entry': '· {installationId} → {choice}{state}',
  'life.updatePlan.commit.details': '最終 Default No 確認後，完整 Update Plan 將原子提交',
  'life.updatePlan.commit.noConsequences': '（無既有 Installation 後果）',
  'life.updatePlan.commit.confirm.apply.title': 'Apply Update — 單次原子提交',
  'life.updatePlan.commit.confirm.rebind.title': 'Apply Rebind — 單次原子提交',
  'life.updatePlan.commit.confirm.body': '將以單一 Lifecycle Operation 原子替換快照並套用所有披露後果：\n{checklist}\n\n確認提交？',
  'life.updatePlan.commit.confirm.empty': '（無既有 Installation）',
  'life.refresh.intent.inspectionOnly': '僅對此 Registration 執行明確的非變異檢查',
  'life.refresh.intent.noWrite': 'Marketplace Refresh 不會寫入 Bridge State',
  'life.refresh.outcome': 'Refresh 結果：{status}',
  'life.refresh.candidateReady': 'Update Candidate 已產生（非變異檢查，Bridge State 未寫入）。',
  'life.rebind.intent.details': '在保留正典 Registration ID 的前提下，替換來源 locator 或 Git Selector',
  'life.rebind.sourceKind.prompt': '新來源型別',
  'life.rebind.sourceKind.local': '本地目錄（local path）',
  'life.rebind.sourceKind.git': 'Git 倉庫（locator + selector）',
  'life.rebind.localRoot.prompt': '新的本地 Marketplace Root 路徑',
  'life.rebind.locator.prompt': 'Git Locator（https:// 或 ssh，無憑證、無 query/fragment）',
  'life.rebind.selectorKind.prompt': 'Git Selector 型別',
  'life.rebind.selectorValue.prompt': '{kind} 值（例：{placeholder}）',
  'life.rebind.cancelled': '已取消 Rebind。',
  'life.rebind.revalidated': '替代來源已完成完整重驗證；需重新收集全部確認（舊 Activation 同意不沿用）。',
  'life.removal.pick.kind': '移除目標',
  'life.removal.kind.registration': '整個 Registration（原子刪除同範圍所有 Installations）',
  'life.removal.kind.installation': '單一 Installation（保留 Registration）',
  'life.removal.pick.installation': '選擇要移除的 Installation',
  'life.removal.notFound': '找不到正典 removal 目標 {targetId}。',
  'life.removal.reg.intent': '原子移除此 Registration 與其全部同範圍 Installations',
  'life.removal.reg.consent.details': 'Registration Removal 確認仍是獨立的 Default No 決策',
  'life.removal.reg.consent.title': 'Registration Removal — 預設 No',
  'life.removal.reg.commit': '於持有的 Attempt Fence 保護下，將已披露的連鎖後果提交至此 scope 文件',
  'life.removal.inst.intent': '僅移除此 scope-local Installation，保留其所屬 Registration',
  'life.removal.inst.consent.details': 'Installation Removal 確認仍是獨立的 Default No 決策',
  'life.removal.inst.consent.title': 'Installation Removal — 預設 No',
  'life.removal.inst.commit': '於持有的 Attempt Fence 保護下，將移除提交至此 scope 文件',
  'life.removal.disclosure.scope': 'Scope：{scope}',
  'life.removal.disclosure.registration': 'Registration：{id} · {source}',
  'life.removal.disclosure.registration.noSource': 'Registration：{id}',
  'life.removal.disclosure.revision': 'State Revision：{revision}',
  'life.removal.disclosure.cascade': '原子移除的同範圍 Installations：{count}',
  'life.removal.disclosure.installation': '{id} · {pluginId} · {state}',
  'life.removal.disclosure.otherScopes': '永不變更其他 scope；殘留參照將 fail closed 顯示為 unavailable，直到修復或移除。',
  'life.removal.disclosure.installationLine': 'Installation：{id} · {pluginId} · {state}',
  'life.removal.disclosure.retainedRegistration': '保留 Registration：{id}',
  'life.removal.disclosure.retainedNone': '保留 Registration：（無）',
  'life.removal.disclosure.resuming.header': '之後恢復生效的繼承 Installations：',
  'life.removal.disclosure.resuming.none': '沒有繼承 Installation 會在此之後恢復生效。',

  // --- journal.ts -----------------------------------------------------------------
  'journal.pick.scope': 'Receipt Journal — 選擇 Scope',
  'journal.repair.pick.scope': 'Repair State — 選擇 Scope',
  'journal.view.header': '=== {scopeWord} Receipt Journal ===',
  'journal.view.total': 'Receipt 總數：{count}',
  'journal.view.degraded.yes': 'Journal 降級：是（{count} 行損毀）',
  'journal.view.degraded.no': 'Journal 降級：否',
  'journal.view.chains.header': '進行中復原鏈：{value}',
  'journal.view.chains.none': '無',
  'journal.view.chain.line': 'Chain {receiptId} 條件：{condition}（長度：{length}）',
  'journal.view.recent.header': '── 最近 Receipt ──',
  'journal.view.recent.empty': '（Journal 為空）',
  'journal.view.receipt.summary': '摘要：{summary}｜持久：{durable}｜運行時：{runtime}',
  'journal.view.receipt.revision': 'State Revision：{expected} → {observed}',
  'journal.view.receipt.recovers': '復原對象：{receiptId}',
  'journal.view.receipt.findings': 'Findings：{findings}',
  'journal.notFound': 'Receipt Journal 找不到精確 Receipt ID {receiptId}。',
  'journal.appendFailed': 'Receipt Journal 寫入失敗：{error}',
  'journal.finding.persistFailed': 'Attempt Receipt 寫入 Journal 失敗：{error}',
  'journal.retry.chainStale': '所選的 Pending Application 復原鏈已不再進行中；請重新開啟 Bridge Ledger',
  'journal.retry.staleDuringConfirm': '確認期間 State Revision 已改變（{expected} → {observed}）；未要求 Runtime Application',
  'journal.retry.staleDuringConfirmSnapshot': '確認期間所綁 Validation Snapshot 已改變；未要求 Runtime Application',
  'journal.retry.noSnapshot': '進行中的 Pending Application 根 Receipt 未綁定 Validation Snapshot；fail closed，請從全新 Intent 重新驗證',
  'journal.retry.snapshotMismatch': '所綁 Validation Snapshot 已不符合現行來源材料；請重新開啟 Bridge Ledger 並重新驗證',
  'journal.retry.unreadable': 'Bridge State 不可讀；無法驗證 Runtime Application',
  'journal.retry.trustDenied': '未授予 Project Trust；Project Runtime Application 不可用',
  'journal.retry.trustRevoked': '確認期間 Project Trust 已被撤銷；未要求 Runtime Application',
  'journal.retry.trustRevokedReload': '宿主重載期間 Project Trust 已被撤銷；Project Runtime Application 保持阻擋',
  'journal.retry.intent.details': '僅重試所選的進行中 Pending Application 復原鏈；不會改寫 Bridge State',
  'journal.retry.validation.root': '進行中的復原根 Receipt {receiptId}',
  'journal.retry.validation.revision': '精確 State Revision {revision}',
  'journal.retry.validation.snapshot': '所綁 Validation Snapshot {snapshot}',
  'journal.retry.validation.snapshotMissing': '（未記錄）',
  'journal.retry.consent.details': 'Retry Application Confirmation 為明確決策，預設為 No',
  'journal.retry.consent.title': 'Retry Application Confirmation — 預設 No',
  'journal.retry.consent.body': '重新載入 Bridge resources 並驗證 {scope} State Revision {revision}？',
  'journal.retry.plan.details': '請求 Pi 宿主重載，然後在完全一致的所綁 State Revision 驗證 Bridge 重新進入',
  'journal.retry.commit.details': '不寫入 Bridge State；僅在精確的重載後驗證通過後附加解題 Receipt',
  'journal.retry.persistenceBeforeReload': 'Runtime Application 前橋接狀態變得不可讀',
  'journal.repair.intent.details': '驗證確切的權威 Bridge State，並在合格時重建降級的 Receipt Journal 行',
  'journal.repair.validation.status': '目前讀取狀態：{status}',
  'journal.repair.validation.diagnostic': '目前診斷：{error}',
  'journal.repair.validation.diagnosticNone': '無',
  'journal.repair.validation.journalDegraded': 'Receipt Journal：{count} 行損毀',
  'journal.repair.validation.journalHealthy': 'Receipt Journal：健康',
  'journal.repair.validation.journalRevision': 'Receipt Journal revision：{revision}',
  'journal.repair.validation.eligibility': 'Receipt Journal 修復資格：{eligibility}',
  'journal.repair.validation.domainGuard': 'Domain Recovery Action 將於 Attempt Fence 下重新驗證；此呈現結果不授權修復',
  'journal.repair.consent.details': 'Repair State Confirmation 仍是獨立的 Default No 決策',
  'journal.repair.consent.title': 'Repair State Confirmation — 預設 No',
  'journal.repair.consent.body': '執行 {scopeWord} Scope 的 State Repair？\n將在 Attempt Fence 保護下驗證 Bridge State，重建可辨識的 Receipt Journal，並解除相應的 Indeterminate/Degraded 復原鏈。',
  'journal.repair.plan.details': '驗證狀態可讀性/schema，原子地僅保留已驗證的 Receipt 行；不重試生命週期操作、也不回滾狀態',
  'journal.repair.commit.details': 'Domain guard 將取得該 scope 的 Attempt Fence，並附加產生的不可變 Receipt',
  'journal.repair.stateError': 'Bridge State 為 {status}',

  // --- effective-state-view.ts -------------------------------------------------------
  'eff.projection.header': 'Effective State：參與 Registration {registrations} · Installation {installations}',
  'eff.projection.suppressed': '⊘ 未參與 {kind} {targetId}（{reason}）',
  'eff.projection.noPlugins': 'Projected Plugins：無',
  'eff.projection.skillProjected': 'projected（已投影）',
  'eff.projection.skillUnavailable': 'unavailable（碰撞）',
  'eff.projection.skill': '{name} · {status} · availability: {availability}',
  'eff.projection.findings': 'Findings：{findings}',
  'eff.projection.trustNote': '\n\n⚠ Project Trust 未授予——Project Scope 紀錄仍保存但不參與 Effective State。',
  'eff.projection.availableNote': '\n\nAvailable 僅由宿主獨立證據確立；碰撞僅影響技能粒度，不改變 Plugin 分類。',

  // --- finding outcome 文案, keyed by stable RULE code -------------------------------
  'finding.FENCE-01': '另一個 Attempt 正在此 Scope 進行；每個 Scope 同時僅允許一個 Attempt（不排隊）',
  'finding.STALE-01': 'State Revision 或所綁快照已不再是現行值；此嘗試依 Stale 規則拒絕，需重新 preflight 與確認（不自動合併）',
  'finding.STALE-02': '所綁 Validation Snapshot 已不符合現行來源材料；需重新驗證',
  'finding.TRUST-01': '未授予 Project Trust；Project Scope 操作不可用',
  'finding.DUP-01': '相同 Source Key 的 Marketplace Source 已存在於此 Scope；不得重複註冊',
  'finding.SRC-01': '指定的來源路徑不存在',
  'finding.SRC-02': '指定的來源路徑不是目錄',
  'finding.CAT-01': '找不到 Marketplace Catalog（.agents/plugins/marketplace.json）；舊式 marketplace 形狀不參與 Bridge 讀取',
  'finding.CAT-02': 'Marketplace Catalog 解析失敗或結構不符',
  'finding.CAT-03': '宣告的 marketplace 名稱不是小寫 kebab-case',
  'finding.CAT-04': 'Marketplace Entry 結構不符或無法解析',
  'finding.CONT-01': '宣告路徑逸出其所屬根目錄（Contained Path 違規）',
  'finding.CONT-02': 'Contained Symlink 違規：斷裂、迴圈、特殊檔案或指向所屬根之外',
  'finding.BUDG-01': '超出 Validation Budget 上限',
  'finding.GIT-01': 'Git Locator 格式無效',
  'finding.GIT-02': 'Git Locator 不得使用明文或本機傳輸',
  'finding.GIT-03': 'Git Locator 內嵌憑證，拒絕接受',
  'finding.GIT-04': 'Git Locator 不得含 query 或 fragment',
  'finding.GIT-05': 'Git Locator 含控制字元，拒絕接受',
  'finding.GIT-06': 'Git Locator 含歧義編碼，拒絕接受',
  'finding.GIT-10': 'Git Selector 無效',
  'finding.GIT-11': 'branch 值不符合 Git ref-name 規則',
  'finding.GIT-12': 'tag 值不符合 Git ref-name 規則',
  'finding.GIT-13': 'commit 值須為完整 40/64 hex 物件名',
  'finding.GIT-20': 'Resolved Revision 無效',
  'finding.GIT-30': 'Git Source Acquisition 失敗',
  'finding.GIT-31': 'SSH host key 未知或已變更，拒絕信任',
  'finding.GIT-32': '偵測到改變 Canonical Git Locator 的重新導向，拒絕',
  'finding.GIT-33': '憑證 helper／SSH agent 設定超出 Acquisition Trust Base，拒絕',
  'finding.COMP-01': 'Plugin manifest 無效或結構不符',
  'finding.COMP-02': 'Skill descriptor 無效或結構不符',
  'finding.COMP-03': '不支援的作用中元件；Bridge 僅接受慣性（inert）元件',
  'finding.COMP-04': 'Plugin ID 碰撞：多個候選宣稱同一 Plugin ID',
  'finding.COMP-05': 'Skill Agent Profile 無效',
  'finding.REG-01': '指定的 Registration 不在此 Scope 的 Bridge State',
  'finding.UPD-01': 'Update Plan 不完整或有衝突；請為每個 Installation 提供明確結果',
  'finding.INSTALL-01': '指定的 Installation 不存在',
  'finding.INSTALL-02': '此 Marketplace Entry 在此 Scope 已有 Installation',
  'finding.INSTALL-03': '缺少必要的 Activation Confirmation（Default No）',
  'finding.INSTALL-04': '來源材料不再符合所綁快照；需要 Source Reacquisition',
  'finding.COLLISION-01': 'Runtime 技能碰撞：同名 Skill Descriptor 由另一候選宣告，此 Skill 不可用',
  'finding.DRIFT-01': 'Source Drift：來源樹與登記的 Validation Snapshot 不符；須先執行 Marketplace Refresh 產生 Update Candidate',
  'finding.JOURNAL-01': 'Attempt Receipt 寫入 Journal 失敗',
  'finding.JOURNAL-02': 'Receipt Journal 有損毀行；已降級保留',
  'finding.PERSIST-01': 'Bridge State 不可讀或已損毀（Persistence Indeterminate）',
  'finding.SCHEMA-01': 'Bridge State schema 版本未知（不相容）；請更新 Bridge Package',
  'finding.RECON-01': '需要 Startup Reconciliation',
} as const;

export type MessageId = keyof typeof zhTW;

type Dictionary = Record<MessageId, string>;

const dictionaries: Record<UiLocale, Dictionary> = {
  [activeLocale]: zhTW,
};

/**
 * Resolve a message id from the active locale dictionary, interpolating `{param}`
 * placeholders. Unknown params render verbatim so gaps are loud instead of silent.
 */
export function uiText(id: MessageId, params?: Record<string, string | number>): string {
  const template = dictionaries[activeLocale][id];
  if (params === undefined) return template;
  return (template as string).replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match,
  );
}

/** Canonical-first closed value rendering: `Canonical（中文釋義）`. */
export function closedValue(canonical: string, gloss: string): string {
  return `${canonical}（${gloss}）`;
}

const ATTEMPT_SUMMARY_GLOSS: Record<AttemptSummary, MessageId> = {
  Completed: 'summary.gloss.Completed',
  'Completed with diagnostics': 'summary.gloss.Completed with diagnostics',
  Declined: 'summary.gloss.Declined',
  Blocked: 'summary.gloss.Blocked',
  'Rejected as Stale': 'summary.gloss.Rejected as Stale',
  'Persistence Failed': 'summary.gloss.Persistence Failed',
  'Persistence Indeterminate': 'summary.gloss.Persistence Indeterminate',
  'Pending Application': 'summary.gloss.Pending Application',
} as const;

/** Attempt Summary closed value presented canonical-first with its zh_TW gloss.
 * Unknown values (e.g. forged journal content) fall back to their quoted canonical form. */
export function attemptSummaryText(summary: AttemptSummary): string {
  const glossId = (ATTEMPT_SUMMARY_GLOSS as Record<string, MessageId>)[summary];
  return glossId ? closedValue(summary, uiText(glossId)) : summary;
}

/** zh_TW gloss only, for callers that own canonical-value escaping themselves. */
export function attemptSummaryGloss(summary: AttemptSummary): string {
  const glossId = (ATTEMPT_SUMMARY_GLOSS as Record<string, MessageId>)[summary];
  return glossId ? uiText(glossId) : '';
}

const RECOVERY_ACTION_GLOSS: Record<RecoveryAction, MessageId> = {
  Retry: 'recovery.gloss.Retry',
  Revalidate: 'recovery.gloss.Revalidate',
  Refresh: 'recovery.gloss.Refresh',
  Rebind: 'recovery.gloss.Rebind',
  'Retry Application': 'recovery.gloss.Retry Application',
  Disable: 'recovery.gloss.Disable',
  Remove: 'recovery.gloss.Remove',
  'Repair State': 'recovery.gloss.Repair State',
  Inspect: 'recovery.gloss.Inspect',
};

/** Recovery Action closed value presented canonical-first with its zh_TW gloss. */
export function recoveryActionText(action: RecoveryAction): string {
  const glossId = RECOVERY_ACTION_GLOSS[action];
  return glossId ? closedValue(action, uiText(glossId)) : action;
}

/** zh_TW gloss only, for callers that own canonical-value escaping themselves. */
export function recoveryActionGloss(action: RecoveryAction): string {
  const glossId = RECOVERY_ACTION_GLOSS[action];
  return glossId ? uiText(glossId) : '';
}

const STEP_GLOSS: Record<TransactionStep, MessageId> = {
  Intent: 'step.gloss.Intent',
  Validation: 'step.gloss.Validation',
  Consent: 'step.gloss.Consent',
  Plan: 'step.gloss.Plan',
  Commit: 'step.gloss.Commit',
  Receipt: 'step.gloss.Receipt',
};

/** Transaction stage label in the active presentation language. */
export function transactionStepLabel(step: TransactionStep): string {
  return uiText(STEP_GLOSS[step]);
}

const VERDICT_GLOSS = {
  Passed: 'verdict.gloss.Passed',
  'Passed with diagnostics': 'verdict.gloss.Passed with diagnostics',
  Blocked: 'verdict.gloss.Blocked',
} as const;

export type ValidationVerdict = keyof typeof VERDICT_GLOSS;

/** Validation verdict closed value presented canonical-first with its zh_TW gloss. */
export function verdictText(verdict: ValidationVerdict): string {
  return closedValue(verdict, uiText(VERDICT_GLOSS[verdict]));
}

/**
 * zh_TW operational copy for a domain finding, selected by its stable rule code at the
 * presentation boundary. Rule codes, classifications, and finding order are unchanged;
 * unknown rules fall back to the canonical outcome text rather than inventing copy.
 */
export function findingOutcomeText(finding: Pick<ValidationFinding, 'rule' | 'outcome'>): string {
  const id = `finding.${finding.rule}` as MessageId;
  return Object.prototype.hasOwnProperty.call(dictionaries[activeLocale], id)
    ? uiText(id)
    : finding.outcome;
}
