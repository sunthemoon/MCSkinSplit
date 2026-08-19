import { createRgbaImage } from "../image";
import { getSkinLayout } from "../layouts/layout";
import {
  SKIN_HEIGHT,
  SKIN_WIDTH,
  type BodyPart,
  type Face,
  type Layer,
  type Rgba,
  type RgbaImage,
  type SkinLayout,
  type SurfaceKey,
  type SurfaceTexel,
} from "../types";
import { assertSkinImage, buildSurfaceTexels } from "../uv/surface-model";
import {
  assignSemanticPixelsWithProvenance,
  rebaseSemanticStateImage,
  synchronizeSemanticPixelOriginSummaries,
  validateSemanticState,
} from "./editor";
import {
  assertMask,
  maskToPixelIds,
  pixelIdsToMask,
  pixelIdsToSpans,
} from "./mask";
import {
  createCopiedPixelOriginAssignments,
  createGeneratedPixelOriginAssignment,
  createManualPixelOriginAssignment,
  deriveGeneratedPixelMask,
  propagatePixelOriginDocument,
  validatePixelOriginDocument,
} from "./origin";
import { aggregateKindForCategory } from "./taxonomy";
import type {
  PixelOriginActor,
  PixelOriginAssignment,
  PixelOriginDocument,
  PixelOriginSubject,
  SemanticPixelSpan,
  SemanticState,
} from "./types";

export const COMPLETION_PROPOSAL_SCHEMA_VERSION = "1.0" as const;
export const COMPLETION_CANDIDATE_ALGORITHM_VERSION =
  "completion-candidates-v1" as const;

/** Public, explicit limits for untrusted proposal and edit material. */
export const MAX_COMPLETION_OCCLUDING_COMPONENTS = 32;
export const MAX_COMPLETION_PROPOSAL_CANDIDATES = 16;
export const MAX_COMPLETION_ALLOWED_PIXELS = 1024;
export const MAX_COMPLETION_CANDIDATE_PIXELS = 1024;
export const MAX_COMPLETION_PIXEL_EDITS = 256;

export type CompletionTargetRepresentation =
  | "skin_texel"
  | "latent_component";
export type CompletionRequestedRepresentation =
  | "auto"
  | CompletionTargetRepresentation;
export type CompletionCandidateStrategy =
  | "opposite_layer_underlay"
  | "mirrored_counterpart"
  | "same_surface_continuation"
  | "opposite_surface_reference"
  | "neighbor_reference"
  | "pattern_continuation"
  | "manual_edit";
export type CompletionConfidence = "high" | "medium" | "low" | "manual";
export type CompletionPixelOriginMode =
  | "generated_completion"
  | "generated_completion_with_copy"
  | "manual_authored";
export type CompletionHashCanonical = (canonicalJson: string) => string;

export interface CompletionSourceSnapshot {
  readonly sourceRevisionId: string;
  readonly sourceResultHash: string;
  readonly sourceSkinHash: string;
  readonly image: RgbaImage;
  readonly semanticState: SemanticState;
  readonly originDocument: PixelOriginDocument;
}

export interface GenerateCompletionProposalCandidatesInput
  extends CompletionSourceSnapshot {
  /** Caller-scoped immutable identity; hashes remain reusable content fingerprints. */
  readonly proposalId: string;
  readonly targetComponentId: string;
  readonly occludingComponentIds: readonly string[];
  readonly representation: CompletionRequestedRepresentation;
  readonly hashCanonical: CompletionHashCanonical;
}

export interface CompletionPixelAssignmentDescriptor {
  readonly targetPixelId: number;
  readonly rgba: Rgba;
  readonly originMode: CompletionPixelOriginMode;
  /** Visible reference pixels used by the deterministic strategy. */
  readonly samplePixelIds: readonly number[];
  /** Optional immediate sample lineage for a newly generated hidden texel. */
  readonly sourcePixelId: number | null;
  readonly sourceComponentInstanceId: string | null;
  /** Present only for a pixel whose candidate value was actually user-edited. */
  readonly manualActor: PixelOriginActor | null;
  readonly manualOperationId: string | null;
}

export interface CompletionCandidateEvidence {
  readonly schemaVersion: "1.0";
  readonly algorithmVersion: typeof COMPLETION_CANDIDATE_ALGORITHM_VERSION;
  readonly proposalEvidenceHash: string;
  readonly sourceRevisionId: string;
  readonly sourceResultHash: string;
  readonly sourceSkinHash: string;
  readonly targetComponentId: string;
  readonly occludingComponentIds: readonly string[];
  readonly representation: CompletionTargetRepresentation;
  readonly strategy: CompletionCandidateStrategy;
  readonly baseCandidateId: string | null;
  readonly assignments: readonly CompletionPixelAssignmentDescriptor[];
}

export interface CompletionCandidateDocument {
  readonly schemaVersion: "1.0";
  readonly algorithmVersion: typeof COMPLETION_CANDIDATE_ALGORITHM_VERSION;
  readonly candidateId: string;
  readonly representation: CompletionTargetRepresentation;
  readonly strategy: CompletionCandidateStrategy;
  readonly targetComponentId: string;
  readonly occludingComponentIds: readonly string[];
  readonly baseCandidateId: string | null;
  readonly assignments: readonly CompletionPixelAssignmentDescriptor[];
  readonly pixelIds: readonly number[];
  readonly spans: readonly SemanticPixelSpan[];
  readonly pixelCount: number;
  readonly missingPixelIds: readonly number[];
  readonly missingPixelCount: number;
  readonly complete: boolean;
  readonly confidence: CompletionConfidence;
  readonly confidenceScore: number | null;
  readonly reviewRequired: true;
  readonly automaticAcceptanceAllowed: false;
  readonly evidence: CompletionCandidateEvidence;
  readonly evidenceHash: string;
  readonly candidateHash: string;
}

export interface CompletionCandidate extends CompletionCandidateDocument {
  /** Materialized from assignments and excluded from canonical JSON. */
  readonly texture: RgbaImage;
  readonly writeMask: Uint8Array;
  readonly generatedMask: Uint8Array;
}

export interface CompletionProposalEvidence {
  readonly schemaVersion: "1.0";
  readonly algorithmVersion: typeof COMPLETION_CANDIDATE_ALGORITHM_VERSION;
  readonly sourceRevisionId: string;
  readonly sourceResultHash: string;
  readonly sourceSkinHash: string;
  readonly armType: "wide" | "slim";
  readonly targetComponentId: string;
  readonly occludingComponentIds: readonly string[];
  readonly requestedRepresentation: CompletionRequestedRepresentation;
  readonly representation: CompletionTargetRepresentation;
  readonly allowedGeneratedPixelIds: readonly number[];
  readonly allowedGeneratedSpans: readonly SemanticPixelSpan[];
}

export interface CompletionProposalDocument {
  readonly schemaVersion: "1.0";
  readonly algorithmVersion: typeof COMPLETION_CANDIDATE_ALGORITHM_VERSION;
  readonly proposalId: string;
  readonly sourceRevisionId: string;
  readonly sourceResultHash: string;
  readonly sourceSkinHash: string;
  readonly armType: "wide" | "slim";
  readonly targetComponentId: string;
  readonly occludingComponentIds: readonly string[];
  readonly requestedRepresentation: CompletionRequestedRepresentation;
  readonly representation: CompletionTargetRepresentation;
  readonly allowedGeneratedPixelIds: readonly number[];
  readonly allowedGeneratedSpans: readonly SemanticPixelSpan[];
  readonly allowedGeneratedPixelCount: number;
  readonly evidence: CompletionProposalEvidence;
  readonly evidenceHash: string;
  readonly candidates: readonly CompletionCandidateDocument[];
  readonly proposalHash: string;
}

export interface CompletionProposal
  extends Omit<CompletionProposalDocument, "candidates"> {
  /** Host materialization, excluded from canonical JSON and public JSON DTOs. */
  readonly allowedGeneratedMask: Uint8Array;
  readonly candidates: readonly CompletionCandidate[];
}

export type CompletionCandidateEdit =
  | {
      readonly type: "set_pixel";
      readonly pixelId: number;
      readonly rgba: Rgba;
    }
  | {
      readonly type: "remove_pixel";
      readonly pixelId: number;
    };

export interface CompletionDecisionBase {
  readonly schemaVersion: "1.0";
  readonly decisionId: string;
  readonly proposalId: string;
  readonly proposalHash: string;
  readonly sourceRevisionId: string;
  readonly sourceResultHash: string;
  readonly sourceSkinHash: string;
  readonly actor: PixelOriginActor;
  readonly automatic: false;
  readonly decisionHash: string;
}

export interface CompletionAcceptDecision extends CompletionDecisionBase {
  readonly action: "accept";
  readonly candidateId: string;
  readonly candidateHash: string;
  readonly candidateEvidenceHash: string;
}

export interface CompletionRejectDecision extends CompletionDecisionBase {
  readonly action: "reject";
  readonly candidateId: null;
  readonly candidateHash: null;
  readonly candidateEvidenceHash: null;
}

export type CompletionDecision =
  | CompletionAcceptDecision
  | CompletionRejectDecision;

export interface CompletionCandidateMaterialization {
  readonly texture: RgbaImage;
  readonly writeMask: Uint8Array;
  readonly generatedMask: Uint8Array;
}

interface CompletionAcceptedResultBase {
  readonly originAssignments: readonly PixelOriginAssignment[];
  readonly originDocument: PixelOriginDocument;
  readonly writeMask: Uint8Array;
  readonly generatedMask: Uint8Array;
  readonly pixelIds: readonly number[];
  readonly pixelCount: number;
}

export interface CompletionSkinTexelAcceptResult
  extends CompletionAcceptedResultBase {
  readonly kind: "skin_texel";
  readonly sourceSkinChanged: true;
  readonly image: RgbaImage;
  readonly semanticDelta: CompletionSemanticDelta;
}

export interface CompletionLatentComponentAcceptResult
  extends CompletionAcceptedResultBase {
  readonly kind: "latent_component";
  readonly sourceSkinChanged: false;
  readonly texture: RgbaImage;
}

export type CompletionAcceptResult =
  | CompletionSkinTexelAcceptResult
  | CompletionLatentComponentAcceptResult;

export interface CompletionSemanticDelta {
  readonly targetComponentId: string;
  readonly addedPixelIds: readonly number[];
  readonly addedSpans: readonly SemanticPixelSpan[];
  readonly addedMask: Uint8Array;
}

