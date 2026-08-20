import type { Rgba, SurfaceKey } from "@mc-skin-split/skin-core";
import type {
  CompletionSyntheticFixture,
  CompletionSyntheticOcclusion,
  CompletionSyntheticPixel,
} from "./completion-evaluation";

const BLUE: Rgba = [36, 78, 132, 255];
const RED: Rgba = [196, 42, 54, 255];
const GREEN: Rgba = [34, 172, 88, 255];
const PURPLE: Rgba = [112, 58, 164, 255];
const HAIR: Rgba = [24, 18, 16, 255];
const ACCESSORY: Rgba = [226, 188, 72, 255];

/**
 * Deterministic M21 matrix. Every emitted candidate is still produced by the
 * current Host generator; definitions never inject a strategy or candidate.
 */
export const DEFAULT_COMPLETION_SYNTHETIC_FIXTURES:
  readonly CompletionSyntheticFixture[] = [
    {
      id: "slim_base_pattern",
      description: "Slim Base clothing with a one-pixel repeatable pattern gap",
      armType: "slim",
      targetLayer: "base",
      traits: ["symmetric"],
      targetCategory: "upper_clothing",
      occluderCategory: "hair",
      representation: "skin_texel",
      expectedOutcome: "candidates",
      targetPixels: [0, 1, 2, 3, 4].map((localU) =>
        pixel("torso.base.front", localU, 2, BLUE)
      ),
      occlusions: [
        occlusion(
          coordinate("torso.base.front", 2, 2),
          coordinate("torso.outer.front", 2, 2),
          HAIR,
        ),
      ],
    },
    {
      id: "wide_base_mirror_symmetric",
      description: "Wide-arm Base clothing with exact left/right mirror evidence",
      armType: "wide",
      targetLayer: "base",
      traits: ["symmetric"],
      targetCategory: "upper_clothing",
      occluderCategory: "hair",
      representation: "skin_texel",
      expectedOutcome: "candidates",
      targetPixels: [
        pixel("rightArm.base.front", 0, 2, RED),
        pixel("rightArm.base.front", 2, 2, RED),
        pixel("leftArm.base.front", 3, 2, RED),
      ],
      occlusions: [
        occlusion(
          coordinate("rightArm.base.front", 0, 2),
          coordinate("rightArm.outer.front", 0, 2),
          HAIR,
        ),
      ],
    },
    {
      id: "wide_base_mirror_asymmetric",
      description: "Wide-arm Base clothing whose mirrored reference has a different color",
      armType: "wide",
      targetLayer: "base",
      traits: ["asymmetric"],
      targetCategory: "upper_clothing",
      occluderCategory: "hair",
      representation: "skin_texel",
      expectedOutcome: "candidates",
      targetPixels: [
        pixel("rightArm.base.front", 0, 4, RED),
        pixel("rightArm.base.front", 1, 4, RED),
        pixel("leftArm.base.front", 3, 4, GREEN),
      ],
      occlusions: [
        occlusion(
          coordinate("rightArm.base.front", 0, 4),
          coordinate("rightArm.outer.front", 0, 4),
          HAIR,
        ),
      ],
    },
    {
      id: "slim_outer_underlay",
      description: "Slim Outer clothing with exact Base underlay evidence",
      armType: "slim",
      targetLayer: "outer",
      traits: ["symmetric"],
      targetCategory: "upper_clothing",
      occluderCategory: "hair",
      representation: "latent_component",
      expectedOutcome: "candidates",
      targetPixels: [
        pixel("torso.base.front", 2, 3, PURPLE),
        pixel("torso.outer.front", 1, 3, BLUE),
        pixel("torso.outer.front", 2, 3, PURPLE),
      ],
      occlusions: [
        occlusion(
          coordinate("torso.outer.front", 2, 3),
          coordinate("torso.outer.front", 2, 3),
          HAIR,
        ),
      ],
    },
    {
      id: "wide_outer_pattern",
      description: "Wide Outer clothing with two-sided constant pattern evidence",
      armType: "wide",
      targetLayer: "outer",
      traits: ["symmetric"],
      targetCategory: "upper_clothing",
      occluderCategory: "hair",
      representation: "latent_component",
      expectedOutcome: "candidates",
      targetPixels: [1, 2, 3].map((localU) =>
        pixel("torso.outer.front", localU, 5, GREEN)
      ),
      occlusions: [
        occlusion(
          coordinate("torso.outer.front", 2, 5),
          coordinate("torso.outer.front", 2, 5),
          HAIR,
        ),
      ],
    },
    {
      id: "slim_base_uv_seam",
      description: "Slim Base clothing hidden at a canonical front/right UV seam",
      armType: "slim",
      targetLayer: "base",
      traits: ["uv_seam", "asymmetric"],
      targetCategory: "upper_clothing",
      occluderCategory: "hair",
      representation: "skin_texel",
      expectedOutcome: "candidates",
      targetPixels: [
        pixel("torso.base.front", 7, 4, BLUE),
        pixel("torso.base.right", 0, 4, BLUE),
      ],
      occlusions: [
        occlusion(
          coordinate("torso.base.right", 0, 4),
          coordinate("torso.outer.right", 0, 4),
          HAIR,
        ),
      ],
    },
    {
      id: "slim_outer_whole_surface",
      description: "Slim latent clothing with its entire Outer front surface occluded",
      armType: "slim",
      targetLayer: "outer",
      traits: ["whole_surface", "symmetric"],
      targetCategory: "upper_clothing",
      occluderCategory: "hair",
      representation: "latent_component",
      expectedOutcome: "candidates",
      targetPixels: [
        ...surfacePixels("torso.outer.front", 8, 12, BLUE),
        ...surfacePixels("torso.outer.back", 8, 12, BLUE),
      ],
      occlusions: surfaceCoordinates("torso.outer.front", 8, 12).map((target) =>
        occlusion(target, target, HAIR)
      ),
    },
    {
      id: "slim_outer_hair_accessory",
      description: "Slim Outer hair hidden by an accessory with a repeatable pattern",
      armType: "slim",
      targetLayer: "outer",
      traits: ["symmetric"],
      targetCategory: "hair",
      occluderCategory: "head_accessory",
      representation: "latent_component",
      expectedOutcome: "candidates",
      targetPixels: [2, 3, 4].map((localU) =>
        pixel("head.outer.front", localU, 5, PURPLE)
      ),
      occlusions: [
        occlusion(
          coordinate("head.outer.front", 3, 5),
          coordinate("head.outer.front", 3, 5),
          ACCESSORY,
        ),
      ],
    },
    {
      id: "wide_base_transparent_mixed",
      description: "Wide Base gap containing one colored and one transparent hidden texel",
      armType: "wide",
      targetLayer: "base",
      traits: ["transparent", "asymmetric"],
      targetCategory: "upper_clothing",
      occluderCategory: "hair",
      representation: "skin_texel",
      expectedOutcome: "candidates",
      targetPixels: [
        pixel("torso.base.front", 1, 7, RED),
        pixel("torso.base.front", 2, 7, RED),
        pixel("torso.base.front", 3, 7, [0, 0, 0, 0]),
        pixel("torso.base.front", 4, 7, RED),
      ],
      occlusions: [
        occlusion(
          coordinate("torso.base.front", 2, 7),
          coordinate("torso.outer.front", 2, 7),
          HAIR,
        ),
        occlusion(
          coordinate("torso.base.front", 3, 7),
          coordinate("torso.outer.front", 3, 7),
          HAIR,
        ),
      ],
    },
    {
      id: "slim_base_transparent_only",
      description: "Negative Base gap whose hidden ground truth is transparent",
      armType: "slim",
      targetLayer: "base",
      traits: ["transparent"],
      targetCategory: "upper_clothing",
      occluderCategory: "hair",
      representation: "skin_texel",
      expectedOutcome: "zero_candidates",
      targetPixels: [
        pixel("torso.base.front", 1, 9, BLUE),
        pixel("torso.base.front", 2, 9, [0, 0, 0, 0]),
      ],
      occlusions: [
        occlusion(
          coordinate("torso.base.front", 2, 9),
          coordinate("torso.outer.front", 2, 9),
          HAIR,
        ),
      ],
    },
    {
      id: "wide_base_no_evidence",
      description: "Negative requested skin-texel case with only a Base-layer occluder",
      armType: "wide",
      targetLayer: "base",
      traits: ["no_evidence"],
      targetCategory: "upper_clothing",
      occluderCategory: "hair",
      representation: "skin_texel",
      expectedOutcome: "zero_candidates",
      targetPixels: [
        pixel("torso.base.front", 0, 10, GREEN),
        pixel("torso.base.front", 1, 10, GREEN),
      ],
      occlusions: [
        occlusion(
          coordinate("torso.base.front", 1, 10),
          coordinate("torso.base.front", 1, 10),
          HAIR,
        ),
      ],
    },
    {
      id: "slim_base_unsupported",
      description: "Negative hair target occluded by unsupported clothing",
      armType: "slim",
      targetLayer: "base",
      traits: ["unsupported"],
      targetCategory: "hair",
      occluderCategory: "upper_clothing",
      representation: "skin_texel",
      expectedOutcome: "unsupported_error",
      targetPixels: [
        pixel("head.base.front", 0, 2, PURPLE),
        pixel("head.base.front", 1, 2, PURPLE),
      ],
      occlusions: [
        occlusion(
          coordinate("head.base.front", 1, 2),
          coordinate("head.outer.front", 1, 2),
          RED,
        ),
      ],
    },
  ];

