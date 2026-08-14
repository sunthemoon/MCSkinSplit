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
```

The output Revision changes semantic segmentation only. Its `skin.png` is copied
byte-for-byte from the input Revision.

The current semantic runtime pins `mc-skin-segmenter` Skill `1.2.0` and prompt
`semantic-proposal-v3-tool-free`. Those values are stored on every new Job so a
retry remains attributable to the contract that actually ran.

## Analysis workspace

`packages/skin-analysis-pack` creates one private directory per Run. It contains:

- `job.json` with input Revision, model, reasoning, arm type, and version pins;
- `input/source.png`, a 16x Atlas, a gridded Atlas, a face Contact Sheet, and
  front/back/left/right/isometric views;
- palette, full pixel map, compact candidate summary, complete candidate regions,
  and previous segmentation documents;
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
- inlines the immutable public Job, compact candidate summary, palette, prior
  component summary, and classification rules through stdin. The model neither
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
- component IDs are unique and component references point to existing components;
- `sameOutfitGroup` is treated as an opaque grouping identifier, not a component
  reference;
- pixel additions/removals stay inside visible valid UV coordinates and do not
  create overlapping ownership;
- component masks plus `unknown` cover every visible valid UV pixel exactly once;
- confidence below 0.65 produces `needs_review` rather than a confirmed component.

Validation errors are written to the Run log and can be supplied to one repair
attempt. A repaired proposal must pass the complete validator again.

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
can still be empty. Retrying creates a new Job against the same historical input
and records the currently installed Skill/prompt versions. It does not create a
Revision unless requested and validated.

A successful proposal creates a Revision only if the original input is still the
target Branch HEAD, the source/result hashes match, and the successful Run ID is
recorded as AI provenance. This prevents a late model response from overwriting newer
work.

## HTTP API

```text
GET  /api/ai/providers
POST /api/revisions/:revisionId/ai-analysis
GET  /api/ai-jobs?revisionId=:revisionId
GET  /api/ai-jobs/:jobId
GET  /api/ai-jobs/:jobId/events
POST /api/ai-jobs/:jobId/cancel
POST /api/ai-jobs/:jobId/retry
```

The start request requires `full` mode, a registered provider, model, reasoning
effort (`low`, `medium`, `high`, `xhigh`, or `max`), coarse taxonomy, focus category
list, and `createRevisionOnSuccess` flag. Unknown request fields are rejected.

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

On 2026-08-13, a separate real-browser run started from the Studio against
`9058f3af3ffb104c.png` with `max` reasoning, Skill `1.2.0`, and prompt
`semantic-proposal-v3-tool-free`. The one observed Job/Run completed in 429.5
seconds (7 minutes 9.5 seconds), passed host validation in Run attempt 1, produced 15
components covering all 1,989 visible pixels with zero `unknown` pixels, and
created an immutable `ai_segment` Revision. It emitted zero `provider_tool` events,
confirming tool-free execution for that run. Its first schema-constrained transport
request failed and the narrow local-JSON fallback succeeded, so this observation is
neither a latency benchmark nor evidence that the selected external endpoint
supports structured output.

On 2026-08-14, after making host-validated single-pass JSON the default, a fresh
Studio run completed in about 76 seconds with `medium` reasoning. It used one
Codex session and one model turn, emitted no schema fallback, provider error, or
failed turn, and created `main #3`. The host accepted all 211 candidate regions
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

The semantic Job card shows a fixed five-stage outline before a task starts:
queue, isolated input, Codex classification, deterministic validation, and optional
repair/revalidation. The bar represents completed workflow stages rather than an
elapsed-time estimate. A second model Run moves into the repair stage without
resetting earlier progress; failure or cancellation remains attached to the last
evidenced stage. After machine validation succeeds, the card separately marks the
handoff to manual review because AI success does not mean that component review is
complete. The live event list remains the detailed record beneath this outline.
Paired tool rows and recoverable warnings reduce duplicate noise without changing
the stored event history or the fixed five-stage progress model.

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
