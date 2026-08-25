# Codex Marketplace Compatibility

This context describes how Codex marketplaces and plugins become usable in Pi while retaining their Codex-facing identity and an explicit compatibility boundary.

## Language

**Bridge Package**:
The installable Pi package produced by this project and distributed for use by other Pi users.
_Avoid_: Pi plugin, importer, converter

**Bridge Extension**:
The runtime portion of the Bridge Package that presents marketplace and plugin capabilities inside Pi.
_Avoid_: Bridge Package, Codex plugin

**Bridge State**:
The Bridge-owned durable desired state stored in a single Global Scope document. It contains a schema version and Registration and Installation records; source-derived catalogs, compatibility results, effective precedence, and diagnostics are recomputed.
_Avoid_: Pi settings, runtime snapshot, cache

**State Revision**:
An opaque identifier for one exact Bridge State version, bound with the applicable Validation Snapshot to every Lifecycle Operation and confirmation. If either changes before commit, the operation is rejected as stale and requires new preflight and confirmation without automatic merge.
_Avoid_: Schema version, Resolved Revision, last-write-wins

**Lifecycle Operation**:
An explicit user-requested change to the Global scope's Registration or Installation state, committed atomically with every disclosed effect required by that action. Independent Registrations and Installations are never combined into a best-effort batch.
_Avoid_: Runtime Application, partial record update, bulk confirmation

**Attempt Fence**:
The exclusivity and exact-state boundary shared by Lifecycle Operations and Runtime Applications. It admits only one attempt at a time and prevents an attempt from committing, becoming Applied, or resolving a receipt after its State Revision or applicable Validation Snapshots cease to be current.
_Avoid_: Last-write-wins, attempt queue, shared lock

**Attempt Receipt**:
A redacted, immutable, non-authoritative record of one Bridge-managed attempt, including explicit lifecycle, refresh, or retry attempts and startup reconciliation. It relates expected, target, and observed State Revisions with any available Validation Snapshots, outcomes, findings, and earlier receipt it seeks to recover; passive inspection creates none and a receipt never authorizes replay.
_Avoid_: Operation Receipt, Bridge State, free-form log, activation authority

**Receipt Journal**:
The durable, bounded, non-authoritative history of Attempt Receipts that preserves every active recovery chain across restarts. It establishes attempt history before an attempt proceeds and remains reconstructible from authoritative state after partial failure without rolling back a verified commit.
_Avoid_: Bridge State, best-effort log, audit authority

**Receipt Resolution**:
The derived relationship in which a later receipt resolves an earlier active receipt by verifying the same state, or supersedes it by committing a replacement state; a failed retry leaves the active condition unresolved. Receipts remain immutable, and only history outside every active recovery chain may be cleared.
_Avoid_: Receipt mutation, acknowledgement, deletion of active diagnostics

**Attempt Summary**:
The current user-visible headline derived from an Attempt Receipt's outcomes and findings rather than stored as authority. Its closed values are `Completed`, `Completed with diagnostics`, `Declined`, `Blocked`, `Rejected as Stale`, `Persistence Failed`, `Persistence Indeterminate`, and `Pending Application`.
_Avoid_: Success boolean, authoritative state, free-form status

**Persistence Indeterminate**:
The fail-closed outcome after a persistence attempt when neither the previous nor target State Revision can be verified as the exact durable Bridge State. No Runtime Application or further Lifecycle Operation may proceed until the state is readable and exact; the Bridge neither assumes no commit nor performs automatic rollback.
_Avoid_: Unchanged, Committed, best-effort rollback

**Persistence Failed**:
The outcome after a Bridge State write fails while the exact previous State Revision remains verified, proving that the target state did not commit. Receipt Journal degradation is diagnosed separately and never changes this outcome.
_Avoid_: Persistence Indeterminate, receipt failure, assumed rollback

**Recovery Action**:
A stable next step eligible under the exact current State Revision, applicable Validation Snapshots, and finding outcome. It expresses only a currently safe recovery path and never authorizes replay or automatic remediation.
_Avoid_: Free-form advice, generic retry button, automatic remediation

