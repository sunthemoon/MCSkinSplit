import type {
  ArmType,
  ManualSemanticOperation,
  PartApplicationReport,
  PartManifest,
  SemanticComponent,
  SemanticCategory,
} from "@mc-skin-split/skin-core";

export interface ApiProject {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly defaultBranchId: string;
  readonly headRevisionId: string | null;
  readonly settings: Readonly<Record<string, unknown>>;
}

export interface ApiBranch {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly baseRevisionId: string | null;
  readonly headRevisionId: string | null;
  readonly createdAt: string;
}

export interface ApiRevision {
  readonly id: string;
  readonly projectId: string;
  readonly parentRevisionId: string | null;
  readonly branchId: string;
  readonly branchName: string;
  readonly sequence: number;
  readonly operationType: string;
  readonly actorType: "user" | "ai" | "system";
  readonly createdAt: string;
  readonly summary: string;
  readonly resultHash: string;
  readonly isBranchHead: boolean;
}

export interface ApiMutationResult {
  readonly project: ApiProject;
  readonly branch: ApiBranch;
  readonly revision: ApiRevision;
}

export interface ApiImportResult {
  readonly projectId: string;
  readonly branchId: string;
  readonly revisionId: string;
  readonly armType: ArmType;
  readonly warnings: readonly string[];
}

export interface ApiSegmentation {
  readonly schemaVersion: "1.0";
  readonly revisionId: string;
  readonly source: {
    readonly width: 64;
    readonly height: 64;
    readonly armType: ArmType;
    readonly coordinateOrigin: "top-left";
    readonly sourceHash: string;
  };
  readonly components: readonly SemanticComponent[];
  readonly unknown: {
    readonly maskFile: string | null;
    readonly pixelCount: number;
  };
}

export interface ApiPart {
  readonly id: string;
  readonly sourceProjectId: string;
  readonly sourceRevisionId: string;
  readonly sourceComponentId: string;
  readonly name: string;
  readonly category: SemanticCategory;
  readonly subtype?: string;
  readonly armType: ArmType;
  readonly manifest: PartManifest;
  readonly createdAt: string;
}

export interface ApiPartPreview {
  readonly committed: false;
  readonly revisionId: string;
  readonly part: ApiPart;
  readonly report: PartApplicationReport;
}

export interface ApiPartCommit extends ApiMutationResult {
  readonly committed: true;
  readonly part: ApiPart;
  readonly report: PartApplicationReport;
}

export interface ApiCompositionPixelWrite {
  readonly layerId: string;
  readonly partId: string | null;
  readonly position: number;
  readonly rgba: readonly [number, number, number, number];
}

export type ApiCompositionConflict =
  | {
      readonly id: string;
      readonly type: "hard_conflict" | "same_color_overlap";
      readonly blocking: boolean;
      readonly resolved: boolean;
      readonly pixelId: number;
      readonly x: number;
      readonly y: number;
      readonly writes: readonly ApiCompositionPixelWrite[];
      readonly defaultWinnerLayerId: string;
      readonly winnerLayerId: string;
    }
  | {
      readonly id: string;
      readonly type: "model_conflict";
      readonly blocking: true;
      readonly resolved: false;
      readonly layerId: string;
      readonly partId: string;
      readonly targetArmType: ArmType;
      readonly supportedArmTypes: readonly ArmType[];
    }
  | {
      readonly id: string;
      readonly type: "unknown_conflict";
      readonly blocking: true;
      readonly resolved: false;
      readonly layerId: string;
      readonly partId: string;
      readonly pixelIds: readonly number[];
    };

export interface ApiCompositionReport {
  readonly targetArmType: ArmType;
  readonly layerCount: number;
  readonly writePixelCount: number;
  readonly appliedPixelCount: number;
  readonly hardConflictCount: number;
  readonly sameColorOverlapCount: number;
  readonly layerConflictCount: number;
  readonly modelConflictCount: number;
  readonly unknownConflictCount: number;
  readonly unresolvedConflictCount: number;
  readonly committable: boolean;
  readonly conflicts: readonly ApiCompositionConflict[];
}

