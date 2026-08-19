# Codex Marketplace Compatibility

This context describes how Codex marketplaces and plugins become usable in Pi while retaining their Codex-facing identity and an explicit compatibility boundary.

## Language

**Bridge Package**:
The installable Pi package produced by this project and distributed for use by other Pi users.
_Avoid_: Pi plugin, importer, converter

**Bridge Extension**:
The runtime portion of the Bridge Package that presents marketplace and plugin capabilities inside Pi.
_Avoid_: Bridge Package, Codex plugin

**Marketplace**:
A Codex-format catalog that identifies plugins available from a source.
_Avoid_: Package registry, plugin directory

**Marketplace ID**:
The canonical identity of a Marketplace, composed of its Registration ID and declared Marketplace name. It distinguishes same-named Marketplaces from different registrations; changing the declared name changes the Marketplace identity.
_Avoid_: Registration Alias, globally unique Marketplace name

**Marketplace Root**:
The directory that contains a Marketplace and the Plugin paths referenced by that Marketplace.
_Avoid_: Plugin directory, installation directory

**Marketplace Source**:
An explicitly chosen local directory or Git repository that supplies a Marketplace Root. Local and Git sources are distinct source kinds even when the local directory is a clone of the Git repository; the Bridge Package does not infer equality from Git remotes or commits.
_Avoid_: Plugin source, marketplace entry

**Marketplace Registration**:
The user-approved association of a Marketplace Source with either a global or project scope in Pi. Each registration has an immutable Registration ID and independently scoped state; its source locator, Source Key, alias, and declared Marketplace name are attributes.
_Avoid_: Subscription, automatic discovery

**Registration ID**:
An opaque, immutable lowercase UUIDv4 generated locally by the Bridge Package for a Marketplace Registration. It is the persistence anchor that survives changes to registration attributes.
_Avoid_: Marketplace name, alias, source path, Git URL

**Source Key**:
A deterministic, typed value used to compare Marketplace Sources for duplicate detection and repeated registration; it is not the identity of a Marketplace Registration. A local Source Key uses the Marketplace Root's canonical real path, while a Git Source Key combines a canonical remote URL with its exact selector; local and Git keys remain distinct.
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

**Skill Descriptor**:
The explicit YAML frontmatter at the start of a Plugin skill's `SKILL.md`, containing the identity and discovery metadata required by its Compatibility Profile.
_Avoid_: Directory-name fallback, Skill Body

**Skill Body**:
The Markdown instructions after a Skill Descriptor. Compatibility Profile v1 treats it as an opaque prompt under Pi's native newline and whitespace normalization.
_Avoid_: Executable template, dynamic command

**Skill ID**:
The canonical identity of a Plugin skill, composed of its Plugin ID and Skill Descriptor name. Version, directory path, and Skill Agent Profile are attributes rather than identity.
_Avoid_: Globally unique skill name, SKILL.md path

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
A Compatible Plugin selected from a Marketplace and made available within either a global or project scope in Pi.
_Avoid_: Marketplace entry, bundled plugin

**Installation ID**:
The canonical identity of an Installed Plugin, composed of its scope and Plugin ID. Plugin version and Marketplace source revision are attributes rather than identity.
_Avoid_: Manifest name alone, install attempt ID
