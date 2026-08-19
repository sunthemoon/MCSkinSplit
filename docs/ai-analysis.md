# AI-assisted semantic analysis

M5 classifies a selected Revision without giving a model authority over skin bytes,
history, or the SQLite store. The model produces one JSON proposal; deterministic
code decides whether that proposal is complete and safe enough to become an
immutable `ai_segment` Revision.

## Execution flow

```text
selected Branch HEAD Revision
  -> deterministic analysis workspace
  -> repository mc-skin-segmenter Skill
  -> replaceable AI provider (Codex CLI by default)
  -> JSON Schema and pixel-ownership validation
  -> optional single repair attempt
  -> immutable AI Revision or audited failure
  -> deterministic cross-body classification assessment
  -> optional user-confirmed classification-repair Revision
  -> original result plus optional repaired catalog variant
```

The output Revision changes semantic segmentation only. Its `skin.png` is copied
byte-for-byte from the input Revision.

The current semantic runtime pins `mc-skin-segmenter` Skill `1.4.0`, prompt
`semantic-proposal-v7-all-surface-grounding`, proposal Schema `1.2`, taxonomy
`coarse-v2-no-unknown-components`, and validator
`semantic-proposal-validator-v3`. Those values are stored on every new Job so a
retry remains attributable to the contract that actually ran. Schema `1.0` and
`1.1` proposal artifacts remain shape-readable for audit, but are read-only and
cannot be submitted to the current validator.

## Analysis workspace

`packages/skin-analysis-pack` creates one private directory per Run. It contains:

- `job.json` with input Revision, model, reasoning, arm type, and version pins;
- `input/source.png`, a 16x Atlas, a gridded Atlas, a face Contact Sheet,
  front/back/left/right views, and a truthful front/right contact image;
- palette, full pixel map, compact candidate summary, complete candidate regions,
  full and compact Candidate Evidence Graph documents, a grounding manifest, and
  previous segmentation documents;
- paired composite/Base/Outer natural and candidate-region orthographic contact
  sheets plus a stable visual-ID legend under `input/grounding/`;
- a copied `.agents/skills/mc-skin-segmenter` Skill and proposal JSON Schema;
- isolated `output/` and `logs/` directories.

Candidate algorithm `bounded-color80-surface-cc-v2` groups adjacent pixels only
within one canonical surface, with exact alpha and a maximum RGB Euclidean distance
of 80. Every visible valid UV pixel belongs to exactly one candidate. These regions
are deterministic classification units, not inferred semantic labels.

The compact summary contains every candidate identifier but avoids placing the full
pixel map in model context. A manifest hashes the source, all derived inputs, the
schema, and the copied Skill. The worker verifies those hashes after model execution;
input or Skill mutation invalidates the Run.

### Candidate evidence and visual grounding

M17 retains `bounded-color80-surface-cc-v2` as the exact, non-overlapping source
partition. It builds a separate `CandidateEvidenceGraphDocument` Schema `1.0`
using algorithm `candidate-evidence-graph-v1`. Each graph node keeps the exact
CandidateRegion ID plus a stable display-only ID such as `R001`, body/surface/layer
identity, Atlas and local bounding boxes, area/fill ratio, slenderness and principal
axis, surface-edge pixel counts, and deterministic dominant-color family features.

Graph edges are undirected host evidence with matched-texel counts, mapping IDs,
dominant RGB distance, and any same-surface local distance. The only edge kinds
are same-surface contact, same-surface Manhattan-distance-2 proximity, canonical UV
seam, Base/Outer same-texel projection, and bilateral mirror. The builder does not
treat nearby Atlas rectangles as neighbors and does not synthesize an unverifiable
3D or cross-body relation. Long-hair continuity across head and torso therefore
still depends on visible evidence in the attached views rather than an invented
graph edge.

Renderer `orthographic-candidate-regions-v2` produces front, back, left, and right
views in a fixed manifest order. Composite, Base-only, and Outer-only natural-color
contact sheets each have a matching candidate-region pseudocolor sheet. A labelled
six-face sheet places natural color and CandidateRegion color side by side for
front/back/left/right/top/bottom, while a pixel-aligned natural/candidate Atlas pair
keeps exact UV lookup available. These inputs, the six four-direction grounding
images, and the visual-ID legend form the ordered attachment contract. Separate
natural and candidate face sheets remain hashed audit files but are not duplicate
model attachments. The provider checks that attachment roles and actual paths agree
before it starts the CLI.

