import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { PNG } from "pngjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDirectory = resolve(projectRoot, "tests/fixtures/skins");
const realSkinManifestPath = resolve(fixtureDirectory, "real-skins.json");
const checkOnly = process.argv.includes("--check");

const WIDTH = 64;
const HEIGHT = 64;
const FACE_ORDER = ["front", "back", "left", "right", "top", "bottom"];
const CORNERS = {
  topLeft: color("#ff174f"),
  topRight: color("#4dff73"),
  bottomLeft: color("#3567ff"),
  bottomRight: color("#ffd52f"),
};

const WIDE_CUBOIDS = [
  cuboid("head", "base", 0, 0, 8, 8, 8),
  cuboid("head", "outer", 32, 0, 8, 8, 8),
  cuboid("torso", "base", 16, 16, 8, 12, 4),
  cuboid("torso", "outer", 16, 32, 8, 12, 4),
  cuboid("rightArm", "base", 40, 16, 4, 12, 4),
  cuboid("rightArm", "outer", 40, 32, 4, 12, 4),
  cuboid("leftArm", "base", 32, 48, 4, 12, 4),
  cuboid("leftArm", "outer", 48, 48, 4, 12, 4),
  cuboid("rightLeg", "base", 0, 16, 4, 12, 4),
  cuboid("rightLeg", "outer", 0, 32, 4, 12, 4),
  cuboid("leftLeg", "base", 16, 48, 4, 12, 4),
  cuboid("leftLeg", "outer", 0, 48, 4, 12, 4),
];

const SLIM_CUBOIDS = WIDE_CUBOIDS.map((entry) =>
  entry.bodyPart === "rightArm" || entry.bodyPart === "leftArm"
    ? { ...entry, width: 3 }
    : entry,
);

const SLIM_MARKER_REGIONS = [
  { x: 50, y: 16, width: 2, height: 4 },
  { x: 54, y: 20, width: 2, height: 12 },
  { x: 42, y: 48, width: 2, height: 4 },
  { x: 46, y: 52, width: 2, height: 12 },
];

function cuboid(bodyPart, layer, x, y, width, height, depth) {
  return { bodyPart, layer, x, y, width, height, depth };
}

function color(hex, alpha = 255) {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff, alpha];
}

function createPng() {
  const png = new PNG({ width: WIDTH, height: HEIGHT, colorType: 6 });
  png.data.fill(0);
  return png;
}

function setPixel(png, x, y, rgba) {
  if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) {
    throw new RangeError(`Fixture pixel is outside 64x64: ${x},${y}`);
  }

  const offset = (y * WIDTH + x) * 4;
  png.data[offset] = rgba[0];
  png.data[offset + 1] = rgba[1];
  png.data[offset + 2] = rgba[2];
  png.data[offset + 3] = rgba[3];
}

function fillRect(png, x, y, width, height, rgba) {
  for (let py = y; py < y + height; py += 1) {
    for (let px = x; px < x + width; px += 1) {
      setPixel(png, px, py, rgba);
    }
  }
}

function paintCuboid(png, x, y, width, depth, height, palette) {
  fillRect(png, x + depth, y, width, depth, palette.top);
  fillRect(png, x + depth + width, y, width, depth, palette.bottom);
  fillRect(png, x, y + depth, depth, height, palette.left);
  fillRect(png, x + depth, y + depth, width, height, palette.front);
  fillRect(png, x + depth + width, y + depth, depth, height, palette.right);
  fillRect(png, x + depth * 2 + width, y + depth, width, height, palette.back);
}

function encodeRgbaPng(png) {
  return PNG.sync.write(png, {
    colorType: 6,
    inputColorType: 6,
    inputHasAlpha: true,
  });
}

