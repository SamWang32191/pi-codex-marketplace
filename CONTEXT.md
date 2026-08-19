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

**Global Scope**:
The Bridge scope whose registrations and installations form the baseline across Pi projects. Project-specific changes affect their effective use without mutating the global records.
_Avoid_: Project Scope, machine-wide effective state

**Project Scope**:
The Bridge scope associated with the current trusted Pi working directory and identified by the location of its Bridge State rather than a stored path or Git identity. It adds project registrations and installations plus sparse overrides to inherited Global Scope state.
_Avoid_: Isolated scope, complete replacement state

**Project Trust**:
Pi's host-owned decision that permits Project Scope state and resources to participate. The Bridge Package never grants or persists it; without Project Trust, project records remain stored but are excluded from Effective State.
_Avoid_: Registration Confirmation, Activation Confirmation, sandbox

**Scope Override**:
A Project Scope record keyed by canonical Registration ID or Installation ID that explicitly suppresses an inherited global record without modifying it. A Registration override suppresses its marketplace subtree, an Installation override suppresses only that Plugin, and removing either reveals the inherited record again.
_Avoid_: Copy of global state, global mutation

**Effective State**:
The computed project view of inherited Global Scope records, Project Scope additions, and Scope Overrides. It selects effective records without merging or mutating their independently persisted provenance.
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
The canonical identity of a Marketplace, composed of its Registration ID and declared Marketplace name. It distinguishes same-named Marketplaces from different registrations; changing the declared name changes the Marketplace identity.
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

**Marketplace Registration**:
The user-approved association of a Marketplace Source with either a global or project scope in Pi. Each registration has an immutable Registration ID and independently scoped state; its source locator, Source Key, alias, and declared Marketplace name are attributes.
_Avoid_: Subscription, automatic discovery

**Registration Confirmation**:
The user's snapshot-bound approval of one validated Marketplace Source, catalog summary, and target scope after a complete Validation Disclosure and an explicit yes-or-no choice that defaults to No. It cannot be remembered or applied in bulk and authorizes only the Marketplace Registration, not activation of any Plugin it lists.
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
The canonical identity of a Plugin, composed of its Marketplace ID and authoritative manifest name. Version, source revision, and directory path are attributes, so same-named Plugins from different Marketplaces remain distinct.
_Avoid_: Marketplace entry name, Plugin path

**Unavailable Entry**:
A Marketplace Entry that cannot supply an activatable Plugin because it uses an unsupported source kind or is Invalid, Incompatible, unresolved, or colliding. Unavailable Entries are disclosed independently and do not invalidate an otherwise valid Marketplace Catalog.
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
A conflict in Pi's flat skill namespace when different Skill IDs, or a Plugin skill and a pre-existing Pi skill, claim the same exact Skill Descriptor name. Candidates are resolved in `Pi → Project Scope → Global Scope` layers: same-scope Bridge colliders have no winner, and only surviving higher-layer Plugins reserve names against lower layers.
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
A Plugin whose complete set of declared active components and skill behaviours satisfies a Compatibility Profile. It is projected as one complete unit rather than a partial subset.
_Avoid_: Converted plugin, Pi-native plugin

**Incompatible Plugin**:
A structurally readable Plugin that requires an active component or behaviour outside its Compatibility Profile. It is not partially projected.
_Avoid_: Invalid Plugin, degraded Plugin

**Invalid Plugin**:
A Plugin whose required identity or component structure cannot be safely parsed or validated against its Compatibility Profile.
_Avoid_: Incompatible Plugin, Plugin with warnings

**Installed Plugin**:
A Compatible Plugin selected from a Marketplace and made available within either a global or project scope in Pi. A project Installation of an inherited global Plugin ID takes effective precedence over its retained global Installation.
_Avoid_: Marketplace entry, bundled plugin

**Activation Confirmation**:
The user's snapshot-bound approval of one Compatible Plugin for one target scope after a complete Validation Disclosure and an explicit yes-or-no choice that defaults to No. It cannot be remembered or applied in bulk, is separate from Registration Confirmation, and expires when the confirmed source changes.
_Avoid_: Registration Confirmation, permanent source trust

**Validation Disclosure**:
The source, scope, identity, snapshot, classification, and finding summary presented before a Bridge confirmation. Registration disclosure covers the Marketplace and its entry outcomes; activation disclosure covers the exact Plugin, skills, resources, Invocation Policies, and projected precedence.
_Avoid_: Confirmation itself, raw diagnostic dump

**Validation Finding**:
A machine-readable validation result identified by a stable rule code and carrying its classification, scope, safe source and revision provenance, affected domain identity, file or data pointer, and operational outcome. Secret-bearing input is redacted, and presentation is derived from the finding rather than stored as authority.
_Avoid_: Free-form log line, persisted source truth

**Blocking Finding**:
A validation result that prevents the targeted Registration or activation rather than requesting consent. Source acquisition or host-authentication failure, missing project trust, any declared path escape or unsafe filesystem object even in optional metadata, exceeded Validation Budget, Invalid or Incompatible classification, and unresolved identity or runtime collisions are Blocking Findings and cannot be waived.
_Avoid_: Warning, confirmation prompt

**Validation Warning**:
A non-blocking finding limited to ignored Inert Metadata or optional presentation data that does not affect active behaviour and has no path, symlink, or filesystem safety violation. It is always disclosed and may be accepted through the applicable confirmation without changing Plugin classification.
_Avoid_: Blocking Finding, silent fallback

**Projected Plugin**:
An Installed Plugin admitted by Effective State and presented to Pi as one complete unit. Any losing or unresolved Runtime Skill Collision prevents the entire Plugin from being projected.
_Avoid_: Partially loaded Plugin, individual projected skill

**Installation ID**:
The canonical identity of an Installed Plugin, composed of its scope and Plugin ID. Plugin version and Marketplace source revision are attributes rather than identity.
_Avoid_: Manifest name alone, install attempt ID
