# Composition remnant cleanup and Base restoration

M9 extends a draft Composition Project with a deterministic restoration plan. It
solves the gap left by colored-only part write masks: replacing a component does
not otherwise remove old target pixels outside the new part, and clearing an old
Base pixel would expose transparency instead of skin.

Restoration is part of composition, not part repair and not AI segmentation. It
does not change the fixed 23 fine semantic categories. The Studio's complete
hair, clothing, and accessory choices are selection views that expand to the
matching stored fine component IDs; persisted plans still name those IDs.

## Workflow

1. Start from an editable Composition Project whose base Revision contains stored
   semantic components.
2. Select one or more target components. Fine selection is explicit. A complete
   hair, clothing, or accessory view selects all matching fine components without
   merging, reclassifying, or deleting them.
3. Optionally provide one compatible donor Revision and/or one manually chosen
   opaque RGBA skin color.
4. Generate candidates. This request is read-only: it does not store a plan,
   append an audit event, or create a skin Revision.
5. Inspect the aggregate Outer cleanup and the Base candidates grouped by body
   part. Outer cleanup is always included. Select at most one Base candidate for
   each target group and require complete coverage before applying the plan. As
   an optional M10 step, request an AI recommendation over this exact public
   candidate set, review its ranking, confidence, and explanation, then load the
   suggested IDs into the same local selector.
6. Apply explicitly. The service regenerates the complete candidate set from the
   trusted Revisions and request inputs, checks its hash and selected IDs, then
   stores a new version of the plan.
7. Inspect the resulting 64x64 texture or draggable Wide/Slim 3D preview. Both
   views use the server-rendered composition detail after the plan is applied.
8. Clear the plan with its current version or commit the composition. Commit still
   rechecks the Branch HEAD, immutable assets, conflicts, plan integrity, and Base
   coverage before creating an immutable `compose` Revision.

Changing candidate controls creates another disposable selection state in the
browser; it does not alter the current server preview. **Apply** is the persistence
boundary. A missing Base pixel or restoration integrity issue keeps the
composition non-committable.

## Deterministic candidate rules

The host derives cleanup pixels from the selected components' verified semantic
masks and maps each pixel to its canonical body part and Base/Outer layer.

- All selected Outer pixels form one aggregate `outer_transparent` candidate.
  Applying a plan always includes it and writes transparent RGBA to those Outer
  pixels.
- Base pixels are never cleared to transparency. They must be filled with alpha
  `255` by one candidate for their body-part group.
- `current_same_surface` samples opaque pixels classified as `skin` on the same
  Base surface of the composition's base Revision.
- `current_same_body_part` samples opaque semantic skin from another Base surface
  of the same body part.
- `mirrored_counterpart` uses the canonical mirrored Base coordinate: arms and
  legs use the opposite limb, while left/right faces are mirrored within the
  applicable body part. The sampled coordinate must have semantic skin evidence.
- `donor_revision` uses semantic skin from one explicitly named compatible donor
  Revision. The service verifies its snapshot and arm model.
- `manual_rgba` fills the target group with the exact user-selected opaque RGBA
  value. Manual fill is an authored reconstruction, not a claim about the hidden
  source color.

Distance ordering, pixel-ID tie breaking, group ordering, candidate IDs,
candidate-set hashes, evidence hashes, and plan hashes are deterministic.
Translucent or transparent manual fills are rejected. A candidate may be partial;
its coverage is shown, but a plan with any missing requested pixel cannot be
committed.

M9 candidate generation remains deterministic and never calls a model. M10 can
optionally recommend among the resulting public Base candidate IDs, but it is not
connected to candidate generation, masks, pixels, target expansion, cleanup
operations, or color creation. It cannot supply a restoration mask, write pixels,
return a PNG, access the application database, or apply a plan.

## Optional AI recommendation

The repository `mc-skin-replacement-planner` Skill receives an integrity-checked
public candidate catalog plus a short user intent. The default provider ignores
user configuration, clears MCP/apps, disables model tools, uses a read-only
sandbox, and inlines that public input instead of granting file access. It returns exactly
one sorted decision per Base target group: a complete ranking of that group's
supplied candidate IDs, an optional selected complete candidate, confidence, and
a short explanation. Aggregate Outer cleanup remains automatic host behavior and
is excluded from the proposal.