export interface ApiCompositionProject {
  readonly id: string;
  readonly projectId: string;
  readonly baseRevisionId: string;
  readonly branchId: string;
  readonly name: string;
  readonly armType: ArmType;
  readonly status: "draft" | "committed";
  readonly resolutionMode: "unresolved" | "layer_order";
  readonly conflictWinners: Readonly<Record<string, string>>;
  readonly report: ApiCompositionReport;
  readonly resultRevisionId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly committedAt: string | null;
}

export interface ApiCompositionLayer {
  readonly id: string;
  readonly compositionId: string;
  readonly partId: string;
  readonly position: number;
  readonly part: ApiPart;
  readonly createdAt: string;
}

export interface ApiCompositionDetail {
  readonly composition: ApiCompositionProject;
  readonly layers: readonly ApiCompositionLayer[];
  readonly report: ApiCompositionReport;
}

export interface ApiCompositionCommit extends ApiMutationResult {
  readonly composition: ApiCompositionProject;
  readonly report: ApiCompositionReport;
}

export type ApiAiJobStatus =
  | "queued"
  | "preparing"
  | "running"
  | "validating"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface ApiAiReviewItem {
  readonly type:
    | "ambiguous_region"
    | "low_confidence"
    | "coverage_gap"
    | "model_mismatch";
  readonly candidateRegionIds: readonly string[];
  readonly question: string;
  readonly suggestedCategories: readonly SemanticCategory[];
  readonly confidence: number;
}

export interface ApiAiAnalysisOptions {
  readonly mode: "full";
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort: "low" | "medium" | "high" | "xhigh" | "max";
  readonly taxonomyLevel: "coarse";
  readonly focus: readonly SemanticCategory[];
  readonly createRevisionOnSuccess: boolean;
}

export interface ApiAiJobError {
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface ApiAiJob {
  readonly id: string;
  readonly projectId: string;
  readonly inputRevisionId: string;
  readonly resultRevisionId: string | null;
  readonly retryOfJobId: string | null;
  readonly status: ApiAiJobStatus;
  readonly provider: string;
  readonly model: string;
  readonly skillName: string;
  readonly skillVersion: string;
  readonly promptVersion: string;
  readonly inputHash: string | null;
  readonly outputHash: string | null;
  readonly options: ApiAiAnalysisOptions;
  readonly reviewItems: readonly ApiAiReviewItem[];
  readonly proposalSummary: string | null;
  readonly cancelRequested: boolean;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly error: ApiAiJobError | null;
}

export interface ApiAiRun {
  readonly id: string;
  readonly jobId: string;
  readonly provider: string;
  readonly model: string;
  readonly threadId: string | null;
  readonly attempt: number;
  readonly status: "running" | "succeeded" | "failed" | "cancelled";
  readonly workspacePath: string;
  readonly usage: Readonly<Record<string, unknown>> | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly error: ApiAiJobError | null;
  readonly assets: readonly {
    readonly id: string;
    readonly fileRole:
      | "input_manifest"
      | "raw_events"
      | "raw_output"
      | "validator_report"
      | "stderr";
    readonly mimeType: string;
    readonly byteSize: number;
    readonly sha256: string;
    readonly createdAt: string;
  }[];
}

export interface ApiAiJobEvent {
  readonly id: number;
  readonly jobId: string;
  readonly eventType: string;
  readonly message: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface ApiAiJobDetail {
  readonly job: ApiAiJob;
  readonly runs: readonly ApiAiRun[];
  readonly events: readonly ApiAiJobEvent[];
}

export class RevisionApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "RevisionApiError";
    this.status = status;
    this.code = code;
  }
}

type Fetcher = typeof fetch;

export async function listProjects(
  fetcher: Fetcher = fetch,
): Promise<readonly ApiProject[]> {
  const body = await requestJson<{ projects: readonly ApiProject[] }>(
    "/api/projects",
    undefined,
    fetcher,
  );
  return body.projects;
}

