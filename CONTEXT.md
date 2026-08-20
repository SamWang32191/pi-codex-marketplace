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
The Bridge-owned durable desired state stored independently for global and project scopes. Each state document contains a schema version, scope-local Registration and Installation records, and any project-only Scope Overrides; source-derived catalogs, compatibility results, effective precedence, and diagnostics are recomputed.
_Avoid_: Pi settings, runtime snapshot, cache

**State Revision**:
An opaque identifier for one exact scope-local Bridge State version, bound with the applicable Validation Snapshot to every Lifecycle Operation and confirmation. If either changes before commit, the operation is rejected as stale and requires new preflight and confirmation without automatic merge.
_Avoid_: Schema version, Resolved Revision, last-write-wins

**Lifecycle Operation**:
An explicit user-requested change to one scope's Registration or Installation state, committed atomically with every disclosed same-scope effect required by that action. Independent Registrations and Installations are never combined into a best-effort batch.
_Avoid_: Runtime Application, partial record update, bulk confirmation

**Global Scope**:
The Bridge scope whose registrations and installations form the baseline across Pi projects. Project-specific changes affect their effective use without mutating the global records.
_Avoid_: Project Scope, machine-wide effective state

**Project Scope**:
The Bridge scope associated with the current trusted Pi working directory and identified by the location of its Bridge State rather than a stored path or Git identity. It adds project registrations and installations plus sparse overrides to inherited Global Scope state.
_Avoid_: Isolated scope, complete replacement state

**Project Trust**:
Pi's host-owned decision that permits Project Scope state, resources, and Lifecycle Operations to participate. The Bridge Package never grants or persists it; without Project Trust, project records remain stored but are excluded from Effective State and no Project Scope Lifecycle Operation may mutate them.
_Avoid_: Registration Confirmation, Activation Confirmation, sandbox

**Scope Override**:
A Project Scope record keyed by canonical Registration ID or Installation ID that explicitly suppresses an inherited global record without modifying it. A Registration override suppresses its marketplace subtree, an Installation override suppresses only that Plugin, and removing either reveals the inherited record again.
_Avoid_: Copy of global state, global mutation

**Effective State**:
The computed project view of inherited Global Scope records, Project Scope additions, and Scope Overrides. Only enabled Installations participate, and no selected record's independently persisted provenance is merged or mutated.
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
The user-approved association of a Marketplace Source with either a global or project scope in Pi. Each registration has an immutable Registration ID and independently scoped state; its source locator, Source Key, alias, and declared Marketplace name are attributes.
_Avoid_: Subscription, automatic discovery

**Registration Rebind**:
A Lifecycle Operation that explicitly replaces a Marketplace Registration's source locator or Git Selector and is distinct from Marketplace Refresh and Apply Update. It preserves the Registration ID only after fresh validation, Registration Confirmation, and a complete Update Plan for every existing Installation; prior activation consent never carries over.
_Avoid_: Update Candidate, repeated registration, silent relocation

**Registration Removal**:
A Lifecycle Operation that removes one scope-local Marketplace Registration and all of its same-scope Installations as one disclosed atomic effect. It does not mutate other scopes or projects; references left there fail closed as unavailable and surface diagnostics until repaired or removed.
_Avoid_: Disablement, Scope Override, cross-project cascade

**Registration Confirmation**:
The user's Validation Snapshot- and State Revision-bound approval of one validated Marketplace Source, catalog summary, and target scope after a complete Validation Disclosure and an explicit yes-or-no choice that defaults to No. It cannot be remembered or applied in bulk and authorizes only the Marketplace Registration, not activation of any Plugin it lists.
_Avoid_: Project trust, blanket Plugin approval

**Registration ID**:
An opaque, immutable lowercase UUIDv4 generated locally by the Bridge Package for a Marketplace Registration and associated with exactly one scope. It is allocated before preflight validation so findings can have stable derived identities, persisted only after Registration Confirmation, and never reused after a failed or declined attempt. It survives changes to registration attributes; a project record that duplicates a global Registration ID is invalid rather than an override.
_Avoid_: Marketplace name, alias, source path, Git URL

**Source Key**:
A deterministic, typed value used to compare Marketplace Sources for duplicate detection and repeated registration; it is not the identity of a Marketplace Registration. A local Source Key uses the Marketplace Root's canonical real path, while a Git Source Key combines a canonical remote URL with its exact selector; local and Git keys remain distinct, and equal keys across scopes do not merge registrations.
_Avoid_: Registration ID, user-facing alias

**Registration Alias**:
An optional, scope-local, human-readable handle for a Marketplace Registration, initially derived from a compatible declared Marketplace name. It is unique within its scope and can be explicitly renamed without changing the Registration ID.
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
A conflict in Pi's flat skill namespace when different Skill IDs, or a Plugin skill and a pre-existing Pi skill, claim the same exact Skill Descriptor name. It changes only skill availability, never Plugin classification: candidates resolve per name in `Pi → Project Scope → Global Scope` order, all same-scope Bridge colliders are unavailable, and only a surviving higher-layer skill reserves the name, so a lower-layer candidate survives when no higher-layer skill does.
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
A Lifecycle Operation that creates an Installation in one scope after current compatibility validation and disclosure. `Install Disabled` creates disabled state without Activation Confirmation, while `Install and Enable` atomically creates enabled state only after Activation Confirmation.
_Avoid_: Pi package installation, Marketplace Registration, implicit activation

