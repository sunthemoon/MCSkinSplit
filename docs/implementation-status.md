# Implementation status

Last updated: 2026-08-11

## Milestones

| Milestone | Status | Verification target |
|---|---|---|
| M0 repository baseline | Complete | `pnpm verify` and browser smoke test |
| M1 deterministic pixel core | Complete | Lossless RGBA and UV round trips for Wide/Slim fixtures |
| M2 immutable revisions | Complete | SQLite, snapshots, revert, branch, hash checks |
| M3 revision-aware 3D preview | Complete | One viewer instance tracks selected revisions |
| M4 manual semantic editor and parts | Complete | Manual segmentation and lossless part reuse |
| M5 AI Skill and worker | Complete | Schema-valid proposals create revisions only after validation |
| M6 compositor | Complete | Explicit conflicts and deterministic six-skin composition |

## M0 baseline

- The target GitHub repository existed without refs, and the local project directory contained only the specification.
- Node.js 24, pnpm workspaces, Vite 8, React 19, and TypeScript establish the runnable baseline.
- `skinview3d` is pinned to 3.4.2 and bundled locally. Its supported animation API is `skinViewer.animation = new WalkingAnimation()`.
- Skin input uses file/blob URLs; skin bytes are not embedded into application source.
- The M0 commit is `ed54c7fc7e89e6ae8597b6b7059aa7791cb8da68` (`feat(studio): establish M0 skin preview baseline`).

## M1 deliverables

- Added framework-independent `packages/skin-core` with 64×64 PNG decode/encode and structured `SkinPngError` codes.
- Added schema-backed `wide-64.json` and `slim-64.json` layouts. Each expands to 72 bounded, non-overlapping surfaces.
- Added reversible orientation transforms, Atlas → Surface Model → Atlas conversion, fixed texel records, and unused-pixel preservation.
- Added deterministic Wide/Slim inference with the four arm marker regions used by the installed upstream renderer utilities.
- Added 16× nearest-neighbor Atlas and semantic face Contact Sheet renderers.
- Added deterministic Wide, Slim, RGBA-alpha, indexed-color + `tRNS`, and directional UV-calibration fixtures.
- Pinned six user-provided real skins by SHA-256; all six fully decode and classify as Slim through transparent marker regions.
- Added deterministic `alex-mix-real.png`: head A1, torso A4, right arm A3, left arm A5, right leg A6, and left leg A2, including both Base and Outer surfaces.
- Replaced header-only upload checks with complete RGBA decoding before a skin becomes active.
- Replaced the Atlas `<img>` with Canvas 2D output, disabled smoothing, and exposed Atlas/face views.
- Added Auto/Wide/Slim controls; one resolved arm type drives UV mapping and `skinview3d` together.
- Documented the stable coordinate and pixel contract in [`uv-layout.md`](uv-layout.md).

## M1 verification evidence

- `pnpm verify`: passes fixture drift detection, both TypeScript projects, 54 Vitest cases, and the production builds.
- Core tests: 43 cases cover JSON Schema validation, all 72 face rectangles/orientations, all rotation/flip combinations, PNG formats, byte-exact RGBA round trips, fixed texels, arm inference, nearest-neighbor scaling, Contact Sheet order, six pinned real skins, and every surface in the generated mix.
- Web tests: 11 cases cover complete fixture decoding, model assessment, invalid/truncated data, legacy dimensions, MIME, and size limits.
- Browser Wide fixture: inferred `Wide / Classic`, selected `wide-64`, reported 72 surfaces / 3,264 used pixels, created a 1024×1024 Canvas buffer, and reached 3D `ready`.
- Browser Slim fixture: inferred `Slim / Alex`, selected `slim-64`, reported 72 surfaces / 3,136 used pixels, and kept the 3D preview ready.
- Browser manual override: a Slim fixture overridden to Wide updated the active layout, used-pixel count, Contact Sheet, and avatar model together.
- Browser Contact Sheet: generated a 226×646 Canvas containing all 72 semantic cells. Collected console errors were browser-extension message-channel noise without an application stack; the separate Vite resize report is recorded below.
- Browser real-skin pass: A1 through A6 each reported Slim/Alex, 72 surfaces / 3,136 used pixels, and 3D ready while selected from the fixture grid.
- Browser mix pass: `alex-mix-real.png` loaded as the default Slim model, rendered in the 1024×1024 Atlas and 226×646 face views, and reached 3D ready.

