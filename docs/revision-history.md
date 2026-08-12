# Revision history contract

MCSkinSplit treats SQLite metadata and complete Revision snapshots as the authoritative project state. A browser session or an agent thread is never the source of truth.

## Invariants

1. A confirmed mutation creates a new Revision ID and a new snapshot directory.
2. Existing Revision files and rows are never updated in place.
3. Every Revision independently contains the skin, segmentation state, operation record, checksum manifest, and any semantic masks needed to load it.
4. A Revert Revision copies the selected historical state but uses the current target Branch HEAD as its parent.
5. A Branch Revision uses the selected historical Revision as its parent and does not move the source Branch HEAD.
6. Snapshot reads fail with `SNAPSHOT_CORRUPT` when a file, checksum, asset record, or result hash disagrees.

## Storage layout

```text
data/
├── mcskinsplit.sqlite
├── projects/<project-id>/revisions/<revision-id>/
│   ├── skin.png
│   ├── segmentation.json
│   ├── operation.json
│   ├── checksum.json
│   └── components/
│       ├── unknown.mask.png
│       └── <component-instance-id>.mask.png
└── part-edits/<part-edit-project-id>/revisions/<part-edit-revision-id>/
    ├── texture.png
    ├── write-mask.png
    └── revision.json
```

`skin.png` and component masks are canonical 64×64 RGBA PNGs. JSON files use recursively sorted keys and a trailing newline. Hash strings use the `sha256:<hex>` form. M2/M3 snapshots without component masks remain valid historical inputs; the first later semantic edit writes a complete M4 snapshot.

Snapshot creation writes every core and mask file into a private sibling temporary directory, synchronizes each file, and atomically renames the directory. SQLite assets are then attached to the new Revision in one immediate transaction. A failed metadata transaction removes only that new snapshot.

## Local API

`pnpm dev` starts the API on `http://127.0.0.1:3001` and Vite on `http://127.0.0.1:5173`; Vite proxies `/api` requests. Set `MC_SKIN_DATA_DIR` to override the repository `data` directory, and use `MC_SKIN_API_HOST` or `MC_SKIN_API_PORT` to override the listener.

Main M2 endpoints:

```text
GET    /api/projects
POST   /api/projects
GET    /api/projects/:projectId
POST   /api/projects/:projectId/import
GET    /api/projects/:projectId/branches
POST   /api/projects/:projectId/branches
GET    /api/projects/:projectId/revisions
GET    /api/revisions/:revisionId
GET    /api/revisions/:revisionId/skin.png
GET    /api/revisions/:revisionId/segmentation
GET    /api/revisions/:revisionId/diff/:otherRevisionId
POST   /api/revisions/:revisionId/revert
POST   /api/revisions/:revisionId/branch
POST   /api/revisions/:revisionId/operations
POST   /api/revisions/:revisionId/components/:componentId/export-part
GET    /api/parts
GET    /api/parts/:partId
GET    /api/parts/:partId/texture.png
GET    /api/parts/:partId/preview.png
POST   /api/revisions/:revisionId/apply-part
GET    /api/part-edits
POST   /api/part-edits
GET    /api/part-edits/:projectId
POST   /api/part-edits/:projectId/operations
POST   /api/part-edits/:projectId/commit
GET    /api/part-edit-revisions/:revisionId/texture.png
GET    /api/part-edit-revisions/:revisionId/write-mask.png
GET    /api/part-edit-revisions/:revisionId/mannequin.png
```

Create a Project with JSON `{ "name": "Example" }`, then send the skin bytes to its import endpoint with `Content-Type: image/png`. Optional `fileName` and `armType=wide|slim` query parameters preserve import context or apply an explicit model override. The body limit is 1 MiB.

## Hash model

`checksum.json` records hashes for the PNG, segmentation, operation, and dynamic mask files. SQLite also records each asset path, byte size, and file hash. `resultHash` is computed from the skin bytes and semantic state while excluding the Revision-specific ID, so Revert and Branch copies retain the same state identity without sharing mutable files.

The M4 operation and part contracts are documented in
[`semantic-editing-and-parts.md`](semantic-editing-and-parts.md).
The separate M8 single-part history, hash, commit, and API contracts are documented
in [`component-repair-workflow.md`](component-repair-workflow.md).
