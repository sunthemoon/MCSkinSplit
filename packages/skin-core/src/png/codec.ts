import { Buffer } from "buffer";
import { PNG } from "pngjs/browser.js";
import { assertRgbaImage, createRgbaImage } from "../image";
import { SKIN_HEIGHT, SKIN_WIDTH, type RgbaImage } from "../types";

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;

interface PngSyncCodec {
  read(input: Uint8Array): { width: number; height: number; data: Uint8Array };
  write(
    input: { width: number; height: number; data: Uint8Array },
    options?: {
      colorType?: number;
      inputColorType?: number;
      inputHasAlpha?: boolean;
      deflateLevel?: number;
    },
  ): Uint8Array;
}

const pngSync = PNG.sync as unknown as PngSyncCodec;

export type SkinPngErrorCode = "INVALID_PNG" | "INVALID_DIMENSIONS";

export class SkinPngError extends Error {
  readonly code: SkinPngErrorCode;

  constructor(code: SkinPngErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SkinPngError";
    this.code = code;
  }
}

export function decodePngRgba(input: ArrayBuffer | Uint8Array): RgbaImage {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);

  if (
    bytes.length < PNG_SIGNATURE.length ||
    !PNG_SIGNATURE.every((value, index) => bytes[index] === value)
  ) {
    throw new SkinPngError("INVALID_PNG", "文件不是有效的 PNG 容器");
  }

  try {
    const decoded = pngSync.read(Buffer.from(bytes));
    return createRgbaImage(
      decoded.width,
      decoded.height,
      new Uint8Array(decoded.data),
    );
  } catch (error) {
    if (error instanceof SkinPngError) {
      throw error;
    }
    throw new SkinPngError("INVALID_PNG", "PNG 像素数据无法解码", {
      cause: error,
    });
  }
}

export function decodeSkinPng(input: ArrayBuffer | Uint8Array): RgbaImage {
  const image = decodePngRgba(input);

  if (image.width !== SKIN_WIDTH || image.height !== SKIN_HEIGHT) {
    throw new SkinPngError(
      "INVALID_DIMENSIONS",
      `仅支持 64×64 皮肤，检测到 ${image.width}×${image.height}`,
    );
  }

  return image;
}

export function encodePngRgba(image: RgbaImage): Uint8Array {
  assertRgbaImage(image);
  const encoded = pngSync.write(
    {
      width: image.width,
      height: image.height,
      data: Buffer.from(image.data),
    },
    {
      colorType: 6,
      inputColorType: 6,
      inputHasAlpha: true,
      deflateLevel: 9,
    },
  );

  return new Uint8Array(encoded);
}

export function encodeSkinPng(image: RgbaImage): Uint8Array {
  if (image.width !== SKIN_WIDTH || image.height !== SKIN_HEIGHT) {
    throw new SkinPngError(
      "INVALID_DIMENSIONS",
      `仅支持编码 64×64 皮肤，收到 ${image.width}×${image.height}`,
    );
  }

  return encodePngRgba(image);
}
