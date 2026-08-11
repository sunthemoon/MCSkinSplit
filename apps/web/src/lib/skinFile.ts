import {
  assessArmType,
  decodeSkinPng,
  type ArmTypeAssessment,
  type RgbaImage,
} from "@mc-skin-split/skin-core";

export const MAX_SKIN_FILE_BYTES = 1024 * 1024;

export interface DecodedMinecraftSkin {
  readonly image: RgbaImage;
  readonly assessment: ArmTypeAssessment;
}

export function decodeMinecraftSkinBytes(
  source: ArrayBuffer | Uint8Array,
): DecodedMinecraftSkin {
  const image = decodeSkinPng(source);
  return {
    image,
    assessment: assessArmType(image),
  };
}

export async function decodeMinecraftSkinFile(
  file: File,
): Promise<DecodedMinecraftSkin> {
  if (file.size > MAX_SKIN_FILE_BYTES) {
    throw new Error("PNG 文件不能超过 1 MiB");
  }

  if (file.type && file.type !== "image/png") {
    throw new Error("仅支持 PNG 文件");
  }

  return decodeMinecraftSkinBytes(await file.arrayBuffer());
}
