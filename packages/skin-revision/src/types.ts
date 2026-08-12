import type {
  AggregateKind,
  ArmType,
  ManualSemanticOperation,
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

export interface SkinPart {
  readonly id: string;
  readonly sourceProjectId: string;
  readonly sourceRevisionId: string;
  readonly sourceComponentId: string;
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
  readonly metadata: Readonly<Record<string, unknown>>;
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
  readonly name: string;
  readonly kind: AggregateKind;
  readonly sourceGroupKey: string | null;
  readonly armTypes: readonly ArmType[];
  readonly members: readonly PartBundleMember[];
  readonly createdAt: string;
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
  readonly resultRevisionId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly committedAt: string | null;
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
  | "composition"
  | "composition_layer";

export interface RevisionStoreOptions {
  readonly dataDirectory: string;
  readonly databasePath?: string;
  readonly now?: () => Date | string;
  readonly createId?: (kind: RevisionIdKind) => string;
}
