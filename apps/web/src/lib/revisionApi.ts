import type {
  AggregateKind,
  ArmType,
  CompletionCandidateStrategy,
  CompletionCandidateDocument,
  CompletionConfidence,
  CompletionPixelOriginMode,
  CompletionRequestedRepresentation,
  CompletionTargetRepresentation,
  ManualSemanticOperation,
  PartRepairCopyMapping,
  PartRepairOverwriteMode,
  PartApplicationReport,
  PartManifest,
  PixelOriginDocument,
  PixelOriginSummary,
  Rgba,
  SemanticComponent,
  SemanticCategory,
  SemanticPixelSpan,
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

export interface ApiRevisionMutationResult extends ApiMutationResult {
  readonly generatedComponentId?: string;
}

type OptionalSemanticTargetId<Operation> =
  Operation extends { readonly target: infer Target extends { readonly instanceId: string } }
    ? Omit<Operation, "target"> & {
        readonly target: Omit<Target, "instanceId"> & {
          readonly instanceId?: string;
        };
      }
    : Operation;

/** Public Revision API carrier; the Host materializes omitted target IDs before core validation. */
export type ApiManualSemanticOperation =
  OptionalSemanticTargetId<ManualSemanticOperation>;

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

export type ApiRevisionOrigin =
  | {
      readonly availability: "recorded";
      readonly revisionId: string;
      readonly originAssetId: string;
      readonly document: PixelOriginDocument;
      readonly summary: PixelOriginSummary;
      readonly componentSummaries: Readonly<Record<string, PixelOriginSummary>>;
    }
  | {
      readonly availability: "legacy_unavailable";
      readonly revisionId: string;
      readonly originAssetId: null;
      readonly document: null;
      readonly summary: null;
      readonly componentSummaries: Readonly<Record<string, never>>;
    };

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
  readonly libraryStatus: ApiLibraryStatus;
  readonly retiredAt: string | null;
  readonly retiredReason: string | null;
  readonly sourceProjectName: string;
  readonly sourceBranchName: string;
  readonly sourceRevisionSequence: number;
  readonly createdAt: string;
}

export type ApiLibraryStatus = "active" | "retired";
export type ApiLibraryStatusFilter = ApiLibraryStatus | "all";

export type ApiPartEditStatus = "draft" | "committed";

export type ApiPartEditOperation =
  | {
      readonly type: "paint_color";
      readonly spans: readonly SemanticPixelSpan[];
      readonly rgba: Rgba;
    }
  | {
      readonly type: "erase_pixels";
      readonly spans: readonly SemanticPixelSpan[];
    }
  | {
      readonly type: "replace_color";
      readonly from: Rgba;
      readonly to: Rgba;
      readonly spans?: readonly SemanticPixelSpan[];
    }
  | {
      readonly type: "copy_surfaces";
      readonly source:
        | { readonly kind: "part"; readonly partId: string }
        | { readonly kind: "edit_revision"; readonly revisionId: string };
      readonly mappings: readonly PartRepairCopyMapping[];
      readonly overwrite?: PartRepairOverwriteMode;
    };

export interface ApiPartEditProject {
  readonly id: string;
  readonly basePartId: string;
  readonly name: string;
  readonly status: ApiPartEditStatus;
  readonly headRevisionId: string;
  readonly resultPartId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly committedAt: string | null;
}

