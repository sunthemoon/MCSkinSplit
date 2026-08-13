import type {
  AggregateKind,
  ArmType,
  ManualSemanticOperation,
  PartRepairCopyMapping,
  PartRepairOperation,
  PartRepairOverwriteMode,
  PartApplicationReport,
  PartManifest,
  SemanticComponent,
  SemanticState,
} from "@mc-skin-split/skin-core";
import type {
  CompositionReport,
  CompositionResolutionMode,
} from "@mc-skin-split/skin-compositor";

export const OPERATION_TYPES = [
  "import",
  "ai_segment",
  "manual_edit",
  "merge_components",
  "split_component",
  "reclassify_component",
  "apply_part",
  "compose",
  "palette_change",
  "revert",
  "branch",
] as const;

export type RevisionOperationType = (typeof OPERATION_TYPES)[number];
export type ActorType = "user" | "ai" | "system";

export interface SkinProject {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly defaultBranchId: string;
  readonly headRevisionId: string | null;
  readonly settings: Readonly<Record<string, unknown>>;
}

export interface SkinBranch {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly baseRevisionId: string | null;
  readonly headRevisionId: string | null;
  readonly createdAt: string;
}

export interface SkinRevision {
  readonly id: string;
  readonly projectId: string;
  readonly parentRevisionId: string | null;
  readonly branchId: string;
  readonly branchName: string;
  readonly sequence: number;
  readonly operationType: RevisionOperationType;
  readonly actorType: ActorType;
  readonly actorId?: string;
  readonly aiRunId?: string;
  readonly createdAt: string;
  readonly summary: string;
  readonly skinAssetId: string;
  readonly segmentationAssetId: string;
  readonly operationAssetId: string;
  readonly sourceHash: string;
  readonly resultHash: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly isBranchHead: boolean;
}

export interface SkinAsset {
  readonly id: string;
  readonly projectId: string;
  readonly revisionId: string;
  readonly assetType:
    | "revision_skin"
    | "segmentation_json"
    | "component_mask"
    | "operation_json";
  readonly storagePath: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly createdAt: string;
}

