# MCSkinSplit Agent Guide

Read these files before changing implementation code:

1. `docs/mc-skin-ai-assisted-segmentation-versioned-studio-plan.md`
2. `docs/implementation-status.md`
3. The nearest package tests and README files.

## Milestone workflow

- Work on one implementation milestone at a time unless a prerequisite fix is required.
- Update `docs/implementation-status.md` with verified evidence before committing a milestone.
- Run `pnpm verify` before each milestone commit.
- Use a focused commit and push it to `origin/main` after the milestone passes.
- Preserve unrelated user changes and never rewrite published history.

## Product invariants

- The supported source format is a decoded 64x64 RGBA PNG in M1-M6.
- Pixel coordinates, masks, copying, composition, and export are deterministic operations. AI may classify proposals but never invent coordinates or directly write a skin.
- Nearest-neighbor scaling is mandatory for pixel assets; interpolation is forbidden.
- Revision snapshots are immutable. Revert and branching create new revisions.
- Reusable parts remain 64x64 textures with an independent 64x64 write mask.
- Pixel conflicts must be reported and must never be silently overwritten.
- AI providers cannot write the application database or production snapshot tree.

## Commands

```text
pnpm dev
pnpm typecheck
pnpm test
pnpm build
pnpm verify
```

Generated fixtures are deterministic:

```text
pnpm fixtures:generate
pnpm fixtures:check
```

Commit generated fixtures only when their generator changed intentionally.
