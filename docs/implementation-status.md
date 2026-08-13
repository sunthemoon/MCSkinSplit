# Implementation status

Last updated: 2026-08-13

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
| M7 analyzed-skin catalog and complete-category bundles | Complete | Immutable atomic bundles, derived previews, and atomic whole-bundle composition |
| M8 immutable component repair | Complete | Append-only repair Revisions, verified files, neutral 3D preview, and new-part commit |
| M9 composition remnant cleanup and Base restoration | Complete | Deterministic candidates, versioned/audited plans, restored previews, and compose provenance |
| M10 constrained AI replacement recommendation | Complete | Repository Skill, ID-only validated proposal, shared Job/Run/Event telemetry, and explicit user Apply boundary |
| M11 source-aware library lifecycle and correction | Complete | Whole-component unassign, provenance filters, soft retirement, immutable Bundle revision, and corrected-HEAD re-export |
| M12 responsive workflow navigation | Complete | Seven stable section targets, sticky desktop/mobile navigation, scroll-aware active state, native hash links, and reduced-motion behavior |

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

## M6 usability refinement

- The compositor now owns its component picker. Every saved part is visible in
  the composition section and can be selected or added without first selecting
  it in the semantic part panel above.
- Added a deterministic neutral mannequin texture for sparse parts. The preview
  copies only pixels allowed by the immutable part write mask and fills valid
  base-model UV faces with shaded neutral pixels for Wide or Slim rendering.
- Component inspection uses the mannequin in a draggable 3D viewer. Composition
  output defaults to draggable 3D while retaining an explicit 64x64 texture view.
- Both 3D inspectors default to an idle pose and expose compact in-frame idle/walk
  controls. Automatic rotation is disabled; drag rotation and wheel zoom remain
  under user control.

## M6 usability-refinement verification evidence

- Focused core, Revision, API, and web suites pass, including mannequin pixels,
  mannequin HTTP validation, encoded client URLs, and idle/walk Viewer switching.
- Browser desktop flow created a Slim draft, added the saved part directly from
  the compositor, and reached a ready result Viewer with 1 layer, 2 written pixels,
  and no unresolved conflicts.
- Browser controls switched component idle/walk and result idle/walk plus
  3D/texture/3D without recreating the surrounding composition state.
- Browser responsive inspection at a 390px viewport kept the component and result
  Viewers ready, stacked all three panels, and produced no horizontal overflow.
- Browser console output contained only the known Chrome-extension message-channel
  noise, with no application stack or failed local API response.

## AI live-process refinement

- Codex JSONL stdout is decoded and parsed incrementally instead of waiting for the
  child process to exit. Safe lifecycle projections are appended to persistent Job
  events and reach both Job-detail and event-list HTTP responses during execution.
- The projection exposes generic session, turn, tool, output, usage, fallback,
  and error states. It drops model reasoning, command output, searches, proposal
  bodies, and raw item fields. Tool-capable events may carry only a sanitized item
  ID, bounded command summary, and integer exit code for correlation and diagnosis.
- The Studio console now shows the complete event history in chronological order
  inside a fixed-height terminal pane. Active Jobs refresh every 1.5 seconds and
  automatically follow new events; completed Jobs remain manually scrollable.
- Progress observers are non-authoritative telemetry. Callback failures cannot fail
  an otherwise valid provider Run, while provider launch errors still produce a
  normal audited Job failure.

## AI semantic provider hardening

- Semantic analysis now pins `mc-skin-segmenter` Skill `1.2.0` and prompt
  `semantic-proposal-v3-tool-free`. The provider inlines the immutable public Job,
  compact candidate summary, palette, previous-component summary, and rules while
  attaching the prepared skin views.
- Semantic Codex runs use a read-only sandbox with shell, web, browser, computer,
  image generation, apps/plugins/MCP, delegation, and related tools disabled. The
  model returns one final JSON response; it cannot read or write the Run workspace.
- Captured JSONL and stderr survive provider timeout, cancellation, launch errors,
  and output-limit termination and are registered as failure assets when possible.
  The narrow structured-output transport fallback remains locally JSON- and
  pixel-validated; it does not imply endpoint support for structured output.
