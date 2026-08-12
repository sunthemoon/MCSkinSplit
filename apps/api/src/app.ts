import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  CODEX_CONFIG_DEFAULT_MODEL,
  CodexExecProvider,
  type SkinSemanticAiProvider,
} from "@mc-skin-split/ai-provider";
import {
  ANALYSIS_REASONING_EFFORTS,
  AiJobManager,
  AiJobStoreError,
  type AiAnalysisOptions,
  type AnalysisReasoningEffort,
} from "@mc-skin-split/ai-worker";
import {
  AGGREGATE_KINDS,
  SEMANTIC_CATEGORIES,
  SkinPngError,
  type AggregateKind,
  type ArmType,
  type ManualSemanticOperation,
} from "@mc-skin-split/skin-core";
import {
  RevisionStore,
  RevisionStoreError,
  type BranchFromRevisionInput,
  type PartBundle,
  type RevertRevisionInput,
  type SerializedPartRepairOperation,
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
  readonly aiJobManager?: AiJobManager;
  readonly aiProviders?: readonly SkinSemanticAiProvider[];
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

interface ComponentParams extends RevisionParams {
  readonly componentId: string;
}

interface PartParams {
  readonly partId: string;
}

interface PartEditParams {
  readonly projectId: string;
}

interface PartEditRevisionParams {
  readonly revisionId: string;
}

interface PartBundleParams {
  readonly bundleId: string;
}

interface CompositionParams {
  readonly compositionId: string;
}

interface CompositionLayerParams extends CompositionParams {
  readonly layerId: string;
}

interface AiJobParams {
  readonly jobId: string;
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

type ManualOperationBody = ManualSemanticOperation & {
  readonly branchId?: string;
  readonly actorId?: string;
  readonly summary?: string;
};

interface ExportPartBody {
  readonly name?: string;
}

interface ExportPartBundleBody {
  readonly name?: string;
  readonly kind: AggregateKind;
  readonly componentIds: readonly string[];
  readonly sourceGroupKey?: string;
}

interface PartsQuery {
  readonly category?: string;
}

interface PartEditsQuery {
  readonly basePartId?: string;
}

interface CreatePartEditBody {
  readonly basePartId: string;
  readonly name?: string;
}

interface ApplyPartEditOperationBody {
  readonly headRevisionId: string;
  readonly operation: SerializedPartRepairOperation;
  readonly actorId?: string;
  readonly summary?: string;
}

interface CommitPartEditBody {
  readonly headRevisionId: string;
  readonly name?: string;
  readonly actorId?: string;
  readonly summary?: string;
}

interface PartBundlesQuery {
  readonly kind?: AggregateKind;
  readonly sourceRevisionId?: string;
}

interface AnalyzedSkinsQuery {
  readonly projectId?: string;
  readonly kind?: AggregateKind;
  readonly q?: string;
}

interface PartMannequinQuery {
  readonly armType?: ArmType;
}

interface ApplyPartBody {
  readonly partId: string;
  readonly strategy?: "use_part" | "keep_base";
  readonly branchId?: string;
  readonly actorId?: string;
  readonly summary?: string;
}

interface CompositionsQuery {
  readonly revisionId?: string;
}

interface CreateCompositionBody {
  readonly baseRevisionId: string;
  readonly branchId?: string;
  readonly name?: string;
}

interface AddCompositionPartBody {
  readonly partId: string;
  readonly position?: number;
}

interface AddCompositionBundleBody {
  readonly bundleId: string;
  readonly position?: number;
}

interface ReorderCompositionBody {
  readonly layerIds: readonly string[];
}

type ResolveCompositionBody =
  | { readonly strategy: "layer_order" }
  | {
      readonly strategy: "winner";
      readonly conflictId: string;
      readonly winnerLayerId: string;
    }
  | { readonly strategy: "clear" };

interface CommitCompositionBody {
  readonly actorId?: string;
  readonly summary?: string;
}

interface AiJobsQuery {
  readonly revisionId?: string;
}

interface StartAiAnalysisBody extends AiAnalysisOptions {}

interface RetryAiJobBody {
  readonly provider?: string;
  readonly model?: string;
  readonly reasoningEffort?: AnalysisReasoningEffort;
  readonly createRevisionOnSuccess?: boolean;
}

export function buildApi(options: ApiOptions = {}): FastifyInstance {
  const app = Fastify({
    bodyLimit: MAX_SKIN_BYTES,
    logger: options.logger ?? false,
    ajv: { customOptions: { removeAdditional: false } },
  });
  const ownsStore = !options.revisionStore;
  const store =
    options.revisionStore ??
    new RevisionStore({
      dataDirectory: resolve(
        options.dataDirectory ?? resolve(process.cwd(), "data"),
      ),
    });
  const ownsAiJobManager = !options.aiJobManager;
  const defaultAiReasoningEffort = readReasoningEffort(
    process.env.AI_REASONING_EFFORT,
    "medium",
  );
  const aiJobManager =
    options.aiJobManager ??
    new AiJobManager({
      revisionStore: store,
      providers:
        options.aiProviders ??
        [
          new CodexExecProvider({
            defaultModel:
              process.env.AI_MODEL?.trim() || CODEX_CONFIG_DEFAULT_MODEL,
            timeoutMs: readBoundedInteger(
              process.env.AI_TIMEOUT_SECONDS,
              600,
              10,
              1_800,
            ) * 1_000,
            ignoreUserConfig: readBoolean(
              process.env.AI_IGNORE_USER_CONFIG,
              false,
            ),
            allowSchemaFallback: readBoolean(
              process.env.AI_ALLOW_SCHEMA_FALLBACK,
              true,
            ),
          }),
        ],
      maxRepairAttempts: readBoundedInteger(
        process.env.AI_MAX_REPAIR_ATTEMPTS,
        1,
        0,
        3,
      ),
      ...(process.env.MC_SKIN_AI_SKILL_DIR?.trim()
        ? { skillDirectory: resolve(process.env.MC_SKIN_AI_SKILL_DIR) }
        : {}),
    });

  app.addContentTypeParser(
    "image/png",
    { bodyLimit: MAX_SKIN_BYTES, parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );

  app.addHook("onClose", async () => {
    if (ownsAiJobManager) {
      await aiJobManager.close();
    }
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
    if (error instanceof AiJobStoreError) {
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

  app.get("/api/ai/providers", async () => ({
    providers: aiJobManager.listProviders(),
    defaultModel:
      process.env.AI_MODEL?.trim() || CODEX_CONFIG_DEFAULT_MODEL,
    defaultReasoningEffort: defaultAiReasoningEffort,
  }));

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

  app.post<{ Params: RevisionParams; Body: ManualOperationBody }>(
    "/api/revisions/:revisionId/operations",
    { schema: { body: manualOperationSchema } },
    async (request, reply) => {
      const { branchId, actorId, summary, ...operation } = request.body;
      const result = await store.applyManualOperation(
        request.params.revisionId,
        {
          operation: operation as ManualSemanticOperation,
          ...(branchId ? { branchId } : {}),
          ...(actorId ? { actorId } : {}),
          ...(summary ? { summary } : {}),
        },
      );
      return reply.status(201).send(result);
    },
  );

  app.post<{ Params: ComponentParams; Body: ExportPartBody }>(
    "/api/revisions/:revisionId/components/:componentId/export-part",
    { schema: { body: exportPartSchema } },
    async (request, reply) => {
      const part = await store.exportPart(
        request.params.revisionId,
        request.params.componentId,
        request.body,
      );
      return reply.status(201).send({ part });
    },
  );

  app.post<{ Params: RevisionParams; Body: ExportPartBundleBody }>(
    "/api/revisions/:revisionId/export-bundle",
    { schema: { body: exportPartBundleSchema } },
    async (request, reply) => {
      const bundle = await store.exportPartBundle(
        request.params.revisionId,
        request.body,
      );
      return reply.status(201).send({ bundle });
    },
  );

  app.get<{ Querystring: AnalyzedSkinsQuery }>(
    "/api/analyzed-skins",
    { schema: { querystring: analyzedSkinsQuerySchema } },
    async (request) => ({
      analyzedSkins: await store.listAnalyzedSkins({
        ...(request.query.projectId
          ? { projectId: request.query.projectId }
          : {}),
        ...(request.query.kind ? { kind: request.query.kind } : {}),
        ...(request.query.q ? { query: request.query.q } : {}),
      }),
    }),
  );

  app.get<{ Params: RevisionParams }>(
    "/api/analyzed-skins/:revisionId",
    async (request) => ({
      analyzedSkin: await store.getAnalyzedSkin(request.params.revisionId),
    }),
  );

  app.get<{ Querystring: PartsQuery }>(
    "/api/parts",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            category: { type: "string", enum: SEMANTIC_CATEGORIES },
          },
        },
      },
    },
    async (request) => ({ parts: store.listParts(request.query.category) }),
  );

  app.get<{ Querystring: PartEditsQuery }>(
    "/api/part-edits",
    { schema: { querystring: partEditsQuerySchema } },
    async (request) => ({
      partEdits: store.listPartEditProjects(request.query.basePartId),
    }),
  );

  app.post<{ Body: CreatePartEditBody }>(
    "/api/part-edits",
    { schema: { body: createPartEditSchema } },
    async (request, reply) => {
      const partEdit = await store.createPartEditProject(request.body);
      return reply.status(201).send({ partEdit });
    },
  );

  app.get<{ Params: PartEditParams }>(
    "/api/part-edits/:projectId",
    async (request) => ({
      partEdit: store.getPartEditDetail(request.params.projectId),
    }),
  );

  app.post<{ Params: PartEditParams; Body: ApplyPartEditOperationBody }>(
    "/api/part-edits/:projectId/operations",
    { schema: { body: applyPartEditOperationSchema } },
    async (request, reply) => {
      const partEdit = await store.applyPartEditOperation(
        request.params.projectId,
        request.body,
      );
      return reply.status(201).send({ partEdit });
    },
  );

  app.post<{ Params: PartEditParams; Body: CommitPartEditBody }>(
    "/api/part-edits/:projectId/commit",
    { schema: { body: commitPartEditSchema } },
    async (request, reply) => {
      const result = await store.commitPartEditProject(
        request.params.projectId,
        request.body,
      );
      return reply.status(201).send({
        partEdit: store.getPartEditDetail(request.params.projectId),
        part: result.part,
      });
    },
  );

  app.get<{ Params: PartEditRevisionParams }>(
    "/api/part-edit-revisions/:revisionId/texture.png",
    async (request, reply) => {
      const revision = store.getPartEditRevision(request.params.revisionId);
      const bytes = await store.readPartEditTexturePng(revision.id);
      return reply
        .type("image/png")
        .header("Cache-Control", "private, max-age=31536000, immutable")
        .header("ETag", `\"${revision.texture.sha256}\"`)
        .send(Buffer.from(bytes));
    },
  );

  app.get<{ Params: PartEditRevisionParams }>(
    "/api/part-edit-revisions/:revisionId/write-mask.png",
    async (request, reply) => {
      const revision = store.getPartEditRevision(request.params.revisionId);
      const bytes = await store.readPartEditWriteMaskPng(revision.id);
      return reply
        .type("image/png")
        .header("Cache-Control", "private, max-age=31536000, immutable")
        .header("ETag", `\"${revision.writeMask.sha256}\"`)
        .send(Buffer.from(bytes));
    },
  );

  app.get<{
    Params: PartEditRevisionParams;
    Querystring: PartMannequinQuery;
  }>(
    "/api/part-edit-revisions/:revisionId/mannequin.png",
    { schema: { querystring: armTypeQuerySchema } },
    async (request, reply) => {
      const revision = store.getPartEditRevision(request.params.revisionId);
      const detail = store.getPartEditDetail(revision.projectId);
      const armType = request.query.armType ?? detail.basePart.armType;
      const bytes = await store.readPartEditMannequinPng(revision.id, armType);
      return reply
        .type("image/png")
        .header("Cache-Control", "private, max-age=31536000, immutable")
        .header("ETag", partEditMannequinEtag(revision.texture.sha256, armType))
        .send(Buffer.from(bytes));
    },
  );

  app.get<{ Querystring: PartBundlesQuery }>(
    "/api/part-bundles",
    { schema: { querystring: partBundlesQuerySchema } },
    async (request) => ({
      bundles: store.listPartBundles(
        request.query.kind,
        request.query.sourceRevisionId,
      ),
    }),
  );

  app.get<{ Params: PartBundleParams }>(
    "/api/part-bundles/:bundleId",
    async (request) => ({
      bundle: store.getPartBundle(request.params.bundleId),
    }),
  );

  app.get<{ Params: PartBundleParams }>(
    "/api/part-bundles/:bundleId/preview.png",
    async (request, reply) => {
      const bundle = store.getPartBundle(request.params.bundleId);
      const bytes = await store.readPartBundlePreviewPng(bundle.id);
      return reply
        .type("image/png")
        .header("Cache-Control", "private, max-age=31536000, immutable")
        .header("ETag", bundlePngEtag(bundle, "preview"))
        .send(Buffer.from(bytes));
    },
  );

  app.get<{ Params: PartBundleParams; Querystring: PartMannequinQuery }>(
    "/api/part-bundles/:bundleId/mannequin.png",
    { schema: { querystring: armTypeQuerySchema } },
    async (request, reply) => {
      const bundle = store.getPartBundle(request.params.bundleId);
      const armType =
        request.query.armType ??
        (bundle.armTypes.includes("slim") ? "slim" : "wide");
      const bytes = await store.readPartBundleMannequinPng(bundle.id, armType);
      return reply
        .type("image/png")
        .header("Cache-Control", "private, max-age=31536000, immutable")
        .header("ETag", bundlePngEtag(bundle, `mannequin-${armType}`))
        .send(Buffer.from(bytes));
    },
  );

  app.get<{ Params: PartParams }>("/api/parts/:partId", async (request) => ({
    part: store.getPart(request.params.partId),
  }));

  app.get<{ Params: PartParams }>(
    "/api/parts/:partId/texture.png",
    async (request, reply) => {
      const part = store.getPart(request.params.partId);
      const bytes = await store.readPartTexturePng(part.id);
      return reply
        .type("image/png")
        .header("Cache-Control", "private, max-age=31536000, immutable")
        .header("ETag", `\"${part.texture.sha256}\"`)
        .send(Buffer.from(bytes));
    },
  );

  app.get<{ Params: PartParams }>(
    "/api/parts/:partId/preview.png",
    async (request, reply) => {
      const part = store.getPart(request.params.partId);
      const bytes = await store.readPartPreviewPng(part.id);
      return reply
        .type("image/png")
        .header("Cache-Control", "private, max-age=31536000, immutable")
        .header("ETag", `\"${part.preview.sha256}\"`)
        .send(Buffer.from(bytes));
    },
  );

  app.get<{ Params: PartParams; Querystring: PartMannequinQuery }>(
    "/api/parts/:partId/mannequin.png",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            armType: { type: "string", enum: ["wide", "slim"] },
          },
        },
      },
    },
    async (request, reply) => {
      const part = store.getPart(request.params.partId);
      const armType =
        request.query.armType ??
        (part.manifest.compatibility.armTypes.includes("slim")
          ? "slim"
          : "wide");
      const bytes = await store.readPartMannequinPng(part.id, armType);
      return reply
        .type("image/png")
        .header("Cache-Control", "private, max-age=31536000, immutable")
        .header("ETag", `"${part.texture.sha256}-${armType}-mannequin-v1"`)
        .send(Buffer.from(bytes));
    },
  );

  app.post<{ Params: RevisionParams; Body: ApplyPartBody }>(
    "/api/revisions/:revisionId/apply-part",
    { schema: { body: applyPartSchema } },
    async (request, reply) => {
      if (!request.body.strategy) {
        const preview = await store.previewPartApplication(
          request.params.revisionId,
          request.body.partId,
        );
        return reply.send({ committed: false, ...preview });
      }
      const result = await store.applyPart(request.params.revisionId, {
        partId: request.body.partId,
        strategy: request.body.strategy,
        ...(request.body.branchId ? { branchId: request.body.branchId } : {}),
        ...(request.body.actorId ? { actorId: request.body.actorId } : {}),
        ...(request.body.summary ? { summary: request.body.summary } : {}),
      });
      return reply.status(201).send({ committed: true, ...result });
    },
  );

  app.get<{ Querystring: CompositionsQuery }>(
    "/api/compositions",
    { schema: { querystring: compositionsQuerySchema } },
    async (request) => ({
      compositions: store.listCompositions(request.query.revisionId),
    }),
  );

  app.post<{ Body: CreateCompositionBody }>(
    "/api/compositions",
    { schema: { body: createCompositionSchema } },
    async (request, reply) => {
      const detail = await store.createComposition(request.body);
      return reply.status(201).send(detail);
    },
  );

  app.get<{ Params: CompositionParams }>(
    "/api/compositions/:compositionId",
    async (request) =>
      await store.getCompositionDetail(request.params.compositionId),
  );

  app.get<{ Params: CompositionParams }>(
    "/api/compositions/:compositionId/preview.png",
    async (request, reply) => {
      const bytes = await store.readCompositionPreviewPng(
        request.params.compositionId,
      );
      return reply
        .type("image/png")
        .header("Cache-Control", "private, no-store")
        .send(Buffer.from(bytes));
    },
  );

  app.post<{ Params: CompositionParams; Body: AddCompositionPartBody }>(
    "/api/compositions/:compositionId/apply-part",
    { schema: { body: addCompositionPartSchema } },
    async (request, reply) => {
      const detail = await store.addCompositionPart(
        request.params.compositionId,
        request.body,
      );
      return reply.status(201).send(detail);
    },
  );

  app.post<{ Params: CompositionParams; Body: AddCompositionBundleBody }>(
    "/api/compositions/:compositionId/apply-bundle",
    { schema: { body: addCompositionBundleSchema } },
    async (request, reply) => {
      const detail = await store.addCompositionBundle(
        request.params.compositionId,
        request.body,
      );
      return reply.status(201).send(detail);
    },
  );

  app.post<{ Params: CompositionParams; Body: ReorderCompositionBody }>(
    "/api/compositions/:compositionId/reorder",
    { schema: { body: reorderCompositionSchema } },
    async (request) =>
      await store.reorderCompositionLayers(
        request.params.compositionId,
        request.body,
      ),
  );

  app.delete<{ Params: CompositionLayerParams }>(
    "/api/compositions/:compositionId/layers/:layerId",
    async (request) =>
      await store.removeCompositionLayer(
        request.params.compositionId,
        request.params.layerId,
      ),
  );

  app.post<{ Params: CompositionParams; Body: ResolveCompositionBody }>(
    "/api/compositions/:compositionId/resolve-conflict",
    { schema: { body: resolveCompositionSchema } },
    async (request) =>
      await store.resolveCompositionConflict(
        request.params.compositionId,
        request.body,
      ),
  );

  app.post<{ Params: CompositionParams; Body: CommitCompositionBody }>(
    "/api/compositions/:compositionId/commit",
    { schema: { body: commitCompositionSchema } },
    async (request, reply) => {
      const result = await store.commitComposition(
        request.params.compositionId,
        request.body,
      );
      return reply.status(201).send(result);
    },
  );

  app.post<{ Params: RevisionParams; Body: StartAiAnalysisBody }>(
    "/api/revisions/:revisionId/ai-analysis",
    { schema: { body: startAiAnalysisSchema } },
    async (request, reply) => {
      const job = aiJobManager.startAnalysis(
        request.params.revisionId,
        request.body,
      );
      return reply.status(202).send({ job });
    },
  );

  app.get<{ Querystring: AiJobsQuery }>(
    "/api/ai-jobs",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            revisionId: { type: "string", minLength: 1, maxLength: 120 },
          },
        },
      },
    },
    async (request) => ({
      jobs: aiJobManager.listJobs(request.query.revisionId),
    }),
  );

  app.get<{ Params: AiJobParams }>(
    "/api/ai-jobs/:jobId",
    async (request) => aiJobManager.getJobDetail(request.params.jobId),
  );

  app.get<{ Params: AiJobParams }>(
    "/api/ai-jobs/:jobId/events",
    async (request) => {
      const detail = aiJobManager.getJobDetail(request.params.jobId);
      return { jobId: detail.job.id, events: detail.events };
    },
  );

  app.post<{ Params: AiJobParams }>(
    "/api/ai-jobs/:jobId/cancel",
    async (request) => ({ job: aiJobManager.cancelJob(request.params.jobId) }),
  );

  app.post<{ Params: AiJobParams; Body: RetryAiJobBody }>(
    "/api/ai-jobs/:jobId/retry",
    { schema: { body: retryAiJobSchema } },
    async (request, reply) => {
      const job = aiJobManager.retryJob(request.params.jobId, request.body);
      return reply.status(202).send({ job });
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

const surfaceKeySchema = {
  type: "string",
  pattern:
    "^(head|torso|rightArm|leftArm|rightLeg|leftLeg)\\.(base|outer)\\.(front|back|left|right|top|bottom)$",
} as const;

const spanSchema = {
  type: "object",
  additionalProperties: false,
  required: ["surface", "y", "x0", "x1"],
  properties: {
    surface: surfaceKeySchema,
    y: { type: "integer", minimum: 0, maximum: 63 },
    x0: { type: "integer", minimum: 0, maximum: 63 },
    x1: { type: "integer", minimum: 0, maximum: 63 },
  },
} as const;

const componentInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["instanceId", "displayName", "category"],
  properties: {
    instanceId: {
      type: "string",
      minLength: 1,
      maxLength: 100,
      pattern: "^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$",
    },
    displayName: { type: "string", minLength: 1, maxLength: 80 },
    category: { type: "string", enum: SEMANTIC_CATEGORIES },
    subtype: { type: "string", minLength: 1, maxLength: 80 },
  },
} as const;

const operationMetadataProperties = {
  branchId: { type: "string", minLength: 1 },
  actorId: { type: "string", minLength: 1, maxLength: 120 },
  summary: { type: "string", minLength: 1, maxLength: 300 },
} as const;

const manualOperationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["type"],
  properties: {
    type: {
      type: "string",
      enum: [
        "assign_pixels",
        "unassign_pixels",
        "merge_components",
        "split_component",
        "reclassify_component",
      ],
    },
    target: componentInputSchema,
    spans: { type: "array", minItems: 1, items: spanSchema },
    componentIds: {
      type: "array",
      minItems: 2,
      uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 100 },
    },
    sourceComponentId: { type: "string", minLength: 1, maxLength: 100 },
    componentId: { type: "string", minLength: 1, maxLength: 100 },
    category: { type: "string", enum: SEMANTIC_CATEGORIES },
    subtype: { type: "string", minLength: 1, maxLength: 80 },
    ...operationMetadataProperties,
  },
  oneOf: [
    {
      required: ["type", "target", "spans"],
      properties: {
        type: { const: "assign_pixels" },
      },
    },
    {
      required: ["type", "spans"],
      properties: {
        type: { const: "unassign_pixels" },
      },
    },
    {
      required: ["type", "componentIds", "target"],
      properties: {
        type: { const: "merge_components" },
      },
    },
    {
      required: ["type", "sourceComponentId", "target", "spans"],
      properties: {
        type: { const: "split_component" },
      },
    },
    {
      required: ["type", "componentId", "category"],
      properties: {
        type: { const: "reclassify_component" },
      },
    },
  ],
} as const;

const exportPartSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 120 },
  },
} as const;

const aggregateKindSchema = {
  type: "string",
  enum: AGGREGATE_KINDS,
} as const;

const exportPartBundleSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "componentIds"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 120 },
    kind: aggregateKindSchema,
    componentIds: {
      type: "array",
      minItems: 1,
      maxItems: 256,
      uniqueItems: true,
      items: {
        type: "string",
        minLength: 1,
        maxLength: 100,
        pattern: "^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$",
      },
    },
    sourceGroupKey: {
      type: "string",
      minLength: 1,
      maxLength: 100,
    },
  },
} as const;

const analyzedSkinsQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    projectId: { type: "string", minLength: 1, maxLength: 100 },
    kind: aggregateKindSchema,
    q: { type: "string", minLength: 1, maxLength: 120 },
  },
} as const;

const partEditsQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    basePartId: { type: "string", minLength: 1, maxLength: 100 },
  },
} as const;

const createPartEditSchema = {
  type: "object",
  additionalProperties: false,
  required: ["basePartId"],
  properties: {
    basePartId: { type: "string", minLength: 1, maxLength: 100 },
    name: { type: "string", minLength: 1, maxLength: 120 },
  },
} as const;

const byteSchema = {
  type: "integer",
  minimum: 0,
  maximum: 255,
} as const;