**Global Scope**:
The single Bridge scope in which all Registrations and Installations are recorded. Former Project Scope mechanisms are retired; no other scope exists.
_Avoid_: Project Scope, machine-wide effective state

**Effective State**:
The computed view of Global Scope Bridge State. Only enabled Installations participate, and no selected record's independently persisted provenance is merged or mutated.
_Avoid_: Bridge State, persisted merged state

**Marketplace**:
A Codex-format catalog that identifies plugins available from a source.
_Avoid_: Package registry, plugin directory

**Marketplace Catalog**:
The canonical `.agents/plugins/marketplace.json` object within a Marketplace Root, declaring its validated lowercase kebab-case name and Plugin entries. Legacy and Antigravity marketplace-shaped files do not participate in Bridge ingestion.
_Avoid_: `.claude-plugin/marketplace.json`, `.agents/plugins.json`

**Marketplace Entry**:
A Marketplace Catalog member that names one Plugin candidate and locates it through a local Contained Path. Other entry source kinds are recognized only as Unavailable Entries rather than recursively acquired.
_Avoid_: Marketplace Source, Installed Plugin

**Marketplace Entry ID**:
The snapshot-scoped identity of a Marketplace Entry, composed of its Marketplace ID and canonical JSON Pointer `/plugins/<zero-based ordinal>`. It remains stable when the same Validation Snapshot is read again and distinguishes malformed or duplicate entries even when no Plugin ID can be derived; source- and catalog-level findings have no Marketplace Entry ID.
_Avoid_: Entry name, Plugin ID, durable per-entry UUID

**Marketplace ID**:
The canonical identity of a Marketplace, composed of its Registration ID and declared Marketplace name. It distinguishes same-named Marketplaces from different registrations; changing the declared name creates a new Marketplace ID without automatically migrating downstream identities.
_Avoid_: Registration Alias, globally unique Marketplace name

**Marketplace Root**:
The directory that contains a Marketplace and the Plugin paths referenced by that Marketplace.
_Avoid_: Plugin directory, installation directory

**Marketplace Source**:
An explicitly chosen local directory or Git repository that supplies a Marketplace Root. Local and Git sources are distinct source kinds even when the local directory is a clone of the Git repository; the Bridge Package does not infer equality from Git remotes or commits.
_Avoid_: Plugin source, marketplace entry

**Source Acquisition**:
The non-executing retrieval of a Git Marketplace Source at a Resolved Revision. It never runs repository-controlled hooks, filters, submodules, dependencies, or Plugin components.
_Avoid_: Package installation, build, Plugin activation

**Acquisition Trust Base**:
The constrained host components trusted during Source Acquisition: the selected Git and SSH executables, operating-system certificate authorities, pre-established SSH known-host keys, and approved credential helper or SSH agent. The Bridge Package permits only necessary trust and credential configuration, rejects unknown or changed SSH host keys and canonical-locator-changing redirects, and never extends this trust to repository content or repository-controlled Git configuration.
_Avoid_: Project Trust, Plugin trust, sandbox

**Git Selector**:
The structured `default`, `branch`, `tag`, or `commit` choice attached to a Git Marketplace Source. Branch and tag values obey Git ref-name rules and canonicalize to exact case-sensitive `refs/heads/...` or `refs/tags/...` values; commit values are complete 40- or 64-hex object names canonicalized to lowercase. Ambiguous shorthand, abbreviated object names, generic refs, `HEAD`, revision or reflog expressions, option-like values, whitespace, and control characters are not accepted; default, branch, and tag selectors are movable and every selector resolves to a full commit before confirmation.
_Avoid_: Resolved Revision, arbitrary Git revision expression

**Resolved Revision**:
The full Git commit bound to validation and confirmation for a Git Selector. It is a source attribute rather than identity, and a changed resolution requires new validation and confirmation.
_Avoid_: Git Selector, Plugin version

**Canonical Git Locator**:
A credential-free HTTPS or SSH repository locator that preserves identity-relevant transport, host, port, path, and SSH user. Plaintext or local transports, embedded credentials, query, fragment, and ambiguous encoding are not accepted.
_Avoid_: Raw clone URL, Source Key, credential string