function buildBasicFixture(armWidth) {
  const png = createPng();
  const skin = color("#d8a27d");
  const skinLight = color("#edbd98");
  const skinShadow = color("#b97b61");
  const hair = color("#382a32");
  const hairLight = color("#57404a");
  const shirt = color("#1f7584");
  const shirtLight = color("#2e96a0");
  const shirtShadow = color("#15515d");
  const trousers = color("#435069");
  const trousersLight = color("#596984");
  const trousersShadow = color("#30394e");
  const shoe = color("#20232d");
  const eye = color("#172330");
  const eyeLight = color("#8fd5d0");

  paintCuboid(png, 0, 0, 8, 8, 8, {
    top: hairLight,
    bottom: skinShadow,
    left: hair,
    front: skinLight,
    right: hairLight,
    back: hair,
  });
  paintCuboid(png, 16, 16, 8, 4, 12, {
    top: shirtLight,
    bottom: shirtShadow,
    left: shirtShadow,
    front: shirt,
    right: shirtLight,
    back: shirtShadow,
  });
  paintCuboid(png, 40, 16, armWidth, 4, 12, {
    top: shirtLight,
    bottom: skinShadow,
    left: shirtShadow,
    front: shirt,
    right: shirtLight,
    back: shirtShadow,
  });
  paintCuboid(png, 32, 48, armWidth, 4, 12, {
    top: shirtLight,
    bottom: skinShadow,
    left: shirtLight,
    front: shirt,
    right: shirtShadow,
    back: shirtShadow,
  });
  paintCuboid(png, 0, 16, 4, 4, 12, {
    top: trousersLight,
    bottom: shoe,
    left: trousersShadow,
    front: trousers,
    right: trousersLight,
    back: trousersShadow,
  });
  paintCuboid(png, 16, 48, 4, 4, 12, {
    top: trousersLight,
    bottom: shoe,
    left: trousersLight,
    front: trousers,
    right: trousersShadow,
    back: trousersShadow,
  });

  // Face details on head.base.front.
  fillRect(png, 8, 8, 8, 2, hair);
  fillRect(png, 8, 10, 1, 2, hair);
  fillRect(png, 15, 10, 1, 2, hair);
  setPixel(png, 10, 12, eye);
  setPixel(png, 13, 12, eye);
  setPixel(png, 10, 11, eyeLight);
  setPixel(png, 13, 11, eyeLight);
  setPixel(png, 11, 14, skinShadow);
  setPixel(png, 12, 14, skinShadow);

  // Transparent outer layers receive only deliberate hair and jacket pixels.
  fillRect(png, 40, 8, 8, 2, hairLight);
  fillRect(png, 40, 10, 2, 2, hair);
  fillRect(png, 46, 10, 2, 2, hair);
  fillRect(png, 47, 12, 1, 2, hairLight);
  fillRect(png, 56, 8, 8, 8, hair);
  fillRect(png, 20, 36, 2, 10, shirtLight);
  fillRect(png, 26, 36, 2, 10, shirtLight);
  fillRect(png, 22, 36, 4, 1, shirtShadow);
  setPixel(png, 23, 38, color("#e5b94f"));

  // Hands and shoes are deliberately distinct for later semantic fixtures.
  fillRect(png, 44, 29, armWidth, 3, skin);
  fillRect(png, 36, 61, armWidth, 3, skin);
  fillRect(png, 4, 29, 4, 3, shoe);
  fillRect(png, 20, 61, 4, 3, shoe);

  return encodeRgbaPng(png);
}

function buildRgbaAlphaFixture() {
  const png = createPng();
  const alphaLevels = [0, 64, 128, 255];

  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      setPixel(png, x, y, [
        (x * 29 + y * 7) % 256,
        (x * 11 + y * 31) % 256,
        (x * 3 + y * 47) % 256,
        alphaLevels[(x + y) % alphaLevels.length],
      ]);
    }
  }

  return encodeRgbaPng(png);
}

function buildUvCalibrationFixture() {
  const png = createPng();
  let surfaceIndex = 0;

  for (const entry of WIDE_CUBOIDS) {
    const rects = getFaceRects(entry);
    for (const face of FACE_ORDER) {
      const rect = rects[face];
      const base = calibrationColor(surfaceIndex);
      surfaceIndex += 1;
      fillRect(png, rect.x, rect.y, rect.width, rect.height, base);
      paintCanonicalCorners(png, rect, face === "bottom");
    }
  }

  return encodeRgbaPng(png);
}

function getFaceRects(entry) {
  const { x, y, width, height, depth } = entry;
  return {
    top: { x: x + depth, y, width, height: depth },
    bottom: { x: x + depth + width, y, width, height: depth },
    left: { x, y: y + depth, width: depth, height },
    front: { x: x + depth, y: y + depth, width, height },
    right: { x: x + depth + width, y: y + depth, width: depth, height },
    back: { x: x + depth * 2 + width, y: y + depth, width, height },
  };
}

function calibrationColor(index) {
  return [
    32 + ((index * 67) % 192),
    32 + ((index * 101) % 192),
    32 + ((index * 149) % 192),
    255,
  ];
}

function paintCanonicalCorners(png, rect, flipY) {
  const atlasCorners = flipY
    ? {
        topLeft: CORNERS.bottomLeft,
        topRight: CORNERS.bottomRight,
        bottomLeft: CORNERS.topLeft,
        bottomRight: CORNERS.topRight,
      }
    : CORNERS;

  setPixel(png, rect.x, rect.y, atlasCorners.topLeft);
  setPixel(png, rect.x + rect.width - 1, rect.y, atlasCorners.topRight);
  setPixel(png, rect.x, rect.y + rect.height - 1, atlasCorners.bottomLeft);
  setPixel(
    png,
    rect.x + rect.width - 1,
    rect.y + rect.height - 1,
    atlasCorners.bottomRight,
  );
}

