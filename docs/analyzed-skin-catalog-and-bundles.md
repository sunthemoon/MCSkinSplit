# Analyzed-skin catalog and complete-category bundles

M7 turns confirmed AI results into reusable sources without flattening the
semantic model. The existing 23 fine categories remain authoritative. The three
complete-category kinds—`hair`, `clothing`, and `accessory`—only group fine parts
for faster browsing, export, preview, and composition.

## Catalog behavior

The catalog is derived from persisted successful AI Jobs whose valid proposal has
already created an immutable `ai_segment` Revision. It is not a second mutable
skin store. When more than one successful Job points to the same result Revision,
the latest successful Job supplies the catalog metadata.

Each entry exposes the Project and Revision identity, provider and model, arm
layout, component and unknown-pixel counts, review-item count, source skin URL,
and available complete-category groups. Loading an entry selects that exact
Revision in the same Atlas, semantic editor, timeline, and 3D viewer used by the
rest of the Studio.

The grouping rules are deterministic:

- all classified `hair` components form the complete-hair group;
- clothing components that share `sameOutfitGroup` form one clothing group;
- clothing without an outfit-group value forms the default complete-clothing group;
- all classified accessory categories form the accessory group.

“Complete” means all classified components in that semantic group. It does not
claim to reconstruct pixels hidden in the source artwork or correct a mistaken AI
classification. Review items remain visible, and the semantic editor remains the
correction path.

## Bundle export and storage

Exporting a catalog group creates an immutable Bundle and one ordinary immutable
part asset per member. The Bundle stores the source Project and Revision, aggregate
kind, optional outfit-group key, compatible arm models, ordered member references,
creation time, and metadata. Member textures and masks are not merged into a new
editable file.

Batch export validates the source Revision snapshot, every component identifier,
aggregate membership, optional outfit-group membership, and the common arm-model
intersection. Part directories are prepared with the normal five hashed files.
The parts, Bundle, and ordered membership rows become visible together in one
SQLite transaction; a failure removes only the newly prepared directories.

Bundle 2D and mannequin previews are derived at read time from the verified member
parts. The mannequin fills valid base-layer UV faces with neutral shading and then
copies Bundle pixels for the requested compatible Wide or Slim layout. Conflicting
different-color writes between members fail integrity validation instead of being
silently ordered.

## Composition workflow

The Bundle shelf is available directly inside the Composition Project. Selecting
a Bundle opens its combined preview and draggable 3D mannequin. The inspector
defaults to an idle pose and also supports the walk preview, drag rotation, and
wheel zoom.

Adding a Bundle performs one atomic draft mutation:

1. Require an editable Composition Project and a compatible arm model.
2. Reject a Bundle when any member is already present.
3. Verify every member's stored hashes and manifest before changing layers.
4. Insert all members consecutively at the requested position.
5. Re-evaluate the complete stack, clear stale conflict decisions, and persist the
   normalized layers together.

The resulting layers are ordinary fine-part layers. Users can reorder or remove
them independently, and normal conflict resolution still applies. Adding a Bundle
does not create a skin Revision; only the existing composition commit operation can
create an immutable `compose` Revision.

## HTTP API

```text
GET  /api/analyzed-skins?projectId=&kind=&q=
GET  /api/analyzed-skins/:revisionId
POST /api/revisions/:revisionId/export-bundle

GET  /api/part-bundles?kind=&sourceRevisionId=
GET  /api/part-bundles/:bundleId
GET  /api/part-bundles/:bundleId/preview.png
GET  /api/part-bundles/:bundleId/mannequin.png?armType=slim

POST /api/compositions/:compositionId/apply-bundle
```

All mutation bodies use strict request schemas. Derived PNG responses use
Bundle-specific immutable ETags; part reads retain the existing file and database
hash checks.

## Boundaries

- Manual-only Revisions do not enter the analyzed-skin catalog unless they are the
  persisted result of a successful AI Job.
- A Bundle captures one immutable source Revision. Later semantic corrections or
  re-analysis require exporting a new Bundle; existing Bundles are not rewritten.
- The grouping layer does not synthesize occluded content, erase unrelated pixels
  from a target skin, or fill newly exposed Base pixels. Component repair and
  Composition restoration remain explicit separate workflows; see
  [`component-repair-workflow.md`](component-repair-workflow.md) and
  [`composition-restoration-workflow.md`](composition-restoration-workflow.md).
- Bundle compatibility is the intersection of its member manifests. A Bundle with
  no common arm model is rejected during export.
