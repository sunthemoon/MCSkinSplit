import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { decodeSkinPng, type RgbaImage } from "../src";

export const fixtureDirectory = resolve(
  process.cwd(),
  "../../tests/fixtures/skins",
);

export async function readFixtureBytes(fileName: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(resolve(fixtureDirectory, fileName)));
}

export async function decodeFixture(fileName: string): Promise<RgbaImage> {
  return decodeSkinPng(await readFixtureBytes(fileName));
}
