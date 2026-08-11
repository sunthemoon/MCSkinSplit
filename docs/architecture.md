# Architecture baseline

MCSkinSplit separates deterministic pixel operations from semantic classification and immutable persistence.

```text
Browser UI
  -> HTTP API (M2)
    -> Revision service (M2)
    -> Deterministic skin core (M1)
    -> AI job service (M5)

Deterministic skin core
  -> PNG RGBA decoder
  -> Classic/Slim UV layouts
  -> Atlas/surface round trip
  -> masks, spans, composition, conflict reports

AI worker
  -> read-only analysis workspace
  -> replaceable provider
  -> schema validator
  -> proposal returned to revision service
```

## M0 decisions

- The repository had no pre-existing application, so M0 establishes the regression baseline rather than migrating an older page.
- The web baseline uses Vite, React, and TypeScript. Pixel and persistence packages remain framework-independent.
- `skinview3d` is pinned as an npm dependency and bundled locally by Vite. The browser does not rely on a CDN.
- The installed 3.4.2 API uses `viewer.animation = new WalkingAnimation()` and `viewer.autoRotate = true`.
- The bundled fixture is created by a deterministic script and can be checked without rewriting it.

## M1 decisions

- `packages/skin-core` is framework-independent and has no React, WebGL, AI, database, or persistence dependency.
- A decoded `RgbaImage` is the source of truth for pixel work. Blob URLs remain presentation adapters for `skinview3d`, not the pixel model.
- Wide and Slim layouts are versioned JSON inputs validated by a JSON Schema in tests and expanded to 72 fixed surface rectangles at module load.
- Canonical surfaces are outside-facing. Explicit orientation transforms normalize Atlas coordinates and make the inverse write deterministic.
- Used UV pixels live in surface textures; every other Atlas byte lives in `unusedAtlasData`. The two stores are disjoint and together reconstruct the full image.
- The PNG adapter normalizes supported PNG color formats to 8-bit RGBA. The contract preserves decoded RGBA, not original PNG container bytes or metadata.
- The web adapter renders derived RGBA images into Canvas 2D with smoothing disabled. The core remains DOM-free.

The detailed coordinate and inference contract is in [`uv-layout.md`](uv-layout.md).

## M2 decisions

- `packages/skin-revision` owns strict SQLite metadata, complete immutable snapshots, canonical JSON, and hash verification.
- `apps/api` is the only HTTP boundary. It accepts raw `image/png` imports and returns structured Project/Branch/Revision state.
- Revert and Branch are append-only graph operations. Neither path edits historical files or moves an unrelated Branch HEAD.
- The detailed persistence and API contract is in [`revision-history.md`](revision-history.md).

## M3 decisions

- `McSkinPreview` owns one Viewer instance, texture request ordering, animation compatibility, ResizeObserver scheduling, and disposal.
- React owns only the Canvas mount and current skin/model props. Revision changes call the adapter instead of remounting the Viewer.
- The installed 3.4.2 branch uses `viewer.animation`; `animations.add` exists only inside the compatibility function for older/custom bundles.
- `skinview3d` is dynamically imported. The Studio/Atlas bundle can render before the WebGL dependency finishes loading or if it fails.
- Viewer dimensions follow observed content size and are written in a scheduled animation frame. CSS size and WebGL backing-buffer size remain separate through device pixel ratio handling.

## Planned package boundaries

```text
apps/web                 UI and 2D/3D adapters (M0-M3)
apps/api                 HTTP API and revision orchestration
apps/ai-worker           isolated analysis jobs
packages/skin-core       PNG, UV, pixels, and render helpers (M1)
packages/skin-schema     JSON schemas and shared types
packages/skin-revision   immutable snapshots and branching (M2)
packages/skin-compositor part application and conflict detection
packages/skin-analysis-pack analysis workspace generation
packages/ai-provider     replaceable provider contracts
```