## Known boundaries

- M1 accepts modern 64×64 skins only. Legacy 64×32 conversion is intentionally rejected.
- Lossless means decoded RGBA equality. PNG compression, chunk ordering, ancillary chunks, and original palette encoding are not retained.
- Automatic arm inference follows deterministic marker rules but cannot infer artistic intent in every ambiguous file; the UI therefore retains a manual override.
- The real-skin `MIX` began as a deterministic fixture recipe; M6 now rebuilds it through persisted parts and the production compositor.
- The production web entry remains large because `skinview3d` and Three.js are eager-loaded. M3 will isolate and lazy-load the viewer adapter.
- M1 fixture/model overrides remain local display choices until the current texture is imported into a Project.
- A non-blocking pre-existing `ResizeObserver loop` development report is recorded in [`mc-skin-ai-assisted-segmentation-versioned-studio-plan_问题记录.md`](mc-skin-ai-assisted-segmentation-versioned-studio-plan_问题记录.md); M1 does not include an unrelated viewer resize fix.

## M2 deliverables

- Added `packages/skin-revision` with a strict SQLite migration for Project, Branch, Revision, Asset, and Operation metadata.
- Added a two-stage Project flow: an empty Project starts with a `main` Branch and Slim default, then a valid 64×64 PNG creates its first Import Revision.
- Added full snapshot directories containing `skin.png`, `segmentation.json`, `operation.json`, and `checksum.json`.
- Canonical JSON and SHA-256 hashes make snapshot verification deterministic. File reads also cross-check the SQLite asset path, byte size, content hash, and Revision result hash.
- Snapshot writes use a private temporary directory, durable file writes, and an atomic directory rename before the SQLite transaction is committed. Failed metadata commits remove only their newly created snapshot.
- Revert copies a historical state into a new child of the selected Branch HEAD. It never deletes or rewrites the later nodes.
- Branch creates a new Branch and first Revision from any historical node without moving the source Branch HEAD.
- Added Fastify JSON Schema validation and buffered `image/png` parsing with a 1 MiB limit. Structured storage, PNG, and request errors retain stable HTTP status/code pairs.
- Added Project, Branch, Revision list/detail/content, segmentation, diff, revert, and branch endpoints. The immutable PNG response uses a Revision-specific ETag and immutable cache policy.
- Added a responsive web timeline with Project/Branch selectors, historical node loading, restore-as-new-Revision, and branch-from-selection controls.
- Uploads create an Import Revision automatically; bundled fixtures can be imported explicitly. The last active Project is restored from SQLite after a page reload.
- Documented the stable contract in [`revision-history.md`](revision-history.md).

## M2 verification evidence

- `pnpm verify` passes fixture drift detection, all TypeScript projects, 71 Vitest cases, and every production build.
- Revision tests: 8 cases cover two-stage import, model-override persistence, complete snapshot contents, immutable parent bytes, revert ancestry, historical branching, serialized concurrent writes, database reopen, duplicate Branch rejection, and corrupted checksum rejection.
- API tests: 5 endpoint flows use a real Slim fixture and cover Project creation, PNG import/content, segmentation, Branch/Revert, diff, project-scoped branching, stable client errors, duplicate import, and corrupted snapshot responses.
- Web tests: 15 cases include revision-client PNG upload semantics, encoded paths/query metadata, stored arm-model loading, content-type checks, and structured API error preservation.
- Browser Import: `alex-mix-real.png` created `main #1`, reloaded through the hash-verifying PNG endpoint, stayed Slim/Alex, and kept both Atlas and 3D preview ready.
- Browser Branch/Revert: `main #1` produced `experiment-slim #1`; restoring that node produced `experiment-slim #2` while `main #1` remained selectable.
- Browser persistence: reloading the page restored the SQLite Project, both Branches, all three Revisions, and the default Branch HEAD. Browser logs contained no application errors.

## M2 known boundaries

