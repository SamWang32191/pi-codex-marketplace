# Marketplace Compatibility

This context describes how Codex and Claude marketplaces and plugins become usable in Pi while retaining their source-facing identity and an explicit compatibility boundary.

## Language

**Bridge Package**:
The installable Pi package produced by this project and distributed for use by other Pi users.
_Avoid_: Pi plugin, importer, converter

**Bridge Extension**:
The runtime portion of the Bridge Package that presents marketplace and plugin capabilities inside Pi.
_Avoid_: Bridge Package, Codex plugin, Claude plugin

**Bridge State**:
The Bridge-owned durable desired state stored in a single Global Scope document. It contains a schema version and Registration and Installation records; source-derived catalogs, projection results, effective precedence, and diagnostics are recomputed.
_Avoid_: Pi settings, runtime snapshot, cache

**Global Scope**:
The single Bridge scope in which all Registrations and Installations are recorded. Former Project Scope mechanisms are retired; no other scope exists.
_Avoid_: Project Scope, machine-wide effective state

**Effective State**:
The computed view of Global Scope Bridge State. Only enabled Installations participate, and no selected record's independently persisted provenance is merged or mutated.
_Avoid_: Bridge State, persisted merged state

**Marketplace**:
A catalog that identifies plugins available from a source.
_Avoid_: Package registry, plugin directory

**Marketplace Catalog**:
The canonical `.agents/plugins/marketplace.json` or `.claude-plugin/marketplace.json` object within a Marketplace Root, declaring its validated lowercase kebab-case name and Plugin entries. Legacy and Antigravity marketplace-shaped files do not participate in Bridge ingestion.
_Avoid_: `.agents/plugins.json`

**Marketplace Format**:
The format of a Marketplace Source (`codex` or `claude`), deterministically derived from its Marketplace Catalog and fixed to the Marketplace Registration upon `add`. It never changes implicitly; an upstream flip surfaces only through an explicit `update`.
_Avoid_: Protocol version, manifest format, adaptive format

**Marketplace Entry**:
A Marketplace Catalog member that names one Plugin candidate and locates it through a local Contained Path. Git-family and unsupported source kinds are recognized only as Unavailable Entries rather than acquired.
_Avoid_: Marketplace Source, Installed Plugin

**Marketplace Entry ID**:
The snapshot-scoped identity of a Marketplace Entry, composed of its Marketplace ID and canonical JSON Pointer `/plugins/<zero-based ordinal>`. It remains stable when the same catalog is read again and distinguishes malformed or duplicate entries even when no Plugin ID can be derived; source- and catalog-level findings have no Marketplace Entry ID.
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
The non-executing retrieval of a Git Marketplace Source at its current Resolved Revision (`ls-remote HEAD → clone → checkout`). It never runs repository-controlled hooks, filters, submodules, dependencies, or Plugin components.
_Avoid_: Package installation, build, Plugin activation

**Acquisition Trust Base**:
The constrained host components trusted during Source Acquisition: the selected Git and SSH executables, operating-system certificate authorities, pre-established SSH known-host keys, and approved credential helper or SSH agent. The Bridge Package permits only necessary trust and credential configuration, rejects unknown or changed SSH host keys and canonical-locator-changing redirects, and never extends this trust to repository content or repository-controlled Git configuration.
_Avoid_: Project Trust, Plugin trust, sandbox

**Git Selector**:
The structured `default`, `branch`, `tag`, or `commit` choice attached to a Git Marketplace Source. Branch and tag values obey Git ref-name rules and canonicalize to exact case-sensitive `refs/heads/...` or `refs/tags/...` values; commit values are complete 40- or 64-hex object names canonicalized to lowercase. Ambiguous shorthand, abbreviated object names, generic refs, `HEAD`, revision or reflog expressions, option-like values, whitespace, and control characters are not accepted.
_Avoid_: Resolved Revision, arbitrary Git revision expression

**Resolved Revision**:
The full Git commit at which a Git Marketplace Source was acquired. It is a source attribute rather than identity; a changed resolution means the latest material differs, which an explicit `update` re-fetches.
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
The deterministic fingerprint of one acquired or inspected source tree (ordered paths, object types, modes, symlink targets, content hashes), binding the Source Key, verified Canonical Git Locator and Resolved Revision where applicable, and the Validation Ruleset and Validation Budget strings. It is the Source Cache addressing key: Git Registrations and Installations pin their fingerprint, and projection reads the pinned cache entry directly, so the fingerprint must never be replaced by another identity value.
_Avoid_: Live source tree, cache freshness marker