**Contained Path**:
A declared `./`-relative path with no absolute, backslash, NUL, dot, or parent segment whose canonical target remains within its owning Marketplace, Plugin, or skill root. Existence without containment is insufficient.
_Avoid_: String-prefix check, arbitrary filesystem path

**Contained Symlink**:
A symlink whose canonical target is a regular file or directory within the same owning root as the link. Broken, looping, special-file, or root-external symlinks are Blocking Findings.
_Avoid_: Unrestricted symlink, path escape

**Validation Snapshot**:
The immutable source state to which validation and confirmation apply, covering the complete inspected catalog and Plugin trees: ordered paths, object types, modes, symlink targets, content hashes, skills, agent profiles, opaque resources, and accepted presentation assets. It binds the Source Key, verified Canonical Git Locator and Resolved Revision where applicable, Compatibility Profile, Validation Ruleset, and Validation Budget; its fingerprint must still match before durable state mutation or activation admission. A mismatch is a Blocking Finding requiring new validation, disclosure, and confirmation; cached bytes may be reused only when identical, and every activation is still validated under the current rules.
_Avoid_: Live source tree, cache freshness marker

**Validation Ruleset**:
The versioned Bridge contract for source, parser, content, path, symlink, finding, and failure-granularity rules, referencing a specific Compatibility Profile and Validation Budget. A changed ruleset requires revalidation even when source bytes are unchanged.
_Avoid_: Compatibility Profile alone, implementation version

**Validation Budget**:
A versioned set of fixed, non-waivable limits on acquisition time and size, parser complexity, path depth, file counts, and validation-relevant content. Exceeding a limit produces a Blocking Finding at the owning source, catalog, entry, or Plugin boundary rather than partial or best-effort validation.
_Avoid_: Cache retention policy, warning threshold

**Stale Snapshot**:
Previously acquired or cached material whose verified locator, selector, Resolved Revision, content, path, or symlink metadata no longer matches the operation being confirmed. It may inform a diagnostic but never substitutes for a current Validation Snapshot.
_Avoid_: Offline success, last-known-good activation

**Source Cache**:
Non-authoritative retained Marketplace Source material that may support only the exact Validation Snapshot that references it. Material referenced by committed Bridge State or a pending Update Candidate is retained; cached material never makes a Stale Snapshot valid or turns offline state into success.
_Avoid_: Bridge State, last-known-good source, source of truth

**Source Drift**:
An external change to a local Marketplace Source that makes its live tree differ from the recorded Validation Snapshot outside Marketplace Refresh. Detection is a Blocking Finding: Bridge State remains unchanged, affected Installations cannot become Projected Plugins, and only an explicit Marketplace Refresh may produce an Update Candidate.
_Avoid_: Marketplace Refresh, Update Candidate, automatic update

**Marketplace Refresh**:
An explicit, non-mutating inspection and validation of the current Marketplace Source for one Registration, producing either no change or an Update Candidate. Startup and runtime reload do not refresh Marketplaces.
_Avoid_: Lifecycle Operation, automatic update, Plugin activation

**Update Candidate**:
A newly validated source state for one Registration that differs from its recorded Validation Snapshot and may be applied only by a separate Lifecycle Operation. Plugin version metadata alone does not establish one, and a full-commit Git Selector cannot produce one solely through ref movement.
_Avoid_: Available version, live source tree, applied update

**Update Plan**:
A Validation Snapshot- and State Revision-bound set of explicit outcomes required before Apply Update can replace one Registration's source state. It requires fresh Registration Confirmation and an update, disablement, or removal outcome for each Installation; every enabled Installation that remains enabled needs Activation Confirmation, an existing Installation without a Compatible candidate must be disabled or removed or the plan abandoned, and the plan commits once without mixing source revisions.
_Avoid_: Bulk confirmation, partial Plugin update, per-Plugin source pin

**Apply Update**:
A Lifecycle Operation that replaces one Marketplace Registration's recorded Validation Snapshot according to one complete Update Plan and atomically applies every disclosed same-scope consequence. It never refreshes the source, silently changes another scope, or retains an enabled Installation from another source revision.
_Avoid_: Marketplace Refresh, Registration Rebind, automatic update