Only compact node/edge and grounding tables enter the prompt; the full graph and
manifest remain integrity-hashed Run inputs. The provider rejects a semantic prompt
above 300,000 characters before provider execution. Visual IDs and pseudocolors are
lookup aids only: the proposal must return exact CandidateRegion IDs, may not invent
edges, and remains subject to complete host ownership validation.

Prompt v7 requires a separate top/bottom audit. Surface names describe cube
geometry rather than anatomy, and vertical long-hair ownership may not be extended
onto torso top/bottom from UV seams, adjacent-face labels, or similar color alone.
Conflicting visible evidence is deferred for review.

### Clean and current semantic baselines

New player-facing analysis defaults to `semanticBaseline: "empty"`. The analysis
pack still retains the immutable previous segmentation for host validation and
audit, but the provider prompt does not include its component labels. The model
therefore classifies from the attached views, candidate regions, and palette
without inheriting an earlier semantic decision.

Advanced settings can select `semanticBaseline: "current"`. In that mode the
provider includes a compact previous-component summary as a soft prior. The prompt
still requires every label to be re-evaluated from the current visual and
candidate evidence. The selected baseline is stored in `job.json`, participates
in the input hash, and is preserved by an ordinary retry unless the retry request
explicitly overrides it. Legacy stored Jobs without the field retain their
historical current-baseline interpretation; new Jobs default to the clean mode.

Source-preserving historical Revisions can be analyzed again directly; catalog
archiving or deletion is not required. Until per-pixel origin metadata exists, a
run with `createRevisionOnSuccess: true` conservatively rejects a source whose
current semantic components report generated pixels or whose effective content
ancestry includes `apply_part`, `compose`, or `palette_change`. `revert` follows
the Revision that supplied its content, so reverting to a clean import remains
eligible. This prevents a new AI segmentation from relabeling known authored or
generated pixels as original. An explicit `createRevisionOnSuccess: false` run may
still inspect that source because it cannot persist a semantic Revision. When an
eligible selected Revision is no longer the current Branch HEAD, the service
creates a new Branch before appending the new analysis result, so the existing
history remains unchanged.

## Codex CLI provider