export interface ApiPartEditRevision {
  readonly id: string;
  readonly projectId: string;
  readonly parentRevisionId: string | null;
  readonly sequence: number;
  readonly operationType:
    | ApiPartEditOperation["type"]
    | "init";
  readonly operation: Readonly<Record<string, unknown>>;
  readonly summary: string;
  readonly actorId?: string;
  readonly changedPixelCount: number;
  readonly authoredProvenance: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface ApiPartEditDetail {
  readonly project: ApiPartEditProject;
  readonly basePart: ApiPart;
  readonly headRevision: ApiPartEditRevision;
  readonly revisions: readonly ApiPartEditRevision[];
  readonly resultPart: ApiPart | null;
}

export interface ApiPartBundleMember {
  readonly bundleId: string;
  readonly partId: string;
  readonly position: number;
  readonly part: ApiPart;
  readonly createdAt: string;
}

export interface ApiPartBundle {
  readonly id: string;
  readonly sourceProjectId: string;
  readonly sourceRevisionId: string;
  readonly name: string;
  readonly kind: AggregateKind;
  readonly sourceGroupKey: string | null;
  readonly armTypes: readonly ArmType[];
  readonly members: readonly ApiPartBundleMember[];
  readonly libraryStatus: ApiLibraryStatus;
  readonly retiredAt: string | null;
  readonly retiredReason: string | null;
  readonly sourceProjectName: string;
  readonly sourceBranchName: string;
  readonly sourceRevisionSequence: number;
  readonly createdAt: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ApiAnalyzedSkinGroup {
  readonly key: string;
  readonly sourceGroupKey: string | null;
  readonly kind: AggregateKind;
  readonly displayName: string;
  readonly componentIds: readonly string[];
  readonly componentCount: number;
  readonly pixelCount: number;
  readonly exportedBundleId: string | null;
}

export type ApiAnalyzedSkinCatalogStatus = "active" | "archived";
export type ApiAnalyzedSkinCatalogStatusFilter =
  | ApiAnalyzedSkinCatalogStatus
  | "all";

export interface ApiAnalyzedSkin {
  readonly project: Pick<ApiProject, "id" | "name">;
  readonly revision: Pick<
    ApiRevision,
    "id" | "branchId" | "branchName" | "sequence" | "createdAt"
  >;
  readonly aiJob: {
    readonly id: string;
    readonly provider: string;
    readonly model: string;
    readonly finishedAt: string;
  };
  readonly armType: ArmType;
  readonly componentCount: number;
  readonly unknownPixelCount: number;
  readonly reviewItemCount: number;
  readonly catalogStatus: ApiAnalyzedSkinCatalogStatus;
  readonly archivedAt: string | null;
  readonly archivedReason: string | null;
  readonly groups: readonly ApiAnalyzedSkinGroup[];
  readonly skinUrl: string;
  readonly semanticFollowup: ApiAnalyzedSkinSemanticFollowup | null;
}

export interface ApiAnalyzedSkinSemanticFollowup {
  readonly jobId: string;
  readonly status: ApiSemanticFollowupStatus;
  readonly evidenceHash: string;
  readonly suggestionCount: number;
  readonly suggestedPixelCount: number;
  readonly notices: readonly ApiSemanticFollowupNotice[];
  readonly appliedVariant: {
    readonly revision: Pick<
      ApiRevision,
      "id" | "branchId" | "branchName" | "sequence" | "createdAt"
    >;
    readonly groups: readonly ApiAnalyzedSkinGroup[];
    readonly skinUrl: string;
    readonly label: string;
  } | null;
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
  readonly restorationPixelCount: number;
  readonly restoredOuterPixelCount: number;
  readonly restoredBasePixelCount: number;
  readonly restorationMissingPixelCount: number;
  readonly restorationIssueCount: number;
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
  readonly restorationVersion: number;
  readonly restorationPlan: ApiCompositionRestorationPlan | null;
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

export type ApiRestorationCandidateKind =
  | "outer_transparent"
  | "current_same_surface"
  | "current_same_body_part"
  | "mirrored_counterpart"
  | "donor_revision"
  | "manual_rgba";

export interface ApiRestorationCandidate {
  readonly id: string;
  readonly kind: ApiRestorationCandidateKind;
  readonly targetGroupId: string;
  readonly label: string;
  readonly description: string;
  readonly pixelCount: number;
  readonly coveragePixelCount: number;
  readonly sourceRevisionId?: string;
  readonly rgba?: Rgba;
  readonly selectedByDefault?: boolean;
}

export interface ApiCompositionRestorationCandidates {
  readonly compositionId: string;
  readonly version: number;
  readonly candidateSetHash: string;
  readonly targetComponentIds: readonly string[];
  readonly outer: {
    readonly pixelCount: number;
    readonly candidateId: string | null;
  };
  readonly base: {
    readonly pixelCount: number;
    readonly coveredPixelCount: number;
    readonly missingPixelCount: number;
    readonly candidates: readonly ApiRestorationCandidate[];
  };
}

export interface ApiCompositionRestorationPlan {
  readonly version: number;
  readonly candidateSetHash: string;
  readonly targetComponentIds: readonly string[];
  readonly candidateIds: readonly string[];
  readonly outerPixelCount: number;
  readonly basePixelCount: number;
  readonly coveredPixelCount: number;
  readonly missingPixelCount: number;
  readonly planHash: string;
}

export interface ApiCompositionCommit extends ApiMutationResult {
  readonly composition: ApiCompositionProject;
  readonly report: ApiCompositionReport;
}

export type ApiCompletionProposalStatus =
  | "awaiting_decision"
  | "accepted"
  | "rejected";

export interface ApiCompletionStoredFile {
  readonly storagePath: string;
  readonly mimeType: "application/json" | "image/png";
  readonly byteSize: number;
  readonly sha256: string;
}

export interface ApiCompletionProposal {
  readonly id: string;
  readonly jobId: string;
  readonly projectId: string;
  readonly sourceRevisionId: string;
  readonly sourceResultHash: string;
  readonly sourceSkinHash: string;
  readonly targetComponentId: string;
  readonly occludingComponentIds: readonly string[];
  readonly representation: CompletionTargetRepresentation;
  readonly allowedSpans: readonly SemanticPixelSpan[];
  readonly allowedGeneratedPixelCount: number;
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly evidenceHash: string;
  readonly proposalHash: string;
  readonly document: ApiCompletionStoredFile;
  readonly allowedMask: ApiCompletionStoredFile;
  readonly createdAt: string;
}

export interface ApiCompletionCandidate {
  readonly id: string;
  readonly proposalId: string;
  readonly representation: CompletionTargetRepresentation;
  readonly strategy: CompletionCandidateStrategy;
  /** Added by the M20 edit carrier; older immutable M19 candidates omit it. */
  readonly baseCandidateId?: string | null;
  readonly confidence: CompletionConfidence;
  readonly originMode: CompletionPixelOriginMode | "mixed";
  readonly pixelCount: number;
  readonly generatedPixelCount: number;
  readonly candidateHash: string;
  readonly evidenceHash: string;
  readonly document: ApiCompletionStoredFile;
  readonly texture: ApiCompletionStoredFile;
  readonly writeMask: ApiCompletionStoredFile;
  readonly generatedMask: ApiCompletionStoredFile;
  readonly reviewRequired: true;
  readonly automaticAcceptanceAllowed: false;
  readonly createdAt: string;
}

export interface ApiCompletionRankingRecommendation {
  readonly status: "recommend" | "defer";
  readonly candidateId: string | null;
  readonly confidence: number;
  readonly explanation: string;
}

export interface ApiCompletionProposalRanking {
  readonly proposalId: string;
  readonly jobId: string;
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort: ApiAiReasoningEffort;
  readonly document: {
    readonly schemaVersion: "1.0";
    readonly jobId: string;
    readonly proposalId: string;
    readonly proposalHash: string;
    readonly sourceRevisionId: string;
    readonly sourceResultHash: string;
    readonly sourceSkinHash: string;
    readonly rankings: readonly {
      readonly candidateId: string;
      readonly confidence: number;
      readonly explanation: string;
    }[];
    readonly recommendation: ApiCompletionRankingRecommendation;
  };
  readonly orderedCandidateIds: readonly string[];
  readonly recommendation: ApiCompletionRankingRecommendation;
  readonly rankingHash: string;
  readonly createdAt: string;
}

export interface ApiCompletionDecision {
  readonly id: string;
  readonly proposalId: string;
  readonly candidateId: string | null;
  readonly action: "accept" | "reject";
  readonly expectedSourceResultHash: string;
  readonly expectedProposalHash: string;
  readonly expectedEvidenceHash: string;
  readonly expectedCandidateHash: string | null;
  readonly actorType: "user";
  readonly actorId: string | null;
  readonly reason: string | null;
  readonly decisionHash: string;
  readonly createdAt: string;
}

export interface ApiCompletionResult {
  readonly id: string;
  readonly proposalId: string;
  readonly decisionId: string;
  readonly candidateId: string;
  readonly representation: CompletionTargetRepresentation;
  readonly sourceRevisionId: string;
  readonly sourceResultHash: string;
  readonly sourceSkinHash: string;
  readonly revision: ApiRevision | null;
  readonly latentPart: ApiPart | null;
  readonly resultHash: string;
  readonly resultSkinHash: string;
  readonly originHash: string;
  readonly publishedAt: string | null;
  readonly createdAt: string;
}

export interface ApiCompletionProposalSummary {
  readonly proposal: ApiCompletionProposal;
  readonly jobStatus: ApiAiJobStatus;
  readonly visible: boolean;
  readonly status: ApiCompletionProposalStatus;
  readonly candidateCount: number;
  readonly ranking: ApiCompletionProposalRanking | null;
  readonly decision: ApiCompletionDecision | null;
  readonly result: ApiCompletionResult | null;
}

export interface ApiCompletionProposalDetail
  extends ApiCompletionProposalSummary {
  readonly candidates: readonly ApiCompletionCandidate[];
}

export interface ApiCompletionProposalListFilters {
  readonly projectId?: string;
  readonly revisionId?: string;
  readonly jobId?: string;
  readonly representation?: CompletionTargetRepresentation;
  readonly status?: ApiCompletionProposalStatus | "all";
}

export interface StartCompletionProposalInput {
  readonly targetComponentId: string;
  readonly occludingComponentIds: readonly string[];
  readonly representation?: CompletionRequestedRepresentation;
}

export interface ApiCompletionDecisionOutcome
  extends ApiCompletionProposalDetail {
  readonly changed: boolean;
}

export type ApiCompletionCandidateEdit =
  | {
      readonly type: "set_pixel";
      readonly pixelId: number;
      readonly rgba: Rgba;
    }
  | {
      readonly type: "remove_pixel";
      readonly pixelId: number;
    };

export interface ApiCompletionCandidateEditOutcome
  extends ApiCompletionProposalDetail {
  readonly changed: boolean;
  readonly editedCandidateId: string;
}

export interface ApiCompletionPublishOutcome {
  readonly changed: boolean;
  readonly result: ApiCompletionResult;
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
  readonly semanticBaseline: "empty" | "current";
}

export type ApiAiReasoningEffort = ApiAiAnalysisOptions["reasoningEffort"];

export interface ApiAiRestorationRecommendationOptions {
  readonly mode: "restoration_recommendation";
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort: ApiAiReasoningEffort;
  readonly userIntent: string;
  readonly compositionId: string;
  readonly compositionVersion: number;
  readonly candidateSetHash: string;
  readonly targetComponentIds: readonly string[];
  readonly donorRevisionId?: string;
  readonly manualRgba?: Rgba;
}

export interface ApiAiCompletionProposalOptions {
  readonly mode: "completion_proposal";
  readonly provider: string;
  readonly model: string;
  readonly targetComponentId: string;
  readonly occludingComponentIds: readonly string[];
  readonly representation: CompletionRequestedRepresentation;
  readonly rankingMode: "host_only" | "ai";
  readonly reasoningEffort?: ApiAiReasoningEffort;
}

export type ApiAiJobOptions =
  | ApiAiAnalysisOptions
  | ApiAiRestorationRecommendationOptions
  | ApiAiCompletionProposalOptions;

export interface ApiAiRestorationRecommendationDecision {
  readonly targetGroupId: string;
  readonly selectedCandidateId: string | null;
  readonly rankedCandidateIds: readonly string[];
  readonly confidence: number;
  readonly explanation: string;
}

export interface ApiAiRestorationRecommendationResult {
  readonly schemaVersion: "1.0";
  readonly jobId: string;
  readonly compositionId: string;
  readonly candidateSetHash: string;
  readonly decisions: readonly ApiAiRestorationRecommendationDecision[];
  readonly summary: string;
}

export interface ApiAiJobError {
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface ApiAiJob {
  readonly id: string;
  readonly kind:
    | "semantic_analysis"
    | "restoration_recommendation"
    | "completion_proposal";
  readonly projectId: string;
  readonly inputRevisionId: string;
  readonly resultRevisionId: string | null;
  readonly compositionId: string | null;
  readonly retryOfJobId: string | null;
  readonly status: ApiAiJobStatus;
  readonly provider: string;
  readonly model: string;
  readonly skillName: string;
  readonly skillVersion: string;
  readonly promptVersion: string;
  readonly inputHash: string | null;
  readonly outputHash: string | null;
  readonly options: ApiAiJobOptions;
  readonly reviewItems: readonly ApiAiReviewItem[];
  readonly proposalSummary: string | null;
  readonly advisoryResult: ApiAiRestorationRecommendationResult | null;
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
  readonly semanticFollowup: ApiSemanticFollowup | null;
}

export type ApiSemanticFollowupStatus =
  | "no_repair"
  | "awaiting_review"
  | "applied"
  | "dismissed"
  | "assessment_failed";

export interface ApiSemanticFollowupSuggestion {
  readonly id: string;
  readonly label: string;
  readonly pixelCount: number;
  readonly confidence: number;
  readonly reason: string;
}

export interface ApiSemanticFollowupNotice {
  readonly kind: string;
  readonly message: string;
}

export interface ApiSemanticFollowup {
  readonly status: ApiSemanticFollowupStatus;
  readonly algorithmVersion: string;
  readonly applicable: boolean;
  readonly evidenceHash: string;
  readonly suggestions: readonly ApiSemanticFollowupSuggestion[];
  readonly notices: readonly ApiSemanticFollowupNotice[];
  readonly appliedRevisionId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ApiAiJobListFilters {
  readonly revisionId?: string;
  readonly kind?: ApiAiJob["kind"];
  readonly compositionId?: string;
}

export type StartAiRestorationRecommendationInput = Omit<
  ApiAiRestorationRecommendationOptions,
  "mode" | "compositionId"
>;

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

export async function loadRevisionOrigin(
  revisionId: string,
  fetcher: Fetcher = fetch,
): Promise<ApiRevisionOrigin> {
  const body = await requestJson<{ origin: ApiRevisionOrigin }>(
    `/api/revisions/${encodeURIComponent(revisionId)}/origin`,
    undefined,
    fetcher,
  );
  return body.origin;
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
  operation: ApiManualSemanticOperation,
  options: {
    readonly branchId?: string;
    readonly actorId?: string;
    readonly summary?: string;
  } = {},
  fetcher: Fetcher = fetch,
): Promise<ApiRevisionMutationResult> {
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
  options: {
    readonly category?: SemanticCategory;
    readonly status?: ApiLibraryStatusFilter;
    readonly projectId?: string;
    readonly sourceRevisionId?: string;
    readonly query?: string;
  } = {},
  fetcher: Fetcher = fetch,
): Promise<readonly ApiPart[]> {
  const query = new URLSearchParams();
  if (options.category) query.set("category", options.category);
  if (options.status) query.set("status", options.status);
  if (options.projectId) query.set("projectId", options.projectId);
  if (options.sourceRevisionId) {
    query.set("sourceRevisionId", options.sourceRevisionId);
  }
  if (options.query) query.set("q", options.query);
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  const body = await requestJson<{ parts: readonly ApiPart[] }>(
    `/api/parts${suffix}`,
    undefined,
    fetcher,
  );
  return body.parts;
}

export async function retirePart(
  partId: string,
  reason?: string,
  fetcher: Fetcher = fetch,
): Promise<ApiPart> {
  const body = await requestJson<{ readonly part: ApiPart }>(
    `/api/parts/${encodeURIComponent(partId)}/retire`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reason?.trim() ? { reason: reason.trim() } : {}),
    },
    fetcher,
  );
  return body.part;
}

export async function restorePart(
  partId: string,
  fetcher: Fetcher = fetch,
): Promise<ApiPart> {
  const body = await requestJson<{ readonly part: ApiPart }>(
    `/api/parts/${encodeURIComponent(partId)}/restore`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    },
    fetcher,
  );
  return body.part;
}

export async function listAnalyzedSkins(
  options: {
    readonly projectId?: string;
    readonly kind?: AggregateKind;
    readonly status?: ApiAnalyzedSkinCatalogStatusFilter;
    readonly query?: string;
  } = {},
  fetcher: Fetcher = fetch,
): Promise<readonly ApiAnalyzedSkin[]> {
  const query = new URLSearchParams();
  if (options.projectId) query.set("projectId", options.projectId);
  if (options.kind) query.set("kind", options.kind);
  if (options.status) query.set("status", options.status);
  if (options.query) query.set("q", options.query);
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  const body = await requestJson<{
    readonly analyzedSkins: readonly ApiAnalyzedSkin[];
  }>(`/api/analyzed-skins${suffix}`, undefined, fetcher);
  return body.analyzedSkins;
}

export async function getAnalyzedSkin(
  revisionId: string,
  fetcher: Fetcher = fetch,
): Promise<ApiAnalyzedSkin> {
  const body = await requestJson<{ readonly analyzedSkin: ApiAnalyzedSkin }>(
    `/api/analyzed-skins/${encodeURIComponent(revisionId)}`,
    undefined,
    fetcher,
  );
  return body.analyzedSkin;
}

export async function archiveAnalyzedSkin(
  revisionId: string,
  reason?: string,
  fetcher: Fetcher = fetch,
): Promise<ApiAnalyzedSkin> {
  const body = await requestJson<{ readonly analyzedSkin: ApiAnalyzedSkin }>(
    `/api/analyzed-skins/${encodeURIComponent(revisionId)}/archive`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reason?.trim() ? { reason: reason.trim() } : {}),
    },
    fetcher,
  );
  return body.analyzedSkin;
}

