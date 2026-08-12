# Immutable component repair

M8 adds a dedicated workspace for repairing one saved atomic part. It is separate
from semantic segmentation and full-skin composition: the source is selected
directly from the part library, every confirmed edit is append-only, and saving
the result creates another immutable part instead of changing the source asset.
The fixed 23 fine semantic categories and M7 complete-category Bundles remain
unchanged; repair preserves the base part's existing semantic classification.

## Workflow

1. Select an existing saved part as the repair base. The part does not need to be
   selected in the semantic component tree first.
2. Create a repair project. Its initial Revision copies the verified part texture
   and write mask; the base part remains unchanged.
3. Select pixels on the 64x64 canvas or configure a surface-copy operation.
   Transparent pixels are selectable when they belong to valid UV for the part's
   Wide or Slim model. The browser applies the configured operation to cached,
   immutable HEAD and donor textures and immediately displays a disposable 2D and
   3D draft preview with its changed-pixel count.
4. Apply the operation. The service requires the current repair HEAD, validates
   the result, and creates a child repair Revision.
5. Inspect either the not-yet-applied local draft or the applied HEAD in the 2D
   texture canvas and on a neutral mannequin. The 3D preview supports Wide and
   Slim geometry, idle and walking display, pointer drag, and wheel zoom.
6. Commit the repair project under a new part name. Commit creates a new verified
   five-file part asset and closes the repair project; it never rewrites the base
   part or an earlier repair Revision.

When a configured local draft differs from the persisted HEAD, the save-as-new
part action remains disabled and identifies the unapplied pixel count. Apply the
draft as a repair Revision first; this prevents the visible preview from being
silently omitted by a commit of the older HEAD.

## Deterministic tools

| Tool | Stored operation | Exact behavior |
|---|---|---|
| Paint | `paint_color` | Writes one explicitly selected RGBA value with alpha `1..255`, including partial alpha, to selected valid-UV pixels. |
| Erase | `erase_pixels` | Writes transparent RGBA and removes the selected pixels from the sparse part write mask. |
| Exact replace | `replace_color` | Replaces exact RGBA matches, including source alpha, either inside an optional selection or across the non-transparent part. Its replacement alpha must be `1..255`; erasure uses `erase_pixels`. Matching transparent source pixels requires an explicit selection. |
| Limb mirror | `copy_surfaces` | Copies canonical arm or leg Base/Outer surfaces to the opposite limb with the required UV mirror transform. |
| Donor copy | `copy_surfaces` | Copies an exact canonical surface from another verified saved part. A repair Revision source is valid only within the same repair project. |

Surface copies can overwrite every destination pixel or only transparent
destination pixels. Source references are serialized as part or repair-Revision
IDs; texture bytes are resolved and verified by the service instead of being
embedded in request JSON. An `edit_revision` reference is restricted to the
target repair project, so reusing content from another repair project requires
first committing it as an immutable saved part and selecting that part as the
external donor. Pixel writes, UV bounds, model compatibility, surface dimensions,
and write-mask derivation are enforced by the deterministic core.

The editor does not anti-alias, interpolate, or synthesize colors. A color chosen
for paint or exact replacement is authored input and is stored exactly.

## Local draft preview

The configured operation is evaluated in the browser by the same deterministic
repair core used by the service. Immutable HEAD and donor PNGs are decoded once
per URL and cached; generated 2D and mannequin PNGs use disposable Blob URLs.
Changing the operation invalidates older asynchronous work, and replacement or
unmount revokes stale Blob URLs. Loading, ready, changed-pixel, and fallback states
are shown in the repair workspace.

This preview does not create files, SQLite rows, or a repair Revision. The
explicit **Apply as new Revision** action remains the only way to persist the
configured operation, and the service repeats all authoritative validation.

## Append-only persistence

Repair histories have their own namespace and do not become skin Revisions:

```text
data/
├── mcskinsplit.sqlite
└── part-edits/<part-edit-project-id>/revisions/<part-edit-revision-id>/
    ├── texture.png
    ├── write-mask.png
    └── revision.json
```

`part_edit_project` records the base part, draft/committed state, current HEAD,
and optional result part. `part_edit_revision` records parentage, sequence,
operation, summary, author metadata, changed-pixel count, file metadata, and
authored provenance.

Each Revision directory is assembled in a private sibling directory, files are
synchronized, and the directory is atomically renamed before its SQLite rows are
committed. A failed metadata transaction removes only the newly created directory.
Reads verify the three file paths, sizes, and SHA-256 hashes against SQLite and
also cross-check `revision.json` with the database row.

Committing a non-empty draft creates a normal immutable part:

```text
data/parts/<new-part-id>/
├── texture.png
├── write-mask.png
├── manifest.json
├── preview.png
└── source.json
```

The new part keeps the base part's semantic and model contract. Its
`manifest.json` uses PartManifest schema `1.1` and requires an explicit
`part_repair` derivation containing `basePartId`, `partEditProjectId`,
`partEditRevisionId`, and `containsGeneratedPixels: false`. `source.json` records
the same repair ancestry plus author and summary. Both repair Revisions and the
committed part therefore state that their pixels are manually authored rather
than model-generated.

## HTTP API

```text
GET  /api/part-edits?basePartId=
POST /api/part-edits
GET  /api/part-edits/:projectId
POST /api/part-edits/:projectId/operations
POST /api/part-edits/:projectId/commit

GET  /api/part-edit-revisions/:revisionId/texture.png
GET  /api/part-edit-revisions/:revisionId/write-mask.png
GET  /api/part-edit-revisions/:revisionId/mannequin.png?armType=slim
```

Create accepts `basePartId` and an optional project name. Operation and commit
requests must include `headRevisionId`; a stale HEAD is rejected rather than
silently overwriting a newer edit. Immutable PNG responses use Revision-specific
ETags. The mannequin texture is derived from verified repair files and is not a
fourth stored repair file.

## Boundaries

- Repair provides deterministic authoring tools; it cannot recover the factual
  source pixels that were hidden by hair, clothing, or another overlay. Mirroring,
  donor copying, and manual painting are explicit reconstruction choices.
- M8 does not invoke an AI model and does not mark authored pixels as generated.
- A repaired part still writes only its own non-transparent write-mask pixels when
  used in a composition. Clearing old target-skin clothing remnants or filling
  newly exposed target Base pixels requires the replacement/restoration workflow
  planned for M9.
- Repair histories are linear HEAD-checked drafts. They do not branch, merge, or
  mutate the full-skin Revision graph.