**Validation Ruleset**:
The versioned Bridge contract for source, parser, content, path, symlink, finding, and failure-granularity rules, bound into the Validation Snapshot fingerprint. A changed ruleset changes fingerprints and therefore cache addresses.
_Avoid_: Compatibility Profile alone, implementation version

**Validation Budget**:
A versioned set of fixed, non-waivable limits on acquisition time and size, parser complexity, path depth, file counts, and validation-relevant content. Exceeding a limit produces a Blocking Finding at the owning source, catalog, entry, or Plugin boundary rather than partial or best-effort validation.
_Avoid_: Cache retention policy, warning threshold

**Source Cache**:
Non-authoritative retained Git Marketplace Source material, addressed by Validation Snapshot fingerprint under `${getAgentDir()}/codex-marketplace/cache/entries/<fingerprint>`. The pinned set consists of fingerprints referenced by committed Bridge State plus in-flight pins; pinned entries are never evicted. For Git Registrations the cached entry is the projection runtime material — projection reads it directly, which is why the fingerprint addressing is identity.
_Avoid_: Bridge State, last-known-good source, source of truth

**Marketplace Registration**:
The user-approved association of a Marketplace Source with the Global scope in Pi, created by `add`. Each registration has an immutable Registration ID; its source locator, Source Key, alias, and declared Marketplace name are attributes.
_Avoid_: Subscription, automatic discovery

**Registration ID**:
An opaque, immutable lowercase UUIDv4 generated locally by the Bridge Package for a Marketplace Registration and associated with the Global scope. It is persisted with the registration and never reused. It survives changes to registration attributes.
_Avoid_: Marketplace name, alias, source path, Git URL

**Source Key**:
A deterministic, typed value used to compare Marketplace Sources for duplicate detection and repeated registration; it is not the identity of a Marketplace Registration. A local Source Key uses the Marketplace Root's canonical real path, while a Git Source Key combines a canonical remote URL with its exact selector; local and Git keys remain distinct, and equal keys do not merge registrations.
_Avoid_: Registration ID, user-facing alias

**Registration Alias**:
An optional, human-readable handle for a Marketplace Registration, initially derived from a compatible declared Marketplace name. It is unique within the Global scope and can be explicitly renamed without changing the Registration ID.
_Avoid_: Registration ID, Marketplace name

**Registration Removal**:
The `forget` command removal of a Marketplace Registration and all of its Installations as one disclosed atomic effect.
_Avoid_: Disablement, Scope Override, cross-project cascade

**Plugin**:
A bundle whose `.codex-plugin/plugin.json` or `.claude-plugin/plugin.json` manifest describes its identity and constituent components. The manifest name, rather than the Marketplace entry name or directory path, is the authoritative Plugin name.
_Avoid_: Pi package, Pi extension

**Plugin ID**:
The canonical identity of a Plugin, composed of its Marketplace ID and authoritative manifest name. Version, source revision, Marketplace Entry ordinal, and directory path are attributes; changing the manifest name creates a new Plugin ID without automatically migrating an Installation.
_Avoid_: Marketplace entry name, Plugin path

**Unavailable Entry**:
A Marketplace Entry that cannot supply an installable Plugin because it uses an unsupported source kind, cannot be resolved to a Plugin, yields an unreadable or invalid Plugin, or has a Plugin-level identity collision. It is disclosed with its reason, never silently skipped and never installable. A Runtime Skill Collision affects skill availability and does not make an otherwise activatable entry unavailable.
_Reason categories:_
- _Unsupported source kinds_: non-git source forms (such as `npm`, `archive`, or permanently disqualified `command` sources) or invalid git entry declarations; all git-family entries are Unavailable because entries are never acquired.
- _Unresolvable sources_: missing sources, bare names, unsupported `metadata.pluginRoot` resolution, or non-`./` relative paths.
- _Unsupported entry structure_: entry-defined plugins (`strict: false`) lacking an independent authoritative manifest, conflicting source declarations, or malformed entry objects.
- _Target resolution & validation failures_: missing directory targets, manifest parse failures, path containment violations, or Plugin ID collisions within the catalog.
_Avoid_: Silently skipped entry, partially compatible Plugin

