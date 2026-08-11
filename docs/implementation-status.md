# Implementation status

Last updated: 2026-08-11

## Milestones

| Milestone | Status | Verification target |
|---|---|---|
| M0 repository baseline | Complete | `pnpm verify` and browser smoke test |
| M1 deterministic pixel core | Complete | Lossless RGBA and UV round trips for Wide/Slim fixtures |
| M2 immutable revisions | Not started | SQLite, snapshots, revert, branch, hash checks |
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
- M1 has no API or persistent project state; reloading the page clears uploads and overrides.
- A non-blocking pre-existing `ResizeObserver loop` development report is recorded in [`mc-skin-ai-assisted-segmentation-versioned-studio-plan_问题记录.md`](mc-skin-ai-assisted-segmentation-versioned-studio-plan_问题记录.md); M1 does not include an unrelated viewer resize fix.

## M2 file-level implementation plan

1. Add `apps/api` with a localhost HTTP boundary and explicit runtime data directory.
2. Add `packages/skin-revision` with SQLite migrations for projects, branches, revisions, parent edges, and content hashes.
3. Store each revision as a complete immutable snapshot directory with canonical manifest and PNG artifacts.
4. Implement import, list, detail, content, revert-as-new-revision, and branch-from-history operations.
5. Verify SHA-256 content hashes whenever snapshots are read and reject path traversal or partial snapshots.
6. Add service tests for immutability, duplicate content, concurrent writes, revert, branch ancestry, and corruption detection.
7. Add a web API adapter and revision timeline that can select any historical node without changing it.
8. Run repository verification and browser-test import, selection, revert, and branch behavior before committing M2 as `feat(history): add immutable skin revisions and branching`.