const rgbaSchema = {
  type: "array",
  minItems: 4,
  maxItems: 4,
  items: byteSchema,
} as const;

const opaqueRgbaSchema = {
  type: "array",
  minItems: 4,
  maxItems: 4,
  items: [
    byteSchema,
    byteSchema,
    byteSchema,
    { type: "integer", minimum: 1, maximum: 255 },
  ],
} as const;

const repairSpansSchema = {
  type: "array",
  minItems: 1,
  maxItems: 4096,
  items: spanSchema,
} as const;

const paintColorOperationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["type", "spans", "rgba"],
  properties: {
    type: { const: "paint_color" },
    spans: repairSpansSchema,
    rgba: opaqueRgbaSchema,
  },
} as const;

const erasePixelsOperationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["type", "spans"],
  properties: {
    type: { const: "erase_pixels" },
    spans: repairSpansSchema,
  },
} as const;

const replaceColorOperationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["type", "from", "to"],
  properties: {
    type: { const: "replace_color" },
    from: rgbaSchema,
    to: opaqueRgbaSchema,
    spans: repairSpansSchema,
  },
} as const;

const partEditCopySourceSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "partId"],
      properties: {
        kind: { const: "part" },
        partId: { type: "string", minLength: 1, maxLength: 100 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "revisionId"],
      properties: {
        kind: { const: "edit_revision" },
        revisionId: { type: "string", minLength: 1, maxLength: 100 },
      },
    },
  ],
} as const;

