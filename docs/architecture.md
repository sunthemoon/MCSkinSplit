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

## Planned package boundaries

```text
apps/web                 UI and 2D/3D adapters
apps/api                 HTTP API and revision orchestration
apps/ai-worker           isolated analysis jobs
packages/skin-core       PNG, UV, pixels, masks, render helpers
packages/skin-schema     JSON schemas and shared types
packages/skin-revision   immutable snapshots and branching
packages/skin-compositor part application and conflict detection
packages/skin-analysis-pack analysis workspace generation
packages/ai-provider     replaceable provider contracts
```