export async function restoreAnalyzedSkin(
  revisionId: string,
  fetcher: Fetcher = fetch,
): Promise<ApiAnalyzedSkin> {
  const body = await requestJson<{ readonly analyzedSkin: ApiAnalyzedSkin }>(
    `/api/analyzed-skins/${encodeURIComponent(revisionId)}/restore`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    },
    fetcher,
  );
  return body.analyzedSkin;
}

export async function exportRevisionBundle(
  revisionId: string,
  input: {
    readonly name?: string;
    readonly kind: AggregateKind;
    readonly componentIds: readonly string[];
    readonly sourceGroupKey?: string;
  },
  fetcher: Fetcher = fetch,
): Promise<ApiPartBundle> {
  const body = await requestJson<{ readonly bundle: ApiPartBundle }>(
    `/api/revisions/${encodeURIComponent(revisionId)}/export-bundle`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
    fetcher,
  );
  return body.bundle;
}

export async function listPartBundles(
  options: {
    readonly kind?: AggregateKind;
    readonly status?: ApiLibraryStatusFilter;
    readonly projectId?: string;
    readonly sourceRevisionId?: string;
    readonly query?: string;
  } = {},
  fetcher: Fetcher = fetch,
): Promise<readonly ApiPartBundle[]> {
  const query = new URLSearchParams();
  if (options.kind) query.set("kind", options.kind);
  if (options.status) query.set("status", options.status);
  if (options.projectId) query.set("projectId", options.projectId);
  if (options.sourceRevisionId) {
    query.set("sourceRevisionId", options.sourceRevisionId);
  }
  if (options.query) query.set("q", options.query);
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  const body = await requestJson<{ readonly bundles: readonly ApiPartBundle[] }>(
    `/api/part-bundles${suffix}`,
    undefined,
    fetcher,
  );
  return body.bundles;
}