export async function createProject(
  name: string,
  fetcher: Fetcher = fetch,
): Promise<{ readonly project: ApiProject; readonly branch: ApiBranch }> {
  return requestJson(
    "/api/projects",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    },
    fetcher,
  );
}

export async function getProject(
  projectId: string,
  fetcher: Fetcher = fetch,
): Promise<ApiProject> {
  const body = await requestJson<{ project: ApiProject }>(
    `/api/projects/${encodeURIComponent(projectId)}`,
    undefined,
    fetcher,
  );
  return body.project;
}

export async function importProjectSkin(
  projectId: string,
  skinPng: Uint8Array,
  options: { readonly fileName?: string; readonly armType?: ArmType } = {},
  fetcher: Fetcher = fetch,
): Promise<ApiImportResult> {
  const query = new URLSearchParams();
  if (options.fileName) {
    query.set("fileName", options.fileName);
  }
  if (options.armType) {
    query.set("armType", options.armType);
  }
  const queryString = query.size > 0 ? `?${query.toString()}` : "";
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/import${queryString}`,
    {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: copyArrayBuffer(skinPng),
    },
    fetcher,
  );
}

export async function listBranches(
  projectId: string,
  fetcher: Fetcher = fetch,
): Promise<readonly ApiBranch[]> {
  const body = await requestJson<{ branches: readonly ApiBranch[] }>(
    `/api/projects/${encodeURIComponent(projectId)}/branches`,
    undefined,
    fetcher,
  );
  return body.branches;
}

export async function listRevisions(
  projectId: string,
  fetcher: Fetcher = fetch,
): Promise<readonly ApiRevision[]> {
  const body = await requestJson<{ revisions: readonly ApiRevision[] }>(
    `/api/projects/${encodeURIComponent(projectId)}/revisions`,
    undefined,
    fetcher,
  );
  return body.revisions;
}

export async function loadRevisionSkin(
  revisionId: string,
  fetcher: Fetcher = fetch,
): Promise<Uint8Array> {
  const response = await fetcher(
    `/api/revisions/${encodeURIComponent(revisionId)}/skin.png`,
  );
  await assertResponse(response);
  if (!response.headers.get("content-type")?.includes("image/png")) {
    throw new RevisionApiError(
      response.status,
      "INVALID_RESPONSE",
      "Revision API 未返回 PNG",
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}

export async function loadRevisionSegmentation(
  revisionId: string,
  fetcher: Fetcher = fetch,
): Promise<ApiSegmentation> {
  const body = await requestJson<{ segmentation: ApiSegmentation }>(
    `/api/revisions/${encodeURIComponent(revisionId)}/segmentation`,
    undefined,
    fetcher,
  );
  return body.segmentation;
}

export async function revertRevision(
  revisionId: string,
  branchId: string,
  fetcher: Fetcher = fetch,
): Promise<ApiMutationResult> {
  return requestJson(
    `/api/revisions/${encodeURIComponent(revisionId)}/revert`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ branchId }),
    },
    fetcher,
  );
}

export async function branchRevision(
  revisionId: string,
  name: string,
  fetcher: Fetcher = fetch,
): Promise<ApiMutationResult> {
  return requestJson(
    `/api/revisions/${encodeURIComponent(revisionId)}/branch`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    },
    fetcher,
  );
}

export async function applySemanticOperation(
  revisionId: string,
  operation: ManualSemanticOperation,
  options: {
    readonly branchId?: string;
    readonly summary?: string;
  } = {},
  fetcher: Fetcher = fetch,
): Promise<ApiMutationResult> {
  return requestJson(
    `/api/revisions/${encodeURIComponent(revisionId)}/operations`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...operation, ...options }),
    },
    fetcher,
  );
}

export async function exportRevisionPart(
  revisionId: string,
  componentId: string,
  name?: string,
  fetcher: Fetcher = fetch,
): Promise<ApiPart> {
  const body = await requestJson<{ part: ApiPart }>(
    `/api/revisions/${encodeURIComponent(revisionId)}/components/${encodeURIComponent(componentId)}/export-part`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(name ? { name } : {}),
    },
    fetcher,
  );
  return body.part;
}

export async function listParts(
  category?: SemanticCategory,
  fetcher: Fetcher = fetch,
): Promise<readonly ApiPart[]> {
  const query = category
    ? `?category=${encodeURIComponent(category)}`
    : "";
  const body = await requestJson<{ parts: readonly ApiPart[] }>(
    `/api/parts${query}`,
    undefined,
    fetcher,
  );
  return body.parts;
}

export async function previewRevisionPart(
  revisionId: string,
  partId: string,
  fetcher: Fetcher = fetch,
): Promise<ApiPartPreview> {
  return requestJson(
    `/api/revisions/${encodeURIComponent(revisionId)}/apply-part`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ partId }),
    },
    fetcher,
  );
}

export async function commitRevisionPart(
  revisionId: string,
  partId: string,
  strategy: "use_part" | "keep_base",
  fetcher: Fetcher = fetch,
): Promise<ApiPartCommit> {
  return requestJson(
    `/api/revisions/${encodeURIComponent(revisionId)}/apply-part`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ partId, strategy }),
    },
    fetcher,
  );
}

export function partPreviewUrl(partId: string): string {
  return `/api/parts/${encodeURIComponent(partId)}/preview.png`;
}

export async function listCompositions(
  revisionId?: string,
  fetcher: Fetcher = fetch,
): Promise<readonly ApiCompositionProject[]> {
  const query = revisionId
    ? `?revisionId=${encodeURIComponent(revisionId)}`
    : "";
  const body = await requestJson<{
    compositions: readonly ApiCompositionProject[];
  }>(`/api/compositions${query}`, undefined, fetcher);
  return body.compositions;
}

export function createComposition(
  baseRevisionId: string,
  name?: string,
  fetcher: Fetcher = fetch,
): Promise<ApiCompositionDetail> {
  return requestJson(
    "/api/compositions",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseRevisionId, ...(name ? { name } : {}) }),
    },
    fetcher,
  );
}

export function loadComposition(
  compositionId: string,
  fetcher: Fetcher = fetch,
): Promise<ApiCompositionDetail> {
  return requestJson(
    `/api/compositions/${encodeURIComponent(compositionId)}`,
    undefined,
    fetcher,
  );
}

export function addCompositionPart(
  compositionId: string,
  partId: string,
  position?: number,
  fetcher: Fetcher = fetch,
): Promise<ApiCompositionDetail> {
  return requestJson(
    `/api/compositions/${encodeURIComponent(compositionId)}/apply-part`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ partId, ...(position === undefined ? {} : { position }) }),
    },
    fetcher,
  );
}

export function reorderCompositionLayers(
  compositionId: string,
  layerIds: readonly string[],
  fetcher: Fetcher = fetch,
): Promise<ApiCompositionDetail> {
  return requestJson(
    `/api/compositions/${encodeURIComponent(compositionId)}/reorder`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ layerIds }),
    },
    fetcher,
  );
}

export function removeCompositionLayer(
  compositionId: string,
  layerId: string,
  fetcher: Fetcher = fetch,
): Promise<ApiCompositionDetail> {
  return requestJson(
    `/api/compositions/${encodeURIComponent(compositionId)}/layers/${encodeURIComponent(layerId)}`,
    { method: "DELETE" },
    fetcher,
  );
}

export function resolveCompositionConflicts(
  compositionId: string,
  resolution:
    | { readonly strategy: "layer_order" | "clear" }
    | {
        readonly strategy: "winner";
        readonly conflictId: string;
        readonly winnerLayerId: string;
      },
  fetcher: Fetcher = fetch,
): Promise<ApiCompositionDetail> {
  return requestJson(
    `/api/compositions/${encodeURIComponent(compositionId)}/resolve-conflict`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(resolution),
    },
    fetcher,
  );
}

export function commitComposition(
  compositionId: string,
  summary?: string,
  fetcher: Fetcher = fetch,
): Promise<ApiCompositionCommit> {
  return requestJson(
    `/api/compositions/${encodeURIComponent(compositionId)}/commit`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(summary ? { summary } : {}),
    },
    fetcher,
  );
}

export function compositionPreviewUrl(
  compositionId: string,
  updatedAt?: string,
): string {
  const cacheBuster = updatedAt
    ? `?v=${encodeURIComponent(updatedAt)}`
    : "";
  return `/api/compositions/${encodeURIComponent(compositionId)}/preview.png${cacheBuster}`;
}

export async function listAiProviders(
  fetcher: Fetcher = fetch,
): Promise<{
  readonly providers: readonly string[];
  readonly defaultModel: string;
  readonly defaultReasoningEffort: ApiAiAnalysisOptions["reasoningEffort"];
}> {
  return await requestJson(
    "/api/ai/providers",
    undefined,
    fetcher,
  );
}

export async function startAiAnalysis(
  revisionId: string,
  options: ApiAiAnalysisOptions,
  fetcher: Fetcher = fetch,
): Promise<ApiAiJob> {
  const body = await requestJson<{ job: ApiAiJob }>(
    `/api/revisions/${encodeURIComponent(revisionId)}/ai-analysis`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(options),
    },
    fetcher,
  );
  return body.job;
}

export async function listAiJobs(
  revisionId?: string,
  fetcher: Fetcher = fetch,
): Promise<readonly ApiAiJob[]> {
  const query = revisionId
    ? `?revisionId=${encodeURIComponent(revisionId)}`
    : "";
  const body = await requestJson<{ jobs: readonly ApiAiJob[] }>(
    `/api/ai-jobs${query}`,
    undefined,
    fetcher,
  );
  return body.jobs;
}

export function loadAiJobDetail(
  jobId: string,
  fetcher: Fetcher = fetch,
): Promise<ApiAiJobDetail> {
  return requestJson(
    `/api/ai-jobs/${encodeURIComponent(jobId)}`,
    undefined,
    fetcher,
  );
}

export async function cancelAiJob(
  jobId: string,
  fetcher: Fetcher = fetch,
): Promise<ApiAiJob> {
  const body = await requestJson<{ job: ApiAiJob }>(
    `/api/ai-jobs/${encodeURIComponent(jobId)}/cancel`,
    { method: "POST" },
    fetcher,
  );
  return body.job;
}

export async function retryAiJob(
  jobId: string,
  overrides: {
    readonly provider?: string;
    readonly model?: string;
    readonly reasoningEffort?: ApiAiAnalysisOptions["reasoningEffort"];
    readonly createRevisionOnSuccess?: boolean;
  },
  fetcher: Fetcher = fetch,
): Promise<ApiAiJob> {
  const body = await requestJson<{ job: ApiAiJob }>(
    `/api/ai-jobs/${encodeURIComponent(jobId)}/retry`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(overrides),
    },
    fetcher,
  );
  return body.job;
}

async function requestJson<T>(
  url: string,
  init: RequestInit | undefined,
  fetcher: Fetcher,
): Promise<T> {
  const response = await fetcher(url, init);
  await assertResponse(response);
  return (await response.json()) as T;
}

async function assertResponse(response: Response): Promise<void> {
  if (response.ok) {
    return;
  }

  let code = `HTTP_${response.status}`;
  let message = `Revision API 请求失败：HTTP ${response.status}`;
  try {
    const body = (await response.json()) as {
      readonly error?: { readonly code?: unknown; readonly message?: unknown };
    };
    if (typeof body.error?.code === "string") {
      code = body.error.code;
    }
    if (typeof body.error?.message === "string") {
      message = body.error.message;
    }
  } catch {
    // Keep the stable HTTP fallback when the server did not return JSON.
  }
  throw new RevisionApiError(response.status, code, message);
}

function copyArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
