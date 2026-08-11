# Implementation status

Last updated: 2026-08-11

## Milestones

| Milestone | Status | Verification target |
|---|---|---|
| M0 repository baseline | Complete | `pnpm verify` and browser smoke test |
| M1 deterministic pixel core | Complete | Lossless RGBA and UV round trips for Wide/Slim fixtures |
| M2 immutable revisions | Complete | SQLite, snapshots, revert, branch, hash checks |
| M3 revision-aware 3D preview | Not started | One viewer instance tracks selected revisions |
| M4 manual semantic editor and parts | Not started | Manual segmentation and lossless part reuse |
| M5 AI Skill and worker | Not started | Schema-valid proposals create revisions only after validation |
| M6 compositor | Not started | Explicit conflicts and deterministic composition |

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
- The real-skin `MIX` is a deterministic fixture recipe without edit controls or conflict handling; it does not replace the M6 compositor.
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
- Revision switching currently uses the existing M1 viewer component. M3 will add the dedicated viewer adapter, lazy loading, and focused resize lifecycle work.
- The eager `skinview3d`/Three.js production bundle remains about 962 kB before gzip and produces Vite's chunk-size warning.
