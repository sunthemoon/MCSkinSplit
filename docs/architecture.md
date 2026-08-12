# Architecture baseline

MCSkinSplit separates deterministic pixel operations from semantic classification and immutable persistence.

```text
Browser UI
  -> HTTP API (M2)
    -> Revision service (M2)
    -> Deterministic skin core (M1)
    -> AI job service (M5)
    -> Composition service (M6)
    -> Part repair service (M8)
    -> Composition restoration service (M9)
    -> Restoration recommendation job service (M10)

Deterministic skin core
  -> PNG RGBA decoder
  -> Classic/Slim UV layouts
  -> Atlas/surface round trip
  -> masks, spans, semantic operations, and parts
  -> exact single-part repair operations and mask derivation

Skin compositor
  -> ordered part layers over an immutable base
  -> validated Outer clear and opaque Base restoration plan
  -> per-pixel winner selection
  -> model, semantic-boundary, and overlap conflict reports

AI worker
  -> isolated, integrity-checked analysis workspace
  -> replaceable provider
  -> schema and pixel-ownership validator
  -> proposal returned to revision service
  -> separate restoration-recommendation workspace and exact candidate-ID validator

Part repair service
  -> append-only part-edit Revisions
  -> atomic texture, write-mask, and operation storage
  -> immutable five-file part commit

Composition restoration service
  -> deterministic host-side candidate derivation from semantic snapshots
  -> versioned candidate-ID/hash plans and append-only audit events
  -> preview and compose-Revision restoration provenance

Restoration recommendation job service
  -> public candidate catalog and user intent only
  -> repository replacement-planner Skill and shared provider telemetry
  -> advisory ranked IDs loaded for review, never automatic plan application
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

## M4 decisions

- `packages/skin-core` owns the fixed semantic taxonomy, masks, spans, palettes,
  manual operations, part extraction, and deterministic single-part conflict
  analysis. These functions remain framework-independent.
- Every valid, non-transparent UV pixel belongs to exactly one confirmed component
  or `unknown`. Masks are authoritative; spans and palettes are validated derived
  data.
- Brush gestures are disposable browser drafts. Only a confirmed semantic
  operation creates a Revision, and only the Branch HEAD can be edited directly.
- Revision snapshots add dynamically named component mask PNGs to the same hash and
  asset verification boundary as the core files. Older snapshots are upgraded only
  when producing a new Revision.
- Exported parts are immutable five-file assets. Export does not mutate the source
  Revision; application always previews first and requires an explicit conflict
  strategy before it creates an `apply_part` Revision.
- M4 single-part conflict reports remain a lightweight preview contract. M6 owns
  ordered layer-to-layer, model, and semantic-boundary conflict evaluation.

The detailed contract is in
[`semantic-editing-and-parts.md`](semantic-editing-and-parts.md).

## M5 decisions

- `packages/skin-analysis-pack` deterministically renders model-facing views and
  partitions every visible valid UV pixel into bounded same-surface color
  candidates. Candidate regions accelerate classification; they are not semantic
  truth.
- Every run receives a private workspace containing versioned input, schema, Skill,
  output, and log directories. Input and Skill hashes are verified after provider
  execution before any proposal can be accepted.
- `packages/ai-provider` owns the replaceable model boundary. The default adapter
  starts `codex exec` without a shell, applies timeout/cancellation/log limits, and
  captures JSONL diagnostics.
- The model can write only a JSON proposal. Host-side Ajv and deterministic pixel
  checks require complete, non-overlapping ownership before the proposal is
  converted to semantic masks.
- `apps/ai-worker` persists Job, Run, Asset, and Event records. One repair attempt is
  allowed by default; every attempt remains independently auditable.
- Failed and cancelled jobs never create a Revision. A successful job can create an
  immutable `ai_segment` Revision only when its exact input is still the Branch
  HEAD. The PNG bytes remain unchanged.
- Low-confidence components are retained with `needs_review` state instead of being
  silently promoted to confirmed data.

The detailed contract is in [`ai-analysis.md`](ai-analysis.md).

## M6 decisions

- `packages/skin-compositor` is a pure framework-independent evaluator. It receives
  decoded base/part images, masks, manifests, ordered positions, and conflict
  decisions; it does not read SQLite, the filesystem, HTTP state, or React state.
- The base participates as a fixed non-transparent pixel writer. Parts are ordered
  bottom to top, and the highest layer is the preview winner.
- Same-color overlap is non-blocking. Different colors require either an explicit
  per-pixel winner or an explicit whole-stack layer-order confirmation. Model and
  semantic-boundary conflicts always block.
- `packages/skin-revision` owns Composition Project persistence and revalidates all
  hashes, manifests, Branch HEAD concurrency, and conflict decisions at commit.
- Layer changes invalidate prior decisions. A committed Composition Project is
  immutable and references its resulting `compose` Revision.
- Winning layer pixels become composed semantic components without duplicating
  pixels that were hidden by higher layers.

The detailed contract is in
[`composition-workflow.md`](composition-workflow.md).

## M8 decisions

- `packages/skin-core` owns exact part-repair transforms. It accepts decoded 64x64
  RGBA images, write masks, model-aware spans, and canonical surface mappings; it
  does not read the database, filesystem, HTTP state, or React state.
- A repair project starts from a verified immutable atomic part selected directly
  from the library. It has a separate linear Revision history and never mutates a
  full-skin Revision or the base part.
- Repair texture alpha is authoritative for the sparse write mask. Painting can
  add valid transparent UV; erasure removes pixels; all unused UV must remain
  transparent.
- Donor operations persist an immutable source identity rather than embedding
  image state in JSON. The Revision service resolves and verifies the source part
  or repair Revision before invoking the deterministic core. Repair-Revision
  sources are confined to the same part-edit project; cross-project reuse goes
  through a committed immutable part.
- Each repair Revision is written atomically as texture, write mask, and revision
  JSON before SQLite metadata is committed. All three files are hash-verified on
  reads.
- Commit creates a normal immutable five-file part with a PartManifest `1.1`
  `part_repair` derivation. Its manifest and source provenance record the base
  part, repair project, repair HEAD, and non-generated authored status.
- Neutral mannequin textures are derived from verified repair files. The browser
  reuses the existing 3D adapter for Wide/Slim geometry, idle/walk display,
  pointer rotation, and wheel zoom. It also applies the configured operation in
  memory to cached immutable inputs and feeds disposable Blob URLs to both the 2D
  canvas and 3D mannequin. This local draft is not persisted until the explicit
  apply request creates a validated child Revision.

The detailed contract is in
[`component-repair-workflow.md`](component-repair-workflow.md).

## M9 decisions

- `packages/skin-core` derives restoration target groups and candidate evidence
  from immutable semantic Revisions. The complete hair, clothing, and accessory
  controls expand to fine component IDs; the fixed 23-category taxonomy remains
  authoritative.
- One aggregate candidate clears all selected Outer pixels. Every selected Base
  group instead requires one opaque fill candidate derived from current
  same-surface skin, current same-body-part skin, a mirrored counterpart, one
  compatible donor Revision, or an explicit manual RGBA value.
- Candidate generation is deterministic and non-mutating. The HTTP boundary
  returns summaries, IDs, hashes, and coverage only. It does not expose masks,
  pixel IDs, operations, or a generated PNG, and no AI provider participates.
- Plan application repeats the candidate-generation inputs. The Revision service
  regenerates the set, validates the hash and IDs, and uses a monotonic version to
  reject stale apply/clear requests.
- `packages/skin-revision` stores the current hash-verified plan and append-only
  set/clear events. `packages/skin-compositor` materializes the trusted plan over
  the base before evaluating normal part layers; missing Base coverage or plan
  integrity issues block commit.
- A committed `compose` Revision records plan identity and counts in its operation
  metadata. Restored opaque pixels receive `composition_restoration` semantic
  provenance; manual fills are marked as user-authored pixels without a source
  texel. Component-level merging preserves only unambiguous same-plan evidence.

The detailed contract is in
[`composition-restoration-workflow.md`](composition-restoration-workflow.md).

## M10 decisions

- AI replacement assistance is a new `restoration_recommendation` Job kind, not
  another responsibility of `mc-skin-segmenter`. The fixed 23-category taxonomy
  and `hair`/`clothing`/`accessory` aggregate selection views remain unchanged.
- `packages/skin-analysis-pack` builds a separate immutable planning workspace
  from the M9 public catalog. It copies
  `.agents/skills/mc-skin-replacement-planner` and its JSON Schema per Run and
  verifies all input hashes after provider execution. No images are attached.
- The default replacement provider ignores user configuration, clears MCP/apps,
  disables shell, web, browser, computer, image, plugin, and delegation tools,
  uses a read-only sandbox, and inlines the public catalog. This tool-free profile
  is specific to replacement recommendation; semantic analysis keeps its existing
  configurable image-and-workspace invocation.
- `packages/ai-provider` accepts only the planner's structured ID recommendation.
  Deterministic validation requires exact Job/Composition/candidate-set identity,
  every Base group, exact per-group ID permutations, a complete selected
  candidate, and prose without private pixel/color/image evidence.
- The worker and API reuse generic persistent Job, Run, Asset, Event, retry,
  cancellation, and live JSONL projection behavior. Job kind and Composition ID
  keep semantic-analysis and replacement-recommendation queries distinct.
- Success stores an advisory result only. It does not create a Revision or alter
  the Composition. The browser rejects stale catalog version/hash results; loading a
  recommendation changes local candidate selection, while the existing M9
  **Apply** request remains the only restoration-plan write boundary.
- Manual deterministic selection is a first-class no-AI fallback. Each
  task-specific Skill is a repository-scoped asset copied into its Run workspace,
  not a required global Codex install.

## Package boundaries

```text
apps/web                 UI, editors, AI consoles, compositor, repair, restoration, and preview adapters
apps/api                 HTTP API, revision, AI, composition, repair, restoration, and recommendation orchestration
apps/ai-worker           persistent semantic/recommendation jobs, validation, and audit assets
packages/skin-core       PNG, UV, pixels, semantic edits, parts, repair, and restoration (M1-M9)
packages/skin-revision   immutable snapshots, parts, repair histories, AI audit, and compositions
packages/skin-compositor ordered layers, restoration, and deterministic conflict evaluation (M6/M9)
packages/skin-analysis-pack deterministic model inputs, candidate catalogs, and manifests (M5/M10)
packages/ai-provider     replaceable model execution and task-specific validation (M5/M10)
```