- SQLite is the supported local single-service store. The in-process write queue serializes mutations; distributed multi-writer deployment is outside M2.
- Revision state uses complete snapshots rather than binary deltas. This is intentional for 64×64 textures and keeps every node independently recoverable.
- M2 segmentation snapshots are valid but empty. Semantic components, masks, and confirmed edit transactions arrive in M4.
- Revision switching uses the M3 adapter and the stored segmentation arm model. M4 will add component visibility and part-specific previews.
- The lazy `skinview3d`/Three.js production chunk remains about 525 kB before gzip and produces Vite's chunk-size warning, but it no longer blocks the initial Studio chunk.

## M3 deliverables

- Added framework-independent `McSkinPreview`, with dependency-injected Viewer, animation, observer, and animation-frame boundaries for deterministic testing.
- React creates the adapter once per mounted Canvas. Skin URL or arm-model changes call `loadSkin` on that instance instead of constructing another Viewer.
- Texture requests are serialized and generation-tagged. A stale result cannot report ready after a newer Revision request, and a failed texture can be followed by a successful load without disposing the Viewer.
- Added a single animation compatibility boundary: installed `skinview3d@3.4.2` uses `viewer.animation` plus `autoRotate`; a legacy `animations.add` implementation receives its own Walking/Rotating registrations instead. The two modes never run together.
- Replaced synchronous Observer writes with `ResizeObserverEntry.contentRect` reads and one coalesced `requestAnimationFrame` write. Unchanged dimensions are skipped, and disposal cancels pending work.
- Added loading/error overlays and an explicit `REVISION / branch #sequence` source label while keeping the rest of the Studio usable on a 3D texture error.
- Changed `skinview3d` to a dynamic import. The initial production JavaScript fell from about 962 kB to 448 kB before gzip; the WebGL viewer is a separate lazy chunk.
- Revision selection loads the authoritative arm model from `segmentation.json`, so a saved Wide override cannot silently return to inferred Slim after reload.
- Closed [`INC-001`](mc-skin-ai-assisted-segmentation-versioned-studio-plan_问题记录.md): the prior ResizeObserver loop report is now fixed and verified in M3.

## M3 verification evidence

- `pnpm verify` passes fixture drift detection, all TypeScript projects, 76 Vitest cases, and every production build.
- Viewer tests: 5 cases cover exactly-once initialization/disposal, modern and legacy animation APIs, serialized latest-Revision loading, failure recovery, and coalesced/cancelled resize work.
- Browser Revision switch: `main #1 → experiment-slim #1 → main #1` kept the Canvas count at one; the Revision label, Atlas texture, model label, and 3D avatar changed together and returned to ready.
- Browser sizing: the Viewer Canvas CSS size matched its stage at 405×596; its 364×536 backing buffer matched the test browser's `devicePixelRatio=0.9`.
- Browser logs contained zero ResizeObserver reports and zero application errors. Browser-extension message-channel errors remained external noise without an application stack.

## M3 known boundaries

- The WebGL chunk remains above Vite's default 500 kB warning threshold even though it is lazy. Further Three.js/skinview3d reduction is a performance task, not a Viewer correctness blocker.
- Skin loading cannot abort an in-flight `skinview3d.loadSkin` call. The adapter serializes requests to guarantee final ordering; a permanently hung upstream texture load would delay later requests.
- M3 previews whole Revision skins. Neutral-base component previews and component visibility controls belong to M4.

## M4 deliverables

- Added a fixed 23-category semantic taxonomy, complete 64x64 masks, canonical
  surface spans, deterministic palettes, and strict ownership validation to
  `packages/skin-core`.
- New imports place every valid non-transparent UV pixel in an independent
  `unknown` mask. Legacy mask-free snapshots stay readable and are upgraded only
  through a new Revision.
- Added deterministic assign, unassign, merge, split, and reclassify operations.
  Every confirmed operation creates a child Revision; browser brush drafts do not.
- Extended snapshot hashing and SQLite asset verification to dynamically named
  component masks without changing historical M2/M3 files.
- Added atomic five-file part assets containing texture, write mask, manifest,
  preview, and source provenance, with database-backed integrity checks.
- Added read-only conflict preview and explicit `use_part`/`keep_base` strategies.
  Only the explicit application creates an `apply_part` Revision.
- Added a responsive semantic editor, component tree, taxonomy form, part library,
  conflict report, and Revision-aware result loading.