export type CompletionDecisionTransformation =
  | {
      readonly status: "rejected";
      readonly sourceSkinChanged: false;
      readonly decision: CompletionDecision;
      readonly result: null;
    }
  | {
      readonly status: "accepted";
      readonly sourceSkinChanged: boolean;
      readonly decision: CompletionDecision;
      readonly result: CompletionAcceptResult;
    };

interface CompletionContext {
  readonly layout: SkinLayout;
  readonly texels: readonly SurfaceTexel[];
  readonly texelByPixel: ReadonlyMap<number, SurfaceTexel>;
  readonly texelByCoordinate: ReadonlyMap<string, SurfaceTexel>;
  readonly ownerByPixel: ReadonlyMap<number, string>;
  readonly targetPixelIds: ReadonlySet<number>;
  readonly targetTexels: readonly SurfaceTexel[];
  readonly targetSupportGroups: ReadonlySet<string>;
  readonly occluderPixelIds: readonly number[];
}

type AssignmentFactory = (
  target: SurfaceTexel,
  context: CompletionContext,
  input: GenerateCompletionProposalCandidatesInput,
) => CompletionPixelAssignmentDescriptor | null;

const HASH_PATTERN = /^sha256:([0-9a-f]{64})$/u;
const SAFE_ID = /^[a-z][a-z0-9_-]{2,100}$/u;
const STRATEGY_ORDER: readonly Exclude<
  CompletionCandidateStrategy,
  "manual_edit"
>[] = [
  "opposite_layer_underlay",
  "mirrored_counterpart",
  "same_surface_continuation",
  "opposite_surface_reference",
  "neighbor_reference",
  "pattern_continuation",
];

export function generateCompletionProposalCandidates(
  input: GenerateCompletionProposalCandidatesInput,
): CompletionProposal {
  const proposalId = checkedId(input.proposalId, "Completion proposal id");
  const context = buildContext(input);
  const occludingComponentIds = sortedUniqueIds(
    input.occludingComponentIds,
    "occludingComponentIds",
    MAX_COMPLETION_OCCLUDING_COMPONENTS,
  );
  if (occludingComponentIds.includes(input.targetComponentId)) {
    throw new RangeError("Target component cannot also be an occluding component");
  }

  const skinTexelIds = deriveAllowedPixelIds(context, "skin_texel");
  const latentIds = deriveAllowedPixelIds(context, "latent_component");
  const representation = resolveRepresentation(
    input.representation,
    skinTexelIds,
  );
  const allowedGeneratedPixelIds =
    representation === "skin_texel" ? skinTexelIds : latentIds;
  assertPixelCount(
    allowedGeneratedPixelIds.length,
    MAX_COMPLETION_ALLOWED_PIXELS,
    "Completion allowed range",
  );
  const allowedGeneratedSpans = pixelIdsToSpans(
    allowedGeneratedPixelIds,
    context.layout,
  );
  const evidence: CompletionProposalEvidence = {
    schemaVersion: COMPLETION_PROPOSAL_SCHEMA_VERSION,
    algorithmVersion: COMPLETION_CANDIDATE_ALGORITHM_VERSION,
    sourceRevisionId: input.sourceRevisionId,
    sourceResultHash: input.sourceResultHash,
    sourceSkinHash: input.sourceSkinHash,
    armType: context.layout.armType,
    targetComponentId: input.targetComponentId,
    occludingComponentIds,
    requestedRepresentation: input.representation,
    representation,
    allowedGeneratedPixelIds,
    allowedGeneratedSpans,
  };
  const evidenceHash = runHash(input.hashCanonical, evidence);
  const candidates = STRATEGY_ORDER.flatMap((strategy) => {
    const candidate = createStrategyCandidate({
      strategy,
      proposalEvidenceHash: evidenceHash,
      allowedPixelIds: allowedGeneratedPixelIds,
      context,
      input: { ...input, occludingComponentIds },
    });
    return candidate ? [candidate] : [];
  });
  if (candidates.length > MAX_COMPLETION_PROPOSAL_CANDIDATES) {
    throw new RangeError(
      `Completion proposal candidates must not exceed ${MAX_COMPLETION_PROPOSAL_CANDIDATES}`,
    );
  }
  const proposalHash = runHash(
    input.hashCanonical,
    proposalFingerprint(
      evidenceHash,
      candidates.map((candidate) => candidate.candidateHash),
    ),
  );
  const proposal: CompletionProposal = {
    schemaVersion: COMPLETION_PROPOSAL_SCHEMA_VERSION,
    algorithmVersion: COMPLETION_CANDIDATE_ALGORITHM_VERSION,
    proposalId,
    sourceRevisionId: input.sourceRevisionId,
    sourceResultHash: input.sourceResultHash,
    sourceSkinHash: input.sourceSkinHash,
    armType: context.layout.armType,
    targetComponentId: input.targetComponentId,
    occludingComponentIds,
    requestedRepresentation: input.representation,
    representation,
    allowedGeneratedPixelIds,
    allowedGeneratedSpans,
    allowedGeneratedPixelCount: allowedGeneratedPixelIds.length,
    allowedGeneratedMask: pixelIdsToMask(allowedGeneratedPixelIds),
    evidence,
    evidenceHash,
    candidates,
    proposalHash,
  };
  validateCompletionProposalSource(proposal, input);
  validateCompletionProposalHashes(proposal, input.hashCanonical);
  return proposal;
}

export function validateCompletionProposalSource(
  proposal: CompletionProposal,
  source: CompletionSourceSnapshot,
): void {
  const context = buildContext({
    ...source,
    proposalId: proposal.proposalId,
    targetComponentId: proposal.targetComponentId,
    occludingComponentIds: proposal.occludingComponentIds,
    representation: proposal.requestedRepresentation,
    hashCanonical: () => `sha256:${"0".repeat(64)}`,
  });
  assertProposalIdentity(proposal, source);
  assertMask(proposal.allowedGeneratedMask);
  assertPixelCount(
    proposal.allowedGeneratedPixelCount,
    MAX_COMPLETION_ALLOWED_PIXELS,
    "Completion allowed range",
  );
  const skinTexelIds = deriveAllowedPixelIds(context, "skin_texel");
  const expectedRepresentation = resolveRepresentation(
    proposal.requestedRepresentation,
    skinTexelIds,
  );
  const expectedPixelIds =
    expectedRepresentation === "skin_texel"
      ? skinTexelIds
      : deriveAllowedPixelIds(context, "latent_component");
  if (
    proposal.representation !== expectedRepresentation ||
    !numberArraysEqual(proposal.allowedGeneratedPixelIds, expectedPixelIds) ||
    !numberArraysEqual(maskToPixelIds(proposal.allowedGeneratedMask), expectedPixelIds) ||
    proposal.allowedGeneratedPixelCount !== expectedPixelIds.length ||
    !spansEqual(
      proposal.allowedGeneratedSpans,
      pixelIdsToSpans(expectedPixelIds, context.layout),
    )
  ) {
    throw new RangeError("Completion proposal allowed range is stale or invalid");
  }
  if (proposal.candidates.length > MAX_COMPLETION_PROPOSAL_CANDIDATES) {
    throw new RangeError(
      `Completion proposal candidates must not exceed ${MAX_COMPLETION_PROPOSAL_CANDIDATES}`,
    );
  }
  for (const candidate of proposal.candidates) {
    validateCompletionCandidateWithContext(proposal, candidate, source, context);
  }
}

export function validateCompletionCandidate(
  proposal: CompletionProposal,
  candidate: CompletionCandidate,
  source: CompletionSourceSnapshot,
): void {
  const context = buildContext({
    ...source,
    proposalId: proposal.proposalId,
    targetComponentId: proposal.targetComponentId,
    occludingComponentIds: proposal.occludingComponentIds,
    representation: proposal.requestedRepresentation,
    hashCanonical: () => `sha256:${"0".repeat(64)}`,
  });
  assertProposalIdentity(proposal, source);
  validateCompletionCandidateWithContext(proposal, candidate, source, context);
}

export function validateCompletionCandidateHashes(
  proposal: CompletionProposal,
  candidate: CompletionCandidate | CompletionCandidateDocument,
  hashCanonical: CompletionHashCanonical,
): void {
  const evidenceHash = runHash(hashCanonical, candidate.evidence);
  const candidateHash = runHash(
    hashCanonical,
    candidateFingerprint(candidate, evidenceHash),
  );
  const identityHash = runHash(hashCanonical, {
    proposalId: proposal.proposalId,
    candidateHash,
  });
  if (
    candidate.evidence.proposalEvidenceHash !== proposal.evidenceHash ||
    candidate.evidenceHash !== evidenceHash ||
    candidate.candidateHash !== candidateHash ||
    candidate.candidateId !== `completioncandidate_${hashToken(identityHash)}`
  ) {
    throw new RangeError("Completion candidate hash or scoped id is invalid");
  }
}

export function validateCompletionProposalHashes(
  proposal: CompletionProposal,
  hashCanonical: CompletionHashCanonical,
): void {
  const evidenceHash = runHash(hashCanonical, proposal.evidence);
  if (proposal.evidenceHash !== evidenceHash) {
    throw new RangeError("Completion proposal evidence hash is invalid");
  }
  for (const candidate of proposal.candidates) {
    validateCompletionCandidateHashes(proposal, candidate, hashCanonical);
  }
  const proposalHash = runHash(
    hashCanonical,
    proposalFingerprint(
      evidenceHash,
      proposal.candidates.map((candidate) => candidate.candidateHash),
    ),
  );
  if (proposal.proposalHash !== proposalHash) {
    throw new RangeError("Completion proposal content hash is invalid");
  }
}

export function completionCandidateDocument(
  candidate: CompletionCandidate,
): CompletionCandidateDocument {
  return {
    schemaVersion: candidate.schemaVersion,
    algorithmVersion: candidate.algorithmVersion,
    candidateId: candidate.candidateId,
    representation: candidate.representation,
    strategy: candidate.strategy,
    targetComponentId: candidate.targetComponentId,
    occludingComponentIds: [...candidate.occludingComponentIds],
    baseCandidateId: candidate.baseCandidateId,
    assignments: candidate.assignments.map(cloneAssignment),
    pixelIds: [...candidate.pixelIds],
    spans: candidate.spans.map(cloneSpan),
    pixelCount: candidate.pixelCount,
    missingPixelIds: [...candidate.missingPixelIds],
    missingPixelCount: candidate.missingPixelCount,
    complete: candidate.complete,
    confidence: candidate.confidence,
    confidenceScore: candidate.confidenceScore,
    reviewRequired: true,
    automaticAcceptanceAllowed: false,
    evidence: cloneCandidateEvidence(candidate.evidence),
    evidenceHash: candidate.evidenceHash,
    candidateHash: candidate.candidateHash,
  };
}

