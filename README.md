# MCSkinSplit

MCSkinSplit is a versioned Minecraft skin studio for lossless UV editing, semantic component extraction, reusable parts, and AI-assisted classification.

The repository is being implemented milestone by milestone from the project specification in [`docs/mc-skin-ai-assisted-segmentation-versioned-studio-plan.md`](docs/mc-skin-ai-assisted-segmentation-versioned-studio-plan.md). M0 provides a runnable browser baseline with PNG validation, a pixelated 2D atlas, and a local `skinview3d` preview.

## Requirements

- Node.js 24
- pnpm 10.13.1
- A browser with WebGL support

## Start the baseline

```bash
pnpm install
pnpm fixtures:generate
pnpm dev
```

Open `http://127.0.0.1:5173`. Upload a 64x64 PNG or use the deterministic bundled fixture.

## Verify

```bash
pnpm verify
```

This checks that generated fixtures are unchanged, runs TypeScript and unit tests, and builds the production web application.

## Repository layout

```text
apps/web/                 Vite + React browser baseline
docs/                     Architecture, implementation status, and specification
scripts/                  Deterministic fixture tooling
tests/fixtures/skins/     Versioned Minecraft skin fixtures
```

The deterministic pixel core, revision service, editor, part library, AI worker, and compositor are added in M1-M6. Progress and evidence are tracked in [`docs/implementation-status.md`](docs/implementation-status.md).
