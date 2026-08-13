# Semantic editing and reusable parts

MCSkinSplit stores manual segmentation as validated pixel masks inside immutable
Revisions. Reusable parts are independent, immutable library assets that can be
previewed against another Revision before any texture is changed.

## Semantic state

Every valid, non-transparent UV pixel belongs to exactly one of these sets:

1. one confirmed semantic component; or
2. the `unknown` mask.

Transparent pixels and pixels outside the selected Wide/Slim UV layout cannot be
assigned. Component masks cannot overlap. The validator reconstructs canonical
surface spans and palettes from the masks and rejects a snapshot when either
derived value disagrees.

A new Import Revision starts with no components. Its valid, non-transparent UV
pixels are placed in `components/unknown.mask.png`, ready for manual or later AI
classification. Older M2/M3 snapshots without mask files remain readable and are
upgraded in memory when a new semantic edit is confirmed; historical files are
never rewritten.

The fixed taxonomy contains skin, face, hair, clothing, footwear, accessories,
and `unknown` categories. Stable machine identifiers are stored separately from
Chinese display labels, so UI text can change without changing saved semantics.

The complete-category kinds `hair`, `clothing`, and `accessory` are an additive
browsing and reuse layer. They map the existing fine components into convenient
groups; they do not replace or remove any of the fixed 23 categories. A saved
clothing bundle can therefore be added in one action and still expose its upper
clothing, sleeves, gloves, legwear, shoes, and other members as independent parts.

## Manual operations

The editor supports five deterministic operations:

| Operation | Effect |
|---|---|
| `assign_pixels` | Move selected pixels into a new or existing component |
| `unassign_pixels` | Move selected pixels back to `unknown` |
| `merge_components` | Replace two or more components with one target component |
| `split_component` | Move a non-empty subset into a new component |
| `reclassify_component` | Change category/subtype without changing its mask |

Canvas brushing only changes an in-browser draft. Confirming one of the
operations sends it to the Revision service, validates the complete resulting
state, and creates a child Revision on the current Branch. Editing a historical
node directly is rejected; branch or restore it first.

The Studio also exposes a two-step **remove selected component recognition**
action. It submits the component's complete stored spans as `unassign_pixels`.
The new Revision has no such component and returns all of its pixels to
`unknown`; it does not erase RGBA pixels or alter the source Revision. Mixed
components should instead be split or selectively unassigned so correctly
classified pixels remain owned.

Each semantic Revision snapshot contains:

```text
projects/<project-id>/revisions/<revision-id>/
├── skin.png
├── segmentation.json
├── operation.json
├── checksum.json
└── components/
    ├── unknown.mask.png
    └── <component-instance-id>.mask.png
```

Every mask is a complete 64x64 PNG. The checksum manifest and SQLite asset rows
cover each dynamic mask file in addition to the four core snapshot files.

## Part assets

Exporting a component creates one immutable library asset without changing the
source skin Revision:

```text
parts/<part-id>/
├── texture.png
├── write-mask.png
├── manifest.json
├── preview.png
└── source.json
```

`texture.png` and `write-mask.png` are always 64x64. Only colored pixels selected
by the write mask participate in application. The manifest records source
provenance, category, subtype, arm-model compatibility, preferred layers,
surfaces, relations, and dominant color. `source.json` preserves the exact
Project, Revision, and component identity from which the part was exported.

Part directories are first written to a private sibling directory and then
atomically renamed. SQLite records all five hashes, byte sizes, MIME types, and
paths. Reads verify both the files and database metadata.

M11 adds source-aware search and a reversible `active`/`retired` lifecycle to
Parts. List entries expose their source Project, Branch, and Revision. Retirement
hides an asset from normal reuse and rejects new applications, repair bases,
external donors, and Composition layers without deleting its files or historical
references. An active Bundle must be retired or revised before one of its members
can be retired.

For 3D inspection, the server generates a complete neutral mannequin texture at
read time. It fills only valid base-layer UV faces for the requested Wide or Slim
model, then copies non-transparent part pixels allowed by the immutable write mask.
The generated preview is derived data; it does not add a sixth stored part file or
change the original texture.

## Complete-category bundles