export function completionProposalDocument(
  proposal: CompletionProposal,
): CompletionProposalDocument {
  return {
    schemaVersion: proposal.schemaVersion,
    algorithmVersion: proposal.algorithmVersion,
    proposalId: proposal.proposalId,
    sourceRevisionId: proposal.sourceRevisionId,
    sourceResultHash: proposal.sourceResultHash,
    sourceSkinHash: proposal.sourceSkinHash,
    armType: proposal.armType,
    targetComponentId: proposal.targetComponentId,
    occludingComponentIds: [...proposal.occludingComponentIds],
    requestedRepresentation: proposal.requestedRepresentation,
    representation: proposal.representation,
    allowedGeneratedPixelIds: [...proposal.allowedGeneratedPixelIds],
    allowedGeneratedSpans: proposal.allowedGeneratedSpans.map(cloneSpan),
    allowedGeneratedPixelCount: proposal.allowedGeneratedPixelCount,
    evidence: cloneProposalEvidence(proposal.evidence),
    evidenceHash: proposal.evidenceHash,
    candidates: proposal.candidates.map(completionCandidateDocument),
    proposalHash: proposal.proposalHash,
  };
}

export function materializeCompletionCandidateDocument(
  document: CompletionCandidateDocument,
): CompletionCandidate {
  const assignments = document.assignments.map(cloneAssignment);
  const materialized = materializeAssignments(assignments);
  return {
    ...document,
    occludingComponentIds: [...document.occludingComponentIds],
    assignments,
    pixelIds: [...document.pixelIds],
    spans: document.spans.map(cloneSpan),
    missingPixelIds: [...document.missingPixelIds],
    evidence: cloneCandidateEvidence(document.evidence),
    ...materialized,
  };
}

export function materializeCompletionProposalDocument(
  document: CompletionProposalDocument,
): CompletionProposal {
  return {
    ...document,
    occludingComponentIds: [...document.occludingComponentIds],
    allowedGeneratedPixelIds: [...document.allowedGeneratedPixelIds],
    allowedGeneratedSpans: document.allowedGeneratedSpans.map(cloneSpan),
    allowedGeneratedMask: pixelIdsToMask(document.allowedGeneratedPixelIds),
    evidence: cloneProposalEvidence(document.evidence),
    candidates: document.candidates.map(materializeCompletionCandidateDocument),
  };
}

export function materializeCompletionCandidate(
  candidate: CompletionCandidate | CompletionCandidateDocument,
): CompletionCandidateMaterialization {
  const materialized = materializeAssignments(candidate.assignments);
  return {
    texture: cloneImage(materialized.texture),
    writeMask: materialized.writeMask.slice(),
    generatedMask: materialized.generatedMask.slice(),
  };
}

/**
 * Canonical JSON automatically projects materialized Completion values to their
 * serializable document form. Other typed arrays are rejected.
 */
export function canonicalCompletionJson(value: unknown): string {
  const projected = isMaterializedProposal(value)
    ? completionProposalDocument(value)
    : isMaterializedCandidate(value)
      ? completionCandidateDocument(value)
      : value;
  return JSON.stringify(canonicalValue(projected));
}

export function editCompletionCandidate(input: {
  readonly proposal: CompletionProposal;
  readonly candidateId: string;
  readonly edits: readonly CompletionCandidateEdit[];
  readonly actor: PixelOriginActor;
  readonly operationId: string;
  readonly hashCanonical: CompletionHashCanonical;
}): CompletionCandidate {
  if (input.edits.length === 0) {
    throw new RangeError("Completion candidate edits must not be empty");
  }
  if (input.edits.length > MAX_COMPLETION_PIXEL_EDITS) {
    throw new RangeError(
      `Completion candidate edits must not exceed ${MAX_COMPLETION_PIXEL_EDITS}`,
    );
  }
  const editActor = cloneActor(input.actor);
  if (editActor.type !== "user") {
    throw new RangeError("Completion candidate edits require an explicit user actor");
  }
  const operationId = checkedId(
    input.operationId,
    "Completion edit operation id",
  );
  const base = input.proposal.candidates.find(
    (candidate) => candidate.candidateId === input.candidateId,
  );
  if (!base) {
    throw new RangeError(`Unknown Completion candidate: ${input.candidateId}`);
  }
  const allowed = new Set(input.proposal.allowedGeneratedPixelIds);
  const assignments = new Map(
    base.assignments.map((assignment) => [
      assignment.targetPixelId,
      cloneAssignment(assignment),
    ]),
  );
  const edited = new Set<number>();
  for (const edit of input.edits) {
    assertPixelId(edit.pixelId, "Completion edit pixel");
    if (!allowed.has(edit.pixelId)) {
      throw new RangeError(
        `Completion edit pixel ${edit.pixelId} is outside the allowed range`,
      );
    }
    if (edited.has(edit.pixelId)) {
      throw new RangeError(`Duplicate Completion edit pixel ${edit.pixelId}`);
    }
    edited.add(edit.pixelId);
    if (edit.type === "remove_pixel") {
      assignments.delete(edit.pixelId);
      continue;
    }
    assertVisibleRgba(edit.rgba, "Completion edit RGBA");
    const previous = assignments.get(edit.pixelId);
    if (previous && rgbaEqual(previous.rgba, edit.rgba)) {
      continue;
    }
    assignments.set(edit.pixelId, {
      targetPixelId: edit.pixelId,
      rgba: cloneRgba(edit.rgba),
      originMode: "manual_authored",
      samplePixelIds: [],
      sourcePixelId: null,
      sourceComponentInstanceId: null,
      manualActor: editActor,
      manualOperationId: operationId,
    });
  }
  const resultAssignments = [...assignments.values()].sort(compareAssignment);
  if (resultAssignments.length === 0) {
    throw new RangeError("Completion candidate cannot be empty after editing");
  }
  return buildCandidate({
    strategy: "manual_edit",
    proposalEvidenceHash: input.proposal.evidenceHash,
    sourceRevisionId: input.proposal.sourceRevisionId,
    sourceResultHash: input.proposal.sourceResultHash,
    sourceSkinHash: input.proposal.sourceSkinHash,
    targetComponentId: input.proposal.targetComponentId,
    occludingComponentIds: input.proposal.occludingComponentIds,
    representation: input.proposal.representation,
    armType: input.proposal.armType,
    proposalId: input.proposal.proposalId,
    baseCandidateId: base.candidateId,
    allowedPixelIds: input.proposal.allowedGeneratedPixelIds,
    assignments: resultAssignments,
    hashCanonical: input.hashCanonical,
  });
}

interface CreateCompletionDecisionCommon {
  readonly proposal: CompletionProposal;
  readonly actor: PixelOriginActor;
  readonly expectedSourceResultHash: string;
  readonly expectedProposalHash: string;
  readonly expectedProposalEvidenceHash: string;
  readonly hashCanonical: CompletionHashCanonical;
}

export type CreateCompletionDecisionInput = CreateCompletionDecisionCommon &
  (
    | {
        readonly action: "accept";
        readonly candidateId: string;
        /** Required for a separately persisted manual-edit candidate. */
        readonly candidate?: CompletionCandidate;
        readonly expectedCandidateHash: string;
      }
    | { readonly action: "reject" }
  );

export function createCompletionDecision(
  input: CreateCompletionDecisionInput,
): CompletionDecision {
  if (
    input.expectedSourceResultHash !== input.proposal.sourceResultHash ||
    input.expectedProposalHash !== input.proposal.proposalHash ||
    input.expectedProposalEvidenceHash !== input.proposal.evidenceHash
  ) {
    throw new RangeError("Completion decision references stale proposal evidence");
  }
  const actor = cloneActor(input.actor);
  if (actor.type !== "user") {
    throw new RangeError("Completion decisions require an explicit user actor");
  }
  if (input.action === "reject") {
    const fingerprint = {
      schemaVersion: COMPLETION_PROPOSAL_SCHEMA_VERSION,
      proposalId: input.proposal.proposalId,
      proposalHash: input.proposal.proposalHash,
      candidateId: null,
      candidateHash: null,
      candidateEvidenceHash: null,
      sourceRevisionId: input.proposal.sourceRevisionId,
      sourceResultHash: input.proposal.sourceResultHash,
      sourceSkinHash: input.proposal.sourceSkinHash,
      action: "reject",
      actor,
      automatic: false,
    } as const;
    const decisionHash = runHash(input.hashCanonical, fingerprint);
    return {
      ...fingerprint,
      decisionId: `completiondecision_${hashToken(decisionHash)}`,
      decisionHash,
    };
  }
  const candidate =
    input.candidate ??
    input.proposal.candidates.find(
      (item) => item.candidateId === input.candidateId,
    );
  if (!candidate || candidate.candidateId !== input.candidateId) {
    throw new RangeError(`Unknown Completion candidate: ${input.candidateId}`);
  }
  if (input.expectedCandidateHash !== candidate.candidateHash) {
    throw new RangeError("Completion decision references a stale candidate hash");
  }
  if (
    candidate.reviewRequired !== true ||
    candidate.automaticAcceptanceAllowed !== false
  ) {
    throw new RangeError("Completion candidate acceptance policy is invalid");
  }
  const fingerprint = {
    schemaVersion: COMPLETION_PROPOSAL_SCHEMA_VERSION,
    proposalId: input.proposal.proposalId,
    proposalHash: input.proposal.proposalHash,
    candidateId: candidate.candidateId,
    candidateHash: candidate.candidateHash,
    candidateEvidenceHash: candidate.evidenceHash,
    sourceRevisionId: input.proposal.sourceRevisionId,
    sourceResultHash: input.proposal.sourceResultHash,
    sourceSkinHash: input.proposal.sourceSkinHash,
    action: "accept",
    actor,
    automatic: false,
  } as const;
  const decisionHash = runHash(input.hashCanonical, fingerprint);
  return {
    ...fingerprint,
    decisionId: `completiondecision_${hashToken(decisionHash)}`,
    decisionHash,
  };
}

export function validateCompletionDecisionHash(
  decision: CompletionDecision,
  hashCanonical: CompletionHashCanonical,
): void {
  const {
    decisionId,
    decisionHash,
    ...fingerprint
  } = decision;
  const expectedHash = runHash(hashCanonical, fingerprint);
  if (
    decisionHash !== expectedHash ||
    decisionId !== `completiondecision_${hashToken(expectedHash)}`
  ) {
    throw new RangeError("Completion decision hash or id is invalid");
  }
}

