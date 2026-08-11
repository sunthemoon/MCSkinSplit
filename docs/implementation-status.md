# Implementation status

Last updated: 2026-08-11

## Milestones

| Milestone | Status | Verification target |
|---|---|---|
| M0 repository baseline | Complete | `pnpm verify` and browser smoke test |
| M1 deterministic pixel core | Not started | Lossless RGBA and UV round trips for wide/slim fixtures |
| M2 immutable revisions | Not started | SQLite, snapshots, revert, branch, hash checks |
| M3 revision-aware 3D preview | Not started | One viewer instance tracks selected revisions |
| M4 manual semantic editor and parts | Not started | Manual segmentation and lossless part reuse |
| M5 AI Skill and worker | Not started | Schema-valid proposals create revisions only after validation |
| M6 compositor | Not started | Explicit conflicts and deterministic composition |

## M0 repository audit

- The target GitHub repository existed but had no refs.
- The local project directory contained only the specification; there was no application, preview bundle, fixture, test command, or historical UI to preserve.
- The baseline stack is Node.js 24, pnpm workspaces, Vite 8, React 19, and TypeScript.
- `skinview3d` is pinned to 3.4.2 and bundled locally by Vite. Its supported animation API is `skinViewer.animation = new WalkingAnimation()`; no `animations.add` compatibility branch is needed for this new baseline.
- Skin input is a file/blob URL. Uploaded skin bytes are never embedded into source code.
- M0 validates the PNG signature and IHDR dimensions before previewing an upload. Complete decode and RGBA validation belong to M1.

## M0 deliverables

- Runnable responsive browser baseline with 2D atlas and 3D avatar views.
- Upload and drag/drop support for standard 64x64 PNG files.
- One `SkinViewer` instance with `ResizeObserver`, animation, auto-rotation, load state, and cleanup.
- Deterministic `wide-basic.png` fixture and a check mode that detects drift.
- Unit tests for PNG signature and 64x64 IHDR validation.
- Root `pnpm verify` command and GitHub Actions verification workflow.

## M0 verification evidence

- `pnpm verify`: passed fixture drift check, TypeScript project references, 6 Vitest cases, and the Vite production build on Node.js 24.18.1.
- Desktop browser smoke: the fixture loaded in both views, `skinview3d` reached `ready`, and the Atlas image filled the pixel stage after visual correction.
- Responsive smoke at the mobile breakpoint: panels stacked, the canvas remained responsive, the preview stayed `ready`, and the document had no horizontal overflow.
- Browser console: no application exceptions. The local graphics driver emitted a non-blocking Three.js shader sample-bias warning.
- Chrome automation could not set a local upload file because the ChatGPT Chrome Extension lacks file URL access. The upload validator is covered by tests for a valid PNG, invalid MIME, oversize input, invalid signature, and legacy dimensions; manual chooser verification remains an environment check rather than a code blocker.

## Known boundaries

- M0 only inspects the PNG container header; it does not yet prove successful RGBA decoding, valid pixel data, or UV use.
- Automatic wide/slim detection is display-only until M1 adds explicit model metadata and an override.
- WebGL coverage is currently a desktop/mobile smoke check; automated browser regression coverage is deferred to the Playwright work in later milestones.
- The `skinview3d` dependency currently forms most of a roughly 715 kB minified entry chunk; M3 should lazy-load the 3D adapter.
- There is no API or persistent project state before M2.

## M1 file-level implementation plan

1. Create `packages/skin-core` with framework-independent public exports.
2. Add `src/png/decode.ts` and `src/png/encode.ts` for exact 64x64 RGBA I/O.
3. Add JSON-schema-validated `src/layouts/wide-64.json` and `src/layouts/slim-64.json`.
4. Add `src/uv/atlas-to-surfaces.ts` and `src/uv/surfaces-to-atlas.ts` with canonical surface keys and explicit orientation transforms.
5. Add `src/render/scale-nearest.ts`, `src/render/contact-sheet.ts`, and grid overlay helpers.
6. Extend `scripts/generate-fixtures.mjs` with slim and directional UV-calibration fixtures.
7. Add unit tests for every face rectangle/orientation plus import-export and atlas-surface-atlas RGBA equality.
8. Replace the M0 `<img>` atlas with a Canvas 2D adapter that disables smoothing and uses the M1 APIs.
9. Update this document with exact fixture coverage and test evidence, then commit M1 as `feat(core): add deterministic minecraft skin uv model`.
