import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  RevisionStore,
  RevisionStoreError,
  type RevisionIdKind,
} from "../src";

const REAL_SKIN_PATH = fileURLToPath(
  new URL(
    "../../../tests/fixtures/skins/ab87de696cfca859.png",
    import.meta.url,
  ),
);

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("RevisionStore", () => {
  it("creates an empty Slim project and imports its first revision exactly once", async () => {
    const { store } = await createStore();

    try {
      const created = await store.createProject({ name: "Two-stage import" });
      expect(created.project).toMatchObject({
        headRevisionId: null,
        settings: { armType: "slim", coordinateOrigin: "top-left" },
      });
      expect(created.branch).toMatchObject({
        name: "main",
        headRevisionId: null,
      });
      expect(store.listRevisions(created.project.id)).toEqual([]);

      const imported = await store.importIntoProject(created.project.id, {
        fileName: "ab87de696cfca859.png",
        skinPng: await readFile(REAL_SKIN_PATH),
      });
      expect(imported.project.headRevisionId).toBe(imported.revision.id);
      expect(imported.branch.headRevisionId).toBe(imported.revision.id);
      expect(imported.revision).toMatchObject({
        parentRevisionId: null,
        sequence: 1,
        operationType: "import",
      });

      await expect(
        store.importIntoProject(created.project.id, {
          skinPng: await readFile(REAL_SKIN_PATH),
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(store.listRevisions(created.project.id)).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("imports a real Slim skin into a complete immutable snapshot", async () => {
    const { directory, store } = await createStore();

    try {
      const skinPng = await readFile(REAL_SKIN_PATH);
      const result = await store.importProject({
        name: "Real skin",
        fileName: "ab87de696cfca859.png",
        skinPng,
      });

      expect(result.armType).toBe("slim");
      expect(result.warnings).toEqual([]);
      expect(result.project.defaultBranchId).toBe(result.branch.id);
      expect(result.project.headRevisionId).toBe(result.revision.id);
      expect(result.branch.name).toBe("main");
      expect(result.branch.baseRevisionId).toBeNull();
      expect(result.branch.headRevisionId).toBe(result.revision.id);
      expect(result.revision).toMatchObject({
        parentRevisionId: null,
        sequence: 1,
        operationType: "import",
        isBranchHead: true,
      });

      const revisionDirectory = join(
        directory,
        "projects",
        result.project.id,
        "revisions",
        result.revision.id,
      );
      expect((await readdir(revisionDirectory)).sort()).toEqual([
        "checksum.json",
        "operation.json",
        "segmentation.json",
        "skin.png",
      ]);

      const snapshot = await store.verifyRevisionSnapshot(result.revision.id);
      expect(snapshot.checksum.revisionId).toBe(result.revision.id);
      expect(Object.keys(snapshot.checksum.files).sort()).toEqual([
        "operation.json",
        "segmentation.json",
        "skin.png",
      ]);
      expect(store.getRevisionAssets(result.revision.id)).toHaveLength(3);

      const segmentation = await store.readRevisionSegmentation(
        result.revision.id,
      );
      expect(segmentation).toMatchObject({
        schemaVersion: "1.0",
        revisionId: result.revision.id,
        source: {
          width: 64,
          height: 64,
          armType: "slim",
        },
        components: [],
      });
      const operation = await store.readRevisionOperation(result.revision.id);
      expect(operation).toMatchObject({
        schemaVersion: "1.0",
        type: "import",
        inputRevisionId: null,
        outputRevisionId: result.revision.id,
        beforeHash: null,
        afterHash: result.revision.resultHash,
      });
      expect(await store.readRevisionSkinPng(result.revision.id)).toEqual(
        snapshot.files["skin.png"].bytes,
      );
    } finally {
      store.close();
    }
  });

  it("persists a manual arm-model override in the revision snapshot", async () => {
    const { store } = await createStore();

    try {
      const result = await store.importProject({
        name: "Wide override",
        fileName: "ab87de696cfca859.png",
        skinPng: await readFile(REAL_SKIN_PATH),
        armType: "wide",
      });

      expect(result.armType).toBe("wide");
      expect(result.warnings).toEqual([
        "手动模型 wide 覆盖自动识别 slim",
      ]);
      expect(await store.readRevisionSegmentation(result.revision.id)).toMatchObject(
        { source: { armType: "wide" } },
      );
    } finally {
      store.close();
    }
  });

  it("creates new revert and branch nodes without mutating historical snapshots", async () => {
    const { directory, store } = await createStore();

    try {
      const imported = await importRealSkin(store);
      const originalDirectory = join(
        directory,
        "projects",
        imported.project.id,
        "revisions",
        imported.revision.id,
      );
      const originalFiles = await readSnapshotFiles(originalDirectory);

      const firstRevert = await store.revertRevision(imported.revision.id);
      const secondRevert = await store.revertRevision(imported.revision.id);
      const branchResult = await store.branchFromRevision(imported.revision.id, {
        name: "historical-mix",
      });

      expect(firstRevert.revision).toMatchObject({
        parentRevisionId: imported.revision.id,
        sequence: 2,
        operationType: "revert",
      });
      expect(secondRevert.revision).toMatchObject({
        parentRevisionId: firstRevert.revision.id,
        sequence: 3,
        operationType: "revert",
      });
      expect(branchResult.branch).toMatchObject({
        name: "historical-mix",
        baseRevisionId: imported.revision.id,
        headRevisionId: branchResult.revision.id,
      });
      expect(branchResult.revision).toMatchObject({
        parentRevisionId: imported.revision.id,
        sequence: 1,
        operationType: "branch",
        isBranchHead: true,
      });

      const mainBranch = store.getBranch(imported.branch.id);
      expect(mainBranch.headRevisionId).toBe(secondRevert.revision.id);
      expect(store.getProject(imported.project.id).headRevisionId).toBe(
        secondRevert.revision.id,
      );
      expect(store.listRevisions(imported.project.id)).toHaveLength(4);

      for (const revision of store.listRevisions(imported.project.id)) {
        await expect(store.readRevisionSkinPng(revision.id)).resolves.toBeInstanceOf(
          Uint8Array,
        );
      }
      expect(
        await store.diffRevisions(
          imported.revision.id,
          branchResult.revision.id,
        ),
      ).toMatchObject({
        changedPixelCount: 0,
        changedPixelIds: [],
        boundingBox: null,
      });
      expect(await readSnapshotFiles(originalDirectory)).toEqual(originalFiles);
    } finally {
      store.close();
    }
  });

  it("serializes concurrent writes into a stable parent chain", async () => {
    const { store } = await createStore();

    try {
      const imported = await importRealSkin(store);
      const [first, second] = await Promise.all([
        store.revertRevision(imported.revision.id),
        store.revertRevision(imported.revision.id),
      ]);

      expect(first.revision.sequence).toBe(2);
      expect(first.revision.parentRevisionId).toBe(imported.revision.id);
      expect(second.revision.sequence).toBe(3);
      expect(second.revision.parentRevisionId).toBe(first.revision.id);
      expect(store.getBranch(imported.branch.id).headRevisionId).toBe(
        second.revision.id,
      );
    } finally {
      store.close();
    }
  });

  it("loads every revision after reopening the SQLite database", async () => {
    const created = await createStore();
    const imported = await importRealSkin(created.store);
    const reverted = await created.store.revertRevision(imported.revision.id);
    const branched = await created.store.branchFromRevision(imported.revision.id, {
      name: "reopen-check",
    });
    created.store.close();

    const reopened = new RevisionStore({ dataDirectory: created.directory });
    try {
      expect(reopened.listProjects()).toHaveLength(1);
      expect(reopened.listBranches(imported.project.id)).toHaveLength(2);
      for (const revisionId of [
        imported.revision.id,
        reverted.revision.id,
        branched.revision.id,
      ]) {
        expect(reopened.getRevision(revisionId).id).toBe(revisionId);
        await expect(reopened.verifyRevisionSnapshot(revisionId)).resolves.toMatchObject(
          { checksum: { revisionId } },
        );
      }
    } finally {
      reopened.close();
    }
  });

  it("rejects duplicate branch names without creating another revision", async () => {
    const { store } = await createStore();

    try {
      const imported = await importRealSkin(store);
      await store.branchFromRevision(imported.revision.id, { name: "variant" });
      const revisionsBefore = store.listRevisions(imported.project.id);

      await expect(
        store.branchFromRevision(imported.revision.id, { name: "variant" }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(store.listRevisions(imported.project.id)).toEqual(revisionsBefore);
    } finally {
      store.close();
    }
  });

  it("refuses to load a revision whose checksum manifest was corrupted", async () => {
    const { directory, store } = await createStore();

    try {
      const imported = await importRealSkin(store);
      const checksumPath = join(
        directory,
        "projects",
        imported.project.id,
        "revisions",
        imported.revision.id,
        "checksum.json",
      );
      await writeFile(checksumPath, "{\"schemaVersion\":\"tampered\"}\n", "utf8");

      const error = await store
        .verifyRevisionSnapshot(imported.revision.id)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(RevisionStoreError);
      expect(error).toMatchObject({ code: "SNAPSHOT_CORRUPT", statusCode: 409 });
    } finally {
      store.close();
    }
  });
});

async function createStore(): Promise<{
  readonly directory: string;
  readonly store: RevisionStore;
}> {
  const directory = await mkdtemp(join(tmpdir(), "mcskinsplit-revision-"));
  temporaryDirectories.push(directory);
  let idCounter = 0;
  let timeCounter = 0;
  const store = new RevisionStore({
    dataDirectory: directory,
    createId: (kind: RevisionIdKind) =>
      `${kind}_${String(++idCounter).padStart(4, "0")}`,
    now: () => new Date(Date.UTC(2026, 7, 11, 0, 0, timeCounter++)),
  });
  return { directory, store };
}

async function importRealSkin(store: RevisionStore) {
  return store.importProject({
    name: "Actual Alex fixture",
    fileName: "ab87de696cfca859.png",
    skinPng: await readFile(REAL_SKIN_PATH),
  });
}

async function readSnapshotFiles(
  directory: string,
): Promise<Readonly<Record<string, Uint8Array>>> {
  const fileNames = await readdir(directory);
  return Object.fromEntries(
    await Promise.all(
      fileNames.map(async (fileName) => [
        fileName,
        Uint8Array.from(await readFile(join(directory, fileName))),
      ]),
    ),
  );
}