export function applyCompletionDecision(input: {
  readonly proposal: CompletionProposal;
  readonly candidate?: CompletionCandidate;
  readonly decision: CompletionDecision;
  readonly sourceImage: RgbaImage;
  readonly sourceSemanticState: SemanticState;
  readonly sourceOriginDocument: PixelOriginDocument;
  readonly resultSubject?: PixelOriginSubject;
}): CompletionDecisionTransformation {
  validateDecisionBinding(input.proposal, input.candidate, input.decision);
  if (input.decision.action === "reject") {
    return {
      status: "rejected",
      sourceSkinChanged: false,
      decision: input.decision,
      result: null,
    };
  }
  const candidate = input.candidate;
  if (!candidate) {
    throw new RangeError("Accepted Completion requires its bound candidate");
  }
  validateCompletionCandidate(input.proposal, candidate, {
    sourceRevisionId: input.proposal.sourceRevisionId,
    sourceResultHash: input.proposal.sourceResultHash,
    sourceSkinHash: input.proposal.sourceSkinHash,
    image: input.sourceImage,
    semanticState: input.sourceSemanticState,
    originDocument: input.sourceOriginDocument,
  });
  validatePixelOriginDocument(input.sourceOriginDocument, input.sourceImage);
  if (
    input.sourceOriginDocument.subject.kind !== "revision" ||
    input.sourceOriginDocument.subject.id !== input.proposal.sourceRevisionId
  ) {
    throw new RangeError("Completion source origin does not match its Revision");
  }
  const resultSubject = input.resultSubject;
  if (!resultSubject) {
    throw new RangeError("Accepted Completion requires a result origin subject");
  }
  const originAssignments = createCompletionOriginAssignments(
    candidate,
    input.decision,
    input.sourceOriginDocument,
  );
  const materialized = materializeCompletionCandidate(candidate);
  if (input.proposal.representation === "skin_texel") {
    if (resultSubject.kind !== "revision") {
      throw new RangeError("skin_texel Completion result must use a Revision subject");
    }
    const image = cloneImage(input.sourceImage);
    for (const assignment of candidate.assignments) {
      const offset = assignment.targetPixelId * 4;
      if (image.data[offset + 3] !== 0) {
        throw new RangeError(
          `skin_texel Completion would overwrite visible pixel ${assignment.targetPixelId}`,
        );
      }
      image.data.set(assignment.rgba, offset);
    }
    const originDocument = propagatePixelOriginDocument({
      sourceDocument: input.sourceOriginDocument,
      sourceImage: input.sourceImage,
      resultImage: image,
      resultSubject,
      assignments: originAssignments,
    });
    return {
      status: "accepted",
      sourceSkinChanged: true,
      decision: input.decision,
      result: {
        kind: "skin_texel",
        sourceSkinChanged: true,
        image,
        semanticDelta: {
          targetComponentId: input.proposal.targetComponentId,
          addedPixelIds: [...candidate.pixelIds],
          addedSpans: candidate.spans.map(cloneSpan),
          addedMask: candidate.writeMask.slice(),
        },
        originAssignments,
        originDocument,
        writeMask: materialized.writeMask,
        generatedMask: materialized.generatedMask,
        pixelIds: [...candidate.pixelIds],
        pixelCount: candidate.pixelCount,
      },
    };
  }
  if (resultSubject.kind !== "part") {
    throw new RangeError("latent_component Completion result must use a Part subject");
  }
  const targetPixelIds = maskToPixelIds(
    input.sourceSemanticState.masks[input.proposal.targetComponentId]!,
  );
  const baseTexture = createRgbaImage(SKIN_WIDTH, SKIN_HEIGHT);
  for (const pixelId of targetPixelIds) {
    baseTexture.data.set(
      input.sourceImage.data.subarray(pixelId * 4, pixelId * 4 + 4),
      pixelId * 4,
    );
  }
  const texture = cloneImage(baseTexture);
  for (const assignment of candidate.assignments) {
    texture.data.set(assignment.rgba, assignment.targetPixelId * 4);
  }
  const baseOriginDocument = propagatePixelOriginDocument({
    sourceDocument: input.sourceOriginDocument,
    sourceImage: input.sourceImage,
    resultImage: baseTexture,
    resultSubject,
    assignments: createCopiedPixelOriginAssignments({
      sourceDocument: input.sourceOriginDocument,
      mappings: targetPixelIds.map((pixelId) => ({
        sourcePixelId: pixelId,
        targetPixelId: pixelId,
      })),
      sourceComponentInstanceId: input.proposal.targetComponentId,
    }),
  });
  const originDocument = propagatePixelOriginDocument({
    sourceDocument: baseOriginDocument,
    sourceImage: baseTexture,
    resultImage: texture,
    resultSubject,
    assignments: originAssignments,
  });
  const pixelIds = sortedNumbers([...targetPixelIds, ...candidate.pixelIds]);
  return {
    status: "accepted",
    sourceSkinChanged: false,
    decision: input.decision,
    result: {
      kind: "latent_component",
      sourceSkinChanged: false,
      texture,
      originAssignments,
      originDocument,
      writeMask: pixelIdsToMask(pixelIds),
      generatedMask: deriveGeneratedPixelMask(originDocument),
      pixelIds,
      pixelCount: pixelIds.length,
    },
  };
}

/** Applies a skin-texel result's exact ownership delta after persistence assigns ids/hashes. */
export function applyCompletionSemanticDelta(input: {
  readonly sourceState: SemanticState;
  readonly sourceImage: RgbaImage;
  readonly resultImage: RgbaImage;
  readonly resultRevisionId: string;
  readonly resultSkinHash: string;
  readonly originDocument: PixelOriginDocument;
  readonly delta: CompletionSemanticDelta;
}): SemanticState {
  assertHash(input.resultSkinHash, "Completion result skin hash");
  if (
    input.originDocument.subject.kind !== "revision" ||
    input.originDocument.subject.id !== input.resultRevisionId
  ) {
    throw new RangeError("Completion semantic delta origin does not match result Revision");
  }
  const target = input.sourceState.document.components.find(
    (component) => component.instanceId === input.delta.targetComponentId,
  );
  if (!target) {
    throw new RangeError(
      `Unknown Completion semantic target: ${input.delta.targetComponentId}`,
    );
  }
  assertMask(input.delta.addedMask);
  const layout = getSkinLayout(input.sourceState.document.source.armType);
  if (
    !numberArraysEqual(
      maskToPixelIds(input.delta.addedMask),
      input.delta.addedPixelIds,
    ) ||
    !spansEqual(
      input.delta.addedSpans,
      pixelIdsToSpans(input.delta.addedPixelIds, layout),
    )
  ) {
    throw new RangeError("Completion semantic delta materialization is inconsistent");
  }
  const rebased = rebaseSemanticStateImage({
    state: input.sourceState,
    sourceImage: input.sourceImage,
    resultImage: input.resultImage,
    sourceHash: input.resultSkinHash,
  });
  const rebound: SemanticState = {
    document: { ...rebased.document, revisionId: input.resultRevisionId },
    masks: rebased.masks,
    unknownMask: rebased.unknownMask,
  };
  const { originSummary: _staleOriginSummary, ...targetProvenance } =
    target.provenance;
  const assigned = assignSemanticPixelsWithProvenance(
    rebound,
    {
      target: {
        instanceId: target.instanceId,
        displayName: target.displayName,
        category: target.category,
        ...(target.subtype === undefined ? {} : { subtype: target.subtype }),
      },
      spans: input.delta.addedSpans,
      provenance: {
        ...targetProvenance,
        containsGeneratedPixels: true,
      },
    },
    input.resultImage,
  );
  const synchronized = synchronizeSemanticPixelOriginSummaries(
    assigned,
    input.originDocument,
    input.resultImage,
  );
  validateSemanticState(synchronized, input.resultImage, layout);
  return synchronized;
}

function buildContext(
  input: GenerateCompletionProposalCandidatesInput,
): CompletionContext {
  assertSkinImage(input.image);
  assertHash(input.sourceResultHash, "Completion source result hash");
  assertHash(input.sourceSkinHash, "Completion source skin hash");
  checkedId(input.sourceRevisionId, "Completion source Revision id");
  checkedComponentId(input.targetComponentId, "Completion target component id");
  const occludingComponentIds = sortedUniqueIds(
    input.occludingComponentIds,
    "occludingComponentIds",
    MAX_COMPLETION_OCCLUDING_COMPONENTS,
  );
  if (occludingComponentIds.length === 0) {
    throw new RangeError("occludingComponentIds must not be empty");
  }
  if (
    input.semanticState.document.revisionId !== input.sourceRevisionId ||
    input.originDocument.subject.kind !== "revision" ||
    input.originDocument.subject.id !== input.sourceRevisionId
  ) {
    throw new RangeError("Completion source documents do not match the source Revision");
  }
  const layout = getSkinLayout(input.semanticState.document.source.armType);
  validateSemanticState(input.semanticState, input.image, layout);
  validatePixelOriginDocument(input.originDocument, input.image);
  if (input.originDocument.source.armType !== layout.armType) {
    throw new RangeError("Completion source origin uses a different arm model");
  }
  const components = new Map(
    input.semanticState.document.components.map((component) => [
      component.instanceId,
      component,
    ]),
  );
  const targetComponent = components.get(input.targetComponentId);
  if (!targetComponent) {
    throw new RangeError(`Unknown Completion target component: ${input.targetComponentId}`);
  }
  const targetKind = aggregateKindForCategory(targetComponent.category);
  if (targetKind !== "hair" && targetKind !== "clothing") {
    throw new RangeError(
      "Completion targets are limited to hair and clothing components",
    );
  }
  for (const componentId of occludingComponentIds) {
    const occludingComponent = components.get(componentId);
    if (!occludingComponent) {
      throw new RangeError(`Unknown Completion occluding component: ${componentId}`);
    }
    const occludingKind = aggregateKindForCategory(occludingComponent.category);
    const supported =
      targetKind === "clothing"
        ? occludingKind === "hair" || occludingKind === "accessory"
        : occludingKind === "accessory";
    if (!supported) {
      throw new RangeError(
        `Unsupported Completion occlusion: ${occludingComponent.category} over ${targetComponent.category}`,
      );
    }
  }
  const texels = buildSurfaceTexels(input.image, layout);
  const texelByPixel = new Map(texels.map((texel) => [texel.pixelId, texel]));
  const texelByCoordinate = new Map(
    texels.map((texel) => [coordinateKey(texel.surface, texel.localU, texel.localV), texel]),
  );
  const ownerByPixel = new Map<number, string>();
  for (const component of input.semanticState.document.components) {
    for (const pixelId of maskToPixelIds(
      input.semanticState.masks[component.instanceId]!,
    )) {
      ownerByPixel.set(pixelId, component.instanceId);
    }
  }
  for (const pixelId of maskToPixelIds(input.semanticState.unknownMask)) {
    ownerByPixel.set(pixelId, "unknown");
  }
  const targetPixelIds = new Set(
    maskToPixelIds(input.semanticState.masks[input.targetComponentId]!),
  );
  if (targetPixelIds.size === 0) {
    throw new RangeError("Completion target component has no visible evidence");
  }
  const targetTexels = [...targetPixelIds].map((pixelId) => {
    const texel = texelByPixel.get(pixelId);
    if (!texel) {
      throw new RangeError(`Completion target pixel ${pixelId} is outside used UV`);
    }
    return texel;
  });
  const targetSupportGroups = new Set(
    targetTexels.map((texel) => supportGroup(texel.bodyPart, texel.layer)),
  );
  const occluderPixelIds = sortedNumbers(
    occludingComponentIds.flatMap((componentId) =>
      maskToPixelIds(input.semanticState.masks[componentId]!),
    ),
  );
  if (occluderPixelIds.length === 0) {
    throw new RangeError("Completion occluding components have no visible evidence");
  }
  return {
    layout,
    texels,
    texelByPixel,
    texelByCoordinate,
    ownerByPixel,
    targetPixelIds,
    targetTexels: targetTexels.sort(compareTexel),
    targetSupportGroups,
    occluderPixelIds,
  };
}

