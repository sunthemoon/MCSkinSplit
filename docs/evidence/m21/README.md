# M21 Completion release evidence

This directory stores source-bound evidence for the Completion default-release
gate. The current decision is **`keep_experimental`**: the deterministic Host and
browser criteria pass and real AI evidence is complete, but AI top-1 synthetic
oracle acceptability is below the release threshold.

## Artifacts

- [`browser-evidence.json`](browser-evidence.json) records the exact deterministic
  Chromium release suite, source fingerprint, Playwright version, duration, retry
  count, and per-test status.
- [`ai-ranking-evidence.json`](ai-ranking-evidence.json) is created only by a successful production-provider
  run. It binds every rankable fixture to its Host proposal, candidates, source
  hashes, validated exact-ID ordering, model, prompt, validator, and attempt
  history.
- [`completion-release-report.json`](completion-release-report.json) is the current
  strict report. It includes the offline, AI-ordering, and browser results, then
  emits `decision:"keep_experimental"` because one quantitative threshold fails.

The AI ranker receives only the occluded public case and immutable Host candidate
previews. Hidden target colors stay inside the independent scorer and are not
included in the model prompt, pack, or evidence input.

## Reproduce the evidence

Install dependencies and Chromium once:

```bash
pnpm install
pnpm browser:install
```

Generate browser evidence bound to the current implementation sources:

```bash
pnpm m21:evidence:browser
```

After authenticating the Codex CLI, generate real ranking evidence with an
explicit model:

```bash
pnpm m21:evidence:ranking -- --model MODEL_NAME --reasoning medium --overwrite
```

The runner keeps the Codex CLI's configured provider transport by default. The
explicit `--model` selects the model while custom `base_url` and authentication
continue to come from the user's Codex configuration.

Build and then verify the strict combined report:

```bash
pnpm m21:report
pnpm m21:report:check
```

Strict report generation fails when either evidence document is missing, stale,
malformed, or bound to different inputs. For diagnosis only, the following command
can write an explicit failed report while AI evidence is unavailable:

```bash
pnpm m21:report:incomplete
pnpm m21:report:check:incomplete
```

The incomplete command cannot produce `enable_default`. Enabling Completion in
the default player path still requires a separately reviewed release change after
the strict report passes every threshold.

## Current recorded result

- Host algorithm: `completion-candidates-v2`
- Offline matrix: 16 candidates, zero generated-mask escape, 8/9 positive oracle
  coverage, 3/3 negative safety
- Browser evidence: 11/11 required scenarios passed with zero retries
- Real AI evidence: 9/9 fixtures validated on the first attempt with
  `gpt-5.6-sol` at medium reasoning
- AI top-1 synthetic oracle acceptability: 7/9 (77.78%); required: at least 80%
- AI mean reciprocal rank: 0.8333
- AI evidence hash:
  `sha256:6ed43900c6be5ca397b40076bab79112cdd0091c2b54593085a2ebbc28a2e505`
- Browser evidence hash:
  `sha256:43660cd5054f91ef1e1698892a0c41ed28d9dc5f6aac6753674bf2c0bfbeaa5f`
- Current source hash:
  `sha256:914f3f76062898639f1bd7dfef59af00e36d1aaa9c950f1523717b3f980ec4d6`
- Strict report hash:
  `sha256:c98f6fcdb10d89e2608283a01af7a65b3a2c616c21850c5ff7c5e366f87f8e8a`
- Missing release evidence: none
- Release decision: `keep_experimental`
