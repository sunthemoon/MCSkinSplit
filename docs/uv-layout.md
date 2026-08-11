# Deterministic UV layout contract

MCSkinSplit treats a modern Minecraft skin as a decoded 64×64 RGBA image. Its lossless guarantee applies to RGBA pixels: PNG compression, chunk order, and ancillary metadata are not preserved.

## Canonical model

Each arm layout exposes 72 surfaces in one stable order:

```text
body part: head, torso, rightArm, leftArm, rightLeg, leftLeg
layer:     base, outer
face:      front, back, left, right, top, bottom
```

A surface key combines those fields, for example `rightArm.outer.front`. Surface pixels are stored in an outside-facing canonical orientation. Atlas bottom faces are vertically flipped when read into the canonical model and flipped back when written; the other five faces need no transform for the supported Minecraft layout.

Pixels outside all 72 UV rectangles remain in `unusedAtlasData`. Reconstructing an Atlas starts from that complete unused-pixel buffer and writes each canonical surface back to its fixed rectangle. This preserves transparent RGB values and other unused pixels instead of clearing them.

## Cuboid origins

The JSON layouts store each cuboid's top-left UV origin plus its width, height, and depth. Face rectangles are expanded deterministically from those dimensions.

| Body layer | Origin | Wide size | Slim size |
|---|---:|---:|---:|
| Head base | `0,0` | `8×8×8` | same |
| Head outer | `32,0` | `8×8×8` | same |
| Torso base | `16,16` | `8×12×4` | same |
| Torso outer | `16,32` | `8×12×4` | same |
| Right arm base | `40,16` | `4×12×4` | `3×12×4` |
| Right arm outer | `40,32` | `4×12×4` | `3×12×4` |
| Left arm base | `32,48` | `4×12×4` | `3×12×4` |
| Left arm outer | `48,48` | `4×12×4` | `3×12×4` |
| Right leg base | `0,16` | `4×12×4` | same |
| Right leg outer | `0,32` | `4×12×4` | same |
| Left leg base | `16,48` | `4×12×4` | same |
| Left leg outer | `0,48` | `4×12×4` | same |

The expanded Wide layout uses 3,264 unique Atlas pixels; Slim uses 3,136. Both contain exactly 72 non-overlapping surfaces within the 64×64 bounds.

## Wide/Slim inference

Automatic inference examines four unused marker regions around the arm UVs:

```text
(50,16) 2×4    (54,20) 2×12
(42,48) 2×4    (46,52) 2×12
```

The model is Slim if any marker pixel is transparent, or if all four regions are fully opaque black, or all four are fully opaque white. Otherwise it is Wide. The Studio always exposes Auto, Wide, and Slim controls because a valid file can still be semantically ambiguous.

These coordinates and inference rules track the installed upstream implementations in [skinview3d `model.ts`](https://github.com/bs-community/skinview3d/blob/master/src/model.ts) and [skinview-utils `process.ts`](https://github.com/bs-community/skinview-utils/blob/master/src/process.ts).

## Public core API

The framework-independent `@mc-skin-split/skin-core` package exports:

- `decodePngRgba`, `decodeSkinPng`, `encodePngRgba`, and `encodeSkinPng`;
- `getSkinLayout`, `createUsedUvMask`, and surface definitions;
- `atlasToSurfaceModel`, `surfaceModelToAtlas`, and fixed surface texels;
- reversible orientation transforms for every 0°, 90°, 180°, and 270° rotation/flip combination;
- `assessArmType` and `inferArmType`;
- `scaleNearest` and `renderFaceContactSheet`.

## Fixture and invariant coverage

| Fixture | Purpose |
|---|---|
| `wide-basic.png` | Wide baseline and 4-pixel arms |
| `slim-basic.png` | Transparent Slim markers and 3-pixel arms |
| `rgba-alpha.png` | Hidden RGB, partial alpha, and transparent pixels |
| `indexed-color.png` | Indexed palette plus `tRNS` normalization |
| `uv-calibration.png` | Unique center color per surface and directional corner markers |
| Six hashed real-world PNGs | Full decode, transparent Slim markers, PNG and UV round trips |
| `alex-mix-real.png` | One complete Slim body assembled from all six real-world sources |

Tests validate both layout JSON files against the schema, every face rectangle and orientation, all 72 calibration surfaces, fixed texel uniqueness, PNG decode/encode equality, Atlas → Surface Model → Atlas equality, nearest-neighbor output, and semantic Contact Sheet ordering.

The real fixture filenames and SHA-256 digests are pinned in `tests/fixtures/skins/real-skins.json`. All six decode as Slim through transparent marker pixels. The generated mix uses this fixed recipe:

| Mixed body part | Source |
|---|---|
| Head | A1 |
| Torso | A4 |
| Right arm | A3 |
| Left arm | A5 |
| Right leg | A6 |
| Left leg | A2 |

The generator starts from a transparent 64×64 image, copies both Base and Outer surfaces for each body part, and clears all Slim marker regions. Tests compare every mixed surface with its declared source. This is a fixture-generation proof, not the conflict-aware interactive compositor planned for M6.