function deriveAllowedPixelIds(
  context: CompletionContext,
  representation: CompletionTargetRepresentation,
): number[] {
  const allowed = new Set<number>();
  for (const occluderPixelId of context.occluderPixelIds) {
    const occluder = context.texelByPixel.get(occluderPixelId);
    if (!occluder) {
      throw new RangeError(`Completion occluder pixel ${occluderPixelId} is outside used UV`);
    }
    if (representation === "latent_component") {
      // Same-layer latent content is bounded by the actual occluder and only on
      // body/layer groups where the target component already has visible proof.
      if (
        context.targetSupportGroups.has(
          supportGroup(occluder.bodyPart, occluder.layer),
        )
      ) {
        allowed.add(occluder.pixelId);
      }
      continue;
    }
    // A skin texel can represent hidden content only below a visible Outer
    // occluder. Writing an Outer texel above a Base owner would change the
    // rendered artwork instead of completing content behind it.
    if (occluder.layer !== "outer") continue;
    const targetLayer = oppositeLayer(occluder.layer);
    if (
      !context.targetSupportGroups.has(
        supportGroup(occluder.bodyPart, targetLayer),
      )
    ) {
      continue;
    }
    const targetSurface = surfaceKey(
      occluder.bodyPart,
      targetLayer,
      occluder.face,
    );
    const target = context.texelByCoordinate.get(
      coordinateKey(targetSurface, occluder.localU, occluder.localV),
    );
    if (
      target &&
      target.rgba[3] === 0 &&
      !context.ownerByPixel.has(target.pixelId)
    ) {
      allowed.add(target.pixelId);
    }
  }
  return sortedNumbers(allowed);
}

function resolveRepresentation(
  requested: CompletionRequestedRepresentation,
  skinTexelIds: readonly number[],
): CompletionTargetRepresentation {
  if (
    requested !== "auto" &&
    requested !== "skin_texel" &&
    requested !== "latent_component"
  ) {
    throw new TypeError(`Unknown Completion representation: ${String(requested)}`);
  }
  return requested === "auto"
    ? skinTexelIds.length > 0
      ? "skin_texel"
      : "latent_component"
    : requested;
}

function createStrategyCandidate(input: {
  readonly strategy: Exclude<CompletionCandidateStrategy, "manual_edit">;
  readonly proposalEvidenceHash: string;
  readonly allowedPixelIds: readonly number[];
  readonly context: CompletionContext;
  readonly input: GenerateCompletionProposalCandidatesInput;
}): CompletionCandidate | null {
  const factory = assignmentFactory(input.strategy);
  const assignments = input.allowedPixelIds
    .map((pixelId) => {
      const target = input.context.texelByPixel.get(pixelId);
      if (!target) {
        throw new RangeError(`Completion target pixel ${pixelId} is outside used UV`);
      }
      return factory(target, input.context, input.input);
    })
    .filter(
      (assignment): assignment is CompletionPixelAssignmentDescriptor =>
        assignment !== null,
    )
    .sort(compareAssignment);
  if (assignments.length === 0) return null;
  return buildCandidate({
    strategy: input.strategy,
    proposalEvidenceHash: input.proposalEvidenceHash,
    sourceRevisionId: input.input.sourceRevisionId,
    sourceResultHash: input.input.sourceResultHash,
    sourceSkinHash: input.input.sourceSkinHash,
    targetComponentId: input.input.targetComponentId,
    occludingComponentIds: input.input.occludingComponentIds,
    representation:
      input.input.representation === "auto"
        ? resolveRepresentation(
            "auto",
            deriveAllowedPixelIds(input.context, "skin_texel"),
          )
        : input.input.representation,
    armType: input.context.layout.armType,
    proposalId: input.input.proposalId,
    baseCandidateId: null,
    allowedPixelIds: input.allowedPixelIds,
    assignments,
    hashCanonical: input.input.hashCanonical,
  });
}

function buildCandidate(input: {
  readonly strategy: CompletionCandidateStrategy;
  readonly proposalEvidenceHash: string;
  readonly sourceRevisionId: string;
  readonly sourceResultHash: string;
  readonly sourceSkinHash: string;
  readonly targetComponentId: string;
  readonly occludingComponentIds: readonly string[];
  readonly representation: CompletionTargetRepresentation;
  readonly armType: "wide" | "slim";
  readonly proposalId: string;
  readonly baseCandidateId: string | null;
  readonly allowedPixelIds: readonly number[];
  readonly assignments: readonly CompletionPixelAssignmentDescriptor[];
  readonly hashCanonical: CompletionHashCanonical;
}): CompletionCandidate {
  assertPixelCount(
    input.assignments.length,
    MAX_COMPLETION_CANDIDATE_PIXELS,
    "Completion candidate",
  );
  const allowed = new Set(input.allowedPixelIds);
  const assignments = input.assignments.map(cloneAssignment).sort(compareAssignment);
  const seen = new Set<number>();
  for (const assignment of assignments) {
    validateAssignmentDescriptor(assignment);
    if (!allowed.has(assignment.targetPixelId)) {
      throw new RangeError(
        `Completion candidate pixel ${assignment.targetPixelId} is outside the allowed range`,
      );
    }
    if (seen.has(assignment.targetPixelId)) {
      throw new RangeError(
        `Completion candidate duplicates pixel ${assignment.targetPixelId}`,
      );
    }
    seen.add(assignment.targetPixelId);
  }
  const pixelIds = sortedNumbers(seen);
  const allowedSet = new Set(input.allowedPixelIds);
  const missingPixelIds = [...allowedSet]
    .filter((pixelId) => !seen.has(pixelId))
    .sort((left, right) => left - right);
  const evidence: CompletionCandidateEvidence = {
    schemaVersion: COMPLETION_PROPOSAL_SCHEMA_VERSION,
    algorithmVersion: COMPLETION_CANDIDATE_ALGORITHM_VERSION,
    proposalEvidenceHash: input.proposalEvidenceHash,
    sourceRevisionId: input.sourceRevisionId,
    sourceResultHash: input.sourceResultHash,
    sourceSkinHash: input.sourceSkinHash,
    targetComponentId: input.targetComponentId,
    occludingComponentIds: [...input.occludingComponentIds],
    representation: input.representation,
    strategy: input.strategy,
    baseCandidateId: input.baseCandidateId,
    assignments,
  };
  const evidenceHash = runHash(input.hashCanonical, evidence);
  const confidence = confidenceForStrategy(input.strategy);
  const layout = getSkinLayout(input.armType);
  const spans = pixelIdsToSpans(pixelIds, layout);
  const candidateHash = runHash(
    input.hashCanonical,
    candidateFingerprint(
      {
        schemaVersion: COMPLETION_PROPOSAL_SCHEMA_VERSION,
        algorithmVersion: COMPLETION_CANDIDATE_ALGORITHM_VERSION,
        candidateId: "unused_during_hashing",
        representation: input.representation,
        strategy: input.strategy,
        targetComponentId: input.targetComponentId,
        occludingComponentIds: input.occludingComponentIds,
        baseCandidateId: input.baseCandidateId,
        assignments,
        pixelIds,
        spans,
        pixelCount: pixelIds.length,
        missingPixelIds,
        missingPixelCount: missingPixelIds.length,
        complete: missingPixelIds.length === 0,
        confidence: confidence.level,
        confidenceScore: confidence.score,
        reviewRequired: true,
        automaticAcceptanceAllowed: false,
        evidence,
        evidenceHash,
        candidateHash: "unused_during_hashing",
      },
      evidenceHash,
    ),
  );
  const candidateIdentityHash = runHash(input.hashCanonical, {
    proposalId: input.proposalId,
    candidateHash,
  });
  const materialized = materializeAssignments(assignments);
  return {
    schemaVersion: COMPLETION_PROPOSAL_SCHEMA_VERSION,
    algorithmVersion: COMPLETION_CANDIDATE_ALGORITHM_VERSION,
    candidateId: `completioncandidate_${hashToken(candidateIdentityHash)}`,
    representation: input.representation,
    strategy: input.strategy,
    targetComponentId: input.targetComponentId,
    occludingComponentIds: [...input.occludingComponentIds],
    baseCandidateId: input.baseCandidateId,
    assignments,
    pixelIds,
    spans,
    pixelCount: pixelIds.length,
    missingPixelIds,
    missingPixelCount: missingPixelIds.length,
    complete: missingPixelIds.length === 0,
    confidence: confidence.level,
    confidenceScore: confidence.score,
    reviewRequired: true,
    automaticAcceptanceAllowed: false,
    evidence,
    evidenceHash,
    candidateHash,
    ...materialized,
  };
}

function assignmentFactory(
  strategy: Exclude<CompletionCandidateStrategy, "manual_edit">,
): AssignmentFactory {
  switch (strategy) {
    case "opposite_layer_underlay":
      return oppositeLayerUnderlayAssignment;
    case "mirrored_counterpart":
      return mirroredCounterpartAssignment;
    case "same_surface_continuation":
      return sameSurfaceContinuationAssignment;
    case "opposite_surface_reference":
      return oppositeSurfaceReferenceAssignment;
    case "neighbor_reference":
      return neighborReferenceAssignment;
    case "pattern_continuation":
      return patternContinuationAssignment;
  }
}