export async function retirePartBundle(
  bundleId: string,
  reason?: string,
  fetcher: Fetcher = fetch,
): Promise<ApiPartBundle> {
  const body = await requestJson<{ readonly bundle: ApiPartBundle }>(
    `/api/part-bundles/${encodeURIComponent(bundleId)}/retire`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reason?.trim() ? { reason: reason.trim() } : {}),
    },
    fetcher,
  );
  return body.bundle;
}

export async function restorePartBundle(
  bundleId: string,
  fetcher: Fetcher = fetch,
): Promise<ApiPartBundle> {
  const body = await requestJson<{ readonly bundle: ApiPartBundle }>(
    `/api/part-bundles/${encodeURIComponent(bundleId)}/restore`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    },
    fetcher,
  );
  return body.bundle;
}

export async function revisePartBundle(
  bundleId: string,
  input: {
    readonly name?: string;
    readonly replacements: readonly {
      readonly memberPartId: string;
      readonly replacementPartId: string;
    }[];
    readonly reason?: string;
  },
  fetcher: Fetcher = fetch,
): Promise<{
  readonly bundle: ApiPartBundle;
  readonly retiredBundle: ApiPartBundle;
}> {
  return requestJson(
    `/api/part-bundles/${encodeURIComponent(bundleId)}/revise`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
    fetcher,
  );
}

