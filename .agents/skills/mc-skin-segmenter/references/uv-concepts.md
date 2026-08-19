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
- Overrides transfer a small number of pixels between component-owned candidate
  regions. Every add needs one matching removal by the source owner. A removal may
  remain unmatched and then becomes Unknown; unassigned/review pixels cannot be
  added to a component.
- `pixel-map.json` maps every valid visible atlas pixel to a surface, local UV,
  layer, body part, face, and exact RGBA value.
- Base and Outer are separate layers. Similar colors do not prove that two regions
  are the same semantic item.
- UV discontinuity does not prove semantic discontinuity. Use the contact sheet and
  body views to judge continuity across seams.
- The Candidate Evidence Graph contains only host-computed relationships:
  `same_surface_contact`, `same_surface_proximity`, `uv_seam`,
  `layer_projection`, and `bilateral_mirror`. Atlas neighbors are not physical
  neighbors unless the graph contains the corresponding edge.
- Grounding views pair natural color with CandidateRegion pseudo-color and stable
  short visual IDs. A visual ID is only a lookup aid; proposals always use the
  exact CandidateRegion ID supplied by the graph summary.
- The labelled all-surface pair aligns natural and CandidateRegion panels across
  front, back, left, right, top, and bottom. Use it for top/bottom faces that are
  absent from the four-direction orthographic body views. Surface names describe
  cube geometry and must not be treated as anatomical categories.
