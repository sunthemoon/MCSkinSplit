# UV concepts

- The source is a modern 64x64 RGBA Minecraft skin.
- Coordinates start at the top-left. `x` increases rightward and `y` downward.
- Row spans use inclusive `x0` and `x1` values.
- The active layout in `job.json` is authoritative: `wide` means Classic and
  `slim` means Alex.
- A surface key is
  `<bodyPart>.<base|outer>.<front|back|left|right|top|bottom>`.
- Candidate regions partition all visible pixels in valid UV rectangles. Pixels
  outside those rectangles and transparent pixels are not candidates.
- A candidate joins adjacent pixels on one surface when their RGB distance stays
  within the deterministic bound. It may contain mild shading variation, so use
  `pixelOverrides` when a small semantic boundary remains inside one candidate.
- `pixel-map.json` maps every valid visible atlas pixel to a surface, local UV,
  layer, body part, face, and exact RGBA value.
- Base and Outer are separate layers. Similar colors do not prove that two regions
  are the same semantic item.
- UV discontinuity does not prove semantic discontinuity. Use the contact sheet and
  body views to judge continuity across seams.
