import type { ArmType } from "@mc-skin-split/skin-core";

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
  readonly assetType: "revision_skin" | "segmentation_json" | "operation_json";
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
  readonly components: readonly unknown[];
  readonly unknown: {
    readonly maskFile: null;
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
  readonly files: Readonly<Record<"skin.png" | "segmentation.json" | "operation.json", string>>;
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
  | "operation";

export interface RevisionStoreOptions {
  readonly dataDirectory: string;
  readonly databasePath?: string;
  readonly now?: () => Date | string;
  readonly createId?: (kind: RevisionIdKind) => string;
}