export async function loadPartBundle(
  bundleId: string,
  fetcher: Fetcher = fetch,
): Promise<ApiPartBundle> {
  const body = await requestJson<{ readonly bundle: ApiPartBundle }>(
    `/api/part-bundles/${encodeURIComponent(bundleId)}`,
    undefined,
    fetcher,
  );
  return body.bundle;
}

export function partBundlePreviewUrl(bundleId: string): string {
  return `/api/part-bundles/${encodeURIComponent(bundleId)}/preview.png`;
}

export function partBundleMannequinUrl(
  bundleId: string,
  armType: ArmType,
): string {
  return `/api/part-bundles/${encodeURIComponent(bundleId)}/mannequin.png?armType=${armType}`;
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

export function partTextureUrl(partId: string): string {
  return `/api/parts/${encodeURIComponent(partId)}/texture.png`;
}

export function partMannequinUrl(partId: string, armType: ArmType): string {
  return `/api/parts/${encodeURIComponent(partId)}/mannequin.png?armType=${armType}`;
}

export async function listPartEdits(
  basePartId?: string,
  fetcher: Fetcher = fetch,
): Promise<readonly ApiPartEditProject[]> {
  const query = basePartId
    ? `?basePartId=${encodeURIComponent(basePartId)}`
    : "";
  const body = await requestJson<{
    readonly partEdits: readonly ApiPartEditProject[];
  }>(`/api/part-edits${query}`, undefined, fetcher);
  return body.partEdits;
}

export async function createPartEdit(
  input: { readonly basePartId: string; readonly name?: string },
  fetcher: Fetcher = fetch,
): Promise<ApiPartEditDetail> {
  const body = await requestJson<{ readonly partEdit: ApiPartEditDetail }>(
    "/api/part-edits",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
    fetcher,
  );
  return body.partEdit;
}

export async function loadPartEdit(
  projectId: string,
  fetcher: Fetcher = fetch,
): Promise<ApiPartEditDetail> {
  const body = await requestJson<{ readonly partEdit: ApiPartEditDetail }>(
    `/api/part-edits/${encodeURIComponent(projectId)}`,
    undefined,
    fetcher,
  );
  return body.partEdit;
}

export async function applyPartEditOperation(
  projectId: string,
  input: {
    readonly headRevisionId: string;
    readonly operation: ApiPartEditOperation;
    readonly summary?: string;
  },
  fetcher: Fetcher = fetch,
): Promise<ApiPartEditDetail> {
  const body = await requestJson<{ readonly partEdit: ApiPartEditDetail }>(
    `/api/part-edits/${encodeURIComponent(projectId)}/operations`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
    fetcher,
  );
  return body.partEdit;
}

export async function commitPartEdit(
  projectId: string,
  input: { readonly headRevisionId: string; readonly name?: string },
  fetcher: Fetcher = fetch,
): Promise<{ readonly partEdit: ApiPartEditDetail; readonly part: ApiPart }> {
  return requestJson(
    `/api/part-edits/${encodeURIComponent(projectId)}/commit`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
    fetcher,
  );
}

export function partEditTextureUrl(revisionId: string): string {
  return `/api/part-edit-revisions/${encodeURIComponent(revisionId)}/texture.png`;
}

export function partEditWriteMaskUrl(revisionId: string): string {
  return `/api/part-edit-revisions/${encodeURIComponent(revisionId)}/write-mask.png`;
}

export function partEditMannequinUrl(
  revisionId: string,
  armType: ArmType,
): string {
  return `/api/part-edit-revisions/${encodeURIComponent(revisionId)}/mannequin.png?armType=${armType}`;
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

export function applyCompositionBundle(
  compositionId: string,
  bundleId: string,
  position?: number,
  fetcher: Fetcher = fetch,
): Promise<ApiCompositionDetail> {
  return requestJson(
    `/api/compositions/${encodeURIComponent(compositionId)}/apply-bundle`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bundleId,
        ...(position === undefined ? {} : { position }),
      }),
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

export function generateCompositionRestorationCandidates(
  compositionId: string,
  input: {
    readonly targetComponentIds: readonly string[];
    readonly donorRevisionId?: string;
    readonly manualRgba?: Rgba;
  },
  fetcher: Fetcher = fetch,
): Promise<ApiCompositionRestorationCandidates> {
  return requestJson(
    `/api/compositions/${encodeURIComponent(compositionId)}/restoration-candidates`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
    fetcher,
  );
}

export function setCompositionRestorationPlan(
  compositionId: string,
  input: {
    readonly expectedVersion: number;
    readonly candidateSetHash: string;
    readonly candidateIds: readonly string[];
    readonly targetComponentIds: readonly string[];
    readonly donorRevisionId?: string;
    readonly manualRgba?: Rgba;
  },
  fetcher: Fetcher = fetch,
): Promise<ApiCompositionDetail> {
  return requestJson(
    `/api/compositions/${encodeURIComponent(compositionId)}/restoration-plan`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
    fetcher,
  );
}

export function clearCompositionRestorationPlan(
  compositionId: string,
  expectedVersion: number,
  fetcher: Fetcher = fetch,
): Promise<ApiCompositionDetail> {
  return requestJson(
    `/api/compositions/${encodeURIComponent(compositionId)}/restoration-plan`,
    {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion }),
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

export function revisionSkinUrl(revisionId: string): string {
  return `/api/revisions/${encodeURIComponent(revisionId)}/skin.png`;
}

export async function startCompletionProposal(
  revisionId: string,
  input: StartCompletionProposalInput,
  fetcher: Fetcher = fetch,
): Promise<ApiAiJob> {
  const body = await requestJson<{ job: ApiAiJob }>(
    `/api/revisions/${encodeURIComponent(revisionId)}/completion-proposals`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
    fetcher,
  );
  return body.job;
}

export async function listCompletionProposals(
  filters: ApiCompletionProposalListFilters = {},
  fetcher: Fetcher = fetch,
): Promise<readonly ApiCompletionProposalSummary[]> {
  const query = new URLSearchParams();
  if (filters.projectId) query.set("projectId", filters.projectId);
  if (filters.revisionId) query.set("revisionId", filters.revisionId);
  if (filters.jobId) query.set("jobId", filters.jobId);
  if (filters.representation) {
    query.set("representation", filters.representation);
  }
  if (filters.status) query.set("status", filters.status);
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  const body = await requestJson<{
    readonly proposals: readonly ApiCompletionProposalSummary[];
  }>(`/api/completion-proposals${suffix}`, undefined, fetcher);
  return body.proposals;
}

export function loadCompletionProposal(
  proposalId: string,
  fetcher: Fetcher = fetch,
): Promise<ApiCompletionProposalDetail> {
  return requestJson(
    `/api/completion-proposals/${encodeURIComponent(proposalId)}`,
    undefined,
    fetcher,
  );
}

export function completionAllowedMaskUrl(proposalId: string): string {
  return `/api/completion-proposals/${encodeURIComponent(proposalId)}/allowed-mask.png`;
}

export function completionCandidateDocumentUrl(
  proposalId: string,
  candidateId: string,
): string {
  return completionCandidateAssetUrl(proposalId, candidateId, "candidate.json");
}

export function loadCompletionCandidateDocument(
  proposalId: string,
  candidateId: string,
  fetcher: Fetcher = fetch,
): Promise<CompletionCandidateDocument> {
  return requestJson(
    completionCandidateDocumentUrl(proposalId, candidateId),
    undefined,
    fetcher,
  );
}

export function completionCandidateTextureUrl(
  proposalId: string,
  candidateId: string,
): string {
  return completionCandidateAssetUrl(proposalId, candidateId, "texture.png");
}

export function completionCandidateWriteMaskUrl(
  proposalId: string,
  candidateId: string,
): string {
  return completionCandidateAssetUrl(proposalId, candidateId, "write-mask.png");
}

export function completionCandidateGeneratedMaskUrl(
  proposalId: string,
  candidateId: string,
): string {
  return completionCandidateAssetUrl(
    proposalId,
    candidateId,
    "generated-mask.png",
  );
}

export function acceptCompletionCandidate(
  proposal: ApiCompletionProposal,
  candidate: ApiCompletionCandidate,
  input: {
    readonly actorId?: string;
    readonly summary?: string;
  } = {},
  fetcher: Fetcher = fetch,
): Promise<ApiCompletionDecisionOutcome> {
  return requestJson(
    `/api/completion-proposals/${encodeURIComponent(proposal.id)}/candidates/${encodeURIComponent(candidate.id)}/accept`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedSourceResultHash: proposal.sourceResultHash,
        expectedProposalHash: proposal.proposalHash,
        expectedEvidenceHash: proposal.evidenceHash,
        expectedCandidateHash: candidate.candidateHash,
        ...input,
      }),
    },
    fetcher,
  );
}