const copySurfaceMappingSchema = {
  type: "object",
  additionalProperties: false,
  required: ["sourceSurface", "targetSurface"],
  properties: {
    sourceSurface: surfaceKeySchema,
    targetSurface: surfaceKeySchema,
    transform: {
      type: "string",
      enum: ["identity", "mirror_u", "mirror_v", "rotate_180"],
    },
  },
} as const;

const copySurfacesOperationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["type", "source", "mappings"],
  properties: {
    type: { const: "copy_surfaces" },
    source: partEditCopySourceSchema,
    mappings: {
      type: "array",
      minItems: 1,
      maxItems: 72,
      items: copySurfaceMappingSchema,
    },
    overwrite: { type: "string", enum: ["all", "transparent_only"] },
  },
} as const;

const applyPartEditOperationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["headRevisionId", "operation"],
  properties: {
    headRevisionId: { type: "string", minLength: 1, maxLength: 100 },
    operation: {
      oneOf: [
        paintColorOperationSchema,
        erasePixelsOperationSchema,
        replaceColorOperationSchema,
        copySurfacesOperationSchema,
      ],
    },
    actorId: { type: "string", minLength: 1, maxLength: 120 },
    summary: { type: "string", minLength: 1, maxLength: 300 },
  },
} as const;

const commitPartEditSchema = {
  type: "object",
  additionalProperties: false,
  required: ["headRevisionId"],
  properties: {
    headRevisionId: { type: "string", minLength: 1, maxLength: 100 },
    name: { type: "string", minLength: 1, maxLength: 120 },
    actorId: { type: "string", minLength: 1, maxLength: 120 },
    summary: { type: "string", minLength: 1, maxLength: 300 },
  },
} as const;

const partBundlesQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: aggregateKindSchema,
    sourceRevisionId: { type: "string", minLength: 1, maxLength: 100 },
  },
} as const;

const armTypeQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    armType: { type: "string", enum: ["wide", "slim"] },
  },
} as const;

const applyPartSchema = {
  type: "object",
  additionalProperties: false,
  required: ["partId"],
  properties: {
    partId: { type: "string", minLength: 1, maxLength: 100 },
    strategy: { type: "string", enum: ["use_part", "keep_base"] },
    branchId: { type: "string", minLength: 1 },
    actorId: { type: "string", minLength: 1, maxLength: 120 },
    summary: { type: "string", minLength: 1, maxLength: 300 },
  },
} as const;

const compositionsQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    revisionId: { type: "string", minLength: 1, maxLength: 100 },
  },
} as const;

const createCompositionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["baseRevisionId"],
  properties: {
    baseRevisionId: { type: "string", minLength: 1, maxLength: 100 },
    branchId: { type: "string", minLength: 1, maxLength: 100 },
    name: { type: "string", minLength: 1, maxLength: 120 },
  },
} as const;

const addCompositionPartSchema = {
  type: "object",
  additionalProperties: false,
  required: ["partId"],
  properties: {
    partId: { type: "string", minLength: 1, maxLength: 100 },
    position: { type: "integer", minimum: 0, maximum: 255 },
  },
} as const;

