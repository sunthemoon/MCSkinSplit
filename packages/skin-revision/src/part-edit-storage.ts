import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { sha256 } from "./hash";

export const LEGACY_PART_EDIT_FILE_NAMES = [
  "texture.png",
  "write-mask.png",
  "revision.json",
] as const;

export const PART_EDIT_FILE_NAMES = [
  "texture.png",
  "write-mask.png",
  "origin.json",
  "generated-mask.png",
  "revision.json",
] as const;

export type LegacyPartEditFileName = (typeof LEGACY_PART_EDIT_FILE_NAMES)[number];
export type PartEditFileName = (typeof PART_EDIT_FILE_NAMES)[number];

export interface PartEditStorageInput {
  readonly projectId: string;
  readonly revisionId: string;
  readonly files: Readonly<Record<PartEditFileName, Uint8Array>>;
}

export interface StoredPartEditFile {
  readonly name: PartEditFileName;
  readonly storagePath: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

export interface VerifiedPartEditStorage {
  readonly directory: string;
  readonly files: Readonly<Record<LegacyPartEditFileName, StoredPartEditFile>> &
    Readonly<Partial<Record<PartEditFileName, StoredPartEditFile>>>;
}

/** Immutable, atomic storage for one part-repair revision. */
export class PartEditStorage {
  readonly dataDirectory: string;

  constructor(dataDirectory: string) {
    this.dataDirectory = resolve(dataDirectory);
  }

  revisionDirectory(projectId: string, revisionId: string): string {
    assertSafeId("part edit project", projectId);
    assertSafeId("part edit revision", revisionId);
    return resolveWithin(
      this.dataDirectory,
      "part-edits",
      projectId,
      "revisions",
      revisionId,
    );
  }

  async writeRevision(
    input: PartEditStorageInput,
  ): Promise<VerifiedPartEditStorage> {
    const revisionsDirectory = resolveWithin(
      this.dataDirectory,
      "part-edits",
      input.projectId,
      "revisions",
    );
    await mkdir(revisionsDirectory, { recursive: true });
    const finalDirectory = this.revisionDirectory(
      input.projectId,
      input.revisionId,
    );
    const temporaryDirectory = resolveWithin(
      revisionsDirectory,
      `.${input.revisionId}.${randomUUID()}.tmp`,
    );
    await mkdir(temporaryDirectory, { recursive: false });
    let finalized = false;

    try {
      for (const fileName of PART_EDIT_FILE_NAMES) {
        await writeDurableFile(
          resolveWithin(temporaryDirectory, fileName),
          input.files[fileName],
        );
      }
      await rename(temporaryDirectory, finalDirectory);
      finalized = true;
      return await this.readRevision(input.projectId, input.revisionId, true);
    } catch (error) {
      await rm(temporaryDirectory, { recursive: true, force: true });
      if (finalized) {
        await rm(finalDirectory, { recursive: true, force: true });
      }
      throw error;
    }
  }

  async readRevision(
    projectId: string,
    revisionId: string,
    hasOrigin: boolean,
  ): Promise<VerifiedPartEditStorage> {
    const directory = this.revisionDirectory(projectId, revisionId);
    const files = {} as Record<LegacyPartEditFileName, StoredPartEditFile> &
      Partial<Record<PartEditFileName, StoredPartEditFile>>;
    const fileNames = hasOrigin
      ? PART_EDIT_FILE_NAMES
      : LEGACY_PART_EDIT_FILE_NAMES;
    for (const fileName of fileNames) {
      const bytes = new Uint8Array(
        await readFile(resolveWithin(directory, fileName)),
      );
      files[fileName] = {
        name: fileName,
        storagePath: `part-edits/${projectId}/revisions/${revisionId}/${fileName}`,
        bytes,
        sha256: sha256(bytes),
      };
    }
    return { directory, files } as VerifiedPartEditStorage;
  }

  async removeNewRevision(
    projectId: string,
    revisionId: string,
  ): Promise<void> {
    await rm(this.revisionDirectory(projectId, revisionId), {
      recursive: true,
      force: true,
    });
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
