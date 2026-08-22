# Pinned fixture — SamWang32191/codex-plugins@98e78ca

Real-world Codex marketplace pinned at a content-addressed commit to ensure stability.

- Source: `https://github.com/SamWang32191/codex-plugins` at `98e78ca` (tag `v98e78ca` or ref `98e78ca...`)
- Captured snapshot manifest: `pinned/manifest.json` (Validation Snapshot fingerprint + catalog entry outcomes)
- Used as the integration/E2E tier's realistic catalog: entries are read via non-executing Git acquisition at the Resolved Revision, validated through the same pipeline as synthetic.

Regeneration:

```bash
node scripts/capture-pinned.mjs  # clones at 98e78ca, builds snapshot, writes manifest.json
```

The manifest's fingerprint is asserted in tests so drift from the pinned commit is caught.