**Installed Plugin**:
A Compatible Plugin selected from a Marketplace and durably recorded within either a global or project scope in Pi. Its Installation State determines whether it participates in Effective State, and an enabled project Installation of an inherited global Plugin ID takes precedence over its retained global Installation.
_Avoid_: Marketplace entry, bundled plugin

**Installation State**:
The durable `enabled` or `disabled` condition of an Installed Plugin. A disabled Installation retains its Installation ID and recorded provenance but is excluded from Effective State; enabling it is a new activation requiring fresh validation and Activation Confirmation.
_Avoid_: Scope Override, Plugin classification, runtime status

**Installation Removal**:
A Lifecycle Operation that deletes one scope-local Installation while retaining its Marketplace Registration. Its disclosure identifies any inherited Installation that will become effective afterward.
_Avoid_: Disablement, Registration Removal, Scope Override

**Activation Confirmation**:
The user's Validation Snapshot- and State Revision-bound approval of one Compatible Plugin for one target scope after a complete Validation Disclosure and an explicit yes-or-no choice that defaults to No. It cannot be remembered or applied in bulk, is separate from Registration Confirmation, expires when the confirmed source changes, and is required again when enabling a disabled Installation.
_Avoid_: Registration Confirmation, permanent source trust

**Validation Disclosure**:
The source, scope, identity, State Revision, Validation Snapshot, classification, and finding summary presented before a Bridge confirmation. Registration disclosure covers the Marketplace and its entry outcomes; activation disclosure covers the exact Plugin, skills, resources, Invocation Policies, and projected precedence.
_Avoid_: Confirmation itself, raw diagnostic dump

**Validation Finding**:
A machine-readable validation result identified by a stable rule code and carrying its classification, scope, safe source and revision provenance, affected domain identity, file or data pointer, and operational outcome. Secret-bearing input is redacted, and presentation is derived from the finding rather than stored as authority.
_Avoid_: Free-form log line, persisted source truth

**Blocking Finding**:
A validation result that denies its stated target—Registration, whole-Plugin activation, or individual skill availability—rather than requesting consent. Source acquisition or host-authentication failure, missing Project Trust, a stale or mismatched snapshot, unsafe paths or filesystem objects, exceeded Validation Budget, Invalid or Incompatible classification, and unresolved identity collisions block their Registration or whole-Plugin target; a Runtime Skill Collision blocks only its colliding skill candidates, and none can be waived.
_Avoid_: Warning, confirmation prompt

**Validation Warning**:
A non-blocking finding limited to ignored Inert Metadata or optional presentation data that does not affect active behaviour and has no path, symlink, or filesystem safety violation. It is always disclosed and may be accepted through the applicable confirmation without changing Plugin classification.
_Avoid_: Blocking Finding, silent fallback

**Projected Plugin**:
An Installed Plugin admitted by Effective State after no Blocking Finding denies its whole-Plugin activation, independently of Runtime Skill Collision resolution. It contributes zero or more Projected Skills; Invalid or Incompatible Plugins cannot be partially projected.
_Avoid_: Partially compatible Plugin, Pi package

**Projected Skill**:
A skill of a Projected Plugin that survives Runtime Skill Collision resolution and is exposed to Pi under its Skill Descriptor name while retaining its Skill ID and provenance. A colliding skill that does not survive is unavailable without changing its Plugin's Compatible or Projected status.
_Avoid_: Compatible Plugin, renamed skill

**Installation ID**:
The canonical identity of an Installed Plugin, composed of its scope and Plugin ID. It remains stable across Plugin version, source revision, Marketplace Entry ordinal, and path changes, while a new Plugin ID requires a new Installation ID.
_Avoid_: Manifest name alone, install attempt ID

**Runtime Application**:
The immediate post-commit attempt to make a Lifecycle Operation's new Effective State participate in Pi through runtime reload. It succeeds only when reload completes, the Bridge Extension re-enters at the expected State Revision, and no whole-Plugin Blocking Finding remains; Runtime Skill Collisions remain per-skill diagnostics, and any other outcome enters Pending Application.
_Avoid_: Lifecycle Operation, Marketplace Refresh, startup

**Pending Application**:
The condition after a Lifecycle Operation commits but its Runtime Application fails. Bridge State remains desired and no prior runtime is claimed valid; retry or startup application may reuse prior confirmations only while the State Revision and Validation Snapshots remain identical, otherwise recovery requires new preflight and confirmation rather than automatic rollback.
_Avoid_: Successful activation, reverted state, last-known-good runtime
