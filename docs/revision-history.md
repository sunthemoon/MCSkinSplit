# Revision history contract

MCSkinSplit treats SQLite metadata and complete Revision snapshots as the authoritative project state. A browser session or an agent thread is never the source of truth.

## Invariants

1. A confirmed mutation creates a new Revision ID and a new snapshot directory.
2. Existing Revision files and rows are never updated in place.
3. Every Revision independently contains the skin, segmentation state, operation record, and checksum manifest needed to load it.
4. A Revert Revision copies the selected historical state but uses the current target Branch HEAD as its parent.
5. A Branch Revision uses the selected historical Revision as its parent and does not move the source Branch HEAD.
6. Snapshot reads fail with `SNAPSHOT_CORRUPT` when a file, checksum, asset record, or result hash disagrees.

## Storage layout

```text
data/
├── mcskinsplit.sqlite
└── projects/<project-id>/revisions/<revision-id>/
    ├── skin.png
    ├── segmentation.json
    ├── operation.json
    └── checksum.json
```

`skin.png` is a canonical 64×64 RGBA PNG. JSON files use recursively sorted keys and a trailing newline. Hash strings use the `sha256:<hex>` form.

Snapshot creation writes all four files into a private sibling temporary directory, synchronizes each file, and atomically renames the directory. SQLite assets are then attached to the new Revision in one immediate transaction. A failed metadata transaction removes only that new snapshot.

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
```

Create a Project with JSON `{ "name": "Example" }`, then send the skin bytes to its import endpoint with `Content-Type: image/png`. Optional `fileName` and `armType=wide|slim` query parameters preserve import context or apply an explicit model override. The body limit is 1 MiB.

## Hash model

`checksum.json` records hashes for the PNG, segmentation, and operation files. SQLite also records each asset path, byte size, and file hash. `resultHash` is computed from the skin bytes and semantic state while excluding the Revision-specific ID, so Revert and Branch copies retain the same state identity without sharing mutable files.
