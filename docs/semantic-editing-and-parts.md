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
GET  /api/parts
GET  /api/parts/:partId
GET  /api/parts/:partId/texture.png
GET  /api/parts/:partId/preview.png
GET  /api/parts/:partId/mannequin.png?armType=slim
GET  /api/part-bundles
GET  /api/part-bundles/:bundleId
GET  /api/part-bundles/:bundleId/preview.png
GET  /api/part-bundles/:bundleId/mannequin.png?armType=slim
POST /api/revisions/:revisionId/apply-part
```

`GET /api/parts` accepts an optional `category` query. Send only `{ "partId":
"..." }` to preview application. Add `"strategy": "use_part"` or
`"strategy": "keep_base"` to create a Revision.

The complete catalog and bundle workflow, including integrity and composition
boundaries, is documented in
[`analyzed-skin-catalog-and-bundles.md`](analyzed-skin-catalog-and-bundles.md).