**Marketplace Registration**:
The user-approved association of a Marketplace Source with the Global scope in Pi. Each registration has an immutable Registration ID; its source locator, Source Key, alias, and declared Marketplace name are attributes.
_Avoid_: Subscription, automatic discovery

**Registration Rebind**:
A Lifecycle Operation that explicitly replaces a Marketplace Registration's source locator or Git Selector and is distinct from Marketplace Refresh and Apply Update. It preserves the Registration ID only after fresh validation, Registration Confirmation, and a complete Update Plan for every existing Installation; prior activation consent never carries over.
_Avoid_: Update Candidate, repeated registration, silent relocation

**Registration Removal**:
A Lifecycle Operation that removes the Marketplace Registration and all of its Installations as one disclosed atomic effect.
_Avoid_: Disablement, Scope Override, cross-project cascade

**Registration Confirmation**:
The user's Validation Snapshot- and State Revision-bound approval of one validated Marketplace Source, catalog summary, and the Global scope after a complete Validation Disclosure and an explicit yes-or-no choice that defaults to No. It cannot be remembered or applied in bulk and authorizes only the Marketplace Registration, not activation of any Plugin it lists.
_Avoid_: Project trust, blanket Plugin approval

**Registration ID**:
An opaque, immutable lowercase UUIDv4 generated locally by the Bridge Package for a Marketplace Registration and associated with the Global scope. It is allocated before preflight validation so findings can have stable derived identities, persisted only after Registration Confirmation, and never reused after a failed or declined attempt. It survives changes to registration attributes.
_Avoid_: Marketplace name, alias, source path, Git URL

**Source Key**:
A deterministic, typed value used to compare Marketplace Sources for duplicate detection and repeated registration; it is not the identity of a Marketplace Registration. A local Source Key uses the Marketplace Root's canonical real path, while a Git Source Key combines a canonical remote URL with its exact selector; local and Git keys remain distinct, and equal keys do not merge registrations.
_Avoid_: Registration ID, user-facing alias

**Registration Alias**:
An optional, human-readable handle for a Marketplace Registration, initially derived from a compatible declared Marketplace name. It is unique within the Global scope and can be explicitly renamed without changing the Registration ID.
_Avoid_: Registration ID, Marketplace name

**Plugin**:
A Codex-format bundle whose `.codex-plugin/plugin.json` manifest describes its identity and constituent components. The manifest name, rather than the Marketplace entry name or directory path, is the authoritative Plugin name.
_Avoid_: Pi package, Pi extension

**Plugin ID**:
The canonical identity of a Plugin, composed of its Marketplace ID and authoritative manifest name. Version, source revision, Marketplace Entry ordinal, and directory path are attributes; changing the manifest name creates a new Plugin ID without automatically migrating an Installation.
_Avoid_: Marketplace entry name, Plugin path

**Unavailable Entry**:
A Marketplace Entry that cannot supply an activatable Plugin because it uses an unsupported source kind, cannot be resolved to a Plugin, yields an Invalid or Incompatible Plugin, or has a Plugin-level identity collision. A Runtime Skill Collision affects skill availability and does not make an otherwise activatable entry unavailable.
_Avoid_: Silently skipped entry, partially compatible Plugin

**Skill Descriptor**:
The explicit YAML frontmatter at the start of a Plugin skill's `SKILL.md`, containing the identity and discovery metadata required by its Compatibility Profile.
_Avoid_: Directory-name fallback, Skill Body

**Skill Body**:
The Markdown instructions after a Skill Descriptor. Compatibility Profile v1 treats it as an opaque prompt under Pi's native newline and whitespace normalization.
_Avoid_: Executable template, dynamic command

**Skill ID**:
The canonical identity of a Plugin skill, composed of its Plugin ID and Skill Descriptor name. Version, directory path, and Skill Agent Profile are attributes rather than identity.
_Avoid_: Globally unique skill name, SKILL.md path