const addCompositionBundleSchema = {
  type: "object",
  additionalProperties: false,
  required: ["bundleId"],
  properties: {
    bundleId: { type: "string", minLength: 1, maxLength: 100 },
    position: { type: "integer", minimum: 0, maximum: 255 },
  },
} as const;

const reorderCompositionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["layerIds"],
  properties: {
    layerIds: {
      type: "array",
      maxItems: 256,
      uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 100 },
    },
  },
} as const;

const resolveCompositionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["strategy"],
  properties: {
    strategy: { type: "string", enum: ["layer_order", "winner", "clear"] },
    conflictId: { type: "string", minLength: 1, maxLength: 100 },
    winnerLayerId: { type: "string", minLength: 1, maxLength: 100 },
  },
  oneOf: [
    {
      properties: { strategy: { const: "layer_order" } },
      not: {
        anyOf: [
          { required: ["conflictId"] },
          { required: ["winnerLayerId"] },
        ],
      },
    },
    {
      required: ["strategy", "conflictId", "winnerLayerId"],
      properties: { strategy: { const: "winner" } },
    },
    {
      properties: { strategy: { const: "clear" } },
      not: {
        anyOf: [
          { required: ["conflictId"] },
          { required: ["winnerLayerId"] },
        ],
      },
    },
  ],
} as const;

const commitCompositionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    actorId: { type: "string", minLength: 1, maxLength: 120 },
    summary: { type: "string", minLength: 1, maxLength: 300 },
  },
} as const;

const startAiAnalysisSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "mode",
    "provider",
    "model",
    "reasoningEffort",
    "taxonomyLevel",
    "focus",
    "createRevisionOnSuccess",
  ],
  properties: {
    mode: { const: "full" },
    provider: {
      type: "string",
      minLength: 1,
      maxLength: 80,
      pattern: "^[a-z][a-z0-9-]*$",
    },
    model: { type: "string", minLength: 1, maxLength: 120 },
    reasoningEffort: { type: "string", enum: ANALYSIS_REASONING_EFFORTS },
    taxonomyLevel: { const: "coarse" },
    focus: {
      type: "array",
      uniqueItems: true,
      maxItems: SEMANTIC_CATEGORIES.length,
      items: { type: "string", enum: SEMANTIC_CATEGORIES },
    },
    createRevisionOnSuccess: { type: "boolean" },
  },
} as const;

const retryAiJobSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    provider: {
      type: "string",
      minLength: 1,
      maxLength: 80,
      pattern: "^[a-z][a-z0-9-]*$",
    },
    model: { type: "string", minLength: 1, maxLength: 120 },
    reasoningEffort: { type: "string", enum: ANALYSIS_REASONING_EFFORTS },
    createRevisionOnSuccess: { type: "boolean" },
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

