# Hidden-content completion proposals

M19 introduces a separate, review-only workflow for proposing pixels that may
belong to clothing hidden by hair or accessories, or to hair hidden by an
accessory. A Completion Proposal is an inference, not a recovery of the factual
source artwork. It never changes a Revision until a user explicitly accepts one
candidate.

Status: **Complete for the M19 service boundary and the feature-gated M20 player
workspace**. The deterministic core, persistence model, Job/API orchestration,
immutable review assets, acceptance/rejection paths, bounded manual candidate
editing, explicit latent-Part publication, and optional candidate-ID ranking
contract are implemented and verified. Default release remains gated by the M21
evaluation.

## Workflow and authority

Completion has its own immutable records and does not reuse semantic follow-up,
Composition restoration, or Part Edit state:

1. A `completion_proposal` Job binds one source Revision, its result and skin
   hashes, one visible target component, one or more visible occluding components,
   the requested representation, and the server-derived allowed pixel range.
2. The deterministic host generates zero or more bounded candidates. It may use
   an opposite-layer underlay, a mirrored counterpart, same-surface continuation,
   an opposite-surface or neighboring reference, or pattern continuation. If the
   source provides no supported evidence, a successful Job may contain no
   candidates.
3. Optional AI ranking receives immutable source/candidate previews generated
   in its own hash-bound ranking pack plus pixel-free evidence. It may only return an ordering of the exact
   candidate IDs and either recommend the first ID or defer. It cannot submit a
   texture, mask, coordinate, color, new candidate, or acceptance decision.
4. Every candidate remains review-only. `reviewRequired` is always true and
   `automaticAcceptanceAllowed` is always false, including for high-confidence
   host candidates and an AI recommendation.
5. The user either rejects the proposal or accepts exactly one stored candidate.
   A rejection records only the immutable decision. An acceptance creates one
   immutable Completion Result in the representation described below.

Proposal, candidate, optional ranking, decision, result, and optional latent-Part
publication are separate append-only records. Proposal and candidate JSON, masks,
textures, hashes, and database bindings are verified again when read or decided.
Preview images exist only in the optional AI-ranking Run pack. A proposal is
returned through the normal list only after its Job has
succeeded and the Job output hash matches the stored proposal hash.

## Target representations

### `skin_texel`

This representation is allowed only for a transparent, unowned Base texel below
a visible Outer-layer occluder, where the target has visible support for that
body-part/Base group. Writing an Outer texel above a Base owner is never treated
as hidden-content completion because it would cover visible source artwork.
Acceptance:

- refuses to overwrite any visible or owned source texel;
- creates a new `completion_accept` Revision from the exact source Branch HEAD;
- assigns the added pixels to the existing target component;
- advances the Branch HEAD, and the Project HEAD when it is the default Branch;
- records the accepted proposal, candidate, decision, origin, and result hashes.

### `latent_component`

Same-layer hidden content cannot coexist with the visible occluder in one skin
texel. This representation therefore keeps the inference outside the source skin.
Its allowed range is limited to actual occluder pixels on body-part/layer groups
where the target already has visible support. Acceptance:

- creates a verified Part 2.0 variant containing the target's existing visible
  pixels plus the accepted hidden additions;
- keeps the source Revision, Branch HEAD, RGBA bytes, and source skin hash
  unchanged;
- creates an immutable Completion Result that points to the latent Part;
- leaves the Part unpublished, so it is excluded from normal Part-library lists.

Publishing a latent result is a later, explicit append-only action. M20 exposes
that action through a hash-bound public HTTP route, but never calls it
automatically. Publication makes the accepted Part discoverable in normal Part
library lists; it does not silently add the Part to a Bundle or Catalog.

When `representation` is `auto`, the host chooses `skin_texel` if at least one
safe target texel exists; otherwise it uses `latent_component`. The chosen
representation is stored in the proposal and cannot change at decision time.

## Pixel origin

Accepted inferred pixels have intrinsic origin `generated_completion`. A
mirrored or sampled candidate may additionally record immediate copied-from
Revision/component/pixel lineage, but copying does not turn an inferred hidden
pixel into `source_visible`.

The core also defines bounded manual candidate edits. Only pixels that were
actually changed by a user receive intrinsic origin `manual_authored`, together
with actor and operation identity; untouched inferred pixels remain
`generated_completion`. M20 exposes this as an immutable derived candidate:
the original host candidate and optional ranking are never rewritten, and the
user must apply or cancel pending edits before accepting a candidate.

For a latent Part, existing visible target pixels preserve their intrinsic origin
and gain an immediate copy reference to the source Revision/component. Its
`generated-mask.png` is derived from `origin.json` and must remain a subset of the
Part write mask.

## Freshness and idempotency

Decision requests bind the source result hash, proposal hash, proposal evidence
hash, and, for acceptance, candidate hash. The service reloads and verifies all
stored files and source documents before deciding.

Acceptance additionally requires the source Revision to remain the exact Branch
HEAD. A stale source, evidence document, proposal, candidate, or Branch HEAD is a
conflict rather than a best-effort apply. Repeating the exact same decision is
idempotent and returns `changed: false`; attempting a different action, candidate,
actor, or reason after a decision returns a conflict.

A failed or cancelled Completion Job may be retried under its stored contract,
which creates a new proposal identity if it succeeds. A succeeded Completion Job
is not regenerated in place; callers use its immutable proposal or start a new Job
from a Revision.