**Skill Descriptor**:
The explicit YAML frontmatter at the start of a Plugin skill's `SKILL.md`, containing the identity and discovery metadata required for projection.
_Avoid_: Directory-name fallback, Skill Body

**Skill Body**:
The Markdown instructions after a Skill Descriptor. Pi treats it as an opaque prompt under its native newline and whitespace normalization.
_Avoid_: Executable template, dynamic command

**Skill ID**:
The canonical identity of a Plugin skill, composed of its Plugin ID and Skill Descriptor name. Version and directory path are attributes rather than identity.
_Avoid_: Globally unique skill name, SKILL.md path

**Runtime Skill Collision**:
A conflict in Pi's flat skill namespace when different Skill IDs, or a Plugin skill and a pre-existing Pi skill, claim the same exact Skill Descriptor name. It changes only skill availability, never Plugin classification: candidates resolve per name in `Pi → Global Scope` order, all same-layer Bridge colliders are unavailable, and only a surviving higher-layer skill reserves the name, so a lower-layer candidate survives when no higher-layer skill does.
_Avoid_: Skill ID collision, canonical-path duplicate

**Projected Plugin**:
An Installed Plugin admitted by Effective State. It contributes zero or more Projected Skills; a Plugin whose skills cannot be resolved is still installed and disclosed with its skill count.
_Avoid_: Partially compatible Plugin, Pi package

**Projected Skill**:
A skill of a Projected Plugin that survives Runtime Skill Collision resolution and is exposed to Pi under its Skill Descriptor name while retaining its Skill ID and provenance. A colliding skill that does not survive is unavailable without changing its Plugin's Projected status.
_Avoid_: Compatible Plugin, renamed skill

**Runtime Skill Exposure**:
The read-time participation of Projected Skills in Pi through host resource discovery contributed by the Bridge Extension at session start or runtime reload. It derives entirely from the current Effective State and its collision survivors, performs passive existence inspection only, never mutates Bridge State, and is neither confirmation nor activation admission. Exposure never establishes Skill Availability. `install` / `enable` / `update` request a host reload as the only activation action; a failed reload does not affect the recorded state.
_Avoid_: Installation, Marketplace Refresh, activation confirmation

**Skill Availability**:
The evidence status of an Installed Plugin skill, for which the Bridge may report eligibility, known unavailability, or unverified availability while only independent host evidence may establish that it is Available. It does not alter Plugin classification or whole-state application.
_Avoid_: Compatibility, projection success, inferred availability

**Installation ID**:
The canonical identity of an Installed Plugin within the Global scope, composed of its Plugin ID. It remains stable across reinstallation, while a new Plugin ID requires a new Installation ID.
_Avoid_: Manifest name alone, install attempt ID

**Plugin Installation**:
The `install` command creating an Installation in the Global scope. Installing always grabs the current latest material (重裝＝更新：reinstalling the same Plugin re-fetches the latest and overwrites, never an error) and enables it atomically: install and enable are one step, no separate confirmation flow.
_Avoid_: Pi package installation, Marketplace Registration, implicit activation

**Installed Plugin**:
A Plugin selected from a Marketplace and durably recorded within the Global scope in Pi. Its Installation State determines whether it participates in Effective State.
_Avoid_: Marketplace entry, bundled plugin

**Installation State**:
The durable `enabled` or `disabled` condition of an Installed Plugin. A disabled Installation retains its Installation ID and recorded provenance but is excluded from Effective State; enabling it re-projects its skills and requests a reload.
_Avoid_: Scope Override, Plugin classification, runtime status

**Installation Removal**:
The `remove` command deleting one Installation while retaining its Marketplace Registration.
_Avoid_: Disablement, Registration Removal, Scope Override

**Validation Finding**:
A machine-readable validation result identified by a stable rule code and carrying its classification, safe source provenance, affected domain identity, file or data pointer, and operational outcome. Secret-bearing input is redacted, and presentation is derived from the finding rather than stored as authority.
_Avoid_: Free-form log line, persisted source truth

**Blocking Finding**:
A structured finding that denies its stated target — a Registration, an Installation, an individual skill's availability, or one management attempt — rather than requesting consent. Source, trust, snapshot, safety, or budget failures deny their Registration or whole-Plugin target; a Runtime Skill Collision denies only its colliding skill candidates; none can be waived.
_Avoid_: Warning, confirmation prompt