- Documented the stable behavior in
  [`semantic-editing-and-parts.md`](semantic-editing-and-parts.md).

## M4 verification evidence

- `pnpm verify` passes fixture drift detection, all TypeScript projects, 96
  Vitest cases, and every production build.
- Core semantic tests cover taxonomy, pixel/mask/span round trips, all five manual
  operations, image rebasing, part extraction, conflict reports, and exact
  reapplication.
- Revision tests cover complete mask snapshots, legacy compatibility, immutable
  editing, part-file integrity, read-only previews, explicit application, and a
  real-skin cross-project export/apply flow.
- API tests cover semantic operation schemas, component export, part reads,
  conflict preview, explicit application, and stable invalid-operation errors.
- Web tests cover semantic Canvas coordinates, API request/response handling, and
  existing import/model/Revision behavior.
- Browser real-skin pass: two exact pixels from `ab87de696cfca859.png` were assigned
  to `hair.main`, exported as a part, previewed against
  `354359a2c2f33777.png` with two hard conflicts and no Revision side effect, then
  applied with `use_part` as `main #2`. The Atlas, semantic Canvas, timeline, and
  3D avatar all showed the committed state.
- Browser visual inspection found no clipping, overlap, or layout break in the
  desktop semantic workspace. Logs after the schema fix contained no application
  error or new 5xx response.

## M4 known boundaries

- M4 is a manual editor. AI proposals, provider isolation, and confidence/review
  workflows arrive in M5.
- Single-part application reports hard and same-color overlap. M6 extends this with
  ordered layer-to-layer, model, and semantic-boundary conflicts.
- Part export creates an immutable library asset but intentionally does not create
  a skin Revision because source skin state is unchanged.
- The lazy `skinview3d` chunk remains about 525 kB before gzip and retains Vite's
  non-blocking chunk-size warning.

## M5 deliverables

- Added the versioned repository Skill `.agents/skills/mc-skin-segmenter`, including
  taxonomy and UV references, proposal schema, inspection helpers, and a compact
  candidate-first analysis workflow.
- Added `packages/skin-analysis-pack` to build a private workspace with source and
  derived views, palette, pixel map, candidate documents, prior segmentation,
  schema, copied Skill, and integrity hashes.
- Added deterministic `bounded-color80-surface-cc-v2` candidates. Every visible
  valid UV pixel belongs to exactly one candidate and no region crosses a canonical
  surface.
- Added `packages/ai-provider` with a replaceable provider interface, strict Ajv and
  pixel validation, safe Windows Codex CLI resolution, cancellation, timeout, log
  limits, JSONL diagnostics, and structured-output transport fallback.
- Added `apps/ai-worker` with persistent Job, Run, Asset, and Event records, one
  bounded repair attempt by default, retry against the original Revision, and
  complete failure artifacts.
- Added an AI migration and immutable `ai_segment` commit path. Invalid, failed, or
  cancelled model output cannot create a Revision; successful classification keeps
  the input skin PNG byte-identical.
- Added provider/start/list/detail/event/cancel/retry API routes and a responsive
  Studio console for provider, model, reasoning, progress, attempts, artifacts,
  review items, and automatic result loading.
- Documented the provider boundary, environment, privacy behavior, validation, and
  audit contract in [`ai-analysis.md`](ai-analysis.md).

## M5 verification evidence

- `pnpm verify` passes fixture drift detection, all TypeScript projects, 113
  Vitest cases, and every production build.
- Deterministic analysis-pack tests cover all six pinned real skins. They preserve
  exact visible-pixel coverage with 163-419 bounded candidates per skin and produce
  reproducible workspaces without modifying source inputs.
- Provider tests cover schema/pixel validation, opaque outfit-group identifiers,
  Windows `.cmd` resolution without a shell, stdin prompt delivery with attached
  images, structured-output fallback, and diagnostic preservation.
- Worker and Revision tests cover success, validation failure, one repair attempt,
  cancellation, provider failure assets, retry provenance, exact skin bytes, and
  the rule that only a valid Branch HEAD result creates an AI Revision.
- API and web tests cover strict request bodies, provider defaults, all Job actions,
  status polling, and result loading into the semantic editor.
