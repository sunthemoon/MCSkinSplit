# MCSkinSplit

MCSkinSplit is a versioned Minecraft skin studio for lossless UV editing, semantic component extraction, reusable parts, AI-assisted classification, and pixel-safe multi-skin composition.

The repository is implemented milestone by milestone from the project specification in [`docs/mc-skin-ai-assisted-segmentation-versioned-studio-plan.md`](docs/mc-skin-ai-assisted-segmentation-versioned-studio-plan.md). M0 established the browser baseline, M1 added the deterministic 64×64 RGBA/UV core, M2 added immutable local history, M3 made the 3D avatar Revision-aware, M4 added manual semantic editing plus reusable parts, M5 added schema-validated Codex-assisted classification, M6 added conflict-aware composition, M7 added an analyzed-skin catalog plus reusable complete-category bundles, M8 added immutable single-component repair, M9 added deterministic target-remnant cleanup and Base skin restoration, M10 added a separate constrained AI recommendation step over those host-generated restoration candidates, M11 added source-aware library search plus auditable correction and retirement workflows for Parts and Bundles, M12 added a responsive workflow index for navigating the long-form Studio, M13 made semantic JSON transport single-pass by default while retaining strict host validation and opt-in native structured output, M14 added reversible, result-Revision-scoped catalog archiving without deleting or merging immutable history and library assets, M15 added a player-first clean-analysis flow with deterministic cross-body classification review and immutable catalog variants, M16 makes pixel transfers explicit, prevents provenance-losing reanalysis, and enforces immutable Revision/Part history in SQLite, and M17 adds deterministic CandidateRegion evidence plus paired all-surface visual grounding without changing the exact candidate partition or granting the model pixel authority.

The current Studio can:

- navigate seven stable workflow sections through native hash links, with a
  desktop left-side sticky index, a sticky horizontal index at 1280 px and
  below, scroll-aware `aria-current` state, and reduced-motion support;
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
- remove a whole mistaken component classification by returning all of its pixels to `unknown` in a new Revision;
- export a component as a verified five-file 64×64 part asset;
- search and filter Parts and complete-category Bundles by source Project, Branch/Revision provenance, semantic kind, and active/retired state;
- retire or restore immutable library entries without deleting files or breaking historical reads;
- revise a complete-category Bundle by replacing repaired members, creating a new Bundle and retiring the old Bundle atomically;
- re-export hair, clothing, or accessories from a corrected current Branch HEAD without overwriting earlier library versions;
- preview part conflicts without creating a Revision, then apply an explicit conflict strategy as a new Revision;
- prepare an integrity-checked analysis workspace for every AI run;
- run the repository `mc-skin-segmenter` Skill 1.4 contract through a read-only,
  tool-free local Codex CLI invocation with a compact Candidate Evidence Graph,
  an ordered attachment manifest, and paired natural/candidate-region views;
- start semantic analysis with one player-facing action and a clean semantic
  baseline by default, while keeping the existing-classification baseline in
  advanced settings;
- inspect six-stage Job progress, paired tool events, recoverable provider events,
  validation artifacts, cross-body review, and review items in the Studio;
- create an `ai_segment` Revision only after strict schema and pixel-ownership validation;
- review deterministic cross-body hair reclassification suggestions and either
  retain the original result or create an immutable classification-repair Revision;
- browse successful AI result Revisions as a persistent analyzed-skin catalog;
- compare an accepted `分类修复版` beneath its original analyzed-skin entry
  without replacing or hiding the original Revision;
- batch-export complete hair, clothing, or accessory groups without removing any of the 23 fine semantic categories;
- inspect an immutable part bundle as a 2D texture or on a draggable Wide/Slim 3D mannequin;
- add every member of a bundle to a Composition Project atomically while retaining independent fine-component layers;
- start a repair project directly from any saved atomic part without first selecting it in the component tree;
- paint non-transparent pixels, erase explicitly, replace exact RGBA colors, mirror limbs, or copy donor surfaces through append-only repair Revisions;
- preview a configured repair immediately in both 2D and on a draggable Wide/Slim mannequin without persisting it;
- commit a repair as a new immutable part while retaining the original part and complete repair history;
- arrange multiple saved parts in a persistent top-to-bottom layer stack;
- inspect model, semantic-boundary, same-color, and hard per-pixel conflicts;
- resolve hard conflicts through explicit layer order or individual pixel winners;
- choose cleanup targets by fine semantic component or by complete hair, clothing,
  or accessory view without changing the fixed 23-category taxonomy;
- clear selected Outer remnants and fill exposed Base pixels from deterministic
  same-surface, same-body-part, mirror, donor-Revision, or opaque manual candidates;
- preview, version, audit, clear, and commit a hash-verified restoration plan
  without accepting client-supplied masks or PNG output;
- ask the repository `mc-skin-replacement-planner` Skill to rank only the
  already generated Base candidate IDs, then review and load its confidence and
  explanation without automatically applying a restoration plan;
- export the live composition preview and commit a validated `compose` Revision;
- rebuild the checked-in Alex/Slim mix pixel-exactly from all six real skins.

## Requirements

- Node.js 24
- pnpm 10.13.1
- A browser with WebGL support
- An installed and authenticated Codex CLI for optional AI-assisted analysis or replacement recommendation

## Start the Studio

```bash
pnpm install
pnpm fixtures:generate
pnpm dev
```

Open `http://127.0.0.1:5173`. The command starts both the Fastify API (`127.0.0.1:3001`) and Vite. The generated Alex/Slim mix is selected by default. Uploading a 64×64 PNG creates a Project and Import Revision; bundled real-world skins can be previewed first and imported with the timeline button.

