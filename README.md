# MCSkinSplit

MCSkinSplit is a versioned Minecraft skin studio for lossless UV editing, semantic component extraction, reusable parts, and AI-assisted classification.

The repository is implemented milestone by milestone from the project specification in [`docs/mc-skin-ai-assisted-segmentation-versioned-studio-plan.md`](docs/mc-skin-ai-assisted-segmentation-versioned-studio-plan.md). M0 established the browser baseline; M1 adds the deterministic 64×64 RGBA and UV core.

The current Studio can:

- fully decode 64×64 PNG files to RGBA, including indexed-color PNGs with `tRNS`;
- infer Wide/Classic or Slim/Alex arm layouts and let the user override the result;
- map an Atlas to 72 canonical body surfaces and reconstruct every RGBA pixel;
- render a true 1024×1024 nearest-neighbor Atlas and a semantic face Contact Sheet;
- exercise six versioned real-world skins and a deterministic six-source Alex/Slim mix;
- preview the effective arm layout through one local `skinview3d` viewer.

## Requirements

- Node.js 24
- pnpm 10.13.1
- A browser with WebGL support

## Start the Studio

```bash
pnpm install
pnpm fixtures:generate
pnpm dev
```

Open `http://127.0.0.1:5173`. The generated Alex/Slim mix is selected by default. Upload another 64×64 PNG or switch among the six real-world skins and the deterministic laboratory fixtures.

## Verify

```bash
pnpm verify
```

This checks that generated fixtures are unchanged, runs TypeScript and unit tests, and builds the production web application.

## Repository layout

```text
apps/web/                 Vite + React browser Studio
packages/skin-core/       Framework-independent PNG, layout, UV, and render core
docs/                     Architecture, implementation status, and specification
scripts/                  Deterministic fixture tooling
tests/fixtures/skins/     Versioned Minecraft skin fixtures
```

The revision service, editor, part library, AI worker, and compositor follow in M2-M6. The canonical UV contract is documented in [`docs/uv-layout.md`](docs/uv-layout.md); progress and verification evidence are tracked in [`docs/implementation-status.md`](docs/implementation-status.md).
