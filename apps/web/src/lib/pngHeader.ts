const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;
const IHDR_TYPE = [73, 72, 68, 82] as const;

export const MAX_SKIN_FILE_BYTES = 1024 * 1024;

export interface MinecraftSkinHeader {
  width: 64;
  height: 64;
}

function matches(bytes: Uint8Array, offset: number, expected: readonly number[]) {
  return expected.every((value, index) => bytes[offset + index] === value);
}

export function inspectMinecraftSkinHeader(
  source: ArrayBuffer | Uint8Array,
): MinecraftSkinHeader {
  const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);

  if (bytes.byteLength < 24 || !matches(bytes, 0, PNG_SIGNATURE)) {
    throw new Error("文件不是有效的 PNG 容器");
  }

  if (!matches(bytes, 12, IHDR_TYPE)) {
    throw new Error("PNG 缺少首个 IHDR 数据块");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);

  if (width !== 64 || height !== 64) {
    throw new Error(`仅支持 64×64 皮肤，检测到 ${width}×${height}`);
  }

  return { width, height };
}

export async function validateMinecraftSkinFile(file: File) {
  if (file.size > MAX_SKIN_FILE_BYTES) {
    throw new Error("PNG 文件不能超过 1 MiB");
  }

  if (file.type && file.type !== "image/png") {
    throw new Error("仅支持 PNG 文件");
  }

  return inspectMinecraftSkinHeader(await file.arrayBuffer());
}
