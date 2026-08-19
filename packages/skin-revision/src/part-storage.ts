import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { sha256 } from "./hash";

export const LEGACY_PART_FILE_NAMES = [
  "texture.png",
  "write-mask.png",
  "manifest.json",
  "preview.png",
  "source.json",
] as const;

export const PART_FILE_NAMES = [
  "texture.png",
  "write-mask.png",
  "origin.json",
  "generated-mask.png",
  "manifest.json",
  "preview.png",
  "source.json",
] as const;

export type LegacyPartFileName = (typeof LEGACY_PART_FILE_NAMES)[number];
export type PartFileName = (typeof PART_FILE_NAMES)[number];
export type PartStorageSchemaVersion = "1.0" | "1.1" | "2.0";

export interface PartStorageInput {
  readonly partId: string;
  readonly files: Readonly<Record<PartFileName, Uint8Array>>;
}

export interface StoredPartFile {
  readonly name: PartFileName;
  readonly storagePath: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

export interface VerifiedPartStorage {
  readonly directory: string;
  readonly files: Readonly<Record<LegacyPartFileName, StoredPartFile>> &
    Readonly<Partial<Record<PartFileName, StoredPartFile>>>;
}

export function partFileNamesForVersion(
  schemaVersion: PartStorageSchemaVersion,
): readonly PartFileName[] {
  return schemaVersion === "2.0" ? PART_FILE_NAMES : LEGACY_PART_FILE_NAMES;
}

export class PartStorage {
  readonly dataDirectory: string;

  constructor(dataDirectory: string) {
    this.dataDirectory = resolve(dataDirectory);
  }

  partDirectory(partId: string): string {
    assertSafeId("part", partId);
    return resolveWithin(this.dataDirectory, "parts", partId);
  }

  async writePart(input: PartStorageInput): Promise<VerifiedPartStorage> {
    const partsDirectory = resolveWithin(this.dataDirectory, "parts");
    await mkdir(partsDirectory, { recursive: true });
    const finalDirectory = this.partDirectory(input.partId);
    const temporaryDirectory = resolveWithin(
      partsDirectory,
      `.${input.partId}.${randomUUID()}.tmp`,
    );
    await mkdir(temporaryDirectory, { recursive: false });
    let finalized = false;

    try {
      for (const fileName of PART_FILE_NAMES) {
        await writeDurableFile(
          resolveWithin(temporaryDirectory, fileName),
          input.files[fileName],
        );
      }
      await rename(temporaryDirectory, finalDirectory);
      finalized = true;
      return await this.readPart(input.partId, "2.0");
    } catch (error) {
      await rm(temporaryDirectory, { recursive: true, force: true });
      if (finalized) {
        await rm(finalDirectory, { recursive: true, force: true });
      }
      throw error;
    }
  }

  async readPart(
    partId: string,
    schemaVersion: PartStorageSchemaVersion,
  ): Promise<VerifiedPartStorage> {
    const directory = this.partDirectory(partId);
    const files = {} as Record<LegacyPartFileName, StoredPartFile> &
      Partial<Record<PartFileName, StoredPartFile>>;
    for (const fileName of partFileNamesForVersion(schemaVersion)) {
      const bytes = new Uint8Array(
        await readFile(resolveWithin(directory, fileName)),
      );
      files[fileName] = {
        name: fileName,
        storagePath: `parts/${partId}/${fileName}`,
        bytes,
        sha256: sha256(bytes),
      };
    }
    return { directory, files } as VerifiedPartStorage;
  }

  async removeNewPart(partId: string): Promise<void> {
    await rm(this.partDirectory(partId), { recursive: true, force: true });
  }
}

async function writeDurableFile(path: string, data: Uint8Array): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function assertSafeId(kind: string, value: string): void {
  if (!/^[a-z][a-z0-9_-]{2,100}$/.test(value)) {
    throw new TypeError(`Unsafe ${kind} id: ${value}`);
  }
}

function resolveWithin(root: string, ...segments: string[]): string {
  const resolvedRoot = resolve(root);
  const candidate = resolve(resolvedRoot, ...segments);
  const relation = relative(resolvedRoot, candidate);
  if (
    relation === ".." ||
    relation.startsWith(`..${sep}`) ||
    isAbsolute(relation)
  ) {
    throw new TypeError(`Resolved path escapes storage root: ${candidate}`);
  }
  return candidate;
}
