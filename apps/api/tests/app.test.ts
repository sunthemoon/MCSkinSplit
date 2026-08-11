import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeSkinPng } from "@mc-skin-split/skin-core";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApi } from "../src/app";

const REAL_SKIN_PATH = fileURLToPath(
  new URL(
    "../../../tests/fixtures/skins/ab87de696cfca859.png",
    import.meta.url,
  ),
);

const resources: Array<{
  readonly app: FastifyInstance;
  readonly directory: string;
}> = [];

afterEach(async () => {
  const createdResources = resources.splice(0);
  await Promise.all(createdResources.map(({ app }) => app.close()));
  await Promise.all(
    createdResources.map(({ directory }) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("revision API", () => {
  it("creates an empty project with a Slim default", async () => {
    const { app } = await createApi();
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "API project" },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      project: {
        name: "API project",
        headRevisionId: null,
        settings: { armType: "slim", coordinateOrigin: "top-left" },
      },
      branch: { name: "main", headRevisionId: null },
    });

    const listed = await app.inject({ method: "GET", url: "/api/projects" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ projects: unknown[] }>().projects).toHaveLength(1);

    const invalid = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "", extra: true },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({
      error: { code: "INVALID_REQUEST" },
    });
  });

  it("imports, reads, reverts, branches, and diffs a real skin", async () => {
    const { app } = await createApi();
    const project = await createProject(app, "History API");
    const sourceSkin = await readFile(REAL_SKIN_PATH);
    const imported = await app.inject({
      method: "POST",
      url: `/api/projects/${project.projectId}/import?fileName=actual.png`,
      headers: { "content-type": "image/png" },
      payload: sourceSkin,
    });

    expect(imported.statusCode).toBe(201);
    const importResult = imported.json<ImportResponse>();
    expect(importResult).toMatchObject({
      projectId: project.projectId,
      branchId: project.branchId,
      armType: "slim",
      warnings: [],
    });

    const revisionDetail = await app.inject({
      method: "GET",
      url: `/api/revisions/${importResult.revisionId}`,
    });
    expect(revisionDetail.statusCode).toBe(200);
    expect(revisionDetail.json()).toMatchObject({
      revision: {
        id: importResult.revisionId,
        sequence: 1,
        operationType: "import",
      },
      assets: [{}, {}, {}],
    });

    const skin = await app.inject({
      method: "GET",
      url: `/api/revisions/${importResult.revisionId}/skin.png`,
    });
    expect(skin.statusCode).toBe(200);
    expect(skin.headers["content-type"]).toContain("image/png");
    expect(skin.headers["cache-control"]).toContain("immutable");
    expect(decodeSkinPng(skin.rawPayload)).toEqual(decodeSkinPng(sourceSkin));

    const segmentation = await app.inject({
      method: "GET",
      url: `/api/revisions/${importResult.revisionId}/segmentation`,
    });
    expect(segmentation.statusCode).toBe(200);
    expect(segmentation.json()).toMatchObject({
      segmentation: {
        revisionId: importResult.revisionId,
        source: { armType: "slim", width: 64, height: 64 },
      },
    });

    const branch = await app.inject({
      method: "POST",
      url: `/api/revisions/${importResult.revisionId}/branch`,
      payload: { name: "api-experiment" },
    });
    expect(branch.statusCode).toBe(201);
    const branchResult = branch.json<MutationResponse>();
    expect(branchResult.revision).toMatchObject({
      parentRevisionId: importResult.revisionId,
      operationType: "branch",
      sequence: 1,
    });

    const projectAfterBranch = await app.inject({
      method: "GET",
      url: `/api/projects/${project.projectId}`,
    });
    expect(projectAfterBranch.json()).toMatchObject({
      project: { headRevisionId: importResult.revisionId },
    });

    const reverted = await app.inject({
      method: "POST",
      url: `/api/revisions/${importResult.revisionId}/revert`,
      payload: {},
    });
    expect(reverted.statusCode).toBe(201);
    const revertResult = reverted.json<MutationResponse>();
    expect(revertResult.revision).toMatchObject({
      parentRevisionId: importResult.revisionId,
      operationType: "revert",
      sequence: 2,
    });

    const revisions = await app.inject({
      method: "GET",
      url: `/api/projects/${project.projectId}/revisions`,
    });
    expect(revisions.statusCode).toBe(200);
    expect(revisions.json<{ revisions: unknown[] }>().revisions).toHaveLength(3);

    const branches = await app.inject({
      method: "GET",
      url: `/api/projects/${project.projectId}/branches`,
    });
    expect(branches.statusCode).toBe(200);
    expect(branches.json<{ branches: unknown[] }>().branches).toHaveLength(2);

    const diff = await app.inject({
      method: "GET",
      url: `/api/revisions/${importResult.revisionId}/diff/${branchResult.revision.id}`,
    });
    expect(diff.statusCode).toBe(200);
    expect(diff.json()).toMatchObject({
      diff: { changedPixelCount: 0, changedPixelIds: [], boundingBox: null },
    });
  });

  it("exposes the project-scoped branch endpoint", async () => {
    const { app } = await createApi();
    const project = await createProject(app, "Project branch endpoint");
    const imported = await importSkin(app, project.projectId);

    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${project.projectId}/branches`,
      payload: {
        revisionId: imported.revisionId,
        name: "project-route-branch",
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      branch: {
        name: "project-route-branch",
        baseRevisionId: imported.revisionId,
      },
    });
  });

  it("returns stable client errors for bad PNG data and duplicate imports", async () => {
    const { app } = await createApi();
    const project = await createProject(app, "Error handling");

    const invalidPng = await app.inject({
      method: "POST",
      url: `/api/projects/${project.projectId}/import`,
      headers: { "content-type": "image/png" },
      payload: Buffer.from("not a png"),
    });
    expect(invalidPng.statusCode).toBe(400);
    expect(invalidPng.json()).toMatchObject({ error: { code: "INVALID_PNG" } });

    await importSkin(app, project.projectId);
    const duplicate = await app.inject({
      method: "POST",
      url: `/api/projects/${project.projectId}/import`,
      headers: { "content-type": "image/png" },
      payload: await readFile(REAL_SKIN_PATH),
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ error: { code: "CONFLICT" } });
  });

  it("rejects API reads after checksum corruption", async () => {
    const { app, directory } = await createApi();
    const project = await createProject(app, "Corrupt API snapshot");
    const imported = await importSkin(app, project.projectId);
    await writeFile(
      join(
        directory,
        "projects",
        project.projectId,
        "revisions",
        imported.revisionId,
        "checksum.json",
      ),
      "{}\n",
      "utf8",
    );

    const response = await app.inject({
      method: "GET",
      url: `/api/revisions/${imported.revisionId}/skin.png`,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: { code: "SNAPSHOT_CORRUPT" },
    });
  });
});

interface CreatedProject {
  readonly projectId: string;
  readonly branchId: string;
}

interface ImportResponse {
  readonly projectId: string;
  readonly branchId: string;
  readonly revisionId: string;
  readonly armType: "wide" | "slim";
  readonly warnings: readonly string[];
}

interface MutationResponse {
  readonly revision: {
    readonly id: string;
    readonly parentRevisionId: string | null;
    readonly operationType: string;
    readonly sequence: number;
  };
}

async function createApi() {
  const directory = await mkdtemp(join(tmpdir(), "mcskinsplit-api-"));
  const app = buildApi({ dataDirectory: directory });
  resources.push({ app, directory });
  return { app, directory };
}

async function createProject(
  app: FastifyInstance,
  name: string,
): Promise<CreatedProject> {
  const response = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: { name },
  });
  expect(response.statusCode).toBe(201);
  const body = response.json<{
    project: { id: string };
    branch: { id: string };
  }>();
  return { projectId: body.project.id, branchId: body.branch.id };
}

async function importSkin(
  app: FastifyInstance,
  projectId: string,
): Promise<ImportResponse> {
  const response = await app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/import`,
    headers: { "content-type": "image/png" },
    payload: await readFile(REAL_SKIN_PATH),
  });
  expect(response.statusCode).toBe(201);
  return response.json<ImportResponse>();
}
