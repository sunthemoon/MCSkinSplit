# Analysis guidelines

1. Preserve exact source pixels; propose labels, never new colors.
2. Prefer a coarse supported category over an elaborate guess.
3. Separate facial features from hair covering the face when the pixels support it.
4. Separate gloves from sleeves and shoes from legwear only when boundaries are
   visually supported.
5. Consider color, layer, surface adjacency, bilateral symmetry, and the assembled
   body views together. Do not classify from color alone.
6. Use one component for a continuous item that crosses seams or body parts.
7. Use separate left/right instances when paired items can be reused independently;
   connect them through `pairedWith`.
8. Put each ambiguous or low-confidence region in exactly one place: either
   `unassignedCandidateRegionIds` or one precise `reviewItems` entry, never both.
9. Ensure every candidate region appears exactly once: in one component, in the
   unassigned list, or in exactly one review item.
10. Keep `modelAssessment.armType` equal to the authoritative job arm type. Record
    a visual disagreement as a `model_mismatch` review item instead of changing it.
11. Treat `pixelOverrides` as bounded component-to-component transfers. Every add
    needs one matching removal from the component owning that candidate pixel;
    additions from unassigned/review regions are invalid. Unmatched removals become
    Unknown. Use at most 32 spans and 64 unique pixels per proposal.