function pixel(
  surface: SurfaceKey,
  localU: number,
  localV: number,
  rgba: Rgba,
): CompletionSyntheticPixel {
  return { surface, localU, localV, rgba };
}

function coordinate(
  surface: SurfaceKey,
  localU: number,
  localV: number,
): Pick<CompletionSyntheticPixel, "surface" | "localU" | "localV"> {
  return { surface, localU, localV };
}

function occlusion(
  target: Pick<CompletionSyntheticPixel, "surface" | "localU" | "localV">,
  occluder: Pick<CompletionSyntheticPixel, "surface" | "localU" | "localV">,
  rgba: Rgba,
): CompletionSyntheticOcclusion {
  return { target, occluder, rgba };
}

function surfaceCoordinates(
  surface: SurfaceKey,
  width: number,
  height: number,
): Array<Pick<CompletionSyntheticPixel, "surface" | "localU" | "localV">> {
  return Array.from({ length: width * height }, (_, index) =>
    coordinate(surface, index % width, Math.floor(index / width))
  );
}

function surfacePixels(
  surface: SurfaceKey,
  width: number,
  height: number,
  rgba: Rgba,
): CompletionSyntheticPixel[] {
  return surfaceCoordinates(surface, width, height).map((item) => ({
    ...item,
    rgba,
  }));
}