- The Studio pairs tool start/result events where correlation permits, labels tool
  failures and provider-stage errors as recoverable/non-terminal, collapses
  duplicate provider errors, and reserves terminal styling for the Job error and
  terminal lifecycle event. The five-stage progress model is unchanged.

## AI semantic provider hardening verification evidence

- A real Chrome flow started `aijob_7c7431b119c146f9be34813036fa2f23`
  from the Studio against `9058f3af3ffb104c.png` using `max` reasoning. The one
  observed Job/Run took 429.5 seconds (7 minutes 9.5 seconds) and succeeded after
  the schema transport request fell back to host-validated JSON.
- The successful Run attempt 1 created Revision
  `rev_9c599f7ceffb492aa21d33b1807eacac` with 15 components covering all 1,989
  visible pixels and zero `unknown` pixels. One low-confidence component remained
  marked for review by the validator.
- The successful run recorded zero `provider_tool` events and retained non-empty
  JSONL, proposal, validator-report, and stderr audit assets. This demonstrates the
  tool-free profile for that run; the observed duration is not a performance
  guarantee or benchmark.

## AI live-process verification evidence

- The final `pnpm verify` passes fixture drift detection, every workspace
  TypeScript project, 239 Vitest cases, and every production build. Package totals
  are skin core 71, web 80, analysis pack 4, compositor 8, Revision store 26,
  AI provider 23, AI worker 15, and API 12.
- Provider tests cover split JSONL chunks, safe event projection, omitted
  reasoning and raw proposal content, malformed events, usage summaries, and the
  structured-output fallback notice.
- Worker and API tests confirm provider progress is persisted and returned across
  the HTTP boundary without changing success, retry, validation, or Revision rules.
- Desktop browser inspection confirmed second-level timestamps, chronological
  rendering, a 172 px scroll pane, and the existing failed-Job history without
  clipping or horizontal overflow.
- Normal Windows `pnpm dev` startup successfully launched both Vite and Fastify.
  The observed `spawn EPERM` occurred only when Vitest tried to create test workers
  inside the restricted Codex command sandbox; the same suites passed in a normal
  Windows process.

## M7 deliverables

- Kept the fixed 23-category semantic taxonomy intact and added the orthogonal
  aggregate kinds `hair`, `clothing`, and `accessory` for complete-category
  browsing and reuse.
- Added a catalog derived from successful AI Jobs and their immutable result
  Revisions. It exposes Project/Revision identity, provider/model provenance,
  arm layout, review and coverage counts, source skin, and deterministic aggregate
  groups.
- Added SQLite-backed immutable part Bundles. A batch export creates ordinary
  five-file part assets for every fine component and stores only their ordered
  Bundle membership, source, aggregate kind, model intersection, and optional
  outfit-group identity.
- Added integrity-checked combined 2D previews and neutral Wide/Slim mannequin
  previews without creating mutable or flattened Bundle textures.
- Added atomic whole-Bundle insertion into a Composition Project. All members are
  validated before the draft layer set changes, and successful insertion retains
  every member as an independently adjustable fine-part layer.
- Added the analyzed-skin catalog and complete-category shelf to the Studio,
  including filtering, source Revision loading, one-action export, direct
  composition add, and draggable idle/walk 3D inspection.
- Documented the stable workflow in
  [`analyzed-skin-catalog-and-bundles.md`](analyzed-skin-catalog-and-bundles.md).

## M7 verification evidence

- Core test coverage checks the additive aggregate mappings while retaining all
  existing fine taxonomy identifiers.
- Revision-service tests exercise multi-component batch export, immutable member
  provenance, derived Bundle previews, list/read persistence, transaction cleanup,
  and atomic insertion as independently addressable composition layers.
- API tests cover catalog filters and detail loading, strict export validation,
  Bundle listing/detail/PNG routes, whole-Bundle composition add, duplicate-member
  rejection, and exported-group discovery in the catalog.
- Web client tests cover encoded catalog and Bundle URLs, query parameters,
  batch-export request bodies, preview helpers, and whole-Bundle composition calls.
