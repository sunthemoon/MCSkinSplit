import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { canonicalJson, sha256 } from "./hash";
import { RevisionStoreError, snapshotCorrupt } from "./errors";
import type { SnapshotChecksum } from "./types";

const LEGACY_CORE_SNAPSHOT_FILES = [
  "skin.png",
  "segmentation.json",
  "operation.json",
] as const;

const ORIGIN_CORE_SNAPSHOT_FILES = [
  "skin.png",
  "segmentation.json",
  "origin.json",
  "operation.json",
] as const;

type LegacyCoreSnapshotFileName = (typeof LEGACY_CORE_SNAPSHOT_FILES)[number];
type OriginCoreSnapshotFileName = (typeof ORIGIN_CORE_SNAPSHOT_FILES)[number];

export interface SnapshotInput {
  readonly projectId: string;
  readonly revisionId: string;
  readonly skinPng: Uint8Array;
  readonly segmentationJson: string;
  readonly originJson: string;
  readonly operationJson: string;
  readonly additionalFiles?: Readonly<Record<string, Uint8Array>>;
}

export interface SnapshotFile {
  readonly name: string;
  readonly storagePath: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

export type SnapshotFiles = Readonly<Record<string, SnapshotFile>> &
  Readonly<Record<LegacyCoreSnapshotFileName, SnapshotFile>> &
  Readonly<Partial<Record<"origin.json", SnapshotFile>>>;

export interface VerifiedSnapshot {
  readonly directory: string;
  readonly files: SnapshotFiles;
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
      const fileInputs: Record<string, Uint8Array> = {
        "skin.png": input.skinPng,
        "segmentation.json": Buffer.from(input.segmentationJson, "utf8"),
        "origin.json": Buffer.from(input.originJson, "utf8"),
        "operation.json": Buffer.from(input.operationJson, "utf8"),
      };
      for (const [fileName, bytes] of Object.entries(input.additionalFiles ?? {})) {
        assertAdditionalSnapshotFile(fileName);
        if (fileName in fileInputs) {
          throw new TypeError(`Duplicate snapshot file: ${fileName}`);
        }
        fileInputs[fileName] = bytes;
      }
      const fileNames = [
        ...ORIGIN_CORE_SNAPSHOT_FILES,
        ...Object.keys(input.additionalFiles ?? {}).sort(),
      ];
      const fileHashes: Record<string, string> = {};

      for (const fileName of fileNames) {
        const bytes = fileInputs[fileName]!;
        const path = resolveWithin(temporaryDirectory, fileName);
        await mkdir(dirname(path), { recursive: true });
        await writeDurableFile(
          path,
          bytes,
        );
        fileHashes[fileName] = sha256(bytes);
      }

      const checksum: SnapshotChecksum = {
        schemaVersion: "2.0",
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
      const files: Record<string, SnapshotFile> = {};

      for (const fileName of Object.keys(checksum.files).sort()) {
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

      return { directory, files: files as SnapshotFiles, checksum };
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
    (parsed.schemaVersion !== "1.0" && parsed.schemaVersion !== "2.0") ||
    parsed.revisionId !== revisionId ||
    parsed.files === undefined ||
    parsed.files === null ||
    typeof parsed.files !== "object"
  ) {
    throw snapshotCorrupt(revisionId, "checksum.json 结构无效");
  }

  const fileNames = Object.keys(parsed.files).sort();
  const coreFiles = parsed.schemaVersion === "2.0"
    ? ORIGIN_CORE_SNAPSHOT_FILES
    : LEGACY_CORE_SNAPSHOT_FILES;
  for (const coreFile of coreFiles) {
    if (!fileNames.includes(coreFile)) {
      throw snapshotCorrupt(revisionId, `checksum.json 缺少 ${coreFile}`);
    }
  }
  if (parsed.schemaVersion === "1.0" && fileNames.includes("origin.json")) {
    throw snapshotCorrupt(revisionId, "checksum.json 1.0 不能声明 origin.json");
  }

  for (const fileName of fileNames) {
    if (!ORIGIN_CORE_SNAPSHOT_FILES.includes(fileName as OriginCoreSnapshotFileName)) {
      try {
        assertAdditionalSnapshotFile(fileName);
      } catch (error) {
        throw snapshotCorrupt(revisionId, `checksum.json 包含非法文件 ${fileName}`, {
          cause: error,
        });
      }
    }
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
  fileName: string,
): string {
  return `projects/${projectId}/revisions/${revisionId}/${fileName}`;
}

function assertAdditionalSnapshotFile(fileName: string): void {
  if (!/^components\/[a-z][a-z0-9._-]{0,100}\.mask\.png$/.test(fileName)) {
    throw new TypeError(`Unsupported snapshot file: ${fileName}`);
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
