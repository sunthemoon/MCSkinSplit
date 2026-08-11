import { Buffer } from "node:buffer";
import { resolve } from "node:path";
import { SkinPngError, type ArmType } from "@mc-skin-split/skin-core";
import {
  RevisionStore,
  RevisionStoreError,
  type BranchFromRevisionInput,
  type RevertRevisionInput,
} from "@mc-skin-split/skin-revision";
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";

const MAX_SKIN_BYTES = 1024 * 1024;

interface ApiOptions {
  readonly dataDirectory?: string;
  readonly logger?: FastifyServerOptions["logger"];
  readonly revisionStore?: RevisionStore;
}

interface ProjectParams {
  readonly projectId: string;
}

interface RevisionParams {
  readonly revisionId: string;
}

interface DiffParams extends RevisionParams {
  readonly otherRevisionId: string;
}

interface CreateProjectBody {
  readonly name: string;
}

interface ImportQuery {
  readonly fileName?: string;
  readonly armType?: ArmType;
}

interface RevisionsQuery {
  readonly branchId?: string;
}

interface BranchBody extends BranchFromRevisionInput {
  readonly revisionId?: string;
}

export function buildApi(options: ApiOptions = {}): FastifyInstance {
  const app = Fastify({
    bodyLimit: MAX_SKIN_BYTES,
    logger: options.logger ?? false,
  });
  const ownsStore = !options.revisionStore;
  const store =
    options.revisionStore ??
    new RevisionStore({
      dataDirectory: resolve(
        options.dataDirectory ?? resolve(process.cwd(), "data"),
      ),
    });

  app.addContentTypeParser(
    "image/png",
    { bodyLimit: MAX_SKIN_BYTES, parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );

  app.addHook("onClose", async () => {
    if (ownsStore) {
      store.close();
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof RevisionStoreError) {
      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      });
    }
    if (error instanceof SkinPngError) {
      return reply.status(400).send({
        error: { code: error.code, message: error.message },
      });
    }
    if (isFastifyValidationError(error)) {
      return reply.status(400).send({
        error: {
          code: "INVALID_REQUEST",
          message: "请求参数不符合 API Schema",
          details: { validation: error.validation },
        },
      });
    }

    request.log.error(error);
    const statusCode = getErrorStatusCode(error);
    return reply.status(statusCode).send({
      error: {
        code: getErrorCode(error),
        message:
          statusCode < 500
            ? getErrorMessage(error)
            : "服务器无法完成请求",
      },
    });
  });

  app.get("/api/health", async () => ({ status: "ok" }));

  app.get("/api/projects", async () => ({ projects: store.listProjects() }));

  app.post<{ Body: CreateProjectBody }>(
    "/api/projects",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["name"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 120 },
          },
        },
      },
    },
    async (request, reply) => {
      const result = await store.createProject(request.body);
      return reply.status(201).send(result);
    },
  );

  app.get<{ Params: ProjectParams }>(
    "/api/projects/:projectId",
    async (request) => ({
      project: store.getProject(request.params.projectId),
    }),
  );

  app.post<{
    Params: ProjectParams;
    Querystring: ImportQuery;
    Body: Buffer;
  }>(
    "/api/projects/:projectId/import",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            fileName: { type: "string", minLength: 1, maxLength: 180 },
            armType: { type: "string", enum: ["wide", "slim"] },
          },
        },
      },
    },
    async (request, reply) => {
      if (!Buffer.isBuffer(request.body) || request.body.byteLength === 0) {
        return reply.status(400).send({
          error: {
            code: "INVALID_REQUEST",
            message: "请求体必须是非空 image/png",
          },
        });
      }
      const result = await store.importIntoProject(request.params.projectId, {
        skinPng: request.body,
        ...(request.query.fileName ? { fileName: request.query.fileName } : {}),
        ...(request.query.armType ? { armType: request.query.armType } : {}),
      });
      return reply.status(201).send({
        projectId: result.project.id,
        branchId: result.branch.id,
        revisionId: result.revision.id,
        armType: result.armType,
        warnings: result.warnings,
      });
    },
  );

  app.get<{ Params: ProjectParams }>(
    "/api/projects/:projectId/branches",
    async (request) => ({
      branches: store.listBranches(request.params.projectId),
    }),
  );

  app.post<{ Params: ProjectParams; Body: BranchBody }>(
    "/api/projects/:projectId/branches",
    { schema: { body: branchSchema(true) } },
    async (request, reply) => {
      const target = store.getRevision(request.body.revisionId ?? "");
      if (target.projectId !== request.params.projectId) {
        return reply.status(400).send({
          error: {
            code: "INVALID_REQUEST",
            message: "revisionId 不属于 URL 中的 Project",
          },
        });
      }
      const result = await store.branchFromRevision(target.id, request.body);
      return reply.status(201).send(result);
    },
  );

  app.get<{ Params: ProjectParams; Querystring: RevisionsQuery }>(
    "/api/projects/:projectId/revisions",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { branchId: { type: "string", minLength: 1 } },
        },
      },
    },
    async (request) => ({
      revisions: store.listRevisions(
        request.params.projectId,
        request.query.branchId,
      ),
    }),
  );

  app.get<{ Params: RevisionParams }>(
    "/api/revisions/:revisionId",
    async (request) => ({
      revision: store.getRevision(request.params.revisionId),
      assets: store.getRevisionAssets(request.params.revisionId),
    }),
  );

  app.get<{ Params: RevisionParams }>(
    "/api/revisions/:revisionId/skin.png",
    async (request, reply) => {
      const revision = store.getRevision(request.params.revisionId);
      const skinPng = await store.readRevisionSkinPng(revision.id);
      return reply
        .type("image/png")
        .header("Cache-Control", "private, max-age=31536000, immutable")
        .header("ETag", `\"${revision.resultHash}\"`)
        .send(Buffer.from(skinPng));
    },
  );

  app.get<{ Params: RevisionParams }>(
    "/api/revisions/:revisionId/segmentation",
    async (request) => ({
      segmentation: await store.readRevisionSegmentation(
        request.params.revisionId,
      ),
    }),
  );

  app.get<{ Params: DiffParams }>(
    "/api/revisions/:revisionId/diff/:otherRevisionId",
    async (request) => ({
      diff: await store.diffRevisions(
        request.params.revisionId,
        request.params.otherRevisionId,
      ),
    }),
  );

  app.post<{ Params: RevisionParams; Body: RevertRevisionInput }>(
    "/api/revisions/:revisionId/revert",
    { schema: { body: revertSchema } },
    async (request, reply) => {
      const result = await store.revertRevision(
        request.params.revisionId,
        request.body,
      );
      return reply.status(201).send(result);
    },
  );

  app.post<{ Params: RevisionParams; Body: BranchBody }>(
    "/api/revisions/:revisionId/branch",
    { schema: { body: branchSchema(false) } },
    async (request, reply) => {
      const result = await store.branchFromRevision(
        request.params.revisionId,
        request.body,
      );
      return reply.status(201).send(result);
    },
  );

  return app;
}

const revertSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    branchId: { type: "string", minLength: 1 },
    actorId: { type: "string", minLength: 1, maxLength: 120 },
    summary: { type: "string", minLength: 1, maxLength: 300 },
  },
} as const;

function branchSchema(requireRevisionId: boolean) {
  return {
    type: "object",
    additionalProperties: false,
    required: requireRevisionId ? ["revisionId", "name"] : ["name"],
    properties: {
      revisionId: { type: "string", minLength: 1 },
      name: { type: "string", minLength: 1, maxLength: 80 },
      actorId: { type: "string", minLength: 1, maxLength: 120 },
      summary: { type: "string", minLength: 1, maxLength: 300 },
    },
  } as const;
}

function isFastifyValidationError(
  error: unknown,
): error is FastifyError & { validation: readonly unknown[] } {
  return (
    typeof error === "object" &&
    error !== null &&
    "validation" in error &&
    Array.isArray(error.validation)
  );
}

function getErrorStatusCode(error: unknown): number {
  if (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    typeof error.statusCode === "number" &&
    error.statusCode >= 400 &&
    error.statusCode <= 599
  ) {
    return error.statusCode;
  }
  return 500;
}

function getErrorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return "INTERNAL_ERROR";
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "请求无法完成";
}