- `pnpm verify` passes fixture drift detection, TypeScript checks, every Vitest
  suite, and all production builds. Vite retains the known non-blocking
  `skinview3d` chunk-size warning.
- Browser smoke testing loaded the real-skin Studio and reached a ready Slim/Alex
  3D preview. The immutable Revision timeline remained the first body section,
  followed by the analyzed-skin catalog; the complete-category shelf remained
  separate from the existing atomic-part picker.
- Responsive browser inspection confirmed the 1600 px desktop grids and the
  sub-700 px stacked layout without element overflow. Browser logs contained only
  the known Chrome-extension message-channel noise and no application stack or
  failed local API response.

## M7 known boundaries

- The catalog contains successful AI result Revisions, not every imported or
  manually edited Revision. It derives from authoritative Job and Revision data
  rather than duplicating skin files in a separate catalog store.
- “Complete” means all classified components in the aggregate group. M7 does not
  infer hidden pixels, repair incomplete parts, erase target-skin remnants, or fill
  newly exposed base pixels.
- Clothing respects confirmed `sameOutfitGroup` values; ungrouped clothing is
  collected into the Revision's default clothing group. Hair and accessories use
  their aggregate kind for grouping.
- Bundle previews reject different-color overlap between members. Target-skin and
  cross-layer conflicts remain governed by the existing compositor report and
  explicit resolution rules.
- Bundles are immutable snapshots of one source Revision. Later corrections create
  new parts and a new Bundle instead of rewriting prior library data.

## M8 deliverables

- Added deterministic single-part repair operations to `packages/skin-core`:
  painting an explicit RGBA color on valid UV, erasing sparse part pixels, exact
  RGBA replacement, canonical limb mirroring, and verified surface copying from a
  saved donor part or repair Revision.
- Added SQLite-backed part-edit projects with linear, HEAD-checked, append-only
  Revisions. Every Revision stores its parent, operation, changed-pixel count,
  summary, authored provenance, and verified file metadata.
- Added atomic repair storage under `data/part-edits/`. Each Revision contains
  `texture.png`, `write-mask.png`, and `revision.json`; reads cross-check paths,
  byte sizes, hashes, and JSON identity against SQLite.
- Added repair commit as a new immutable five-file part. The base part and every
  repair Revision remain unchanged. PartManifest schema `1.1` records an explicit
  `part_repair` derivation, while `source.json` records repair ancestry and marks
  the pixels as manually authored and non-generated.
- Added strict HTTP routes for project list/create/detail, HEAD-checked operations,
  commit, immutable texture and mask reads, and derived Wide/Slim mannequin
  textures.
- Added a responsive component-repair workspace that selects a base directly from
  the saved part library, edits transparent valid UV, exposes the five repair
  tools, and displays an immediate not-yet-applied draft in both the 2D canvas and
  a neutral draggable 3D mannequin with idle/walk controls and zoom. Explicit
  apply remains the only persistence action.
- Documented the stable behavior in
  [`component-repair-workflow.md`](component-repair-workflow.md).

## M8 verification evidence

- Core tests cover transparent-UV painting, erasure and mask derivation, scoped
  and whole-part exact replacement, limb mapping, donor copy overwrite modes,
  invalid selections, and input immutability.
- Revision-service tests cover append-only history, stale-HEAD rejection, donor
  resolution, immutable source retention, new five-file part commit, empty-part
  rejection, and file-tamper detection.
- API tests exercise project list/create, strict operation validation, immutable
  PNG reads, derived mannequin output, stale-HEAD conflicts, and commit as a new
  part. Web tests cover encoded client routes, explicit HEAD request bodies,
  valid-UV coordinate selection, deterministic repair-operation construction,
  local 2D/3D preview output, immutable texture caching, stale-task suppression,
  receiver-safe browser fetch, retry after failed reads, and Blob URL cleanup.
- `pnpm verify` passes fixture drift checks, all workspace TypeScript projects,
  all Vitest suites, and every production build. One AI Worker test exceeded its
  existing 5-second timeout during the first full run; an isolated rerun and the
  complete second run both passed without code changes.