export function editCompletionCandidate(
  proposal: ApiCompletionProposal,
  candidate: ApiCompletionCandidate,
  edits: readonly ApiCompletionCandidateEdit[],
  input: { readonly actorId?: string } = {},
  fetcher: Fetcher = fetch,
): Promise<ApiCompletionCandidateEditOutcome> {
  if (edits.length < 1 || edits.length > 256) {
    throw new RangeError("Completion candidate edits must contain 1-256 pixels");
  }
  return requestJson(
    `/api/completion-proposals/${encodeURIComponent(proposal.id)}/candidates/${encodeURIComponent(candidate.id)}/edits`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedSourceResultHash: proposal.sourceResultHash,
        expectedProposalHash: proposal.proposalHash,
        expectedEvidenceHash: proposal.evidenceHash,
        expectedCandidateHash: candidate.candidateHash,
        ...input,
        edits,
      }),
    },
    fetcher,
  );
}

export function publishCompletionResult(
  result: ApiCompletionResult,
  input: { readonly actorId?: string } = {},
  fetcher: Fetcher = fetch,
): Promise<ApiCompletionPublishOutcome> {
  if (result.representation !== "latent_component" || !result.latentPart) {
    throw new TypeError("Only latent Completion Parts can be published");
  }
  return requestJson(
    `/api/completion-results/${encodeURIComponent(result.id)}/publish`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedResultHash: result.resultHash,
        expectedPartId: result.latentPart.id,
        ...input,
      }),
    },
    fetcher,
  );
}

