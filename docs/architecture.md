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
    -> Semantic follow-up service (M15)

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
  -> exact CandidateRegions plus deterministic evidence graph and visual grounding
  -> replaceable provider
  -> schema and pixel-ownership validator
  -> proposal returned to revision service
  -> separate restoration-recommendation workspace and exact candidate-ID validator
  -> deterministic post-segmentation assessment and explicit follow-up actions

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

Semantic follow-up service
  -> clean semantic baseline by default; existing labels are an advanced soft prior
  -> deterministic cross-body classification suggestions over exact candidate spans
  -> user-confirmed immutable semantic Revision on a dedicated Branch
  -> original catalog result plus optional verified classification-repair variant
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
  starts `codex exec` without a shell in a read-only, tool-free profile, inlines
  the immutable semantic contract, attaches only the prepared skin views, applies
  timeout/cancellation/log limits, and captures JSONL diagnostics. Skill `1.4.0`,
  prompt `semantic-proposal-v7-all-surface-grounding`, proposal Schema `1.2`, and
  validator v3 identify the current runtime contract. Prompt v7 retains explicit
  cross-body long-hair guidance, consumes host-generated graph/grounding evidence,
  and keeps every bounded pixel transfer explicit.
- The model returns only a JSON proposal captured by the provider. It cannot read
  or write the Run workspace. Host-side Ajv and deterministic pixel checks require
  complete, non-overlapping ownership before the proposal is converted to semantic
  masks. Structured-output transport failure may trigger one local-JSON fallback;
  host validation remains identical.
- Provider failures, including timeout and cancellation, carry captured JSONL and
  stderr into audited Run assets when those streams contain data.
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
  uses a read-only sandbox, and inlines the public catalog. Semantic analysis now
  uses the same tool-free/read-only capability boundary with attached skin views
  and an inline semantic contract, while retaining configured model/provider
  routing unless `AI_IGNORE_USER_CONFIG` is enabled.
- Both tool-free providers capture one JSON response by default and apply the
  repository Schema plus deterministic host validation. Native
  `--output-schema` transport is available only through
  `AI_USE_OUTPUT_SCHEMA=true`; its compatibility fallback never bypasses host
  validation.
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

## M11 decisions

- Semantic mistakes are corrected through the existing immutable Revision model.
  Whole-component removal is a host-authored `unassign_pixels` operation over the
  component's stored spans, not a texture edit or destructive database delete.
- `part_asset` and `part_bundle` remain immutable content records. Their separate
  library lifecycle is reversible `active`/`retired` metadata; files, hashes,
  membership, provenance, and historical references remain readable.
- Source Project, Branch, and Revision provenance is joined into Part and Bundle
  list DTOs instead of being copied into display-name prefixes. Search and filters
  therefore remain stable when users rename an asset or two Projects share a name.
- Bundle member replacement creates a new immutable Bundle and retires the old
  identity in one transaction. It does not mutate `part_bundle_member` rows in
  place or silently replace the same Part in every Bundle.
- Creating new references requires active assets. Repair apply/commit and
  Composition commit repeat active-state checks so retirement after a draft was
  opened cannot bypass the lifecycle decision. Historical previews and committed
  snapshots continue to resolve retired IDs.

## M15 decisions

- New semantic Jobs use `semanticBaseline: "empty"` unless the advanced request
  explicitly selects `"current"`. Both modes retain the immutable previous
  segmentation in the analysis pack for host validation and audit; only current
  mode sends a compact component summary to the model as a non-authoritative prior.
- The player surface has one primary analysis action and six persistent stages:
  preparation, model identification, host validation, deterministic cross-body
  assessment, user confirmation when needed, and catalog availability. Provider,
  model, reasoning, retry, Run, and raw-event controls remain available under
  advanced disclosure.
- `packages/skin-analysis-pack` owns the deterministic semantic follow-up
  assessment. Current algorithm `cross-body-hair-reclassification-v2` can group
  nearby matching fragments on the same torso surface before testing the combined
  drape and can suggest reclassifying their exact spans from clothing to an
  established hair component. Compatible evidence backed by multiple hair
  components is represented by one deterministic cross-body hair component. The
  assessor does not call a model or author coordinates, colors, transparency, or
  new pixels. Version v1 remains readable for historical Job evidence, but pending
  v1 suggestions are read-only and require a new analysis before application.
- `apps/ai-worker` persists assessment identity and state next to the successful
  semantic Job. Apply reloads and reassesses the immutable result, checks the
  evidence hash and suggestion ID, creates a dedicated Branch, and submits the
  exact spans through the normal semantic Revision service. Dismiss has no
  Revision side effect.
- `packages/skin-revision` keeps the successful AI Revision as the catalog root.
  An applied follow-up Revision is integrity-loaded and exposed beneath it as
  `分类修复版`, with groups derived from that Revision rather than copied from the
  original. Catalog archive and Part/Bundle lifecycle remain independent.
- Follow-up success is classification repair only. `no_repair` means no safe rule-
  based suggestion was found; it does not prove that no content is occluded.
  Generating hidden clothing or hair pixels remains outside M15.

## M16 decisions

- Unknown is an independent ownership mask, not an AI component category. Every
  CandidateRegion belongs to exactly one component, the unassigned bucket, or one
  review item.
- Proposal-wide pixel overrides are limited to 64 unique pixels and 32 spans.
  An added pixel is valid only when the component owning its Region removes that
  same pixel; unmatched removals intentionally return pixels to Unknown. Schema
  1.0 artifacts remain readable, while new validation requires Schema 1.1.