A cancellation recorded before the Job reaches `succeeded` takes precedence even
if immutable Proposal files were already written; that Proposal remains hidden.
After a service restart, a validating Completion Job is recovered to `succeeded`
only when its complete Proposal, Candidate set, optional ranking, source bindings,
and execution contract revalidate. A persisted cancellation recovers as cancelled,
while missing, partial, corrupt, or mismatched state follows the interrupted-Job
failure path.

## HTTP API

The public start request deliberately contains no provider, model, reasoning, raw
pixels, spans, masks, or hash fields:

```text
POST /api/revisions/:revisionId/completion-proposals
```

```json
{
  "targetComponentId": "upper_clothing.1",
  "occludingComponentIds": ["hair.1"],
  "representation": "auto"
}
```

`representation` is optional and accepts `auto`, `skin_texel`, or
`latent_component`. The route returns `202` with the persistent Job. Host-only
candidate generation is the default. If optional ranking is enabled in server
configuration, provider/model/reasoning choices remain server-owned; a ranking
failure fails the Job and does not expose a half-ranked proposal.

Proposal discovery and detail routes are:

```text
GET /api/completion-proposals
GET /api/completion-proposals/:proposalId
```

The list accepts optional `projectId`, `revisionId`, `jobId`, `representation`,
and `status` (`awaiting_decision`, `accepted`, `rejected`, or `all`) filters. The
detail response includes stored candidate metadata plus the optional advisory
ranking, decision, and result. Candidate textures and masks remain authoritative
host assets; public DTOs only add the fixed review-only flags.

The following immutable, hash-verified assets let a client inspect the exact
allowed range and each candidate before deciding:

```text
GET /api/completion-proposals/:proposalId/allowed-mask.png
GET /api/completion-proposals/:proposalId/candidates/:candidateId/candidate.json
GET /api/completion-proposals/:proposalId/candidates/:candidateId/texture.png
GET /api/completion-proposals/:proposalId/candidates/:candidateId/write-mask.png
GET /api/completion-proposals/:proposalId/candidates/:candidateId/generated-mask.png
```

They are available only through a succeeded, output-hash-matched Proposal and
return immutable cache metadata. A candidate ID from another Proposal is not
accepted by these routes.

Optional AI ranking is disabled by default. The server-owned configuration is:

```text
AI_COMPLETION_RANKING=true
AI_COMPLETION_RANKING_PROVIDER=codex-exec
AI_COMPLETION_RANKING_MODEL=<model>
AI_COMPLETION_RANKING_REASONING_EFFORT=medium
```

Accept one candidate:

```text
POST /api/completion-proposals/:proposalId/candidates/:candidateId/accept
```

```json
{
  "expectedSourceResultHash": "sha256:...",
  "expectedProposalHash": "sha256:...",
  "expectedEvidenceHash": "sha256:...",
  "expectedCandidateHash": "sha256:...",
  "summary": "Accept hidden clothing candidate"
}
```

Reject the proposal without creating a Revision or Part:

```text
POST /api/completion-proposals/:proposalId/reject
```

```json
{
  "expectedSourceResultHash": "sha256:...",
  "expectedProposalHash": "sha256:...",
  "expectedEvidenceHash": "sha256:...",
  "reason": "The continuation does not match this outfit"
}
```

The first stored decision returns `201` with `changed: true`; an exact replay
returns `200` with `changed: false`. Hash or state mismatches and conflicting
decisions return `409`.

Create an immutable, manually edited candidate before acceptance:

```text
POST /api/completion-proposals/:proposalId/candidates/:candidateId/edits
```

```json
{
  "expectedSourceResultHash": "sha256:...",
  "expectedProposalHash": "sha256:...",
  "expectedEvidenceHash": "sha256:...",
  "expectedCandidateHash": "sha256:...",
  "edits": [
    { "type": "set_pixel", "pixelId": 1234, "rgba": [42, 57, 81, 255] },
    { "type": "remove_pixel", "pixelId": 1235 }
  ]
}
```

The request accepts 1–256 unique, allowed-mask edits. An exact replay returns the
same derived candidate with `changed: false`; `baseCandidateId` preserves the
host-candidate relationship. A derived candidate is accepted with its own exact
candidate hash through the normal acceptance route.

Publish an accepted latent result explicitly:

```text
POST /api/completion-results/:resultId/publish
```

```json
{
  "expectedResultHash": "sha256:...",
  "expectedPartId": "part_..."
}
```

The first publication returns `201`; an exact repeat returns `200` with
`changed: false`. `actorId` is optional on decision, edit, and publication
requests and should be supplied only from a real trusted identity context.

## Product boundary

M19 supplies the deterministic and auditable service boundary. M20 adds the
feature-gated player review/editor, exact source/candidate/mask comparison,
bounded candidate editing, explicit latent-Part publication, and distinct
original/classification-repaired/accepted-completion result choices. It does not
automatically run Completion after semantic analysis, auto-accept a candidate,
auto-publish a Part, or claim that an inferred garment or hairstyle is authentic.

M21 evaluates conservative, mirror, pattern, and AI-ranked candidates against
hidden ground truth. The offline host-v2 gate passes, but the combined release
report is still incomplete; Completion therefore remains absent from the default
player path unless `VITE_ENABLE_COMPLETION_WORKSPACE=true` is set explicitly.