M7 can batch-export confirmed components from one Revision as an immutable part
bundle. Every member remains a normal five-file part asset with its own source
component, texture, mask, manifest, and hashes. The bundle stores only ordered
member references, source Revision, aggregate kind, model compatibility, and an
optional semantic outfit-group key. It never replaces the fine components with a
flattened mutable texture.

Hair and accessories are collected by aggregate kind. Clothing components with a
confirmed `sameOutfitGroup` value are kept in that outfit group; ungrouped clothing
forms the Revision's default clothing group. The derived 2D and neutral-mannequin
previews combine verified member pixels at read time. A different-color overlap
between members is treated as corrupt bundle data instead of being silently
flattened.

## Immutable component repair

M8 can open any saved atomic part directly from the library in a dedicated repair
project. The repair canvas can select transparent pixels inside valid Wide/Slim UV
and supports exact paint, erase, color replacement, limb mirror, and donor-surface
copy operations. Each confirmed operation creates a new repair Revision; it does
not alter semantic masks, the source skin Revision, or the base part.

The browser applies a configured operation in memory to cached immutable HEAD and
donor textures, then switches both the 2D texture and neutral-mannequin views to
disposable not-yet-applied draft PNGs. Stale asynchronous results are ignored and
their Blob URLs are revoked. Only the explicit apply action persists a validated
child Revision. Committing creates another normal five-file part with a
PartManifest `1.1` `part_repair` derivation and leaves the complete repair history
readable. Repair does not replace or merge any of the fixed 23 semantic
categories. An `edit_revision` surface-copy source must belong to the same repair
project; content from another project is reused through a committed saved part.
These tools reconstruct appearance through authored choices; they cannot
determine the factual pixels that were hidden in the source image.

## Conflict preview and application

Calling apply without a strategy performs a read-only preview. It reports model
compatibility, write-pixel count, and conflicts without creating a Revision.
The M4 single-part report distinguishes different-color hard conflicts from
same-color overlap. M6 extends that contract with ordered part layers, model and
semantic-boundary conflicts, and persisted pixel-winner decisions; see
[`composition-workflow.md`](composition-workflow.md).

An application is committed only with an explicit strategy:

- `use_part` writes the part pixels over conflicts;
- `keep_base` preserves conflicting base pixels and writes only safe pixels.

The committed result is a new `apply_part` Revision. Existing semantic masks are
rebased to the resulting image, affected pixels are removed from prior component
ownership, and written part pixels receive a provenance-backed component.

## HTTP endpoints

```text
POST /api/revisions/:revisionId/operations
POST /api/revisions/:revisionId/components/:componentId/export-part
POST /api/revisions/:revisionId/export-bundle
GET  /api/parts?category=&projectId=&sourceRevisionId=&status=&q=
GET  /api/parts/:partId
GET  /api/parts/:partId/texture.png
GET  /api/parts/:partId/preview.png
GET  /api/parts/:partId/mannequin.png?armType=slim
POST /api/parts/:partId/retire
POST /api/parts/:partId/restore
GET  /api/part-bundles?kind=&projectId=&sourceRevisionId=&status=&q=
GET  /api/part-bundles/:bundleId
GET  /api/part-bundles/:bundleId/preview.png
GET  /api/part-bundles/:bundleId/mannequin.png?armType=slim
POST /api/part-bundles/:bundleId/retire
POST /api/part-bundles/:bundleId/restore
POST /api/part-bundles/:bundleId/revise
GET  /api/part-edits
POST /api/part-edits
GET  /api/part-edits/:projectId
POST /api/part-edits/:projectId/operations
POST /api/part-edits/:projectId/commit
GET  /api/part-edit-revisions/:revisionId/texture.png
GET  /api/part-edit-revisions/:revisionId/write-mask.png
GET  /api/part-edit-revisions/:revisionId/mannequin.png?armType=slim
POST /api/revisions/:revisionId/apply-part
```

`GET /api/parts` defaults to active entries and accepts the filters shown above.
Send only `{ "partId":
"..." }` to preview application. Add `"strategy": "use_part"` or
`"strategy": "keep_base"` to create a Revision.

The complete catalog and bundle workflow, including integrity and composition
boundaries, is documented in
[`analyzed-skin-catalog-and-bundles.md`](analyzed-skin-catalog-and-bundles.md).
The component repair contract is documented in
[`component-repair-workflow.md`](component-repair-workflow.md).