- Browser testing created a repair project from a real saved part, painted one
  selected UV pixel as Revision `#2`, committed it as a distinct saved part, and
  kept the base part available. A second uncommitted paint rendered immediately
  in the 2D draft and neutral Slim/Alex mannequin, reported the changed-pixel
  count, kept the 3D viewer ready through idle/walk switching, and disabled
  new-part commit until the draft was applied. Browser testing also caught and
  fixed an unbound native `fetch` receiver before release; the regression test
  now enforces the browser invocation contract.
- Responsive inspection found no horizontal overflow in the default desktop
  layout or the sub-700 px stacked layout. The repair workspace changed from
  three columns to one, while its texture Canvas remained square and the 3D
  preview remained contained.

## M8 known boundaries

- Component repair is deterministic authoring, not factual occlusion recovery.
  When source pixels were hidden, mirror, donor, and paint results remain explicit
  user reconstruction choices.
- M8 does not call an AI model. Repair provenance uses `source: manual` and
  `containsGeneratedPixels: false`.
- Partial-alpha paint and exact replacement are supported, but no anti-aliasing,
  interpolation, palette synthesis, or automatic skin-tone inference is applied.
  Paint and replacement outputs must remain non-transparent; explicit erasure is
  the only operation that removes pixels from the repair write mask.
- Repair-Revision surface-copy sources are limited to the same repair project.
  Cross-project content can be reused after it is committed as a saved donor part.
- Local draft previews are disposable and are never authoritative storage. The
  service validates the operation again before appending a repair Revision.
- Committing a repaired part does not remove pixels from the target skin that lie
  outside the repaired part's write mask. Target-remnant clearing and Base-layer
  restoration are provided by M9 inside the Composition Project; see
  [`composition-restoration-workflow.md`](composition-restoration-workflow.md).
- Repair projects use a linear HEAD rather than Branch/Revert semantics. Committed
  projects are read-only and further corrections start from a saved part in a new
  project.

## M9 deliverables

- Added deterministic host-side restoration candidate generation. Selected fine
  semantic component masks are grouped by body part and Base/Outer layer; the
  Studio's complete hair, clothing, and accessory modes only expand the selection
  and do not alter the fixed 23-category taxonomy.
- Added one aggregate transparent Outer cleanup candidate and opaque Base
  candidates from current same-surface skin, current same-body-part skin,
  canonical mirror evidence, one compatible donor Revision, or an explicit manual
  RGBA value. Coverage and missing pixels are reported per candidate set.
- Extended the compositor with validated Outer clear and Base fill operations
  applied before ordinary part layers. Restoration counts are included in the
  Composition report, while missing coverage or plan-integrity issues block
  commit.
- Added SQLite migration `007_composition_restoration.sql`, a monotonic restoration
  version, hash-verified current plan storage, and append-only plan-set/plan-clear
  audit events.
- Added non-mutating candidate generation plus versioned plan set/clear APIs.
  Public request/response DTOs use regeneration inputs, candidate IDs, hashes, and
  counts; strict schemas reject client-supplied masks, operations, pixel IDs, PNGs,
  non-opaque manual colors, and stale versions.
- Added a responsive restoration panel inside Composition. It supports fine or
  complete-category target selection, optional donor/manual inputs, forced Outer
  cleanup, mutually exclusive Base choices per target group, coverage/missing
  metrics, explicit Apply/Clear, and refreshed texture/3D previews.
- Added commit provenance. Compose operation metadata records plan identity and
  coverage, while restored opaque skin components record candidate/source
  evidence. Manual fills are identified as user-authored without source texels
  and set `containsGeneratedPixels: true`.
- Documented the stable behavior in
  [`composition-restoration-workflow.md`](composition-restoration-workflow.md).

## M9 verification evidence

- Skin Core passes 11 test files / 71 tests, including deterministic candidate
  ordering/hashing, aggregate Outer cleanup, semantic-skin sampling, donor model
  checks, Slim-arm mirror evidence, opaque manual fill, overlap prevention, and
  exclusion of typed masks from canonical candidate evidence.
- Skin Core typecheck and production build pass.
- Skin Compositor passes 1 test file / 8 tests, including layer-constrained Outer
  clear, opaque Base fill, overlap and invalid-operation rejection, restoration
  counts, missing/issue commit gates, and ordinary part-layer evaluation over the
  restored base.
