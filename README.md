# MCSkinSplit

MCSkinSplit is a versioned Minecraft skin studio for lossless UV editing, semantic component extraction, reusable parts, and AI-assisted classification.

The repository is implemented milestone by milestone from the project specification in [`docs/mc-skin-ai-assisted-segmentation-versioned-studio-plan.md`](docs/mc-skin-ai-assisted-segmentation-versioned-studio-plan.md). M0 established the browser baseline, M1 added the deterministic 64×64 RGBA/UV core, M2 added immutable local history, M3 made the 3D avatar Revision-aware, and M4 adds manual semantic editing plus reusable parts.

The current Studio can:

- fully decode 64×64 PNG files to RGBA, including indexed-color PNGs with `tRNS`;
- infer Wide/Classic or Slim/Alex arm layouts and let the user override the result;
- map an Atlas to 72 canonical body surfaces and reconstruct every RGBA pixel;
- render a true 1024×1024 nearest-neighbor Atlas and a semantic face Contact Sheet;
- exercise six versioned real-world skins and a deterministic six-source Alex/Slim mix;
- preview the effective arm layout through one lazy-loaded `skinview3d` viewer that is reused across Revision switches;
- create SQLite-backed Projects with a Slim/Alex default and Import Revisions;
- load any independently verified historical snapshot into the Atlas and 3D avatar together;
- restore an old state as a new Revision or continue it on a new Branch;
- classify exact UV pixels into a fixed semantic taxonomy through a 64×64 draft canvas;
- merge, split, reclassify, or return component pixels to `unknown` without editing history in place;
- export a component as a verified five-file 64×64 part asset;
- preview part conflicts without creating a Revision, then apply an explicit conflict strategy as a new Revision.

## Requirements

- Node.js 24
- pnpm 10.13.1
- A browser with WebGL support

## Start the Studio

```bash
pnpm install
pnpm fixtures:generate
pnpm dev
```

Open `http://127.0.0.1:5173`. The command starts both the Fastify API (`127.0.0.1:3001`) and Vite. The generated Alex/Slim mix is selected by default. Uploading a 64×64 PNG creates a Project and Import Revision; bundled real-world skins can be previewed first and imported with the timeline button.

Runtime metadata and snapshots are stored under `data/`. Set `MC_SKIN_DATA_DIR` before starting the API to use another directory.

## Verify

```bash
pnpm verify
```

This checks that generated fixtures are unchanged, runs TypeScript and unit tests, and builds the production web application.

## Repository layout

```text
apps/api/                 Fastify Project and Revision API
apps/web/                 Vite + React browser Studio
packages/skin-core/       Framework-independent PNG, layout, UV, and render core
packages/skin-revision/   SQLite metadata and immutable snapshot service
docs/                     Architecture, implementation status, and specification
scripts/                  Deterministic fixture tooling
tests/fixtures/skins/     Versioned Minecraft skin fixtures
```

The AI worker and multi-part compositor follow in M5-M6. The canonical UV contract is documented in [`docs/uv-layout.md`](docs/uv-layout.md), the history/storage contract in [`docs/revision-history.md`](docs/revision-history.md), semantic editing and part reuse in [`docs/semantic-editing-and-parts.md`](docs/semantic-editing-and-parts.md), and verification evidence in [`docs/implementation-status.md`](docs/implementation-status.md).
