import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = resolve(projectRoot, "tests/fixtures/skins/wide-basic.png");
const checkOnly = process.argv.includes("--check");

const WIDTH = 64;
const HEIGHT = 64;

function color(hex, alpha = 255) {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff, alpha];
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

function buildWideBasicFixture() {
  const png = new PNG({ width: WIDTH, height: HEIGHT, colorType: 6 });

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

  paintCuboid(png, 40, 16, 4, 4, 12, {
    top: shirtLight,
    bottom: skinShadow,
    left: shirtShadow,
    front: shirt,
    right: shirtLight,
    back: shirtShadow,
  });

  paintCuboid(png, 32, 48, 4, 4, 12, {
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
  fillRect(png, 44, 29, 4, 3, skin);
  fillRect(png, 36, 61, 4, 3, skin);
  fillRect(png, 4, 29, 4, 3, shoe);
  fillRect(png, 20, 61, 4, 3, shoe);

  return PNG.sync.write(png, {
    colorType: 6,
    inputColorType: 6,
    inputHasAlpha: true,
  });
}

const expected = buildWideBasicFixture();

if (checkOnly) {
  let actual;
  try {
    actual = await readFile(fixturePath);
  } catch {
    console.error(`Missing generated fixture: ${fixturePath}`);
    process.exitCode = 1;
  }

  if (actual && !actual.equals(expected)) {
    console.error(`Generated fixture is stale: ${fixturePath}`);
    process.exitCode = 1;
  } else if (actual) {
    console.log(`Fixture is deterministic: ${fixturePath}`);
  }
} else {
  await mkdir(dirname(fixturePath), { recursive: true });
  await writeFile(fixturePath, expected);
  console.log(`Generated ${fixturePath}`);
}