- Skin Compositor typecheck and production build pass.
- Revision service passes 1 test file / 26 tests, including versioned plan
  set/clear, append-only events, persistence/reopen verification, partial-coverage
  commit blocking, Base-only zero-operation draft round trips, preview pixels,
  committed manual provenance, and immutable compose output.
- Revision-service typecheck and production build pass.
- API typecheck and production build pass. The API suite passes all 11 cases,
  including deterministic non-mutating candidate generation, alpha `0`/`128`
  rejection for manual candidates, strict request bodies, candidate-set hash
  mismatch, Base fill plus Outer clear in the preview PNG, versioned clear, and
  stale-version rejection.
- Web typecheck and production build pass. All 52 web cases pass, including
  candidate-ID-only transport, regeneration inputs on plan application, aggregate
  versus fine selection, forced Outer inclusion, one Base candidate per target
  group, opaque manual color parsing, coverage gating, and visible panel content.
- The production web build retains the existing non-blocking Vite warning for
  chunks larger than 500 kB.

## M9 known boundaries

- M9 is deterministic and does not call an AI model. Candidate generation uses
  opaque pixels owned by stored semantic skin components or explicit user input;
  it does not infer factual hidden pixels.
- Manual Base fill is intentionally opaque and authored. It records no donor
  Revision or source component and is marked as containing generated pixels even
  though no generative model was called.
- The public API never returns authoritative masks, pixel lists, compositor
  operations, or a generated PNG as candidate output. These remain host-derived
  and hash-verified behind the persistence boundary.
- Provenance is component-level rather than a general per-pixel ancestry graph.
  Merging evidence from different restoration plans keeps the conservative
  generated-pixel flag but drops ambiguous restoration details.
- Aggregate modes remain selection convenience. Fine components, atomic parts,
  and Bundle members are still stored and edited independently.
- Mirror coverage is verified for the canonical Slim arm counterpart exercised by
  the focused suite; the tests do not claim exhaustive mirror coverage for every
  face and both arm models.

## M10 deliverables

- Added a separate repository Skill at
  `.agents/skills/mc-skin-replacement-planner`. It ranks only host-supplied Base
  restoration candidate IDs and does not change the existing semantic-analysis
  Skill or the fixed 23-category taxonomy.
- Added a dedicated integrity-checked planning-pack contract over the public M9
  candidate catalog. The model input contains IDs, labels, source identity where
  applicable, coverage counts, and only an already user-authored opaque RGBA
  attached to a `manual_rgba` candidate; it contains no masks, coordinates,
  pixel lists, compositor operations, PNG output, or database state.
- Added a schema and deterministic proposal validator for exact Job,
  Composition, and candidate-set identity; complete sorted target-group coverage;
  exact per-group rankings; fully covering selected candidates; bounded
  explanations and confidence; and rejection of private evidence.
- Added the browser recommendation surface and local-selection adapter. A valid,
  fresh result can be loaded into the existing candidate selector, but loading
  does not persist a plan. The normal M9 **Apply** action remains required.
- Added a separate `restoration_recommendation` Job kind to the persistent
  worker/API infrastructure. It reuses isolated Runs, immutable input/output
  Assets, projected Events, cancellation, retry, and the live-process display,
  while database constraints prevent it from creating a result Revision or
  storing an advisory result for the wrong Job kind.
- Recommendation start and retry regenerate the deterministic candidate catalog
  and compare both Composition version and candidate-set hash. The worker repeats
  that check after provider execution, so a result that becomes stale while the
  model runs is retained as audited failed work rather than exposed as a current
  recommendation.
- Provider capability discovery and selection are independent from semantic
  analysis. The browser enables recommendation only for providers that advertise
  the replacement-planning capability, and keeps the full manual candidate flow
  available when none do.
- The default replacement provider uses a tool-free, read-only Codex invocation:
  it ignores user configuration while retaining authentication, clears MCP/apps,
  disables shell, web, browser, computer, image, plugin, and delegation features,
  and inlines only the immutable public Job/catalog. Semantic analysis retains its
  existing configurable provider behavior.