Host validation binds a recommendation to its Job ID, Composition ID, and
candidate-set hash. The browser separately compares the catalog's Composition
version before loading. Unknown, duplicate, cross-group,
partial selected, or privately evidenced results fail validation. The Studio
shows the normal live Job/Run/Event process and lets the user load a fresh valid
recommendation into local candidate selection. Loading is deliberately distinct
from applying: the user must still press **Apply** so the service can regenerate
the candidates, recheck version/hash/coverage, and persist the existing M9 plan.

Manual selection remains available before, during, and after an AI Job. No Codex
installation or model call is required for deterministic candidate generation,
selection, preview, plan application, or commit. The Skill is stored in the
repository and copied into each Run workspace; it is not a required global Codex
Skill installation.

## Trust boundary and API

```text
POST   /api/compositions/:compositionId/restoration-candidates
POST   /api/compositions/:compositionId/ai-restoration-recommendation
PUT    /api/compositions/:compositionId/restoration-plan
DELETE /api/compositions/:compositionId/restoration-plan
```

The AI route starts an advisory Job bound to the supplied public catalog inputs;
the shared `/api/ai-jobs` detail, event, cancel, and retry routes expose its
audited process. It does not replace either candidate generation or plan apply.

Candidate generation accepts `targetComponentIds` plus optional
`donorRevisionId` and `manualRgba`. It returns public summaries, coverage counts,
one aggregate Outer candidate ID, Base candidate IDs, and a candidate-set hash.
It does not return masks, pixel-ID lists, compositor operations, or a generated
PNG.

Plan application accepts only the public selection and regeneration inputs:
`expectedVersion`, `candidateSetHash`, `candidateIds`, `targetComponentIds`, and
the same optional donor/manual inputs. The service does not trust a prior POST or
browser memory. It regenerates candidates from immutable snapshots and rejects a
changed hash, unknown candidate, overlapping group choice, stale version, invalid
model, non-opaque manual color, or malformed semantic component ID.

Plan clearing accepts `expectedVersion`. Both applying and clearing increment the
monotonic restoration version. Strict request schemas reject extra fields, so a
client cannot submit a raw mask, pixel coordinates, compositor operation, or PNG
through these routes.

## Persistence, audit, and commit provenance

SQLite migration `007_composition_restoration.sql` adds
`restoration_version`, the current `restoration_plan_json`, and the append-only
`composition_restoration_event` audit table. Every event records its version,
event type, candidate-set identity, effective candidate IDs, and timestamp. A set
event also records plan identity and coverage counts; a clear event records the
previous plan hash. A cleared plan is not silently forgotten: its event remains
while the current plan becomes null.

The persisted plan contains host-derived operations and pixel evidence behind the
service boundary. Reads verify its canonical storage hash, validate plan and
candidate hash formats, and cross-check its coverage partition, target groups,
operation shape, and opaque Base fills before materializing it for the compositor.
The public Composition detail exposes only the plan summary and report counts.

A committed `compose` operation records the restoration version, plan hash,
candidate-set hash, selected candidate IDs, and requested/covered/missing counts.
Restored non-transparent Base pixels become `skin` components with
`composition_restoration` provenance:

- sampled candidates are system-authored and non-generated; they record their
  candidate, source Revision, and source semantic skin components;
- manual candidates have `actorType: user`, no source Revision/component claim,
  and `containsGeneratedPixels: true` because the color is authored without a
  source texel;
- Outer transparent pixels are recorded by the compose operation and affected
  spans, but do not become a non-transparent semantic component.

Provenance is deliberately conservative at component level. When pixels with
different provenance are later merged into one semantic component, evidence is
combined only when all restoration evidence refers to the same plan hash;
otherwise the merged component retains the generated-pixel flag but drops the
ambiguous restoration detail. This avoids inventing a precise per-pixel ancestry
that the semantic component schema does not store.

## Boundaries

- Candidate colors reconstruct exposed skin; they do not recover factual pixels
  that were hidden in the source image.
- Sampling uses only opaque pixels owned by stored semantic `skin` components.
  Ordinary visible pixels, translucent samples, and unclassified pixels are not
  skin evidence.
- Only one donor Revision is accepted per generation request, and it must match
  the target arm model.
- Aggregate selection is UI convenience only. The 23 fine categories, saved
  components, atomic parts, and Bundle members remain independently addressable.
- Restoration operates on the immutable composition base before ordinary part
  layers are evaluated. Normal part conflicts and explicit winner rules still
  apply above the restored result.