**Runtime Skill Collision**:
A conflict in Pi's flat skill namespace when different Skill IDs, or a Plugin skill and a pre-existing Pi skill, claim the same exact Skill Descriptor name. It changes only skill availability, never Plugin classification: candidates resolve per name in `Pi → Global Scope` order, all same-layer Bridge colliders are unavailable, and only a surviving higher-layer skill reserves the name, so a lower-layer candidate survives when no higher-layer skill does.
_Avoid_: Skill ID collision, canonical-path duplicate

**Skill Agent Profile**:
The optional `agents/openai.yaml` companion to a Plugin skill, containing presentation metadata and declarations about invocation or external dependencies.
_Avoid_: Skill Descriptor, required manifest

**Invocation Policy**:
The canonical declaration of whether a Plugin skill participates in implicit model discovery or is available only through explicit invocation.
_Avoid_: Tool policy, installation state

**Skill Resource**:
An opaque support file available relative to a skill's base directory, such as a script, reference, or asset. Its presence alone neither executes it nor creates another Active Component.
_Avoid_: Active Component, automatically executed script

**Active Component**:
A declared or conventionally discovered part of a Plugin that changes its runtime behaviour. A Compatibility Profile must support every Active Component for the Plugin to be Compatible.
_Avoid_: Inert Metadata, optional file

**Inert Metadata**:
Optional descriptive or presentation data that does not change a Plugin's runtime behaviour. It may enrich management surfaces without expanding the Compatibility Profile.
_Avoid_: Active Component, required behaviour

**Compatibility Profile**:
A versioned, Bridge-owned contract declaring the Codex component types and semantic behaviours the Bridge Package supports. Compatibility Profile v1 classifies a Plugin atomically and contains Pi-native skill semantics only.
_Avoid_: Best-effort compatibility, silent fallback

**Compatible Plugin**:
A Plugin whose complete set of declared active components and skill behaviours satisfies a Compatibility Profile; Compatible, Incompatible, or Invalid classification is atomic. Runtime Skill Collision is resolved only after classification and may make individual skills unavailable without permitting an Invalid or Incompatible Plugin to be partially projected.
_Avoid_: Converted plugin, Pi-native plugin

**Incompatible Plugin**:
A structurally readable Plugin that requires an active component or behaviour outside its Compatibility Profile. It is not partially projected.
_Avoid_: Invalid Plugin, degraded Plugin

**Invalid Plugin**:
A Plugin whose required identity or component structure cannot be safely parsed or validated against its Compatibility Profile.
_Avoid_: Incompatible Plugin, Plugin with warnings

**Plugin Installation**:
A Lifecycle Operation that creates an Installation in the Global scope after current compatibility validation and disclosure. `Install Disabled` creates disabled state without Activation Confirmation, while `Install and Enable` atomically creates enabled state only after Activation Confirmation.
_Avoid_: Pi package installation, Marketplace Registration, implicit activation

**Installed Plugin**:
A Compatible Plugin selected from a Marketplace and durably recorded within the Global scope in Pi. Its Installation State determines whether it participates in Effective State.
_Avoid_: Marketplace entry, bundled plugin

**Installation State**:
The durable `enabled` or `disabled` condition of an Installed Plugin. A disabled Installation retains its Installation ID and recorded provenance but is excluded from Effective State; enabling it is a new activation requiring fresh validation and Activation Confirmation.
_Avoid_: Scope Override, Plugin classification, runtime status

**Installation Removal**:
A Lifecycle Operation that deletes one Installation while retaining its Marketplace Registration.
_Avoid_: Disablement, Registration Removal, Scope Override

**Activation Confirmation**:
The user's Validation Snapshot- and State Revision-bound approval of one Compatible Plugin for the Global scope after a complete Validation Disclosure and an explicit yes-or-no choice that defaults to No. It cannot be remembered or applied in bulk, is separate from Registration Confirmation, expires when the confirmed source changes, and is required again when enabling a disabled Installation.
_Avoid_: Registration Confirmation, permanent source trust

**Validation Disclosure**:
The source, identity, State Revision, Validation Snapshot, classification, and finding summary presented before a Bridge confirmation. Registration disclosure covers the Marketplace and its entry outcomes; activation disclosure covers the exact Plugin, skills, resources, Invocation Policies, and projected precedence.
_Avoid_: Confirmation itself, raw diagnostic dump