## M10 verification evidence

- `pnpm verify` passes all workspace checks: fixture integrity, type checks, 239
  tests, and production builds. The package totals are skin core 71, compositor
  8, analysis pack 4, AI provider 23, Revision store 26, AI worker 15, API 12,
  and web 80 tests.
- The replacement Skill scripts pass syntax checks, the contract self-test, and
  repository Skill validation. The provider output schema is byte-for-byte equal
  to the Skill's checked-in schema.
- Worker and API integration tests cover advisory-only success, immutable Run
  evidence, strict request shapes, stale input rejection before provider use,
  retry freshness, capability discovery, and the absence of Revision,
  restoration-plan, version, or preview mutations after recommendation success.
- A real-browser smoke test imported fixture `354359a2c2f33777.png`, assigned Base
  and Outer cleanup targets, created a Composition, generated deterministic
  candidates, selected a complete Base candidate, and confirmed that the
  recommendation control becomes available without changing the persisted plan
  or restoration version. The smoke test did not invoke an external model.
- Production web build still reports the existing advisory warning for a bundle
  larger than 500 kB; it does not fail the build.

## M10 boundaries

- Candidate generation, masks, pixels, color creation, and plan application stay
  deterministic host operations. AI output is advisory metadata only and never
  creates a Revision or changes a Composition automatically.
- Aggregate hair, clothing, and accessory controls remain convenience views over
  the same persisted fine components. M10 neither merges nor deletes them.
- The replacement-planner Skill is copied from the repository into each Run. It
  does not need to be installed as a global Codex Skill.
- Manual candidate selection remains the full no-AI fallback, including when a
  recommendation is stale, deferred, invalid, cancelled, or failed.

## M11 deliverables

- Added an explicit two-step whole-component correction action. It submits the
  selected component's complete stored spans as `unassign_pixels`, creates a new
  semantic Revision, and returns those pixels to `unknown`; the old Revision and
  any already exported Parts or Bundles remain unchanged.
- Added source-aware Part and Bundle browsing. Library rows expose source Project
  name, source Branch name, and source Revision sequence, and the browser can
  search names/provenance or filter by Project, semantic category/aggregate kind,
  and `active`/`retired` state. List APIs default to active assets and accept
  strict `status`, `projectId`, `sourceRevisionId`, `q`, and category/kind filters.
- Added a soft library lifecycle to immutable `part_asset` and `part_bundle`
  records. Retirement stores time and an optional reason; restoration clears
  those lifecycle fields. Texture, masks, manifests, files, member ordering, and
  historical references are never deleted or rewritten.
- An active Bundle protects its members from direct retirement and reports the
  blocking Bundle IDs. A Bundle may instead be retired as a whole or revised by
  replacing one or more members.
- Bundle revision validates active state, source Project/Revision, aggregate
  kind, model intersection, unique resulting membership, stored hashes, and
  conflicting pixel overlap. One immediate transaction creates a new immutable
  Bundle, copies the resulting ordered member references, records the old/new
  mapping in metadata, and retires the former Bundle.
- Added corrected-HEAD aggregate export beside the analyzed-skin catalog. After
  reclassifying or returning mistaken pixels to `unknown`, users can export the
  current Branch HEAD as a new complete hair, clothing, or accessory Bundle. No
  successful AI Job is required for this corrective re-export path.
- Retired assets remain available through detail, PNG preview, repair history,
  composition history, and existing reference reads. Operations that create a
  new reference reject retired assets: applying a Part, creating or continuing a
  repair, copying an external donor Part, and adding a Part or Bundle to a
  Composition. Composition commit also rechecks every persisted layer so a Part
  retired after draft creation cannot be committed accidentally.
- The analyzed-skin catalog reports an exported Bundle only while that Bundle is
  active. Retiring it makes the group available for a fresh export without
  erasing the prior Bundle.

## M11 verification evidence

- The final `pnpm verify` passes deterministic fixture checks, every workspace
  TypeScript project, all `249` Vitest cases, and every production build. Package
  totals are core `71`, compositor `8`, analysis pack `4`, provider `23`, Revision
  `32`, Worker `15`, API `12`, and Web `84`.