export function rejectCompletionProposal(
  proposal: ApiCompletionProposal,
  input: {
    readonly actorId?: string;
    readonly reason?: string;
  } = {},
  fetcher: Fetcher = fetch,
): Promise<ApiCompletionDecisionOutcome> {
  return requestJson(
    `/api/completion-proposals/${encodeURIComponent(proposal.id)}/reject`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedSourceResultHash: proposal.sourceResultHash,
        expectedProposalHash: proposal.proposalHash,
        expectedEvidenceHash: proposal.evidenceHash,
        ...input,
      }),
    },
    fetcher,
  );
}

export async function listAiProviders(
  fetcher: Fetcher = fetch,
): Promise<{
  readonly providers: readonly string[];
  readonly restorationRecommendationProviders: readonly string[];
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

export async function startAiRestorationRecommendation(
  compositionId: string,
  input: StartAiRestorationRecommendationInput,
  fetcher: Fetcher = fetch,
): Promise<ApiAiJob> {
  const body = await requestJson<{ job: ApiAiJob }>(
    `/api/compositions/${encodeURIComponent(compositionId)}/ai-restoration-recommendation`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
    fetcher,
  );
  return body.job;
}

export async function listAiJobs(
  filtersOrRevisionId?: ApiAiJobListFilters | string,
  fetcher: Fetcher = fetch,
): Promise<readonly ApiAiJob[]> {
  const filters = typeof filtersOrRevisionId === "string"
    ? { revisionId: filtersOrRevisionId }
    : (filtersOrRevisionId ?? {});
  const queryParts = [
    filters.revisionId
      ? `revisionId=${encodeURIComponent(filters.revisionId)}`
      : null,
    filters.kind ? `kind=${encodeURIComponent(filters.kind)}` : null,
    filters.compositionId
      ? `compositionId=${encodeURIComponent(filters.compositionId)}`
      : null,
  ].filter((part): part is string => Boolean(part));
  const query = queryParts.length > 0 ? `?${queryParts.join("&")}` : "";
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
    readonly semanticBaseline?: ApiAiAnalysisOptions["semanticBaseline"];
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

export async function applySemanticFollowup(
  jobId: string,
  suggestionId: string,
  fetcher: Fetcher = fetch,
): Promise<ApiAiJobDetail> {
  return requestJson(
    `/api/ai-jobs/${encodeURIComponent(jobId)}/semantic-followup/apply`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ suggestionId }),
    },
    fetcher,
  );
}

export async function dismissSemanticFollowup(
  jobId: string,
  fetcher: Fetcher = fetch,
): Promise<ApiAiJobDetail> {
  return requestJson(
    `/api/ai-jobs/${encodeURIComponent(jobId)}/semantic-followup/dismiss`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    },
    fetcher,
  );
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

function completionCandidateAssetUrl(
  proposalId: string,
  candidateId: string,
  fileName:
    | "candidate.json"
    | "texture.png"
    | "write-mask.png"
    | "generated-mask.png",
): string {
  return `/api/completion-proposals/${encodeURIComponent(proposalId)}/candidates/${encodeURIComponent(candidateId)}/${fileName}`;
}