function buildIndexedColorFixture() {
  const palette = Buffer.from([
    0x00, 0x00, 0x00,
    0xd8, 0xa2, 0x7d,
    0x1f, 0x75, 0x84,
    0x20, 0x23, 0x2d,
  ]);
  const transparency = Buffer.from([0x00, 0xff, 0xff, 0xff]);
  const scanlines = Buffer.alloc((WIDTH + 1) * HEIGHT);

  for (let y = 0; y < HEIGHT; y += 1) {
    const rowOffset = y * (WIDTH + 1);
    scanlines[rowOffset] = 0;
    for (let x = 0; x < WIDTH; x += 1) {
      scanlines[rowOffset + 1 + x] = (Math.floor(x / 8) + Math.floor(y / 8)) % 4;
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(WIDTH, 0);
  header.writeUInt32BE(HEIGHT, 4);
  header[8] = 8;
  header[9] = 3;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("PLTE", palette),
    pngChunk("tRNS", transparency),
    pngChunk("IDAT", deflateSync(scanlines, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

async function loadRealSkinSources(manifest) {
  const sources = new Map();

  for (const skin of manifest.skins) {
    const skinPath = resolve(fixtureDirectory, skin.file);
    const bytes = await readFile(skinPath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== skin.sha256) {
      throw new Error(
        `Real skin fixture hash mismatch for ${skin.file}: expected ${skin.sha256}, received ${sha256}`,
      );
    }

    const decoded = PNG.sync.read(bytes);
    if (decoded.width !== WIDTH || decoded.height !== HEIGHT) {
      throw new Error(
        `Real skin fixture must be 64x64: ${skin.file} is ${decoded.width}x${decoded.height}`,
      );
    }

    sources.set(skin.id, decoded);
    console.log(`Real skin fixture is unchanged: ${skinPath}`);
  }

  return sources;
}

function buildRealSkinMix(manifest, sources) {
  if (manifest.defaultArmType !== "slim" || manifest.mix.armType !== "slim") {
    throw new Error("The real-skin mix currently requires the Slim/Alex layout");
  }

  const target = createPng();
  for (const bodyPart of [
    "head",
    "torso",
    "rightArm",
    "leftArm",
    "rightLeg",
    "leftLeg",
  ]) {
    const sourceId = manifest.mix.recipe[bodyPart];
    const source = sources.get(sourceId);
    if (!source) {
      throw new Error(`Mix recipe references unknown real skin ${sourceId}`);
    }

    for (const cuboidEntry of SLIM_CUBOIDS.filter(
      (entry) => entry.bodyPart === bodyPart,
    )) {
      const rects = getFaceRects(cuboidEntry);
      for (const face of FACE_ORDER) {
        copyRect(source, target, rects[face]);
      }
    }
  }

  for (const marker of SLIM_MARKER_REGIONS) {
    fillRect(
      target,
      marker.x,
      marker.y,
      marker.width,
      marker.height,
      [0, 0, 0, 0],
    );
  }

  return encodeRgbaPng(target);
}

function copyRect(source, target, rect) {
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      const offset = (y * WIDTH + x) * 4;
      target.data.set(source.data.subarray(offset, offset + 4), offset);
    }
  }
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const expectedFixtures = new Map([
  ["wide-basic.png", buildBasicFixture(4)],
  ["slim-basic.png", buildBasicFixture(3)],
  ["rgba-alpha.png", buildRgbaAlphaFixture()],
  ["indexed-color.png", buildIndexedColorFixture()],
  ["uv-calibration.png", buildUvCalibrationFixture()],
]);

const realSkinManifest = JSON.parse(await readFile(realSkinManifestPath, "utf8"));
const realSkinSources = await loadRealSkinSources(realSkinManifest);
expectedFixtures.set(
  realSkinManifest.mix.file,
  buildRealSkinMix(realSkinManifest, realSkinSources),
);

await mkdir(fixtureDirectory, { recursive: true });

let failed = false;
for (const [fileName, expected] of expectedFixtures) {
  const fixturePath = resolve(fixtureDirectory, fileName);

  if (checkOnly) {
    let actual;
    try {
      actual = await readFile(fixturePath);
    } catch {
      console.error(`Missing generated fixture: ${fixturePath}`);
      failed = true;
      continue;
    }

    if (!actual.equals(expected)) {
      console.error(`Generated fixture is stale: ${fixturePath}`);
      failed = true;
    } else {
      console.log(`Fixture is deterministic: ${fixturePath}`);
    }
  } else {
    await writeFile(fixturePath, expected);
    console.log(`Generated ${fixturePath}`);
  }
}

if (failed) {
  process.exitCode = 1;
}
