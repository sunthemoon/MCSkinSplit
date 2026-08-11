import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { canonicalJson, sha256 } from "./hash";
import { RevisionStoreError, snapshotCorrupt } from "./errors";
import type { SnapshotChecksum } from "./types";

const SNAPSHOT_FILES = [
  "skin.png",
  "segmentation.json",
  "operation.json",
] as const;

type SnapshotFileName = (typeof SNAPSHOT_FILES)[number];

export interface SnapshotInput {
  readonly projectId: string;
  readonly revisionId: string;
  readonly skinPng: Uint8Array;
  readonly segmentationJson: string;
  readonly operationJson: string;
}

export interface SnapshotFile {
  readonly name: SnapshotFileName;
  readonly storagePath: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

export interface VerifiedSnapshot {
  readonly directory: string;
  readonly files: Readonly<Record<SnapshotFileName, SnapshotFile>>;
  readonly checksum: SnapshotChecksum;
}

export class SnapshotStorage {
  readonly dataDirectory: string;

  constructor(dataDirectory: string) {
    this.dataDirectory = resolve(dataDirectory);
  }

  snapshotDirectory(projectId: string, revisionId: string): string {
    assertSafeId("project", projectId);
    assertSafeId("revision", revisionId);
    return resolveWithin(
      this.dataDirectory,
      "projects",
      projectId,
      "revisions",
      revisionId,
    );
  }

  async writeSnapshot(input: SnapshotInput): Promise<VerifiedSnapshot> {
    const finalDirectory = this.snapshotDirectory(input.projectId, input.revisionId);
    const revisionsDirectory = resolveWithin(
      this.dataDirectory,
      "projects",
      input.projectId,
      "revisions",
    );
    await mkdir(revisionsDirectory, { recursive: true });

    const temporaryDirectory = resolveWithin(
      revisionsDirectory,
      `.${input.revisionId}.${randomUUID()}.tmp`,
    );
    await mkdir(temporaryDirectory, { recursive: false });
    let finalized = false;

    try {
      const fileInputs: Readonly<Record<SnapshotFileName, Uint8Array>> = {
        "skin.png": input.skinPng,
        "segmentation.json": Buffer.from(input.segmentationJson, "utf8"),
        "operation.json": Buffer.from(input.operationJson, "utf8"),
      };
      const fileHashes = {} as Record<SnapshotFileName, string>;

      for (const fileName of SNAPSHOT_FILES) {
        const bytes = fileInputs[fileName];
        await writeDurableFile(
          resolveWithin(temporaryDirectory, fileName),
          bytes,
        );
        fileHashes[fileName] = sha256(bytes);
      }

      const checksum: SnapshotChecksum = {
        schemaVersion: "1.0",
        revisionId: input.revisionId,
        files: fileHashes,
      };
      await writeDurableFile(
        resolveWithin(temporaryDirectory, "checksum.json"),
        Buffer.from(canonicalJson(checksum), "utf8"),
      );
      await rename(temporaryDirectory, finalDirectory);
      finalized = true;
      return await this.verifySnapshot(input.projectId, input.revisionId);
    } catch (error) {
      await rm(temporaryDirectory, { recursive: true, force: true });
      if (finalized) {
        await rm(finalDirectory, { recursive: true, force: true });
      }
      throw error;
    }
  }

  async verifySnapshot(
    projectId: string,
    revisionId: string,
  ): Promise<VerifiedSnapshot> {
    const directory = this.snapshotDirectory(projectId, revisionId);

    try {
      const checksumBytes = await readFile(resolveWithin(directory, "checksum.json"));
      const checksum = parseChecksum(checksumBytes, revisionId);
      const files = {} as Record<SnapshotFileName, SnapshotFile>;

      for (const fileName of SNAPSHOT_FILES) {
        const bytes = new Uint8Array(
          await readFile(resolveWithin(directory, fileName)),
        );
        const actualHash = sha256(bytes);
        if (actualHash !== checksum.files[fileName]) {
          throw snapshotCorrupt(
            revisionId,
            `${fileName} 哈希不匹配`,
          );
        }

        files[fileName] = {
          name: fileName,
          storagePath: storagePath(projectId, revisionId, fileName),
          bytes,
          sha256: actualHash,
        };
      }

      return { directory, files, checksum };
    } catch (error) {
      if (error instanceof RevisionStoreError) {
        throw error;
      }
      throw snapshotCorrupt(revisionId, "文件缺失或 checksum.json 无效", {
        cause: error,
      });
    }
  }

  async removeNewSnapshot(projectId: string, revisionId: string): Promise<void> {
    await rm(this.snapshotDirectory(projectId, revisionId), {
      recursive: true,
      force: true,
    });
  }
}

function parseChecksum(bytes: Uint8Array, revisionId: string): SnapshotChecksum {
  const parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as Partial<SnapshotChecksum>;
  if (
    parsed.schemaVersion !== "1.0" ||
    parsed.revisionId !== revisionId ||
    parsed.files === undefined ||
    parsed.files === null ||
    typeof parsed.files !== "object"
  ) {
    throw snapshotCorrupt(revisionId, "checksum.json 结构无效");
  }

  const fileNames = Object.keys(parsed.files).sort();
  if (fileNames.join("\0") !== [...SNAPSHOT_FILES].sort().join("\0")) {
    throw snapshotCorrupt(revisionId, "checksum.json 文件清单不完整");
  }

  for (const fileName of SNAPSHOT_FILES) {
    const hash = parsed.files[fileName];
    if (typeof hash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(hash)) {
      throw snapshotCorrupt(revisionId, `${fileName} checksum 无效`);
    }
  }

  return parsed as SnapshotChecksum;
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

function storagePath(
  projectId: string,
  revisionId: string,
  fileName: SnapshotFileName,
): string {
  return `projects/${projectId}/revisions/${revisionId}/${fileName}`;
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