function bundlePngEtag(bundle: PartBundle, variant: string): string {
  const signature = createHash("sha256")
    .update(bundle.id)
    .update("\0")
    .update(variant)
    .update("\0")
    .update(
      bundle.members
        .map((member) => `${member.position}:${member.part.texture.sha256}`)
        .join("\n"),
    )
    .digest("hex");
  return `"sha256:${signature}"`;
}

function partEditMannequinEtag(
  textureSha256: string,
  armType: ArmType,
): string {
  const signature = createHash("sha256")
    .update(textureSha256)
    .update("\0")
    .update(armType)
    .update("\0part-edit-mannequin-v1")
    .digest("hex");
  return `"sha256:${signature}"`;
}

function readBoundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError(
      `环境变量必须是 ${minimum}-${maximum} 的整数：${value}`,
    );
  }
  return parsed;
}

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new TypeError(`环境变量必须是 true 或 false：${value}`);
}

function readReasoningEffort(
  value: string | undefined,
  fallback: AnalysisReasoningEffort,
): AnalysisReasoningEffort {
  const normalized = value?.trim() || fallback;
  if (
    !ANALYSIS_REASONING_EFFORTS.includes(
      normalized as AnalysisReasoningEffort,
    )
  ) {
    throw new TypeError(
      `AI_REASONING_EFFORT 必须是 ${ANALYSIS_REASONING_EFFORTS.join(", ")}：${normalized}`,
    );
  }
  return normalized as AnalysisReasoningEffort;
}
