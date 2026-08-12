# Pixel-safe composition workflow

M6 combines multiple saved 64x64 parts over an immutable Revision without
changing the source skin. The compositor is deterministic: the same base image,
ordered layers, and conflict decisions always produce the same RGBA result.

## Composition lifecycle

1. Select a Branch HEAD Revision. Its stored arm model is the target model; new
   projects default to Slim/Alex unless an imported Revision explicitly records
   Wide/Classic.
2. Create a Composition Project. It stores the base Revision and Branch instead of
   copying mutable skin state.
3. Add saved parts as ordered layers. Position zero is closest to the base and the
   highest position is the top writer.
   A complete-category bundle may be added in one action; its ordered members are
   inserted as consecutive ordinary layers and remain independently adjustable.
4. Inspect the live 3D result or switch to its 64x64 texture and conflict report.
   Previewing is read-only and may show the default top-layer result even while
   conflicts remain unresolved.
5. Resolve each hard pixel conflict by choosing a winning layer, or explicitly
   confirm that the complete layer order should decide all hard conflicts.
6. Commit only when the report is committable. The service rechecks the Branch
   HEAD, all stored hashes, every part manifest, and the conflict decisions before
   creating one immutable `compose` Revision.

Adding, removing, or reordering a layer clears prior conflict decisions because
the available writers or their priorities may have changed. A committed
Composition Project is immutable.

## Pixel rules

`packages/skin-compositor` evaluates every Atlas pixel independently.

- A transparent base pixel has no base write.
- A non-transparent base pixel participates as the fixed `base` layer.
- Part layers are evaluated from bottom to top; the last writer is the preview
  winner.
- Overlapping writes with identical RGBA values are same-color overlaps and do not
  block a commit.
- Different RGBA writes are hard conflicts. They block until a pixel winner or the
  complete layer order is explicitly confirmed.
- A part that does not support the target arm model is a blocking model conflict.
- A write outside the surfaces declared by the part manifest is a blocking
  semantic-boundary conflict. Neither structural conflict can be dismissed through
  layer ordering.
- Empty compositions cannot be committed.

The committed segmentation keeps existing base ownership for untouched pixels and
creates semantic components from the winning pixels of each part layer. Pixels
lost to higher layers are not duplicated into component masks.

## Persistence and API

SQLite migration `004_compositions.sql` adds `composition_project` and
`composition_layer`. Resolution mode, per-pixel winners, the latest report, base
Revision, Branch, and result Revision are persisted for reload and audit.

The HTTP surface is:

```text
GET    /api/compositions?revisionId=:revisionId
POST   /api/compositions
GET    /api/compositions/:compositionId
GET    /api/compositions/:compositionId/preview.png
POST   /api/compositions/:compositionId/apply-part
POST   /api/compositions/:compositionId/apply-bundle
POST   /api/compositions/:compositionId/reorder
DELETE /api/compositions/:compositionId/layers/:layerId
POST   /api/compositions/:compositionId/resolve-conflict
POST   /api/compositions/:compositionId/commit
```

All mutation bodies use strict Fastify JSON Schemas. Storage and concurrency
failures keep the existing structured API error contract.

Whole-bundle insertion is atomic. Before any layer is stored, the service verifies
the draft state, target arm model, insertion position, duplicate members, and every
member's immutable part files. It then evaluates the complete resulting stack and
replaces the draft layer set in one transaction. As with any layer mutation,
previous conflict decisions are cleared because their writers may have changed.

## Real-skin composition fixture

The deterministic M6 integration test exports six surface groups from the six
pinned user skins and rebuilds `alex-mix-real.png`:

| Output region | Source fixture |
|---|---|
| Head, Base + Outer | `ab87de696cfca859.png` (A1) |
| Torso, Base + Outer | `bc1a12c777b45e7b.png` (A4) |
| Right arm, Base + Outer | `bad5dea368e72b05.png` (A3) |
| Left arm, Base + Outer | `8d9ecb2e49f9d3df.png` (A5) |
| Right leg, Base + Outer | `9058f3af3ffb104c.png` (A6) |
| Left leg, Base + Outer | `354359a2c2f33777.png` (A2) |

All sources are recognized as Slim/Alex. The test starts from a transparent Slim
base, persists all six parts, composes them through the Revision service, and
requires both the preview and committed Revision PNG to match the checked-in mix
pixel for pixel.

## Studio behavior

The M6 panel restores the newest draft for the selected Revision and displays the
global part library inside the compositor itself. Selecting a part opens a neutral
mannequin 3D inspector, while the adjacent add action places it in the stack. The
component and result viewers default to an idle pose, support drag rotation and
wheel zoom, and expose compact idle/walk controls; the result also switches between
3D and its raw texture.

M7 adds a complete-category shelf beside the fine-part picker. A bundle card has a
combined 2D preview and a neutral-mannequin 3D inspector with the same idle/walk,
drag, and zoom controls. The whole-set action adds every compatible member at once;
afterward the normal stack controls can reorder or remove each member separately.

The panel shows the stack from top to base and exposes both bulk layer-order
confirmation and individual pixel-winner controls. The preview PNG can be
downloaded at any time for inspection; the commit action stays disabled until the
server report is committable. After commit, the new Revision is loaded into the
timeline, Atlas, semantic editor, and 3D avatar together.