function oppositeLayerUnderlayAssignment(
  target: SurfaceTexel,
  context: CompletionContext,
  input: GenerateCompletionProposalCandidatesInput,
): CompletionPixelAssignmentDescriptor | null {
  const source = context.texelByCoordinate.get(
    coordinateKey(
      surfaceKey(target.bodyPart, oppositeLayer(target.layer), target.face),
      target.localU,
      target.localV,
    ),
  );
  return source && context.targetPixelIds.has(source.pixelId)
    ? sampledGeneratedAssignment(target.pixelId, source, input.targetComponentId)
    : null;
}

function mirroredCounterpartAssignment(
  target: SurfaceTexel,
  context: CompletionContext,
  input: GenerateCompletionProposalCandidatesInput,
): CompletionPixelAssignmentDescriptor | null {
  const bodyPart = mirroredBodyPart(target.bodyPart);
  const face = mirroredFace(target.face);
  const sourceSurface = surfaceKey(bodyPart, target.layer, face);
  const width = surfaceDimensions(context, sourceSurface).width;
  const source = context.texelByCoordinate.get(
    coordinateKey(sourceSurface, width - 1 - target.localU, target.localV),
  );
  return source && context.targetPixelIds.has(source.pixelId)
    ? sampledGeneratedAssignment(target.pixelId, source, input.targetComponentId)
    : null;
}

function sameSurfaceContinuationAssignment(
  target: SurfaceTexel,
  context: CompletionContext,
): CompletionPixelAssignmentDescriptor | null {
  const sample = nearestTargetTexel(
    target,
    context.targetTexels.filter((item) => item.surface === target.surface),
    context,
  );
  return sample
    ? generatedAssignment(target.pixelId, sample.rgba, [sample.pixelId])
    : null;
}

function oppositeSurfaceReferenceAssignment(
  target: SurfaceTexel,
  context: CompletionContext,
): CompletionPixelAssignmentDescriptor | null {
  const sourceSurface = surfaceKey(
    target.bodyPart,
    target.layer,
    oppositeFace(target.face),
  );
  const source = context.texelByCoordinate.get(
    coordinateKey(sourceSurface, target.localU, target.localV),
  );
  return source && context.targetPixelIds.has(source.pixelId)
    ? generatedAssignment(target.pixelId, source.rgba, [source.pixelId])
    : null;
}

function neighborReferenceAssignment(
  target: SurfaceTexel,
  context: CompletionContext,
): CompletionPixelAssignmentDescriptor | null {
  const sample = nearestTargetTexel(
    target,
    context.targetTexels.filter(
      (item) =>
        item.bodyPart === target.bodyPart && item.layer === target.layer,
    ),
    context,
  );
  return sample
    ? generatedAssignment(target.pixelId, sample.rgba, [sample.pixelId])
    : null;
}

function patternContinuationAssignment(
  target: SurfaceTexel,
  context: CompletionContext,
): CompletionPixelAssignmentDescriptor | null {
  const pairs = [
    [
      [target.localU - 1, target.localV],
      [target.localU + 1, target.localV],
    ],
    [
      [target.localU, target.localV - 1],
      [target.localU, target.localV + 1],
    ],
  ] as const;
  for (const [leftCoordinate, rightCoordinate] of pairs) {
    const left = context.texelByCoordinate.get(
      coordinateKey(target.surface, leftCoordinate[0], leftCoordinate[1]),
    );
    const right = context.texelByCoordinate.get(
      coordinateKey(target.surface, rightCoordinate[0], rightCoordinate[1]),
    );
    if (
      left &&
      right &&
      context.targetPixelIds.has(left.pixelId) &&
      context.targetPixelIds.has(right.pixelId) &&
      rgbaEqual(left.rgba, right.rgba)
    ) {
      return generatedAssignment(
        target.pixelId,
        left.rgba,
        sortedNumbers([left.pixelId, right.pixelId]),
      );
    }
  }
  return null;
}

function sampledGeneratedAssignment(
  targetPixelId: number,
  source: SurfaceTexel,
  sourceComponentInstanceId: string,
): CompletionPixelAssignmentDescriptor {
  return {
    targetPixelId,
    rgba: cloneRgba(source.rgba),
    originMode: "generated_completion_with_copy",
    samplePixelIds: [source.pixelId],
    sourcePixelId: source.pixelId,
    sourceComponentInstanceId,
    manualActor: null,
    manualOperationId: null,
  };
}

function generatedAssignment(
  targetPixelId: number,
  rgba: Rgba,
  samplePixelIds: readonly number[],
): CompletionPixelAssignmentDescriptor {
  return {
    targetPixelId,
    rgba: cloneRgba(rgba),
    originMode: "generated_completion",
    samplePixelIds: sortedNumbers(samplePixelIds),
    sourcePixelId: null,
    sourceComponentInstanceId: null,
    manualActor: null,
    manualOperationId: null,
  };
}

function nearestTargetTexel(
  target: SurfaceTexel,
  samples: readonly SurfaceTexel[],
  context: CompletionContext,
): SurfaceTexel | null {
  let winner: SurfaceTexel | null = null;
  let winnerScore: readonly number[] | null = null;
  const targetSize = surfaceDimensions(context, target.surface);
  for (const sample of samples) {
    const sampleSize = surfaceDimensions(context, sample.surface);
    const score = [
      sample.surface === target.surface ? 0 : 1,
      sample.face === target.face ? 0 : 1,
      Math.abs(
        (sample.localU + 0.5) / sampleSize.width -
          (target.localU + 0.5) / targetSize.width,
      ) +
        Math.abs(
          (sample.localV + 0.5) / sampleSize.height -
            (target.localV + 0.5) / targetSize.height,
        ),
      sample.pixelId,
    ] as const;
    if (!winnerScore || compareScore(score, winnerScore) < 0) {
      winner = sample;
      winnerScore = score;
    }
  }
  return winner;
}

function confidenceForStrategy(strategy: CompletionCandidateStrategy): {
  readonly level: CompletionConfidence;
  readonly score: number | null;
} {
  switch (strategy) {
    case "opposite_layer_underlay":
      return { level: "high", score: 0.95 };
    case "mirrored_counterpart":
      return { level: "medium", score: 0.8 };
    case "same_surface_continuation":
      return { level: "medium", score: 0.7 };
    case "pattern_continuation":
      return { level: "medium", score: 0.75 };
    case "opposite_surface_reference":
      return { level: "low", score: 0.55 };
    case "neighbor_reference":
      return { level: "low", score: 0.45 };
    case "manual_edit":
      return { level: "manual", score: null };
  }
}

function materializeAssignments(
  assignments: readonly CompletionPixelAssignmentDescriptor[],
): CompletionCandidateMaterialization {
  const texture = createRgbaImage(SKIN_WIDTH, SKIN_HEIGHT);
  const writeMask = new Uint8Array(SKIN_WIDTH * SKIN_HEIGHT);
  const generatedMask = new Uint8Array(SKIN_WIDTH * SKIN_HEIGHT);
  const occupied = new Set<number>();
  for (const assignment of assignments) {
    validateAssignmentDescriptor(assignment);
    if (occupied.has(assignment.targetPixelId)) {
      throw new RangeError(
        `Completion assignments duplicate pixel ${assignment.targetPixelId}`,
      );
    }
    occupied.add(assignment.targetPixelId);
    texture.data.set(assignment.rgba, assignment.targetPixelId * 4);
    writeMask[assignment.targetPixelId] = 1;
    if (
      assignment.originMode === "generated_completion" ||
      assignment.originMode === "generated_completion_with_copy"
    ) {
      generatedMask[assignment.targetPixelId] = 1;
    }
  }
  return { texture, writeMask, generatedMask };
}

