# Pinned fixture — SamWang32191/codex-plugins@98e78caf

Real-world Codex marketplace pinned at a content-addressed commit to ensure stability.

- Source: `https://github.com/SamWang32191/codex-plugins` at `98e78caf2b658dc5ccfd77720b0849dff9b7e99a`.
- `codex-plugins-98e78caf.json` stores the exact catalog and complete `cmd`/`dev` Plugin trees as base64 chunks, including binary assets.
- The integration tier materializes those bytes into a temporary Marketplace Root and validates both entries through the normal inspection and install-list pipeline.

The fixture metadata records the full commit and source repository; regeneration must read Git blobs from that exact commit rather than a movable branch or tag.