- The current component-level provenance model cannot safely carry known authored
  or generated pixels through a fresh AI segmentation. For runs that will create
  a Revision, the worker rejects generated semantic state and effective
  `apply_part`, `compose`, or `palette_change` ancestry before Job creation,
  before provider execution, and before commit. Read-only runs remain available.
  This commit boundary is deliberately conservative until per-pixel origin exists.
- Retry never silently upgrades a legacy semantic contract. Stored Skill name,
  Skill version, and prompt version must match the installed contract; otherwise
  the caller must start a fresh analysis from the source Revision.
- Migration 013 enforces append-only Revision, operation, revision-bound asset,
  Part file/content, Part-edit Revision, and Bundle membership history in SQLite.
  Snapshot and Part staging files retain one tightly checked `NULL`-to-owner
  binding transition; project heads, repair-project state, and library lifecycle
  fields remain mutable.

## M17 decisions

- Existing CandidateRegions remain the exact deterministic ownership partition.
  A separately versioned Candidate Evidence Graph adds stable visual IDs and
  host-computed geometry, shape, surface-edge, dominant-color, and relation
  evidence without changing Region pixels or semantic categories.
- Graph edges are limited to coordinate-verifiable same-surface contact/proximity,
  canonical UV seams, Base/Outer same-texel projection, and bilateral mirror
  mappings. The graph does not derive adjacency from Atlas layout and does not
  invent perspective, hidden 3D, or cross-body edges.
- The analysis pack owns deterministic four-direction orthographic grounding.
  Composite, Base, and Outer natural-color sheets are paired with CandidateRegion
  pseudocolor sheets and a stable-ID legend. A labelled natural/CandidateRegion
  six-face sheet covers top and bottom, and the all-surface natural/candidate Atlas
  pair preserves exact UV lookup. Role/path order is a checked provider input;
  separate face sheets remain hashed audit artifacts rather than duplicate model
  attachments.
- The provider receives compact graph and grounding manifests rather than the full
  pixel map or full graph. A 300,000-character prompt limit is enforced before CLI
  execution. Visual IDs are lookup aids only; exact CandidateRegion IDs and the
  supplied graph relations remain authoritative references.
- Prompt v7 audits top/bottom faces separately and treats Surface names as cube
  geometry, not anatomy. UV seams, adjacent vertical ownership, or similar color
  alone cannot extend a cross-body component onto a top/bottom face.
- Proposal Schema 1.2 adds a bounded same-pass `appearanceInventory`. Validator v3
  validates its structure and Region references, but it remains diagnostic and
  cannot change Region ownership, masks, commit decisions, or M15 follow-up input.
  Schema 1.0/1.1 remain historical read-only shapes, and stale Job contracts require
  a fresh analysis rather than an upgraded Retry.
- Host-side ownership and bounded-transfer rules remain unchanged: one bucket per
  CandidateRegion, at most 32 override spans and 64 unique override pixels, and an
  explicit paired removal for every transferred pixel.
- M17 is visible-evidence classification work only. Per-pixel provenance, Part 2.0,
  hidden-content Completion, player Completion UX, and its release gate remain
  isolated in M18-M21.

## M18 decisions

- Pixel origin is an immutable, versioned document owned by the resulting
  Revision, Part, or Part Edit Revision. Its canonical surface-qualified spans
  cover every non-transparent used-UV pixel exactly once.
- Intrinsic origin and derivation are separate. The four intrinsic values are
  source-visible, manually authored, generated completion, and legacy mixed.
  Copy operations retain that intrinsic value while recording one immediate
  immutable copied-from subject/component/pixel reference.
- Origin-bearing Revision result hashes include canonical `origin.json` after
  normalizing only the result subject ID. Evidence IDs and copied-from references
  remain part of the hash. Legacy Revision hashes keep their historical contract.
- New Part 2.0 storage has seven files. `generated-mask.png` is deterministically
  derived from `origin.json`, must be a subset of the write mask, and is verified
  together with the manifest summary. Part 1.0/1.1 readers retain their original
  five-file contract.
- Semantic component `containsGeneratedPixels` and origin counts are compatibility
  projections derived from authoritative origins plus component masks; model output
  and client input cannot declare them independently.
- Revision, Part, and Part Edit asset references are immutable after binding.
  SQLite migration 014 expands the closed file-role enums while retaining nullable
  origin references only for rows that predate the migration.
- The public origin endpoint distinguishes recorded evidence from
  `legacy_unavailable`. The Studio uses the same distinction and never translates
  unavailable history into zero-valued source counts.
- M18 does not generate hidden pixels. Completion candidates and acceptance remain
  isolated in M19, using `generated_completion` only after an explicit decision.

## Package boundaries

```text
apps/web                 UI, editors, six-stage AI review, compositor, repair, restoration, and preview adapters
apps/api                 HTTP API, revision, AI follow-up, composition, repair, restoration, and recommendation orchestration
apps/ai-worker           persistent semantic/recommendation jobs, follow-up actions, validation, and audit assets
packages/skin-core       PNG, UV, pixels, semantic edits, parts, repair, and restoration (M1-M9)
packages/skin-revision   immutable snapshots, catalog variants, parts, repair histories, AI audit, and compositions
packages/skin-compositor ordered layers, restoration, and deterministic conflict evaluation (M6/M9)
packages/skin-analysis-pack deterministic model inputs, evidence graph/grounding, candidate catalogs, follow-up assessment, and manifests (M5/M10/M15/M17)
packages/ai-provider     replaceable model execution and task-specific validation (M5/M10/M17)
```
