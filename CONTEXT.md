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

**Marketplace Root**:
The directory that contains a Marketplace and the Plugin paths referenced by that Marketplace.
_Avoid_: Plugin directory, installation directory

**Marketplace Source**:
An explicitly chosen local directory or Git repository that supplies a Marketplace Root.
_Avoid_: Plugin source, marketplace entry

**Marketplace Registration**:
The user-approved association of a Marketplace Source with either a global or project scope in Pi.
_Avoid_: Subscription, automatic discovery

**Plugin**:
A Codex-format bundle whose manifest describes its identity and constituent components.
_Avoid_: Pi package, Pi extension

**Compatibility Profile**:
A declared boundary identifying the Codex component types and behaviours the Bridge Package supports. Compatibility Profile v1 contains skill components only.
_Avoid_: Best-effort compatibility, silent fallback

**Compatible Plugin**:
A Plugin whose required components and behaviours fall within the Bridge Package's declared compatibility boundary.
_Avoid_: Converted plugin, Pi-native plugin

**Installed Plugin**:
A Compatible Plugin selected from a Marketplace and made available within either a global or project scope in Pi.
_Avoid_: Marketplace entry, bundled plugin