The default provider follows the official Codex non-interactive `codex exec`
workflow documented in [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
and uses supported options from the [CLI command reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli).

For semantic analysis, the adapter:

- starts the command directly without a shell;
- uses the Run directory as `--cd` with `--sandbox read-only`, `--ephemeral`,
  `--ignore-rules`, JSONL events, attached analysis images, and a bounded timeout;
- disables shell, web, browser, computer, image-generation, app, plugin, MCP,
  delegation, and related tool capabilities, and inherits no shell environment;
- inlines the immutable public Job, compact evidence graph, compact grounding and
  attachment manifests, palette, classification rules, and only when requested the
  current component summary through stdin. The model neither
  reads the workspace nor writes the proposal file; Codex captures its final
  response through `--output-last-message`;
- resolves the Windows `codex.cmd` shim to the installed Node entry point instead
  of executing a batch file through a shell;
- captures thread ID, token usage, stdout events, stderr, and final output with a
  16 MiB combined log limit;
- preserves the stdout/stderr captured before timeout, cancellation, launch error,
  or output-limit termination and lets the worker register those files as failure
  assets when persistence succeeds;
- projects JSONL stdout incrementally into safe Job events for the Studio process
  display while the provider is still running;
- captures one JSON response by default, then applies the repository Schema and
  deterministic pixel validator on the host;
- can explicitly opt into native structured-output transport. Only that opt-in
  path may retry without `--output-schema` after a recognized native-request or
  transport failure.

Neither mode weakens host validation. The same Ajv and pixel validator checks the
final JSON in every path. The default avoids an otherwise redundant failed request
on endpoints that do not carry native structured-output parameters. A successful
opt-in fallback proves only that the provider can return host-valid JSON without
schema-constrained transport; it does not establish endpoint support for structured
output.

By default semantic analysis retains the user's model/provider selection so
existing authentication and custom provider routing work, while the adapter
overrides tool and sandbox capabilities for this invocation. The model value
`codex-config-default` means “use the model selected by that configuration.” Set
`AI_IGNORE_USER_CONFIG=true` only when an independently authenticated default Codex
configuration is available; this additionally ignores user configuration rather
than changing the mandatory tool-free restrictions.

Replacement recommendation uses the same tool-free boundary but a smaller input.
It always adds
`--ignore-user-config` (Codex authentication still comes from `CODEX_HOME`), uses
no attached images, and inlines only the immutable public Job and candidate
catalog. The checked-in Skill remains the versioned decision contract and manual
validation tool; schema validation and exact catalog validation remain
authoritative host checks.

## Live process display

While a Job is active, the provider converts supported Codex JSONL lifecycle events
into generic session, turn, tool, output, usage, fallback, and error messages. The
worker persists those messages in the existing Job event stream, and the Studio
refreshes the Job every 1.5 seconds, renders events in chronological order, and
automatically follows newly appended entries.

The projection deliberately excludes `reasoning` and agent-message bodies. When a
tool-capable historical/provider event supplies them, the event stream may include
a sanitized item ID, bounded command summary, and integer exit code, never command
output or private reasoning. The Studio pairs matching tool start/result events
where possible. A failed tool or provider-stage error is shown as recoverable and
non-terminal; only the Job's `failed`/`cancelled` lifecycle event and dedicated Job
error banner represent the terminal result. Repeated provider errors are collapsed,
and an agent-message completion is presented as a stage update rather than proof
that a validated proposal exists. Complete JSONL remains a local `raw_events` audit
asset. Progress reporting is telemetry: a display or persistence callback failure
cannot change the provider Run result.

## Proposal validation

A proposal is accepted only when all of the following hold:

- JSON matches the repository schema and the source Revision/model metadata;
- every candidate ID exists and occurs exactly once: in one component, in the
  unassigned bucket, or in exactly one review item;
- `unknown` is not a component category; unassigned/review pixels become the
  independent Unknown mask;
- component IDs are unique and component references point to existing components;
- `sameOutfitGroup` is treated as an opaque grouping identifier, not a component
  reference;
- pixel additions/removals stay inside visible valid UV coordinates, use at most
  64 unique pixels and 32 spans across the whole proposal, and do not create
  overlapping ownership;
- every added pixel is paired with one explicit removal from the component that
  owns its CandidateRegion; additions from unassigned/review Regions and self-
  transfers are rejected, while an unmatched removal intentionally returns a
  boundary pixel to Unknown;
- component masks plus `unknown` cover every visible valid UV pixel exactly once;
- confidence below 0.65 produces `needs_review` rather than a confirmed component.
- Schema 1.2 includes a same-response `appearanceInventory` with at most 32
  Region-linked observations over visible evidence. Validator v3 checks its shape
  and CandidateRegion references, but the inventory is not an ownership bucket and
  cannot assign pixels, create masks, alter commit behavior, or affect the
  deterministic follow-up.

Validation errors are written to the Run log and can be supplied to one repair
attempt. A repaired proposal must pass the complete validator again. Validator v3
reports the total override span count and unique override pixel count so the
bounded-transfer behavior remains auditable, together with the diagnostic
appearance-observation count.

## Jobs, Runs, and audit assets

Jobs progress through `queued`, `preparing`, `running`, `validating`, and a terminal
`succeeded`, `failed`, or `cancelled` state. A Job records the immutable source
Revision, provider/model/reasoning options, Skill and prompt versions, input/output
hashes, review items, summary, timestamps, and any structured error.

Each model attempt is a separate Run. Available audit roles are:

- `input_manifest`
- `raw_events`
- `raw_output`
- `validator_report`
- `stderr`

Failures retain every artifact that was available at failure time. Provider
timeouts and cancellations carry their captured JSONL/stderr to the worker instead
of replacing those diagnostics with empty files; if nothing was emitted, an asset
can still be empty. Retry is reproducible only for a Job whose stored Skill name,
Skill version, and prompt version match the installed contract. A mismatch returns
`AI_ANALYSIS_RETRY_CONTRACT_STALE` and requires starting a fresh analysis; it never
silently upgrades the old Job. A valid current-contract Retry creates a new Job
against the same historical input and does not create a Revision unless requested,
eligible, and validated.

A successful proposal creates a Revision only if the original input is still the
target Branch HEAD, the source/result hashes match, and the successful Run ID is
recorded as AI provenance. This prevents a late model response from overwriting newer
work.

## Deterministic semantic follow-up

After a successful semantic Job creates its `ai_segment` Revision, the worker
continues with a host-side assessment. This is not another model call. The current
assessment conservatively checks whether vertically continuous torso regions that
were classified as clothing match established head-hair colors closely enough to
be plausible cross-body long hair. It can return exact candidate-region spans as
`cross_body_hair_reclassification` suggestions.

New assessments use `cross-body-hair-reclassification-v2`. In addition to the v1
single-region case, v2 can join nearby, hair-colored candidate fragments on the
same torso surface before evaluating their combined vertical drape. This covers a
single visual hair strand split into several candidate regions by shading or a
small gap without joining fragments across different UV surfaces. The rule also
uses the dominant connected head-hair palette and excludes a narrow horizontal
Base-layer bridge when it matches exposed face/skin colors.

`cross-body-hair-reclassification-v1` remains accepted when old Job evidence is
loaded, so historical results and notices stay readable. Pending v1 suggestions
are read-only and always require a fresh v2 analysis before they can be applied;
they are never silently translated into current evidence.

Suggestions are review-only. The assessment never creates coordinates, colors, or
new pixels: every suggested span is rebuilt from deterministic candidate regions
and existing semantic ownership. Before applying a suggestion, the worker reloads
the immutable result snapshot, regenerates the assessment, and requires the same
evidence hash and suggestion identity. A stale or changed result is rejected.

The user then chooses one of two simple outcomes:

- **Use the classification repair.** The service creates a dedicated Branch from
  the AI result and reassigns the exact suggested spans through the normal semantic
  operation service. A single supported source reuses its existing hair component;
  compatible evidence backed by multiple hair components creates one deterministic
  cross-body hair component. The resulting Revision is immutable, and its skin RGBA
  bytes do not change. The catalog retains the AI result as the base entry and nests
  the new Revision as `分类修复版`.
- **Keep the original result.** The suggestion becomes `dismissed`; no Revision or
  pixel state changes, and the original AI result remains the catalog version.

The follow-up state vocabulary is `no_repair`, `awaiting_review`, `applied`,
`dismissed`, and `assessment_failed`; a failure that occurs before a follow-up row
exists is represented by the corresponding Job event. `no_repair` has a
deliberately narrow meaning: the conservative classifier found no safe cross-body
reclassification suggestion. It does **not** prove that the artwork has no
occlusion, that clothing
or hair is complete, or that hidden pixels can be recovered. Likewise, an
assessment failure does not roll back an already valid semantic Revision.

### Player progress and events

The Studio presents one primary **智能分析皮肤** action and moves technical
provider, model, reasoning, baseline, retry, Run, and raw-log controls into
advanced sections. The visible progress model contains six evidence-backed stages:

1. `准备识别`
2. `识别皮肤部件`
3. `校验识别结果`
4. `复核跨部位分类`
5. `确认分类修复`
6. `准备分析目录`

A second model attempt that repairs invalid proposal JSON remains part of stages 2
and 3; it is shown as correcting the recognition result, not as skin-pixel repair.
Stage 5 is skipped when there is no reviewable suggestion or the user retains the
original. Closing the browser does not cancel the persistent server Job.

The follow-up appends bounded public events to the existing Job stream:

- `occlusion_assessing` and `occlusion_assessed` describe deterministic review;
- `repair_review_ready` or `repair_review_skipped` records whether confirmation
  is needed;
- `occlusion_assessment_failed` records a non-terminal follow-up failure;
- `semantic_repair_applied` or `semantic_repair_dismissed` records the explicit
  user decision;
- `catalog_ready` records availability of the original or repaired catalog view.

These events contain identifiers, counts, status, and evidence hashes only. They
do not expose authoritative masks or private pixel lists.

### Per-pixel origin preservation

Origin-bearing Revision snapshots store a canonical `origin.json` independently
of the model proposal. Semantic analysis may change ownership and category masks,
but it does not rewrite the intrinsic origin of unchanged RGBA pixels. Component
source/generated summaries are rebuilt by the host from the stored origin document
and the committed component masks before persistence.

Historical snapshots without recorded origin remain readable. When a new Revision
is derived, immutable import/branch/revert ancestry is used only where it proves an
exact source; otherwise all current visible pixels receive the durable
`legacy_mixed` origin. They are never silently relabelled as source-visible.

The read API is:

```text
GET /api/revisions/:revisionId/origin
```

It returns either verified document/summary/component summaries with
`availability: recorded`, or the explicit `legacy_unavailable` shape for a
historical Revision that has not yet produced a new origin-bearing descendant.
Corrupted origin snapshots fail integrity validation rather than degrading to the
legacy response.

## HTTP API

```text
GET  /api/ai/providers
POST /api/revisions/:revisionId/ai-analysis
GET  /api/ai-jobs?revisionId=:revisionId
GET  /api/ai-jobs/:jobId
GET  /api/ai-jobs/:jobId/events
POST /api/ai-jobs/:jobId/cancel
POST /api/ai-jobs/:jobId/retry
POST /api/ai-jobs/:jobId/semantic-followup/apply
POST /api/ai-jobs/:jobId/semantic-followup/dismiss
```

The start request requires `full` mode, a registered provider, model, reasoning
effort (`low`, `medium`, `high`, `xhigh`, or `max`), coarse taxonomy, focus category
list, and `createRevisionOnSuccess` flag. It optionally accepts
`semanticBaseline: "empty" | "current"`; omission on a new Job selects `empty`.
Unknown request fields are rejected.

Job detail responses include nullable `semanticFollowup` state. Public suggestions
contain only ID, label, pixel count, confidence, and reason; notices contain only
kind and message. Applying requires one exact `suggestionId`; dismissing requires
an empty object. Both mutation routes return the updated Job detail. The normal
event endpoint returns the same persisted follow-up events as the Job detail.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `AI_MODEL` | `codex-config-default` | Codex model override |
| `AI_REASONING_EFFORT` | `medium` | Studio/provider default reasoning |
| `AI_TIMEOUT_SECONDS` | `600` | Per-provider time budget, 10-1800 seconds |
| `AI_MAX_REPAIR_ATTEMPTS` | `1` | Validation repair attempts, 0-3 |
| `AI_IGNORE_USER_CONFIG` | `false` | Add Codex `--ignore-user-config` |
| `AI_USE_OUTPUT_SCHEMA` | `false` | Opt into native `--output-schema` transport |
| `AI_ALLOW_SCHEMA_FALLBACK` | `true` | When native transport is enabled, retry only supported schema-transport failures |
| `MC_SKIN_AI_SKILL_DIR` | repository Skill | Alternate Skill source directory |
| `MC_SKIN_REPLACEMENT_SKILL_DIR` | repository replacement Skill | Alternate replacement-planner Skill source directory |
| `MC_SKIN_DATA_DIR` | repository `data/` | SQLite, snapshots, Run workspaces, and audit assets |

## Real-skin verification

All six pinned fixtures decode and resolve to Slim/Alex. Their deterministic
pre-analysis coverage is:

| Fixture | Candidates | Visible valid pixels |
|---|---:|---:|
| `ab87de696cfca859.png` | 245 | 1,860 |
| `354359a2c2f33777.png` | 163 | 1,913 |
| `bad5dea368e72b05.png` | 219 | 1,869 |
| `bc1a12c777b45e7b.png` | 331 | 1,858 |
| `8d9ecb2e49f9d3df.png` | 223 | 1,909 |
| `9058f3af3ffb104c.png` | 419 | 1,989 |

The earlier recorded end-to-end A1 Codex run produced 10 components covering all
1,860 pixels with zero `unknown` pixels. Its first attempt failed validation and
remained auditable; the bounded repair attempt succeeded and created the AI
Revision.

The browser observations below are historical M13-era evidence for prompt v3, not
verification of the current `semantic-proposal-v7-all-surface-grounding` contract.

On 2026-08-13, a separate real-browser run started from the Studio against
`9058f3af3ffb104c.png` with `max` reasoning, Skill `1.2.0`, and the historical
M13 prompt `semantic-proposal-v3-tool-free`. The one observed Job/Run completed in
429.5 seconds (7 minutes 9.5 seconds), passed host validation in Run attempt 1, produced 15
components covering all 1,989 visible pixels with zero `unknown` pixels, and
created an immutable `ai_segment` Revision. It emitted zero `provider_tool` events,
confirming tool-free execution for that run. Its first schema-constrained transport
request failed and the narrow local-JSON fallback succeeded, so this observation is
neither a latency benchmark nor evidence that the selected external endpoint
supports structured output.

On 2026-08-14, after making host-validated single-pass JSON the M13 default, a
fresh v3 Studio run completed in about 76 seconds with `medium` reasoning. It used
one Codex session and one model turn, emitted no schema fallback, provider error,
or failed turn, and created `main #3`. The host accepted all 211 candidate regions
covering 2,047 visible pixels, produced 13 components, and reported zero unknown
pixels, review items, warnings, or validation errors. This is one functional
browser observation, not a latency guarantee.

## Privacy and operational boundaries

AI workspaces include the original skin, derived images, candidate data, prompts,
and model logs. They stay under `MC_SKIN_DATA_DIR`, but attached images can be sent to
the remote service selected by the user's Codex configuration. Operators should
treat Run directories as sensitive application data and apply their own retention
or backup policy.

Semantic labels remain probabilistic. Review low-confidence items and use the manual
editor for corrections before exporting reusable parts or composing a final skin.

The semantic Job card's six-stage bar represents completed workflow stages rather
than elapsed time. Failure or cancellation remains attached to the last evidenced
stage. After machine validation succeeds, the card continues through deterministic
cross-body review and any explicit user decision because AI success does not mean
that component review is complete. The live event list remains the detailed record
beneath this outline. Paired tool rows and recoverable warnings reduce duplicate
noise without changing stored event history.

M15 semantic analysis does not generate pixels hidden by clothing, long hair, or
accessories, and it cannot infer the factual back of a covered garment or
reconstruct hair hidden on both sides. M19 implements a separate,
provenance-aware Completion Proposal service: the host owns candidate pixels and
an optional dedicated AI task may only rank existing candidate IDs. Every result
still requires an explicit user accept/reject decision. This is not an extension
of the semantic-analysis proposal or its follow-up. See
[`hidden-content-completion.md`](hidden-content-completion.md) for the completed
service and API contract; its player UI and default release gate remain M20/M21.

## Constrained replacement recommendation

M10 adds a second, separate model task for composition restoration. It does not
extend `mc-skin-segmenter`: semantic classification continues to use that Skill,
while `.agents/skills/mc-skin-replacement-planner` can only rank candidates that
the deterministic M9 restoration service has already generated.

```text
public restoration candidate catalog + user intent
  -> isolated replacement-planning workspace
  -> repository mc-skin-replacement-planner Skill
  -> ID-only ranked decisions, confidence, and short explanations
  -> schema and exact-catalog validation
  -> user loads the suggestion into browser selection
  -> user explicitly applies the existing deterministic restoration plan
```

The planning workspace stores `job.json`, the public
`input/restoration-candidates.json` catalog, the output schema, and a copied
repository Skill for audit and deterministic validation. The default provider
inlines the public Job/catalog and runs tool-free; it has no attached images. The
catalog exposes candidate IDs,
kinds, labels, source identity when applicable, coverage counts, composition
version, and candidate-set hash. It does not expose authoritative masks,
coordinates, pixel-ID lists, compositor operations, generated PNGs, or database
state. A manually supplied color can appear only as the already host-created
`manual_rgba` candidate; the model cannot invent or change it.

The proposal must contain every Base target group exactly once in sorted order.
Each decision ranks exactly the supplied IDs for that group, may select only its
first fully covering candidate, and includes a bounded confidence value and short
explanation. The host validates exact Job, Composition, and candidate-set
identity, rejects unknown/cross-group/duplicate IDs and private pixel evidence,
and permits one normal repair attempt. Aggregate Outer cleanup is host-managed
and never enters the model's Base decisions.

Recommendation reuses the persistent Job, Run, Asset, and Event infrastructure,
including the live provider process display. Job kind and Composition identity
keep it separate from semantic-analysis history. The result is advisory: success
does not create a Revision, write a restoration plan, or alter the preview. A
result can be loaded only while its Composition version and candidate-set hash
still match; loading changes local candidate selection only, and **Apply** remains
the sole plan-persistence action.

Each Job copies its task-specific repository Skill into that Run's isolated
workspace. The Skills are repository-scoped runtime inputs, so users do not need
to install either one globally in Codex. The non-AI candidate selector remains
the complete fallback when Codex is unavailable or a recommendation is deferred,
stale, invalid, cancelled, or failed.

The recommendation start route is:

```text
POST /api/compositions/:compositionId/ai-restoration-recommendation
```

It reuses `/api/ai-jobs` detail, event, cancel, and retry routes. Job-list filters
can distinguish `semantic_analysis` from `restoration_recommendation` and can
scope recommendation history by Composition ID.