- A real end-to-end Codex run on `ab87de696cfca859.png` used the default Slim/Alex
  model and medium reasoning. The first proposal was rejected and retained for
  audit; the automatic repair succeeded with 10 confirmed components covering all
  1,860 visible pixels and zero `unknown` pixels.
- The successful Job retained two Runs with five hashed assets each. Its resulting
  `ai_segment` Revision references the successful Run, preserves the Import PNG's
  SHA-256, and exposes all components in the browser editor and 3D preview.
- Browser visual inspection confirmed the AI console, progress/event history,
  attempt artifacts, Slim avatar, Atlas, and component tree without clipping or
  layout overlap.

## M5 known boundaries

- Semantic output is a model proposal, not objective ground truth. Confidence and
  review state remain visible, and the M4 editor is the correction path.
- Only the bundled local Codex CLI provider is enabled by default. The provider
  interface is replaceable, but no hosted-provider credential UI is included.
- Structured-output fallback is limited to transport/schema capability failures;
  host validation is never skipped.
- The six real skins exercise deterministic pre-analysis. The recorded full model
  run covers A1; running every model over every fixture is intentionally not part of
  deterministic CI.
- AI workspaces and logs may contain skin imagery and model output. They remain
  under the configured local data directory and require explicit operator cleanup.

## M6 deliverables

- Added framework-independent `packages/skin-compositor` with ordered layers,
  fixed-base participation, deterministic preview winners, per-pixel decisions,
  and structured conflict reports.
- Added explicit handling for hard color conflicts, non-blocking same-color
  overlaps, incompatible arm models, and writes outside manifest-declared UV
  surfaces. Model and semantic-boundary violations cannot be dismissed by layer
  order.
- Added SQLite `composition_project` and `composition_layer` persistence, including
  draft/committed state, base Revision and Branch, resolution mode, per-pixel
  winners, latest report, and resulting Revision.
- Added draft creation, reload, add/remove/reorder, conflict resolution, PNG preview,
  and commit methods to the Revision service. Every commit rechecks the Branch HEAD
  and all source/part assets before creating an immutable `compose` Revision.
- Added strict API routes for the complete lifecycle plus cache-busted preview PNGs.
- Added a responsive Studio compositor with a top-to-base stack, real part previews,
  live pixel metrics, individual winner controls, explicit whole-order confirmation,
  PNG export, and a server-driven commit gate.
- Added an end-to-end real-skin recipe that persists six saved parts and recreates
  `alex-mix-real.png` from A1 head, A4 torso, A3 right arm, A5 left arm, A6 right
  leg, and A2 left leg. All sources and the result use Slim/Alex.
- Documented the stable behavior in
  [`composition-workflow.md`](composition-workflow.md).

## M6 verification evidence

- `pnpm verify` passes fixture drift detection, all TypeScript projects, 120
  Vitest cases, and every production build.
- Compositor tests cover explicit per-pixel winners, same-color overlap, model
  mismatch, and a pixel-exact reconstruction from all six pinned real skins.
- Revision tests cover persisted resolution, immutable commit behavior, semantic
  ownership of winning pixels, and preview/committed PNG equality with the
  checked-in six-source mix.
- API and web tests cover strict composition request bodies, lifecycle endpoints,
  encoded client paths, conflict decisions, preview URLs, and commit responses.
- Browser smoke testing created a Slim/Alex Composition Project on a real skin,
  added an exported real-skin part, rendered its preview, committed it, and loaded
  the resulting `COMPOSE` node as `main #3` in the timeline, Atlas, semantic editor,
  and 3D avatar.
- Desktop visual inspection confirmed the full layer/preview/conflict layout,
  disabled-state behavior, and default Slim controls without clipping or overlap.

## M6 known boundaries

- A preview always shows the deterministic current top-layer winner, even before a
  hard conflict is confirmed. The UI labels preview export separately and keeps
  commit disabled until the report is committable.
- Model or semantic-boundary conflicts require removing or repairing the offending
  part; they intentionally have no force-commit action.
- Conflict decisions are stored per Atlas pixel. Reordering or changing layers
  clears them rather than trying to reinterpret stale choices.
- Composition Projects target one Branch HEAD and do not merge histories. If that
  Branch advances independently, the draft must be recreated on the new HEAD.
- The lazy `skinview3d` chunk retains Vite's non-blocking size warning.
