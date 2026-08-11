import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createRgbaImage,
  encodePngRgba,
  type ArmType,
} from "@mc-skin-split/skin-core";
import { describe, expect, it } from "vitest";
import {
  decodeMinecraftSkinBytes,
  decodeMinecraftSkinFile,
  MAX_SKIN_FILE_BYTES,
} from "./skinFile";

const fixtureDirectory = resolve(process.cwd(), "../../tests/fixtures/skins");

async function fixture(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(resolve(fixtureDirectory, name)));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

describe("Minecraft skin file adapter", () => {
  it.each([
    ["wide-basic.png", "wide"],
    ["slim-basic.png", "slim"],
    ["rgba-alpha.png", "slim"],
    ["indexed-color.png", "slim"],
    ["uv-calibration.png", "wide"],
  ] satisfies readonly (readonly [string, ArmType])[])(
    "fully decodes %s and reports its arm layout",
    async (name, armType) => {
      const decoded = decodeMinecraftSkinBytes(await fixture(name));

      expect(decoded.image).toMatchObject({ width: 64, height: 64 });
      expect(decoded.image.data).toHaveLength(64 * 64 * 4);
      expect(decoded.assessment.armType).toBe(armType);
    },
  );

  it("rejects a non-PNG payload", () => {
    expect(() => decodeMinecraftSkinBytes(new Uint8Array(24))).toThrow(
      "文件不是有效的 PNG 容器",
    );
  });

  it("rejects a truncated payload even when its signature is PNG", async () => {
    const bytes = (await fixture("wide-basic.png")).subarray(0, 32);

    expect(() => decodeMinecraftSkinBytes(bytes)).toThrow(
      "PNG 像素数据无法解码",
    );
  });

  it("rejects legacy 64x32 dimensions after a complete decode", () => {
    const legacy = createRgbaImage(64, 32);

    expect(() => decodeMinecraftSkinBytes(encodePngRgba(legacy))).toThrow(
      "仅支持 64×64 皮肤，检测到 64×32",
    );
  });

  it("validates and decodes an uploaded PNG file", async () => {
    const file = new File(
      [toArrayBuffer(await fixture("wide-basic.png"))],
      "wide-basic.png",
      { type: "image/png" },
    );

    await expect(decodeMinecraftSkinFile(file)).resolves.toMatchObject({
      image: { width: 64, height: 64 },
      assessment: { armType: "wide" },
    });
  });

  it("rejects a misleading non-PNG MIME type", async () => {
    const file = new File(
      [toArrayBuffer(await fixture("wide-basic.png"))],
      "wide-basic.txt",
      { type: "text/plain" },
    );

    await expect(decodeMinecraftSkinFile(file)).rejects.toThrow(
      "仅支持 PNG 文件",
    );
  });

  it("rejects files larger than the configured limit", async () => {
    const file = new File(
      [new Uint8Array(MAX_SKIN_FILE_BYTES + 1)],
      "oversized.png",
      { type: "image/png" },
    );

    await expect(decodeMinecraftSkinFile(file)).rejects.toThrow(
      "PNG 文件不能超过 1 MiB",
    );
  });
});