function validateCompletionCandidateWithContext(
  proposal: CompletionProposal,
  candidate: CompletionCandidate,
  source: CompletionSourceSnapshot,
  context: CompletionContext,
): void {
  if (
    candidate.schemaVersion !== COMPLETION_PROPOSAL_SCHEMA_VERSION ||
    candidate.algorithmVersion !== COMPLETION_CANDIDATE_ALGORITHM_VERSION ||
    candidate.representation !== proposal.representation ||
    candidate.targetComponentId !== proposal.targetComponentId ||
    !stringArraysEqual(
      candidate.occludingComponentIds,
      proposal.occludingComponentIds,
    ) ||
    candidate.evidence.proposalEvidenceHash !== proposal.evidenceHash ||
    candidate.evidence.sourceRevisionId !== source.sourceRevisionId ||
    candidate.evidence.sourceResultHash !== source.sourceResultHash ||
    candidate.evidence.sourceSkinHash !== source.sourceSkinHash ||
    candidate.evidence.targetComponentId !== proposal.targetComponentId ||
    candidate.evidence.representation !== proposal.representation ||
    candidate.evidence.strategy !== candidate.strategy ||
    candidate.evidence.baseCandidateId !== candidate.baseCandidateId ||
    !stringArraysEqual(
      candidate.evidence.occludingComponentIds,
      proposal.occludingComponentIds,
    )
  ) {
    throw new RangeError("Completion candidate identity does not match its proposal");
  }
  checkedId(candidate.candidateId, "Completion candidate id");
  assertHash(candidate.evidenceHash, "Completion candidate evidence hash");
  assertHash(candidate.candidateHash, "Completion candidate hash");
  if (
    candidate.reviewRequired !== true ||
    candidate.automaticAcceptanceAllowed !== false
  ) {
    throw new RangeError("Completion candidate must require explicit review");
  }
  if (
    candidate.confidence !== "high" &&
    candidate.confidence !== "medium" &&
    candidate.confidence !== "low" &&
    candidate.confidence !== "manual"
  ) {
    throw new TypeError("Completion candidate confidence is invalid");
  }
  if (
    candidate.confidence === "manual"
      ? candidate.confidenceScore !== null
      : typeof candidate.confidenceScore !== "number" ||
        !Number.isFinite(candidate.confidenceScore) ||
        candidate.confidenceScore < 0 ||
        candidate.confidenceScore > 1
  ) {
    throw new RangeError("Completion candidate confidence score is invalid");
  }
  assertPixelCount(
    candidate.assignments.length,
    MAX_COMPLETION_CANDIDATE_PIXELS,
    "Completion candidate",
  );
  const allowed = new Set(proposal.allowedGeneratedPixelIds);
  const expectedPixelIds: number[] = [];
  for (const assignment of candidate.assignments) {
    validateAssignmentDescriptor(assignment);
    if (!allowed.has(assignment.targetPixelId)) {
      throw new RangeError(
        `Completion candidate pixel ${assignment.targetPixelId} is outside the allowed range`,
      );
    }
    if (proposal.representation === "skin_texel") {
      const offset = assignment.targetPixelId * 4;
      if (
        source.image.data[offset + 3] !== 0 ||
        context.ownerByPixel.has(assignment.targetPixelId)
      ) {
        throw new RangeError(
          `skin_texel Completion cannot overwrite owner at pixel ${assignment.targetPixelId}`,
        );
      }
    } else if (!context.occluderPixelIds.includes(assignment.targetPixelId)) {
      throw new RangeError(
        `latent Completion pixel ${assignment.targetPixelId} is outside its occluder`,
      );
    }
    if (assignment.originMode === "generated_completion_with_copy") {
      const sourcePixelId = assignment.sourcePixelId!;
      if (!context.targetPixelIds.has(sourcePixelId)) {
        throw new RangeError(
          `Completion copy source ${sourcePixelId} is not owned by the target component`,
        );
      }
      const sourceRgba = rgbaAt(source.image, sourcePixelId);
      if (!rgbaEqual(sourceRgba, assignment.rgba)) {
        throw new RangeError("Completion copy color does not match its source pixel");
      }
    } else {
      for (const samplePixelId of assignment.samplePixelIds) {
        if (!context.targetPixelIds.has(samplePixelId)) {
          throw new RangeError(
            `Completion sample ${samplePixelId} is not owned by the target component`,
          );
        }
      }
    }
    expectedPixelIds.push(assignment.targetPixelId);
  }
  const sortedPixelIds = sortedNumbers(expectedPixelIds);
  if (
    sortedPixelIds.length !== expectedPixelIds.length ||
    !numberArraysEqual(candidate.pixelIds, sortedPixelIds) ||
    candidate.pixelCount !== sortedPixelIds.length ||
    !spansEqual(
      candidate.spans,
      pixelIdsToSpans(sortedPixelIds, context.layout),
    )
  ) {
    throw new RangeError("Completion candidate pixel descriptors are inconsistent");
  }
  const expectedMissing = proposal.allowedGeneratedPixelIds.filter(
    (pixelId) => !new Set(sortedPixelIds).has(pixelId),
  );
  if (
    !numberArraysEqual(candidate.missingPixelIds, expectedMissing) ||
    candidate.missingPixelCount !== expectedMissing.length ||
    candidate.complete !== (expectedMissing.length === 0)
  ) {
    throw new RangeError("Completion candidate coverage is inconsistent");
  }
  const materialized = materializeAssignments(candidate.assignments);
  assertSkinImage(candidate.texture);
  assertMask(candidate.writeMask);
  assertMask(candidate.generatedMask);
  if (
    !byteArraysEqual(candidate.texture.data, materialized.texture.data) ||
    !byteArraysEqual(candidate.writeMask, materialized.writeMask) ||
    !byteArraysEqual(candidate.generatedMask, materialized.generatedMask)
  ) {
    throw new RangeError("Completion candidate materialization is inconsistent");
  }
  for (let pixelId = 0; pixelId < candidate.generatedMask.length; pixelId += 1) {
    if (
      candidate.generatedMask[pixelId] !== 0 &&
      candidate.writeMask[pixelId] === 0
    ) {
      throw new RangeError("Completion generated mask must be a write-mask subset");
    }
  }
  if (
    !assignmentsEqual(candidate.assignments, candidate.evidence.assignments)
  ) {
    throw new RangeError("Completion candidate evidence assignments are inconsistent");
  }
}

function assertProposalIdentity(
  proposal: CompletionProposal,
  source: CompletionSourceSnapshot,
): void {
  if (
    proposal.schemaVersion !== COMPLETION_PROPOSAL_SCHEMA_VERSION ||
    proposal.algorithmVersion !== COMPLETION_CANDIDATE_ALGORITHM_VERSION ||
    proposal.sourceRevisionId !== source.sourceRevisionId ||
    proposal.sourceResultHash !== source.sourceResultHash ||
    proposal.sourceSkinHash !== source.sourceSkinHash ||
    proposal.armType !== source.semanticState.document.source.armType ||
    proposal.evidence.sourceRevisionId !== source.sourceRevisionId ||
    proposal.evidence.sourceResultHash !== source.sourceResultHash ||
    proposal.evidence.sourceSkinHash !== source.sourceSkinHash ||
    proposal.evidence.armType !== proposal.armType ||
    proposal.evidence.targetComponentId !== proposal.targetComponentId ||
    proposal.evidence.requestedRepresentation !== proposal.requestedRepresentation ||
    proposal.evidence.representation !== proposal.representation ||
    !stringArraysEqual(
      proposal.evidence.occludingComponentIds,
      proposal.occludingComponentIds,
    ) ||
    !numberArraysEqual(
      proposal.evidence.allowedGeneratedPixelIds,
      proposal.allowedGeneratedPixelIds,
    ) ||
    !spansEqual(
      proposal.evidence.allowedGeneratedSpans,
      proposal.allowedGeneratedSpans,
    )
  ) {
    throw new RangeError("Completion proposal identity does not match its source");
  }
  assertHash(proposal.evidenceHash, "Completion proposal evidence hash");
  assertHash(proposal.proposalHash, "Completion proposal hash");
  checkedId(proposal.proposalId, "Completion proposal id");
}

function createCompletionOriginAssignments(
  candidate: CompletionCandidate,
  decision: CompletionDecision,
  sourceOriginDocument: PixelOriginDocument,
): PixelOriginAssignment[] {
  return candidate.assignments.map((assignment) => {
    switch (assignment.originMode) {
      case "generated_completion":
        return createGeneratedPixelOriginAssignment({
          pixelId: assignment.targetPixelId,
          evidence: {
            candidateId: candidate.candidateId,
            evidenceHash: candidate.evidenceHash,
            decisionId: decision.decisionId,
            actor: decision.actor,
          },
        });
      case "generated_completion_with_copy": {
        const generated = createGeneratedPixelOriginAssignment({
          pixelId: assignment.targetPixelId,
          evidence: {
            candidateId: candidate.candidateId,
            evidenceHash: candidate.evidenceHash,
            decisionId: decision.decisionId,
            actor: decision.actor,
          },
        });
        return {
          ...generated,
          copyLineage: {
            sourceSubject: {
              kind: sourceOriginDocument.subject.kind,
              id: sourceOriginDocument.subject.id,
            },
            sourceComponentInstanceId: assignment.sourceComponentInstanceId,
            sourcePixelId: assignment.sourcePixelId!,
          },
        };
      }
      case "manual_authored":
        return createManualPixelOriginAssignment({
          pixelId: assignment.targetPixelId,
          actor: assignment.manualActor!,
          operationId: assignment.manualOperationId!,
        });
    }
  });
}

function validateDecisionBinding(
  proposal: CompletionProposal,
  candidate: CompletionCandidate | undefined,
  decision: CompletionDecision,
): void {
  if (
    decision.schemaVersion !== COMPLETION_PROPOSAL_SCHEMA_VERSION ||
    decision.proposalId !== proposal.proposalId ||
    decision.proposalHash !== proposal.proposalHash ||
    decision.sourceRevisionId !== proposal.sourceRevisionId ||
    decision.sourceResultHash !== proposal.sourceResultHash ||
    decision.sourceSkinHash !== proposal.sourceSkinHash ||
    decision.actor.type !== "user" ||
    decision.automatic !== false
  ) {
    throw new RangeError("Completion decision does not match its proposal");
  }
  if (decision.action === "reject") {
    if (
      candidate !== undefined ||
      decision.candidateId !== null ||
      decision.candidateHash !== null ||
      decision.candidateEvidenceHash !== null
    ) {
      throw new RangeError("Completion rejection must be proposal-level");
    }
  } else if (
    !candidate ||
    decision.candidateId !== candidate.candidateId ||
    decision.candidateHash !== candidate.candidateHash ||
    decision.candidateEvidenceHash !== candidate.evidenceHash
  ) {
    throw new RangeError("Completion acceptance does not match its candidate");
  }
  assertHash(decision.decisionHash, "Completion decision hash");
  if (
    decision.decisionId !==
    `completiondecision_${hashToken(decision.decisionHash)}`
  ) {
    throw new RangeError("Completion decision id does not match its hash");
  }
}

function validateAssignmentDescriptor(
  assignment: CompletionPixelAssignmentDescriptor,
): void {
  assertPixelId(assignment.targetPixelId, "Completion assignment target");
  assertVisibleRgba(assignment.rgba, "Completion assignment RGBA");
  if (assignment.samplePixelIds.length > MAX_COMPLETION_CANDIDATE_PIXELS) {
    throw new RangeError("Completion assignment has too many sample pixels");
  }
  const samples = sortedNumbers(assignment.samplePixelIds);
  if (!numberArraysEqual(samples, assignment.samplePixelIds)) {
    throw new RangeError("Completion assignment sample pixels must be unique and sorted");
  }
  for (const pixelId of samples) {
    assertPixelId(pixelId, "Completion assignment sample");
  }
  switch (assignment.originMode) {
    case "generated_completion_with_copy":
      if (
        assignment.sourcePixelId === null ||
        assignment.sourceComponentInstanceId === null ||
        assignment.manualActor !== null ||
        assignment.manualOperationId !== null ||
        !numberArraysEqual(assignment.samplePixelIds, [assignment.sourcePixelId])
      ) {
        throw new RangeError("Completion sampled-generation assignment is incomplete");
      }
      assertPixelId(assignment.sourcePixelId, "Completion copy source");
      checkedComponentId(
        assignment.sourceComponentInstanceId,
        "Completion copied component id",
      );
      break;
    case "generated_completion":
      if (
        assignment.sourcePixelId !== null ||
        assignment.sourceComponentInstanceId !== null ||
        assignment.manualActor !== null ||
        assignment.manualOperationId !== null
      ) {
        throw new RangeError("Completion generated assignment has invalid provenance");
      }
      break;
    case "manual_authored":
      if (
        assignment.sourcePixelId !== null ||
        assignment.sourceComponentInstanceId !== null ||
        assignment.manualActor === null ||
        assignment.manualOperationId === null ||
        assignment.samplePixelIds.length !== 0
      ) {
        throw new RangeError("Completion manual assignment is incomplete");
      }
      const manualActor = cloneActor(assignment.manualActor);
      if (manualActor.type !== "user") {
        throw new RangeError(
          "Completion manual assignment requires an explicit user actor",
        );
      }
      checkedId(
        assignment.manualOperationId,
        "Completion manual operation id",
      );
      break;
    default:
      throw new TypeError(
        `Unknown Completion pixel origin: ${String(assignment.originMode)}`,
      );
  }
}

function canonicalValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical Completion JSON rejects non-finite numbers");
    }
    return value;
  }
  if (value instanceof Uint8Array) {
    throw new TypeError("Canonical Completion JSON excludes Uint8Array materializations");
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object") {
    const object = value as Readonly<Record<string, unknown>>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(object).sort(compareString)) {
      const item = object[key];
      if (item === undefined) {
        throw new TypeError(
          `Canonical Completion JSON rejects undefined property: ${key}`,
        );
      }
      result[key] = canonicalValue(item);
    }
    return result;
  }
  throw new TypeError(`Canonical Completion JSON rejects ${typeof value}`);
}

function proposalFingerprint(
  evidenceHash: string,
  candidateHashes: readonly string[],
): unknown {
  return {
    schemaVersion: COMPLETION_PROPOSAL_SCHEMA_VERSION,
    algorithmVersion: COMPLETION_CANDIDATE_ALGORITHM_VERSION,
    evidenceHash,
    candidateHashes,
  };
}

function candidateFingerprint(
  candidate: CompletionCandidateDocument,
  evidenceHash: string,
): unknown {
  return {
    schemaVersion: candidate.schemaVersion,
    algorithmVersion: candidate.algorithmVersion,
    representation: candidate.representation,
    strategy: candidate.strategy,
    targetComponentId: candidate.targetComponentId,
    occludingComponentIds: candidate.occludingComponentIds,
    baseCandidateId: candidate.baseCandidateId,
    assignments: candidate.assignments,
    pixelIds: candidate.pixelIds,
    spans: candidate.spans,
    missingPixelIds: candidate.missingPixelIds,
    confidence: candidate.confidence,
    confidenceScore: candidate.confidenceScore,
    reviewRequired: candidate.reviewRequired,
    automaticAcceptanceAllowed: candidate.automaticAcceptanceAllowed,
    evidenceHash,
  };
}

function isMaterializedProposal(value: unknown): value is CompletionProposal {
  return (
    value !== null &&
    typeof value === "object" &&
    "allowedGeneratedMask" in value &&
    "proposalHash" in value
  );
}

function isMaterializedCandidate(value: unknown): value is CompletionCandidate {
  return (
    value !== null &&
    typeof value === "object" &&
    "texture" in value &&
    "writeMask" in value &&
    "candidateHash" in value
  );
}

function cloneProposalEvidence(
  evidence: CompletionProposalEvidence,
): CompletionProposalEvidence {
  return {
    ...evidence,
    occludingComponentIds: [...evidence.occludingComponentIds],
    allowedGeneratedPixelIds: [...evidence.allowedGeneratedPixelIds],
    allowedGeneratedSpans: evidence.allowedGeneratedSpans.map(cloneSpan),
  };
}

function cloneCandidateEvidence(
  evidence: CompletionCandidateEvidence,
): CompletionCandidateEvidence {
  return {
    ...evidence,
    occludingComponentIds: [...evidence.occludingComponentIds],
    assignments: evidence.assignments.map(cloneAssignment),
  };
}

function cloneAssignment(
  assignment: CompletionPixelAssignmentDescriptor,
): CompletionPixelAssignmentDescriptor {
  return {
    targetPixelId: assignment.targetPixelId,
    rgba: cloneRgba(assignment.rgba),
    originMode: assignment.originMode,
    samplePixelIds: [...assignment.samplePixelIds],
    sourcePixelId: assignment.sourcePixelId,
    sourceComponentInstanceId: assignment.sourceComponentInstanceId,
    manualActor:
      assignment.manualActor === null
        ? null
        : cloneActor(assignment.manualActor),
    manualOperationId: assignment.manualOperationId,
  };
}

function cloneActor(actor: PixelOriginActor): PixelOriginActor {
  if (
    actor.type !== "user" &&
    actor.type !== "ai" &&
    actor.type !== "system"
  ) {
    throw new TypeError(`Unknown Completion actor: ${String(actor.type)}`);
  }
  if (actor.id === undefined) return { type: actor.type };
  if (
    typeof actor.id !== "string" ||
    actor.id.length === 0 ||
    actor.id.length > 120 ||
    actor.id !== actor.id.trim() ||
    /[\u0000-\u001f\u007f]/u.test(actor.id)
  ) {
    throw new TypeError("Completion actor id must be 1-120 visible characters");
  }
  return { type: actor.type, id: actor.id };
}

function cloneSpan(span: SemanticPixelSpan): SemanticPixelSpan {
  return { surface: span.surface, y: span.y, x0: span.x0, x1: span.x1 };
}

function runHash(hashCanonical: CompletionHashCanonical, value: unknown): string {
  const hash = hashCanonical(canonicalCompletionJson(value));
  assertHash(hash, "hashCanonical result");
  return hash;
}

function assertHash(value: string, label: string): void {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw new TypeError(`${label} must be sha256:<64 lowercase hex>`);
  }
}

function hashToken(hash: string): string {
  const match = HASH_PATTERN.exec(hash);
  if (!match) throw new TypeError("Invalid Completion hash");
  return match[1]!;
}

function checkedId(value: string, label: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new TypeError(`${label} must be a path-safe reference id`);
  }
  return value;
}

function checkedComponentId(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    value === "unknown" ||
    value.length > 100 ||
    !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u.test(value)
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function sortedUniqueIds(
  values: readonly string[],
  label: string,
  maximum: number,
): string[] {
  if (!Array.isArray(values) || values.length > maximum) {
    throw new RangeError(`${label} must not exceed ${maximum}`);
  }
  const result = [...values].sort(compareString);
  for (let index = 0; index < result.length; index += 1) {
    const value = result[index]!;
    checkedComponentId(value, label);
    if (index > 0 && value === result[index - 1]) {
      throw new RangeError(`${label} contains duplicate id: ${value}`);
    }
  }
  return result;
}

function assertPixelCount(count: number, maximum: number, label: string): void {
  if (!Number.isInteger(count) || count < 0 || count > maximum) {
    throw new RangeError(`${label} pixels must not exceed ${maximum}`);
  }
}

function assertPixelId(pixelId: number, label: string): void {
  if (
    !Number.isInteger(pixelId) ||
    pixelId < 0 ||
    pixelId >= SKIN_WIDTH * SKIN_HEIGHT
  ) {
    throw new RangeError(
      `${label} must be an integer from 0 to ${SKIN_WIDTH * SKIN_HEIGHT - 1}`,
    );
  }
}

function assertVisibleRgba(rgba: Rgba, label: string): void {
  if (
    !Array.isArray(rgba) ||
    rgba.length !== 4 ||
    rgba.some((value) => !Number.isInteger(value) || value < 0 || value > 255) ||
    rgba[3] === 0
  ) {
    throw new RangeError(`${label} must contain four bytes with nonzero alpha`);
  }
}

function coordinateKey(surface: SurfaceKey, u: number, v: number): string {
  return `${surface}:${u}:${v}`;
}

function surfaceKey(
  bodyPart: BodyPart,
  layer: Layer,
  face: Face,
): SurfaceKey {
  return `${bodyPart}.${layer}.${face}`;
}

function supportGroup(bodyPart: BodyPart, layer: Layer): string {
  return `${bodyPart}.${layer}`;
}

function oppositeLayer(layer: Layer): Layer {
  return layer === "base" ? "outer" : "base";
}

function oppositeFace(face: Face): Face {
  switch (face) {
    case "front":
      return "back";
    case "back":
      return "front";
    case "left":
      return "right";
    case "right":
      return "left";
    case "top":
      return "bottom";
    case "bottom":
      return "top";
  }
}

function mirroredBodyPart(bodyPart: BodyPart): BodyPart {
  switch (bodyPart) {
    case "rightArm":
      return "leftArm";
    case "leftArm":
      return "rightArm";
    case "rightLeg":
      return "leftLeg";
    case "leftLeg":
      return "rightLeg";
    default:
      return bodyPart;
  }
}

function mirroredFace(face: Face): Face {
  if (face === "left") return "right";
  if (face === "right") return "left";
  return face;
}

function surfaceDimensions(
  context: CompletionContext,
  surface: SurfaceKey,
): { readonly width: number; readonly height: number } {
  const texels = context.texels.filter((texel) => texel.surface === surface);
  if (texels.length === 0) {
    throw new RangeError(`Unknown Completion surface ${surface}`);
  }
  return {
    width: Math.max(...texels.map((texel) => texel.localU)) + 1,
    height: Math.max(...texels.map((texel) => texel.localV)) + 1,
  };
}

function rgbaAt(image: RgbaImage, pixelId: number): Rgba {
  const offset = pixelId * 4;
  return [
    image.data[offset]!,
    image.data[offset + 1]!,
    image.data[offset + 2]!,
    image.data[offset + 3]!,
  ];
}

function cloneImage(image: RgbaImage): RgbaImage {
  return createRgbaImage(image.width, image.height, image.data.slice());
}

function cloneRgba(rgba: Rgba): Rgba {
  return [rgba[0], rgba[1], rgba[2], rgba[3]];
}

function rgbaEqual(left: Rgba, right: Rgba): boolean {
  return left.every((value, index) => value === right[index]);
}

function compareAssignment(
  left: CompletionPixelAssignmentDescriptor,
  right: CompletionPixelAssignmentDescriptor,
): number {
  return left.targetPixelId - right.targetPixelId;
}

function compareTexel(left: SurfaceTexel, right: SurfaceTexel): number {
  return left.pixelId - right.pixelId;
}

function compareScore(
  left: readonly number[],
  right: readonly number[],
): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

function compareString(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedNumbers(values: Iterable<number>): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function numberArraysEqual(
  left: readonly number[],
  right: readonly number[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function stringArraysEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function spansEqual(
  left: readonly SemanticPixelSpan[],
  right: readonly SemanticPixelSpan[],
): boolean {
  return (
    left.length === right.length &&
    left.every((span, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        span.surface === other.surface &&
        span.y === other.y &&
        span.x0 === other.x0 &&
        span.x1 === other.x1
      );
    })
  );
}

function assignmentsEqual(
  left: readonly CompletionPixelAssignmentDescriptor[],
  right: readonly CompletionPixelAssignmentDescriptor[],
): boolean {
  return canonicalCompletionJson(left) === canonicalCompletionJson(right);
}

function byteArraysEqual(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