Runtime metadata and snapshots are stored under `data/`. Set `MC_SKIN_DATA_DIR` before starting the API to use another directory.

AI analysis and replacement recommendation default to the locally configured Codex model, `medium` reasoning, and a 600-second timeout. New semantic Jobs default to `semanticBaseline: "empty"`: the provider classifies from the prepared views and candidate evidence without receiving earlier component labels as a prior. Advanced settings can select `"current"`, which supplies the existing component summary as a soft prior that must still be re-evaluated. Semantic analysis uses Skill 1.4, prompt `semantic-proposal-v7-all-surface-grounding`, proposal Schema 1.2, and validator v3. The unchanged CandidateRegions remain the exact ownership units; Candidate Evidence Graph v1 adds host-computed geometry, color, contact, proximity, canonical seam, Base/Outer projection, and bilateral-mirror evidence. A labelled six-face natural/Region sheet covers top and bottom alongside the four-direction composite/Base/Outer pairs and stable-ID legend. A same-response `appearanceInventory` records diagnostic visible evidence only and cannot assign pixels or change masks. Unknown pixels stay in the unassigned/review mask rather than becoming components; proposal-wide overrides remain limited to 64 unique pixels and 32 spans, and every added pixel must be explicitly removed from another component-owned Region. Historical Schema 1.0 and 1.1 artifacts remain readable but cannot be submitted as new results. Historical Skill v1-v3 Job options are normalized only while reading their exact stored contract, so the audit list remains available without relaxing current writes; Retry still requires a fresh analysis instead of silently upgrading an older contract. The provider captures one JSON response by default, then applies strict host-side Schema, candidate-coverage, and pixel-ownership validation. Native structured-output transport is an explicit opt-in for compatible endpoints and retains a narrow host-validation fallback. Timeout and cancellation failures retain captured JSONL/stderr diagnostics when available. Until per-pixel origin metadata exists, a semantic run that would create a Revision rejects known generated, repaired-Part, applied-Part, composed, or palette-authored content ancestry instead of relabeling it as original; an explicitly read-only run remains available for comparison. After a valid AI Revision is stored, deterministic follow-up `cross-body-hair-reclassification-v2` may join nearby same-surface hair fragments into conservative cross-body classification suggestions for explicit review; version v1 remains readable as historical evidence. The follow-up does not generate missing clothing, hair, or body pixels. AI remains optional: deterministic editing, candidate generation, manual selection, history, previews, and parts work without a model call. See [`docs/ai-analysis.md`](docs/ai-analysis.md) for configuration, privacy boundaries, API routes, verification evidence, and audit behavior.

Composition uses the selected Revision's stored arm model and defaults imported projects to Slim/Alex. Preview rendering is always available, but a new Revision cannot be created until every blocking conflict has an explicit resolution and every requested Base restoration pixel has a validated source. Complete-category bundles and restoration target groups are convenience views over immutable fine parts and the unchanged 23-category taxonomy; neither flattens or deletes fine semantic components. Component repair provides deterministic authored reconstruction, while composition restoration clears selected target remnants and fills exposed Base pixels from explicit candidates. Neither workflow claims to recover factual pixels that were hidden in the source artwork. See [`docs/composition-workflow.md`](docs/composition-workflow.md) for layer and conflict behavior, [`docs/composition-restoration-workflow.md`](docs/composition-restoration-workflow.md) for cleanup, candidate, audit, and provenance contracts, [`docs/analyzed-skin-catalog-and-bundles.md`](docs/analyzed-skin-catalog-and-bundles.md) for the catalog and whole-bundle workflow, and [`docs/component-repair-workflow.md`](docs/component-repair-workflow.md) for repair tools and history.

## Verify

```bash
pnpm verify
```

This checks that generated fixtures are unchanged, runs TypeScript and unit tests, and builds the production web application.

## Repository layout

```text
apps/api/                 Fastify Project and Revision API
apps/ai-worker/           Persistent AI jobs, attempts, repair, and audit assets
apps/web/                 Vite + React browser Studio
packages/ai-provider/     Replaceable provider contract and Codex CLI adapter
packages/skin-analysis-pack/ Deterministic isolated analysis-workspace builder
packages/skin-compositor/ Deterministic multi-part composition and conflict reports
packages/skin-core/       Framework-independent PNG, layout, UV, and render core
packages/skin-revision/   SQLite metadata and immutable snapshot service
.agents/skills/mc-skin-segmenter/ Repository semantic-analysis Skill
.agents/skills/mc-skin-replacement-planner/ Repository candidate-ranking Skill
docs/                     Architecture, implementation status, and specification
scripts/                  Deterministic fixture tooling
tests/fixtures/skins/     Versioned Minecraft skin fixtures
```

The canonical UV contract is documented in [`docs/uv-layout.md`](docs/uv-layout.md), the history/storage contract in [`docs/revision-history.md`](docs/revision-history.md), semantic editing and part reuse in [`docs/semantic-editing-and-parts.md`](docs/semantic-editing-and-parts.md), AI analysis in [`docs/ai-analysis.md`](docs/ai-analysis.md), analyzed skins and bundles in [`docs/analyzed-skin-catalog-and-bundles.md`](docs/analyzed-skin-catalog-and-bundles.md), immutable component repair in [`docs/component-repair-workflow.md`](docs/component-repair-workflow.md), composition in [`docs/composition-workflow.md`](docs/composition-workflow.md), composition restoration in [`docs/composition-restoration-workflow.md`](docs/composition-restoration-workflow.md), and verification evidence in [`docs/implementation-status.md`](docs/implementation-status.md).
