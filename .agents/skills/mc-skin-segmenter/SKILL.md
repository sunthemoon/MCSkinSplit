---
name: mc-skin-segmenter
description: Analyze a prepared 64x64 Minecraft skin job and emit a schema-valid semantic proposal over exact UV candidate regions. Use for classifying hair, face, skin, clothing, gloves, shoes, and accessories from an MCSkinSplit analysis workspace. Do not use for generic image segmentation, image generation, or direct database edits.
---

# Minecraft Skin Semantic Segmenter

Produce one semantic proposal for the analysis job in `job.json`. Preserve the
source pixels and express every decision through supplied candidate region IDs or
small coordinate overrides.

## Workflow

1. Resolve every path relative to the directory containing `job.json`.
2. Run `node .agents/skills/mc-skin-segmenter/scripts/inspect-job.mjs job.json`.
3. Read `input/candidate-summary.json`, `input/palette.json`, and
   `input/previous-segmentation.json`. The compact summary contains every
   candidate ID grouped by UV surface.
4. Inspect `input/atlas-grid-16x.png`, `input/face-contact-sheet.png`, and the
   available images under `input/views/`.
5. Read [taxonomy.md](references/taxonomy.md),
   [uv-concepts.md](references/uv-concepts.md), and
   [analysis-guidelines.md](references/analysis-guidelines.md).
6. Do not load the full `input/candidate-regions.json` or `input/pixel-map.json`
   into context. The host validator uses them. Read only a targeted fragment if
   a small `pixelOverrides` decision cannot be made from the compact summary.
7. Assign candidate regions to coarse semantic component instances. Join
   disconnected regions only when they visibly belong to one item.
8. Use `pixelOverrides` only for a small mixed region. Keep uncertain regions in
   `unassignedCandidateRegionIds` and add a precise `reviewItems` entry.
9. Write a JSON object conforming to
   `schema/analysis-proposal.schema.json` at
   `output/analysis-proposal.json`. Do not wrap it in Markdown.
10. Run `node .agents/skills/mc-skin-segmenter/scripts/validate-proposal.mjs job.json`.
11. If validation fails, use `logs/validator-report.json` to repair the proposal
    once. Stop after a valid proposal or a clear failure.
12. Return the same proposal JSON as the final response.

## Boundaries

- Do not modify anything under `input/` or `schema/`.
- Do not modify the source PNG, recolor pixels, generate images, or invent hidden
  pixels.
- Do not access a database, another Project, parent directory, network resource,
  or application source file.
- Do not create a Revision. The host validates and commits a successful proposal.
- Prefer `unknown` and review items over unsupported certainty.
- Keep notes operational and short; do not include private reasoning.
