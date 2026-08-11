import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import type { AiRunFileRole } from "./types";

export interface StoredAiRunFile {
  readonly fileRole: AiRunFileRole;
  readonly storagePath: string;
  readonly absolutePath: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly sha256: string;
}

export class AiRunStorage {
  readonly dataDirectory: string;

  constructor(dataDirectory: string) {
    this.dataDirectory = resolve(dataDirectory);
  }

  workspaceDirectory(runId: string): string {
    assertSafeId(runId);
    return resolveWithin(this.dataDirectory, "ai-runs", runId);
  }

  async createWorkspace(runId: string): Promise<string> {
    const directory = this.workspaceDirectory(runId);
    await mkdir(resolve(this.dataDirectory, "ai-runs"), { recursive: true });
    await mkdir(directory, { recursive: false });
    return directory;
  }

  async writeText(
    runId: string,
    relativePath: string,
    value: string,
  ): Promise<string> {
    const path = this.runPath(runId, relativePath);
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, value, { encoding: "utf8" });
    return path;
  }

  async writeJson(
    runId: string,
    relativePath: string,
    value: unknown,
  ): Promise<string> {
    return await this.writeText(runId, relativePath, canonicalJson(value));
  }

  async inspectFile(
    runId: string,
    fileRole: AiRunFileRole,
    relativePath: string,
    mimeType: string,
  ): Promise<StoredAiRunFile> {
    const absolutePath = this.runPath(runId, relativePath);
    const bytes = new Uint8Array(await readFile(absolutePath));
    return {
      fileRole,
      storagePath: relative(this.dataDirectory, absolutePath).split(sep).join("/"),
      absolutePath,
      mimeType,
      byteSize: bytes.byteLength,
      sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    };
  }

  runPath(runId: string, relativePath: string): string {
    return resolveWithin(
      this.workspaceDirectory(runId),
      ...relativePath.split("/").filter(Boolean),
    );
  }
}

function assertSafeId(value: string): void {
  if (!/^[a-z][a-z0-9_-]{2,100}$/.test(value)) {
    throw new TypeError(`Unsafe AI run id: ${value}`);
  }
}

function resolveWithin(root: string, ...segments: string[]): string {
  const candidate = resolve(root, ...segments);
  const relation = relative(root, candidate);
  if (relation === ".." || relation.startsWith(`..${sep}`)) {
    throw new TypeError(`AI run path escapes storage root: ${candidate}`);
  }
  return candidate;
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }
  return value;
}
