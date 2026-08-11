import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  inspectMinecraftSkinHeader,
  MAX_SKIN_FILE_BYTES,
  validateMinecraftSkinFile,
} from "./pngHeader";

const fixturePath = resolve(
  process.cwd(),
  "../../tests/fixtures/skins/wide-basic.png",
);

describe("inspectMinecraftSkinHeader", () => {
  it("accepts the deterministic 64x64 PNG fixture", async () => {
    const fixture = await readFile(fixturePath);

    expect(inspectMinecraftSkinHeader(fixture)).toEqual({
      width: 64,
      height: 64,
    });
  });

  it("rejects a non-PNG signature", () => {
    const invalid = new Uint8Array(24);

    expect(() => inspectMinecraftSkinHeader(invalid)).toThrow(
      "文件不是有效的 PNG 容器",
    );
  });

  it("rejects legacy 64x32 dimensions", async () => {
    const fixture = new Uint8Array(await readFile(fixturePath));
    fixture[20] = 0;
    fixture[21] = 0;
    fixture[22] = 0;
    fixture[23] = 32;

    expect(() => inspectMinecraftSkinHeader(fixture)).toThrow(
      "仅支持 64×64 皮肤，检测到 64×32",
    );
  });

  it("validates an uploaded PNG file", async () => {
    const fixture = await readFile(fixturePath);
    const file = new File([fixture], "wide-basic.png", { type: "image/png" });

    await expect(validateMinecraftSkinFile(file)).resolves.toEqual({
      width: 64,
      height: 64,
    });
  });

  it("rejects a misleading non-PNG MIME type", async () => {
    const fixture = await readFile(fixturePath);
    const file = new File([fixture], "wide-basic.txt", { type: "text/plain" });

    await expect(validateMinecraftSkinFile(file)).rejects.toThrow(
      "仅支持 PNG 文件",
    );
  });

  it("rejects files larger than the M0 limit", async () => {
    const file = new File(
      [new Uint8Array(MAX_SKIN_FILE_BYTES + 1)],
      "oversized.png",
      { type: "image/png" },
    );

    await expect(validateMinecraftSkinFile(file)).rejects.toThrow(
      "PNG 文件不能超过 1 MiB",
    );
  });
});