- The focused Revision-store suite covers migration defaults and lifecycle
  consistency, source/search/status filters, immutable reads after retirement,
  active-Bundle retirement conflicts, restoration, Bundle revision validation,
  atomic failure, member replacement evidence, and retired-reference guards.
- The API suite covers strict query validation, Part and Bundle retirement and
  restoration, `409` responses with blocking Bundle IDs, source-aware list
  results, preview readability, and active-only analyzed-catalog export state.
- Web tests cover source grouping/filter helpers, lifecycle controls,
  corrected-HEAD actions, whole-component correction, Bundle member replacement,
  and disabled new-reference actions for retired library entries.
- A real Chrome smoke test loaded the persisted `9058f3af3ffb104c` source,
  filtered its three active Bundles, opened the retired prior complete-hair Bundle,
  confirmed the active replacement Bundle contains `Long Crimson Hair · 修补`,
  and found the original erroneous Part in retired management. Selecting the
  source hair component exposed the two-step whole-component removal confirmation
  without executing its second mutation step. A temporary 700 px viewport had no
  document or library-toolbar horizontal overflow, and the app emitted no browser
  console errors. The existing Vite build-size advisory remains non-blocking.

## M11 boundaries

- Retirement is reversible library visibility and reference control, not data
  deletion. It does not remove files, rewrite manifests, edit Bundle membership,
  or purge historical Revisions, repair projects, or Composition layers.
- A repaired Part does not silently replace its ancestor or every Bundle that
  contains it. Users explicitly revise the chosen Bundle, which produces a new
  identity and keeps the prior Bundle readable as retired history.
- Whole-component unassign corrects semantic ownership only. It does not erase
  RGBA pixels from the skin texture; those pixels become `unknown` in the new
  Revision and remain available for a later correct classification.

## M12 deliverables

- Added seven stable navigation targets for the long-form Studio: Revision
  history; analyzed catalog plus corrected-HEAD export; AI analysis; 01–03 skin
  loading, UV, and avatar preview; 04–06 semantic editing and component library;
  07 component repair; and 08 composition, restoration, and conflict handling.
- Added a compact left-side workflow index that remains sticky on desktop. At
  viewport widths of 1280 px and below, the same ordered index becomes a sticky,
  horizontally scrollable bar so it does not reduce the editing canvas width.
- Kept every entry as a native fragment link so direct URLs and no-script anchor
  navigation retain their browser semantics. The active entry exposes
  `aria-current="location"`.
- Active-section selection derives from measured section geometry during scroll,
  resize, and hash changes. Updates are coalesced through
  `requestAnimationFrame`, and reaching the document end selects the final
  composition section.
- Section focus targets and scroll margins account for the responsive sticky
  index. Global reduced-motion preferences disable smooth scrolling and shorten
  navigation transitions.

## M12 verification evidence

- The final `pnpm verify` passes deterministic fixture checks, every workspace
  TypeScript project, all `253` Vitest cases, and every production build. Package
  totals are core `71`, compositor `8`, analysis pack `4`, provider `23`, Revision
  `32`, Worker `15`, API `12`, and Web `88`.
- Web tests cover the ordered native links, unique section identities, exact hash
  validation, activation-line boundaries, non-finite geometry fallback, and the
  document-end selection rule.
- A real Chrome smoke test verified the left sticky index at `1600×900`, the
  sticky horizontally scrollable index at `1200×820` and `700×800`, direct deep
  links, click navigation, active-section updates, and browser Back restoration.
  Each tested viewport had zero document-level horizontal overflow; the active
  item remained visible inside the narrow horizontal list.
- The only observed console message was an external Chrome-extension message
  channel warning during navigation; the application itself emitted no runtime
  error. The existing Vite warning for chunks larger than 500 kB remains
  advisory and does not fail the build.

## M12 boundaries

- The index groups related surfaces into seven stable workflow destinations; it
  does not add an entry for every nested card or editor control.
- Navigation changes the viewport location and active-link presentation only. It
  does not select a Project, Revision, Part, Bundle, repair, or Composition, and
  it does not create or mutate persisted data.