export interface SegmentationSnapshot {
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

export interface OperationSnapshot {
  readonly schemaVersion: "1.0";
  readonly type: RevisionOperationType;
  readonly inputRevisionId: string | null;
  readonly outputRevisionId: string;
  readonly actor: {
    readonly type: ActorType;
    readonly id?: string;
  };
  readonly createdAt: string;
  readonly summary: string;
  readonly affectedComponents: readonly string[];
  readonly affectedSpans: readonly unknown[];
  readonly beforeHash: string | null;
  readonly afterHash: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface SnapshotChecksum {
  readonly schemaVersion: "1.0";
  readonly revisionId: string;
  readonly files: Readonly<Record<string, string>>;
}

export interface CreateProjectInput {
  readonly name: string;
}

export interface CreateProjectResult {
  readonly project: SkinProject;
  readonly branch: SkinBranch;
}

export interface ImportSkinInput {
  readonly skinPng: Uint8Array;
  readonly fileName?: string;
  readonly armType?: ArmType;
  readonly actorId?: string;
  readonly summary?: string;
}

export interface ImportProjectInput extends ImportSkinInput {
  readonly name: string;
}

export interface ImportProjectResult {
  readonly project: SkinProject;
  readonly branch: SkinBranch;
  readonly revision: SkinRevision;
  readonly armType: ArmType;
  readonly warnings: readonly string[];
}

export interface RevertRevisionInput {
  readonly branchId?: string;
  readonly actorId?: string;
  readonly summary?: string;
}

export interface BranchFromRevisionInput {
  readonly name: string;
  readonly actorId?: string;
  readonly summary?: string;
}

export interface RevisionMutationResult {
  readonly project: SkinProject;
  readonly branch: SkinBranch;
  readonly revision: SkinRevision;
}

export interface ManualRevisionOperationInput {
  readonly operation: ManualSemanticOperation;
  readonly branchId?: string;
  readonly actorId?: string;
  readonly summary?: string;
}

export interface AiSegmentationRevisionInput {
  readonly state: SemanticState;
  readonly aiJobId: string;
  readonly aiRunId: string;
  readonly provider: string;
  readonly model: string;
  readonly proposalSummary: string;
  readonly reviewItems: readonly unknown[];
  readonly summary?: string;
}

export interface ExportPartInput {
  readonly name?: string;
}

export interface ExportPartBundleInput {
  readonly name?: string;
  readonly kind: AggregateKind;
  readonly componentIds: readonly string[];
  readonly sourceGroupKey?: string;
}

export interface PartFileAsset {
  readonly id: string;
  readonly storagePath: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly sha256: string;
}

export type LibraryStatus = "active" | "retired";
export type LibraryStatusFilter = LibraryStatus | "all";

export interface PartLibraryQuery {
  readonly status?: LibraryStatusFilter;
  readonly projectId?: string;
  readonly sourceRevisionId?: string;
  readonly q?: string;
  readonly category?: PartManifest["category"];
}

export interface PartBundleLibraryQuery {
  readonly status?: LibraryStatusFilter;
  readonly projectId?: string;
  readonly sourceRevisionId?: string;
  readonly q?: string;
  readonly kind?: AggregateKind;
}

export interface RevisePartBundleInput {
  readonly name?: string;
  readonly replacements: readonly {
    readonly memberPartId: string;
    readonly replacementPartId: string;
  }[];
  readonly reason?: string;
}

export interface RevisePartBundleResult {
  readonly bundle: PartBundle;
  readonly retiredBundle: PartBundle;
}

export interface SkinPart {
  readonly id: string;
  readonly sourceProjectId: string;
  readonly sourceRevisionId: string;
  readonly sourceComponentId: string;
  readonly sourceProjectName: string;
  readonly sourceBranchName: string;
  readonly sourceRevisionSequence: number;
  readonly name: string;
  readonly category: PartManifest["category"];
  readonly subtype?: string;
  readonly armType: ArmType;
  readonly manifest: PartManifest;
  readonly texture: PartFileAsset;
  readonly writeMask: PartFileAsset;
  readonly manifestFile: PartFileAsset;
  readonly preview: PartFileAsset;
  readonly source: PartFileAsset;
  readonly createdAt: string;
  readonly libraryStatus: LibraryStatus;
  readonly retiredAt: string | null;
  readonly retiredReason: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export type PartEditStatus = "draft" | "committed";
export type PartEditOperationType = PartRepairOperation["type"] | "init";

export type SerializedPartRepairOperation =
  | Extract<PartRepairOperation, { readonly type: "paint_color" }>
  | Extract<PartRepairOperation, { readonly type: "erase_pixels" }>
  | Extract<PartRepairOperation, { readonly type: "replace_color" }>
  | {
      readonly type: "copy_surfaces";
      readonly source:
        | { readonly kind: "part"; readonly partId: string }
        | { readonly kind: "edit_revision"; readonly revisionId: string };
      readonly mappings: readonly PartRepairCopyMapping[];
      readonly overwrite?: PartRepairOverwriteMode;
    };

export interface PartEditProject {
  readonly id: string;
  readonly basePartId: string;
  readonly name: string;
  readonly status: PartEditStatus;
  readonly headRevisionId: string;
  readonly resultPartId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly committedAt: string | null;
}

export interface PartEditRevision {
  readonly id: string;
  readonly projectId: string;
  readonly parentRevisionId: string | null;
  readonly sequence: number;
  readonly operationType: PartEditOperationType;
  readonly operation: Readonly<Record<string, unknown>>;
  readonly summary: string;
  readonly actorId?: string;
  readonly texture: PartFileAsset;
  readonly writeMask: PartFileAsset;
  readonly revisionFile: PartFileAsset;
  readonly changedPixelCount: number;
  readonly authoredProvenance: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface PartEditDetail {
  readonly project: PartEditProject;
  readonly basePart: SkinPart;
  readonly headRevision: PartEditRevision;
  readonly revisions: readonly PartEditRevision[];
  readonly resultPart: SkinPart | null;
}

export interface CreatePartEditProjectInput {
  readonly basePartId: string;
  readonly name?: string;
}

export interface ApplyPartEditOperationInput {
  readonly headRevisionId: string;
  readonly operation: SerializedPartRepairOperation;
  readonly actorId?: string;
  readonly summary?: string;
}

export interface CommitPartEditProjectInput {
  readonly headRevisionId: string;
  readonly name?: string;
  readonly actorId?: string;
  readonly summary?: string;
}

export interface CommitPartEditProjectResult {
  readonly project: PartEditProject;
  readonly revision: PartEditRevision;
  readonly part: SkinPart;
}

export interface PartBundleMember {
  readonly bundleId: string;
  readonly partId: string;
  readonly position: number;
  readonly part: SkinPart;
  readonly createdAt: string;
}

export interface PartBundle {
  readonly id: string;
  readonly sourceProjectId: string;
  readonly sourceRevisionId: string;
  readonly sourceProjectName: string;
  readonly sourceBranchName: string;
  readonly sourceRevisionSequence: number;
  readonly name: string;
  readonly kind: AggregateKind;
  readonly sourceGroupKey: string | null;
  readonly armTypes: readonly ArmType[];
  readonly members: readonly PartBundleMember[];
  readonly createdAt: string;
  readonly libraryStatus: LibraryStatus;
  readonly retiredAt: string | null;
  readonly retiredReason: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface AnalyzedSkinGroup {
  readonly key: string;
  readonly sourceGroupKey: string | null;
  readonly kind: AggregateKind;
  readonly displayName: string;
  readonly componentIds: readonly string[];
  readonly componentCount: number;
  readonly pixelCount: number;
  readonly exportedBundleId: string | null;
}

export interface AnalyzedSkinCatalogItem {
  readonly project: Pick<SkinProject, "id" | "name">;
  readonly revision: Pick<
    SkinRevision,
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
  readonly groups: readonly AnalyzedSkinGroup[];
  readonly skinUrl: string;
}

export interface AnalyzedSkinCatalogQuery {
  readonly projectId?: string;
  readonly kind?: AggregateKind;
  readonly query?: string;
}

export interface PartApplicationPreview {
  readonly revisionId: string;
  readonly part: SkinPart;
  readonly report: PartApplicationReport;
}

export interface ApplyPartInput {
  readonly partId: string;
  readonly strategy: "use_part" | "keep_base";
  readonly branchId?: string;
  readonly actorId?: string;
  readonly summary?: string;
}

export interface ApplyPartResult extends RevisionMutationResult {
  readonly part: SkinPart;
  readonly report: PartApplicationReport;
}

export type CompositionStatus = "draft" | "committed";

export interface CompositionProject {
  readonly id: string;
  readonly projectId: string;
  readonly baseRevisionId: string;
  readonly branchId: string;
  readonly name: string;
  readonly armType: ArmType;
  readonly status: CompositionStatus;
  readonly resolutionMode: CompositionResolutionMode;
  readonly conflictWinners: Readonly<Record<string, string>>;
  readonly report: CompositionReport;
  /** Monotonic optimistic-concurrency version, including cleared plans. */
  readonly restorationVersion: number;
  readonly restorationPlan: CompositionRestorationPlanSummary | null;
  readonly resultRevisionId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly committedAt: string | null;
}

export type CompositionRestorationCandidateKind =
  | "outer_transparent"
  | "current_same_surface"
  | "current_same_body_part"
  | "mirrored_counterpart"
  | "donor_revision"
  | "manual_rgba";

export interface CompositionRestorationCandidateSummary {
  readonly id: string;
  readonly kind: CompositionRestorationCandidateKind;
  readonly targetGroupId: string;
  readonly label: string;
  readonly description: string;
  readonly pixelCount: number;
  readonly coveragePixelCount: number;
  readonly sourceRevisionId?: string;
  readonly rgba?: readonly [number, number, number, number];
  readonly selectedByDefault?: boolean;
}

export interface CompositionRestorationCandidates {
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
    readonly candidates: readonly CompositionRestorationCandidateSummary[];
  };
}

export interface CompositionRestorationPlanSummary {
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

export interface PersistedCompositionRestorationPlan {
  readonly storageHash: string;
  readonly summary: CompositionRestorationPlanSummary;
  readonly operations: readonly PersistedCompositionRestorationOperation[];
  readonly selectedCandidates: readonly PersistedCompositionRestorationCandidate[];
  readonly requestedPixelIds: readonly number[];
  readonly coveredPixelIds: readonly number[];
  readonly missingPixelIds: readonly number[];
}

export type PersistedCompositionRestorationOperation =
  | {
      readonly operationId: string;
      readonly mode: "clear_outer";
      readonly pixelIds: readonly number[];
    }
  | {
      readonly operationId: string;
      readonly mode: "fill_base";
      readonly pixelIds: readonly number[];
      readonly rgba: readonly [number, number, number, number];
    };

export interface GenerateCompositionRestorationCandidatesInput {
  readonly targetComponentIds: readonly string[];
  readonly donorRevisionId?: string;
  readonly manualRgba?: readonly [number, number, number, number];
}

export interface SetCompositionRestorationPlanInput {
  readonly expectedVersion: number;
  readonly candidateSetHash: string;
  readonly candidateIds: readonly string[];
  readonly targetComponentIds: readonly string[];
  readonly donorRevisionId?: string;
  readonly manualRgba?: readonly [number, number, number, number];
}

export interface ClearCompositionRestorationPlanInput {
  readonly expectedVersion: number;
}

export interface CompositionRestorationEvent {
  readonly id: number;
  readonly compositionId: string;
  readonly version: number;
  readonly eventType: "plan_set" | "plan_cleared";
  readonly candidateSetHash: string | null;
  readonly candidateIds: readonly string[];
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface PersistedCompositionRestorationCandidate {
  readonly candidateId: string;
  readonly kind: CompositionRestorationCandidateKind;
  readonly targetGroupIds: readonly string[];
  readonly sampleRevisionId: string | null;
  readonly sourceComponentIds: readonly string[];
  readonly evidenceHash: string;
  readonly coveredPixelIds: readonly number[];
}

export interface CompositionLayer {
  readonly id: string;
  readonly compositionId: string;
  readonly partId: string;
  readonly position: number;
  readonly part: SkinPart;
  readonly createdAt: string;
}

export interface CompositionDetail {
  readonly composition: CompositionProject;
  readonly layers: readonly CompositionLayer[];
  readonly report: CompositionReport;
}

export interface CreateCompositionInput {
  readonly baseRevisionId: string;
  readonly branchId?: string;
  readonly name?: string;
}

export interface AddCompositionPartInput {
  readonly partId: string;
  readonly position?: number;
}

export interface AddCompositionBundleInput {
  readonly bundleId: string;
  readonly position?: number;
}

export interface ReorderCompositionLayersInput {
  readonly layerIds: readonly string[];
}

export type ResolveCompositionConflictInput =
  | { readonly strategy: "layer_order" }
  | {
      readonly strategy: "winner";
      readonly conflictId: string;
      readonly winnerLayerId: string;
    }
  | { readonly strategy: "clear" };

export interface CommitCompositionInput {
  readonly actorId?: string;
  readonly summary?: string;
}

export interface CommitCompositionResult extends RevisionMutationResult {
  readonly composition: CompositionProject;
  readonly report: CompositionReport;
}

export interface RevisionDiff {
  readonly fromRevisionId: string;
  readonly toRevisionId: string;
  readonly changedPixelCount: number;
  readonly changedPixelIds: readonly number[];
  readonly boundingBox: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  } | null;
}

export type RevisionIdKind =
  | "project"
  | "branch"
  | "revision"
  | "asset"
  | "operation"
  | "part"
  | "part_bundle"
  | "part_edit"
  | "part_edit_revision"
  | "composition"
  | "composition_layer";

export interface RevisionStoreOptions {
  readonly dataDirectory: string;
  readonly databasePath?: string;
  readonly now?: () => Date | string;
  readonly createId?: (kind: RevisionIdKind) => string;
}