**Validation Finding**:
A machine-readable validation result identified by a stable rule code and carrying its classification, safe source and revision provenance, affected domain identity, file or data pointer, and operational outcome. Secret-bearing input is redacted, and presentation is derived from the finding rather than stored as authority.
_Avoid_: Free-form log line, persisted source truth

**Blocking Finding**:
A structured finding that denies its stated target—Registration, whole-Plugin activation, individual skill availability, or one management attempt—rather than requesting consent. Source, trust, snapshot, safety, budget, classification, or identity failures deny their Registration or whole-Plugin target; a Runtime Skill Collision denies only its colliding skill candidates, an active Attempt Fence denies only the requested attempt, and none can be waived.
_Avoid_: Warning, confirmation prompt

**Validation Warning**:
A non-blocking finding limited to ignored Inert Metadata or optional presentation data that does not affect active behaviour and has no path, symlink, or filesystem safety violation. It is always disclosed and may be accepted through the applicable confirmation without changing Plugin classification.
_Avoid_: Blocking Finding, silent fallback

**Operational Notice**:
A non-blocking diagnostic about a post-commit host-observed Runtime Skill Collision, evidence-limited Skill Availability, or post-commit diagnostic degradation that does not alter Plugin classification or whole-state application. It is distinct from a pre-application collision Blocking Finding, is not a Validation Warning, and requires no acceptance.
_Avoid_: Validation Warning, Blocking Finding, free-form log

**Projected Plugin**:
An Installed Plugin admitted by Effective State after no Blocking Finding denies its whole-Plugin activation, independently of Runtime Skill Collision resolution. It contributes zero or more Projected Skills; Invalid or Incompatible Plugins cannot be partially projected.
_Avoid_: Partially compatible Plugin, Pi package

**Projected Skill**:
A skill of a Projected Plugin that survives Runtime Skill Collision resolution and is exposed to Pi under its Skill Descriptor name while retaining its Skill ID and provenance. A colliding skill that does not survive is unavailable without changing its Plugin's Compatible or Projected status.
_Avoid_: Compatible Plugin, renamed skill

**Runtime Skill Exposure**:
The read-time participation of Projected Skills in Pi through host resource discovery contributed by the Bridge Extension at session start or runtime reload. It derives entirely from the current Effective State and its collision survivors, performs passive existence inspection only, creates no Attempt Receipt, and is neither Activation Confirmation nor activation admission; snapshot-bound validation remains bound to Lifecycle Operations and Runtime Applications. Exposure never establishes Skill Availability.
_Avoid_: Installation, Marketplace Refresh, activation confirmation

**Skill Availability**:
The evidence status of an Installed Plugin skill, for which the Bridge may report snapshot-bound eligibility, known unavailability, or unverified availability while only independent host evidence may establish that it is Available. It does not alter Plugin classification or whole-state application, and zero Available skills can coexist with an Applied Runtime Application with diagnostics.
_Avoid_: Compatibility, projection success, inferred availability

**Installation ID**:
The canonical identity of an Installed Plugin within the Global scope, composed of its Plugin ID. It remains stable across Plugin version, source revision, Marketplace Entry ordinal, and path changes, while a new Plugin ID requires a new Installation ID.
_Avoid_: Manifest name alone, install attempt ID

**Runtime Application**:
An Attempt Fence-bound attempt after commit, explicit retry, or startup reconciliation to make the current Effective State participate in Pi through runtime reload. It is Applied only through host-verifiable Bridge re-entry at the expected State Revision with no whole-Plugin Blocking Finding; this does not establish Skill Availability, and reload completion alone is insufficient.
_Avoid_: Lifecycle Operation, Marketplace Refresh, background retry

**Pending Application**:
The condition after Bridge State commits but Runtime Application has not been verified; Bridge State remains desired and no prior runtime is claimed valid. Recovery may verify the same state or explicitly commit a replacement, while inspection and Marketplace Refresh never supersede it and unrelated state changes, background retry, and automatic rollback remain prohibited.
_Avoid_: Successful activation, reverted state, last-known-good runtime


