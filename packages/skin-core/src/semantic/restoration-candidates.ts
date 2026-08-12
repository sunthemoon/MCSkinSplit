import { getSkinLayout } from "../layouts/layout";
import {
  BODY_PARTS,
  type ArmType,
  type BodyPart,
  type Face,
  type Layer,
  type Rgba,
  type RgbaImage,
  type SkinLayout,
  type SurfaceKey,
  type SurfaceTexel,
} from "../types";
import { buildSurfaceTexels } from "../uv/surface-model";
import { validateSemanticState } from "./editor";
import { maskToPixelIds, pixelIdsToMask } from "./mask";
import type { SemanticState } from "./types";

export type RestorationCandidateKind =
  | "outer_transparent"
  | "current_same_surface"
  | "current_same_body_part"
  | "mirrored_counterpart"
  | "donor_revision"
  | "manual_rgba";

export type RestorationHashCanonical = (canonicalJson: string) => string;

export interface RestorationSemanticRevision {
  readonly revisionId: string;
  readonly image: RgbaImage;
  readonly semanticState: SemanticState;
}

export interface GenerateRestorationCandidatesInput {
  readonly source: RestorationSemanticRevision;
  readonly cleanupComponentIds: readonly string[];
  readonly donors?: readonly RestorationSemanticRevision[];
  readonly manualColors?: readonly Rgba[];
  readonly hashCanonical: RestorationHashCanonical;
}

export interface RestorationTargetGroup {
  readonly targetGroupId: string;
  readonly bodyPart: BodyPart;
  readonly layer: Layer;
  readonly componentIds: readonly string[];
  readonly surfaceKeys: readonly SurfaceKey[];
  readonly pixelIds: readonly number[];
  readonly pixelCount: number;
  /** Materialized host mask. It is deliberately excluded from canonical JSON. */
  readonly mask: Uint8Array;
}

export type RestorationOperationDescriptor =
  | {
      readonly operationId: string;
      readonly mode: "clear_outer";
      readonly pixelIds: readonly number[];
    }
  | {
      readonly operationId: string;
      readonly mode: "fill_base";
      readonly pixelIds: readonly number[];
      readonly rgba: Rgba;
    };

/** Structurally compatible with skin-compositor without creating a dependency cycle. */
export type RestorationPlanOperation =
  | {
      readonly operationId: string;
      readonly mode: "clear_outer";
      readonly mask: Uint8Array;
    }
  | {
      readonly operationId: string;
      readonly mode: "fill_base";
      readonly mask: Uint8Array;
      readonly rgba: Rgba;
    };

export interface RestorationColorGroupEvidence {
  readonly rgba: Rgba;
  readonly targetPixelIds: readonly number[];
  readonly samplePixelIds: readonly number[];
}

export interface RestorationPixelAssignmentEvidence {
  readonly targetPixelId: number;
  readonly samplePixelId: number | null;
  readonly rgba: Rgba;
}

export interface RestorationCandidateEvidence {
  readonly schemaVersion: "1.0";
  readonly kind: RestorationCandidateKind;
  readonly sourceRevisionId: string;
  readonly sourceComponentIds: readonly string[];
  readonly targetGroupId: string;
  readonly targetGroupIds: readonly string[];
  readonly sampleRevisionId: string | null;
  readonly manualRgba: Rgba | null;
  readonly targetPixelIds: readonly number[];
  readonly samplePixelIds: readonly number[];
  readonly assignments: readonly RestorationPixelAssignmentEvidence[];
  readonly colorGroups: readonly RestorationColorGroupEvidence[];
}

export interface RestorationCandidate {
  readonly candidateId: string;
  readonly kind: RestorationCandidateKind;
  /** Selection bucket. Aggregate Outer uses `outer_all`; Base uses one concrete group. */
  readonly targetGroupId: string;
  /** Concrete host-derived body/layer groups affected by this candidate. */
  readonly targetGroupIds: readonly string[];
  readonly sourceComponentIds: readonly string[];
  readonly sampleRevisionId: string | null;
  readonly manualRgba: Rgba | null;
  /** JSON-safe operations used by persistence and canonical hashing. */
  readonly operationDescriptors: readonly RestorationOperationDescriptor[];
  /** Materialized compositor operations. Transport DTOs must omit these masks. */
  readonly operations: readonly RestorationPlanOperation[];
  readonly requestedPixelIds: readonly number[];
  readonly requestedPixelCount: number;
  readonly coveredPixelIds: readonly number[];
  readonly coveredPixelCount: number;
  readonly missingPixelIds: readonly number[];
  readonly missingPixelCount: number;
  readonly complete: boolean;
  readonly evidence: RestorationCandidateEvidence;
  readonly evidenceHash: string;
}

export interface RestorationCandidateSet {
  readonly schemaVersion: "1.0";
  readonly sourceRevisionId: string;
  readonly sourceHash: string;
  readonly armType: ArmType;
  readonly cleanupComponentIds: readonly string[];
  readonly cleanupPixelIds: readonly number[];
  readonly cleanupPixelCount: number;
  /** Materialized union derived from semantic component masks; excluded from hashes/DTOs. */
  readonly cleanupMask: Uint8Array;
  readonly targetGroups: readonly RestorationTargetGroup[];
  readonly candidates: readonly RestorationCandidate[];
  readonly candidateSetHash: string;
}

export interface RestorationCandidatePlanEvidence {
  readonly sourceRevisionId: string;
  readonly candidateEvidenceHashes: readonly string[];
}

export interface RestorationCandidatePlan {
  readonly schemaVersion: "1.0";
  readonly candidateSetHash: string;
  readonly selectedCandidateIds: readonly string[];
  readonly operationDescriptors: readonly RestorationOperationDescriptor[];
  readonly operations: readonly RestorationPlanOperation[];
  readonly requestedPixelIds: readonly number[];
  readonly requestedPixelCount: number;
  readonly coveredPixelIds: readonly number[];
  readonly coveredPixelCount: number;
  readonly missingPixelIds: readonly number[];
  readonly missingPixelCount: number;
  readonly complete: boolean;
  readonly evidence: RestorationCandidatePlanEvidence;
  readonly planHash: string;
}

interface SampleCatalog {
  readonly revisionId: string;
  readonly bySurface: ReadonlyMap<SurfaceKey, readonly SurfaceTexel[]>;
  readonly byBodyPart: ReadonlyMap<BodyPart, readonly SurfaceTexel[]>;
  readonly exact: ReadonlyMap<string, SurfaceTexel>;
  readonly componentIdByPixel: ReadonlyMap<number, string>;
}

interface Assignment {
  readonly target: SurfaceTexel;
  readonly sample: SurfaceTexel | null;
  readonly rgba: Rgba;
}

const HASH_PATTERN = /^sha256:([0-9a-f]{64})$/u;

export function generateRestorationCandidates(
  input: GenerateRestorationCandidatesInput,
): RestorationCandidateSet {
  const { source } = input;
  assertRevision(source, "source");
  const layout = getSkinLayout(source.semanticState.document.source.armType);
  validateSemanticState(source.semanticState, source.image, layout);

  const cleanupComponentIds = sortedUniqueStrings(
    input.cleanupComponentIds,
    "cleanupComponentIds",
  );
  if (cleanupComponentIds.length === 0) {
    throw new RangeError("cleanupComponentIds must not be empty");
  }

  const componentsById = new Map(
    source.semanticState.document.components.map((component) => [
      component.instanceId,
      component,
    ]),
  );
  const cleanupPixels = new Set<number>();
  for (const componentId of cleanupComponentIds) {
    if (!componentsById.has(componentId)) {
      throw new RangeError(`Unknown cleanup component: ${componentId}`);
    }
    for (const pixelId of maskToPixelIds(source.semanticState.masks[componentId]!)) {
      cleanupPixels.add(pixelId);
    }
  }
  const cleanupPixelIds = sortedNumbers(cleanupPixels);
  if (cleanupPixelIds.length === 0) {
    throw new RangeError("Cleanup components do not contain any pixels");
  }

  const sourceTexels = buildSurfaceTexels(source.image, layout);
  const texelByPixel = new Map(sourceTexels.map((texel) => [texel.pixelId, texel]));
  const targetGroups = buildTargetGroups(
    cleanupPixelIds,
    cleanupComponentIds,
    source.semanticState,
    texelByPixel,
    layout,
  );
  const sourceSamples = buildSampleCatalog(source, cleanupPixels, layout);

  const donors = [...(input.donors ?? [])].sort((left, right) =>
    compareString(left.revisionId, right.revisionId),
  );
  assertDonors(donors, source, layout.armType);
  const donorSamples = donors.map((donor) => ({
    donor,
    // Cleanup ids identify pixels removed from the source revision. The same
    // atlas coordinates in an independent donor remain valid evidence.
    samples: buildSampleCatalog(donor, new Set<number>(), layout),
  }));
  const manualColors = sortedUniqueColors(input.manualColors ?? []);

  const candidates: RestorationCandidate[] = [];
  const outerGroups = targetGroups.filter((group) => group.layer === "outer");
  if (outerGroups.length > 0) {
    candidates.push(
      createOuterCandidate(
        outerGroups,
        source.revisionId,
        input.hashCanonical,
      ),
    );
  }

  for (const group of targetGroups.filter((candidate) => candidate.layer === "base")) {
    const targetTexels = group.pixelIds.map((pixelId) => texelByPixel.get(pixelId)!);
    addSampleCandidate(
      candidates,
      "current_same_surface",
      group,
      source.revisionId,
      source.revisionId,
      sourceSamples,
      mapNearestBySurface(targetTexels, sourceSamples),
      input.hashCanonical,
    );
    addSampleCandidate(
      candidates,
      "current_same_body_part",
      group,
      source.revisionId,
      source.revisionId,
      sourceSamples,
      mapNearestByBodyPart(targetTexels, sourceSamples, layout),
      input.hashCanonical,
    );
    addSampleCandidate(
      candidates,
      "mirrored_counterpart",
      group,
      source.revisionId,
      source.revisionId,
      sourceSamples,
      mapMirrored(targetTexels, sourceSamples, layout),
      input.hashCanonical,
    );
    for (const { donor, samples } of donorSamples) {
      addSampleCandidate(
        candidates,
        "donor_revision",
        group,
        source.revisionId,
        donor.revisionId,
        samples,
        mapDonor(targetTexels, samples, layout),
        input.hashCanonical,
      );
    }
    for (const color of manualColors) {
      const assignments = targetTexels.map((target): Assignment => ({
        target,
        sample: null,
        rgba: cloneRgba(color),
      }));
      candidates.push(
        createFillCandidate(
          "manual_rgba",
          group,
          source.revisionId,
          null,
          [],
          assignments,
          color,
          input.hashCanonical,
        ),
      );
    }
  }

  const fingerprint = {
    schemaVersion: "1.0",
    sourceRevisionId: source.revisionId,
    sourceHash: source.semanticState.document.source.sourceHash,
    armType: layout.armType,
    cleanupComponentIds,
    cleanupPixelIds,
    targetGroups: targetGroups.map(groupFingerprint),
    candidates: candidates.map(candidateFingerprint),
  } as const;
  const candidateSetHash = runHash(input.hashCanonical, fingerprint);

  return {
    schemaVersion: "1.0",
    sourceRevisionId: source.revisionId,
    sourceHash: source.semanticState.document.source.sourceHash,
    armType: layout.armType,
    cleanupComponentIds,
    cleanupPixelIds,
    cleanupPixelCount: cleanupPixelIds.length,
    cleanupMask: pixelIdsToMask(cleanupPixelIds),
    targetGroups,
    candidates,
    candidateSetHash,
  };
}

export function createRestorationPlanFromCandidates(
  candidateSet: RestorationCandidateSet,
  candidateIds: readonly string[],
  hashCanonical: RestorationHashCanonical,
): RestorationCandidatePlan {
  const requestedIds = sortedUniqueStrings(candidateIds, "candidateIds");
  const outerCandidates = candidateSet.candidates.filter(
    (candidate) => candidate.kind === "outer_transparent",
  );
  if (outerCandidates.length > 1) {
    throw new RangeError("Restoration candidate set contains multiple Outer candidates");
  }
  const uniqueIds = sortedUnique(
    [
      ...requestedIds,
      ...(outerCandidates[0] ? [outerCandidates[0].candidateId] : []),
    ],
    compareString,
  );
  const candidatesById = new Map(
    candidateSet.candidates.map((candidate) => [candidate.candidateId, candidate]),
  );
  const selected = uniqueIds.map((candidateId) => {
    const candidate = candidatesById.get(candidateId);
    if (!candidate) throw new RangeError(`Unknown restoration candidate: ${candidateId}`);
    return candidate;
  });
  selected.sort(
    (left, right) =>
      candidateSet.candidates.indexOf(left) - candidateSet.candidates.indexOf(right),
  );

  const occupiedGroups = new Map<string, string>();
  const occupiedPixels = new Map<number, string>();
  for (const candidate of selected) {
    for (const targetGroupId of candidate.targetGroupIds) {
      const previous = occupiedGroups.get(targetGroupId);
      if (previous) {
        throw new RangeError(
          `Restoration candidates ${previous} and ${candidate.candidateId} target the same group`,
        );
      }
      occupiedGroups.set(targetGroupId, candidate.candidateId);
    }
    for (const pixelId of candidate.coveredPixelIds) {
      const previous = occupiedPixels.get(pixelId);
      if (previous) {
        throw new RangeError(
          `Restoration candidates ${previous} and ${candidate.candidateId} overlap pixel ${pixelId}`,
        );
      }
      occupiedPixels.set(pixelId, candidate.candidateId);
    }
  }

  const coveredPixelIds = sortedNumbers(occupiedPixels.keys());
  const covered = new Set(coveredPixelIds);
  const missingPixelIds = candidateSet.cleanupPixelIds.filter(
    (pixelId) => !covered.has(pixelId),
  );
  const operationDescriptors = selected.flatMap(
    (candidate) => candidate.operationDescriptors,
  );
  const operations = materializeOperations(operationDescriptors);
  const evidence = {
    sourceRevisionId: candidateSet.sourceRevisionId,
    candidateEvidenceHashes: selected.map((candidate) => candidate.evidenceHash),
  } as const;
  const selectedCandidateIds = selected.map((candidate) => candidate.candidateId);
  const planFingerprint = {
    schemaVersion: "1.0",
    candidateSetHash: candidateSet.candidateSetHash,
    selectedCandidateIds,
    operationDescriptors,
    requestedPixelIds: candidateSet.cleanupPixelIds,
    coveredPixelIds,
    missingPixelIds,
    evidence,
  } as const;
  const planHash = runHash(hashCanonical, planFingerprint);

  return {
    schemaVersion: "1.0",
    candidateSetHash: candidateSet.candidateSetHash,
    selectedCandidateIds,
    operationDescriptors,
    operations,
    requestedPixelIds: candidateSet.cleanupPixelIds,
    requestedPixelCount: candidateSet.cleanupPixelCount,
    coveredPixelIds,
    coveredPixelCount: coveredPixelIds.length,
    missingPixelIds,
    missingPixelCount: missingPixelIds.length,
    complete: missingPixelIds.length === 0,
    evidence,
    planHash,
  };
}

/** Canonical JSON for browser-safe host hashing. Typed-array masks are rejected. */
export function canonicalRestorationJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function buildTargetGroups(
  cleanupPixelIds: readonly number[],
  cleanupComponentIds: readonly string[],
  state: SemanticState,
  texelByPixel: ReadonlyMap<number, SurfaceTexel>,
  layout: SkinLayout,
): RestorationTargetGroup[] {
  const pixelsByGroup = new Map<string, number[]>();
  for (const pixelId of cleanupPixelIds) {
    const texel = texelByPixel.get(pixelId);
    if (!texel) throw new RangeError(`Cleanup pixel ${pixelId} is outside used UV`);
    const id = targetGroupId(texel.bodyPart, texel.layer);
    const groupPixels = pixelsByGroup.get(id) ?? [];
    groupPixels.push(pixelId);
    pixelsByGroup.set(id, groupPixels);
  }

  const surfaceIndex = new Map(layout.surfaceOrder.map((key, index) => [key, index]));
  const groups: RestorationTargetGroup[] = [];
  for (const bodyPart of BODY_PARTS) {
    for (const layer of ["base", "outer"] as const) {
      const id = targetGroupId(bodyPart, layer);
      const pixelIds = pixelsByGroup.get(id);
      if (!pixelIds) continue;
      pixelIds.sort((left, right) => left - right);
      const pixelSet = new Set(pixelIds);
      const componentIds = cleanupComponentIds.filter((componentId) =>
        maskToPixelIds(state.masks[componentId]!).some((pixelId) => pixelSet.has(pixelId)),
      );
      const surfaceKeys = sortedUnique(
        pixelIds.map((pixelId) => texelByPixel.get(pixelId)!.surface),
        (left, right) => (surfaceIndex.get(left) ?? 0) - (surfaceIndex.get(right) ?? 0),
      );
      groups.push({
        targetGroupId: id,
        bodyPart,
        layer,
        componentIds,
        surfaceKeys,
        pixelIds,
        pixelCount: pixelIds.length,
        mask: pixelIdsToMask(pixelIds),
      });
    }
  }
  return groups;
}

function buildSampleCatalog(
  revision: RestorationSemanticRevision,
  cleanupPixels: ReadonlySet<number>,
  layout: SkinLayout,
): SampleCatalog {
  const skinPixels = new Set<number>();
  for (const component of revision.semanticState.document.components) {
    if (component.category !== "skin") continue;
    for (const pixelId of maskToPixelIds(revision.semanticState.masks[component.instanceId]!)) {
      skinPixels.add(pixelId);
    }
  }

  const bySurface = new Map<SurfaceKey, SurfaceTexel[]>();
  const byBodyPart = new Map<BodyPart, SurfaceTexel[]>();
  const exact = new Map<string, SurfaceTexel>();
  const componentIdByPixel = new Map<number, string>();
  for (const component of revision.semanticState.document.components) {
    if (component.category !== "skin") continue;
    for (const pixelId of maskToPixelIds(
      revision.semanticState.masks[component.instanceId]!,
    )) {
      componentIdByPixel.set(pixelId, component.instanceId);
    }
  }
  for (const texel of buildSurfaceTexels(revision.image, layout)) {
    if (
      texel.layer !== "base" ||
      texel.rgba[3] !== 255 ||
      cleanupPixels.has(texel.pixelId) ||
      !skinPixels.has(texel.pixelId)
    ) {
      continue;
    }
    const surface = bySurface.get(texel.surface) ?? [];
    surface.push(texel);
    bySurface.set(texel.surface, surface);
    const bodyPart = byBodyPart.get(texel.bodyPart) ?? [];
    bodyPart.push(texel);
    byBodyPart.set(texel.bodyPart, bodyPart);
    exact.set(exactTexelKey(texel.surface, texel.localU, texel.localV), texel);
  }
  for (const samples of bySurface.values()) samples.sort(compareTexel);
  for (const samples of byBodyPart.values()) samples.sort(compareTexel);
  return {
    revisionId: revision.revisionId,
    bySurface,
    byBodyPart,
    exact,
    componentIdByPixel,
  };
}

function createOuterCandidate(
  groups: readonly RestorationTargetGroup[],
  sourceRevisionId: string,
  hashCanonical: RestorationHashCanonical,
): RestorationCandidate {
  const targetPixelIds = sortedNumbers(groups.flatMap((group) => group.pixelIds));
  const sourceComponentIds: readonly string[] = [];
  const targetGroupIds = groups.map((group) => group.targetGroupId);
  const evidence: RestorationCandidateEvidence = {
    schemaVersion: "1.0",
    kind: "outer_transparent",
    sourceRevisionId,
    sourceComponentIds,
    targetGroupId: "outer_all",
    targetGroupIds,
    sampleRevisionId: null,
    manualRgba: null,
    targetPixelIds,
    samplePixelIds: [],
    assignments: [],
    colorGroups: [],
  };
  const evidenceHash = runHash(hashCanonical, evidence);
  const operationDescriptors: RestorationOperationDescriptor[] = groups.map(
    (group, index) => ({
      operationId: operationId(evidenceHash, index),
      mode: "clear_outer",
      pixelIds: group.pixelIds,
    }),
  );
  return {
    candidateId: candidateId(evidenceHash),
    kind: "outer_transparent",
    targetGroupId: "outer_all",
    targetGroupIds,
    sourceComponentIds,
    sampleRevisionId: null,
    manualRgba: null,
    operationDescriptors,
    operations: materializeOperations(operationDescriptors),
    requestedPixelIds: targetPixelIds,
    requestedPixelCount: targetPixelIds.length,
    coveredPixelIds: targetPixelIds,
    coveredPixelCount: targetPixelIds.length,
    missingPixelIds: [],
    missingPixelCount: 0,
    complete: true,
    evidence,
    evidenceHash,
  };
}

function addSampleCandidate(
  target: RestorationCandidate[],
  kind: Exclude<RestorationCandidateKind, "outer_transparent" | "manual_rgba">,
  group: RestorationTargetGroup,
  sourceRevisionId: string,
  sampleRevisionId: string,
  samples: SampleCatalog,
  assignments: readonly Assignment[],
  hashCanonical: RestorationHashCanonical,
): void {
  if (assignments.length === 0) return;
  target.push(
    createFillCandidate(
      kind,
      group,
      sourceRevisionId,
      sampleRevisionId,
      sourceComponentIdsForAssignments(assignments, samples),
      assignments,
      null,
      hashCanonical,
    ),
  );
}

function createFillCandidate(
  kind: Exclude<RestorationCandidateKind, "outer_transparent">,
  group: RestorationTargetGroup,
  sourceRevisionId: string,
  sampleRevisionId: string | null,
  sourceComponentIds: readonly string[],
  inputAssignments: readonly Assignment[],
  manualRgba: Rgba | null,
  hashCanonical: RestorationHashCanonical,
): RestorationCandidate {
  const assignments = [...inputAssignments].sort(
    (left, right) => left.target.pixelId - right.target.pixelId,
  );
  const colorGroups = groupAssignmentsByColor(assignments);
  const coveredPixelIds = assignments.map((assignment) => assignment.target.pixelId);
  const covered = new Set(coveredPixelIds);
  const missingPixelIds = group.pixelIds.filter((pixelId) => !covered.has(pixelId));
  const evidence: RestorationCandidateEvidence = {
    schemaVersion: "1.0",
    kind,
    sourceRevisionId,
    sourceComponentIds,
    targetGroupId: group.targetGroupId,
    targetGroupIds: [group.targetGroupId],
    sampleRevisionId,
    manualRgba: manualRgba ? cloneRgba(manualRgba) : null,
    targetPixelIds: group.pixelIds,
    samplePixelIds: sortedNumbers(
      assignments.flatMap((assignment) =>
        assignment.sample ? [assignment.sample.pixelId] : [],
      ),
    ),
    assignments: assignments.map((assignment) => ({
      targetPixelId: assignment.target.pixelId,
      samplePixelId: assignment.sample?.pixelId ?? null,
      rgba: cloneRgba(assignment.rgba),
    })),
    colorGroups,
  };
  const evidenceHash = runHash(hashCanonical, evidence);
  const operationDescriptors: RestorationOperationDescriptor[] = colorGroups.map(
    (colorGroup, index) => ({
      operationId: operationId(evidenceHash, index),
      mode: "fill_base",
      pixelIds: colorGroup.targetPixelIds,
      rgba: cloneRgba(colorGroup.rgba),
    }),
  );
  return {
    candidateId: candidateId(evidenceHash),
    kind,
    targetGroupId: group.targetGroupId,
    targetGroupIds: [group.targetGroupId],
    sourceComponentIds,
    sampleRevisionId,
    manualRgba: manualRgba ? cloneRgba(manualRgba) : null,
    operationDescriptors,
    operations: materializeOperations(operationDescriptors),
    requestedPixelIds: group.pixelIds,
    requestedPixelCount: group.pixelCount,
    coveredPixelIds,
    coveredPixelCount: coveredPixelIds.length,
    missingPixelIds,
    missingPixelCount: missingPixelIds.length,
    complete: missingPixelIds.length === 0,
    evidence,
    evidenceHash,
  };
}

function sourceComponentIdsForAssignments(
  assignments: readonly Assignment[],
  samples: SampleCatalog,
): string[] {
  return sortedUniqueStrings(
    [...new Set(assignments.map((assignment) => {
      const samplePixelId = assignment.sample?.pixelId;
      const componentId =
        samplePixelId === undefined
          ? undefined
          : samples.componentIdByPixel.get(samplePixelId);
      if (!componentId) {
        throw new RangeError(
          `Sample pixel ${String(samplePixelId)} has no semantic skin owner`,
        );
      }
      return componentId;
    }))],
    "sourceComponentIds",
  );
}

function mapNearestBySurface(
  targets: readonly SurfaceTexel[],
  samples: SampleCatalog,
): Assignment[] {
  return mapSamples(targets, (target) =>
    nearestTexel(target, samples.bySurface.get(target.surface) ?? [], null),
  );
}

function mapNearestByBodyPart(
  targets: readonly SurfaceTexel[],
  samples: SampleCatalog,
  layout: SkinLayout,
): Assignment[] {
  return mapSamples(targets, (target) =>
    nearestTexel(target, samples.byBodyPart.get(target.bodyPart) ?? [], layout),
  );
}

function mapDonor(
  targets: readonly SurfaceTexel[],
  samples: SampleCatalog,
  layout: SkinLayout,
): Assignment[] {
  return mapSamples(targets, (target) => {
    const sameSurface = samples.bySurface.get(target.surface) ?? [];
    return nearestTexel(
      target,
      sameSurface.length > 0
        ? sameSurface
        : (samples.byBodyPart.get(target.bodyPart) ?? []),
      sameSurface.length > 0 ? null : layout,
    );
  });
}

function mapMirrored(
  targets: readonly SurfaceTexel[],
  samples: SampleCatalog,
  layout: SkinLayout,
): Assignment[] {
  return mapSamples(targets, (target) => {
    const sourceBodyPart = mirroredBodyPart(target.bodyPart);
    const sourceFace = mirroredFace(target.face);
    const sourceSurface = `${sourceBodyPart}.base.${sourceFace}` as SurfaceKey;
    const sampleSurface = layout.surfaces[sourceSurface];
    if (!sampleSurface) return null;
    const width = texelSurfaceDimensions(
      { ...target, surface: sourceSurface },
      layout,
    ).width;
    return samples.exact.get(
      exactTexelKey(sourceSurface, width - 1 - target.localU, target.localV),
    ) ?? null;
  });
}

function mapSamples(
  targets: readonly SurfaceTexel[],
  choose: (target: SurfaceTexel) => SurfaceTexel | null,
): Assignment[] {
  const assignments: Assignment[] = [];
  for (const target of targets) {
    const sample = choose(target);
    if (!sample) continue;
    assignments.push({ target, sample, rgba: cloneRgba(sample.rgba) });
  }
  return assignments;
}

function nearestTexel(
  target: SurfaceTexel,
  samples: readonly SurfaceTexel[],
  layout: SkinLayout | null,
): SurfaceTexel | null {
  let winner: SurfaceTexel | null = null;
  let winnerScore: readonly number[] | null = null;
  const targetDimensions = layout
    ? texelSurfaceDimensions(target, layout)
    : null;
  for (const sample of samples) {
    const sampleDimensions = layout
      ? texelSurfaceDimensions(sample, layout)
      : null;
    const distance =
      targetDimensions && sampleDimensions
        ? Math.abs(
            (sample.localU + 0.5) / sampleDimensions.width -
              (target.localU + 0.5) / targetDimensions.width,
          ) +
          Math.abs(
            (sample.localV + 0.5) / sampleDimensions.height -
              (target.localV + 0.5) / targetDimensions.height,
          )
        : Math.abs(sample.localU - target.localU) +
          Math.abs(sample.localV - target.localV);
    const score = [
      sample.surface === target.surface ? 0 : 1,
      sample.face === target.face ? 0 : 1,
      distance,
      sample.pixelId,
    ] as const;
    if (!winnerScore || compareScore(score, winnerScore) < 0) {
      winner = sample;
      winnerScore = score;
    }
  }
  return winner;
}

function groupAssignmentsByColor(
  assignments: readonly Assignment[],
): RestorationColorGroupEvidence[] {
  const groups = new Map<
    string,
    { rgba: Rgba; targets: number[]; samples: number[] }
  >();
  for (const assignment of assignments) {
    const key = rgbaKey(assignment.rgba);
    const group = groups.get(key) ?? {
      rgba: cloneRgba(assignment.rgba),
      targets: [],
      samples: [],
    };
    group.targets.push(assignment.target.pixelId);
    if (assignment.sample) group.samples.push(assignment.sample.pixelId);
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort((left, right) => compareRgba(left.rgba, right.rgba))
    .map((group) => ({
      rgba: group.rgba,
      targetPixelIds: sortedNumbers(group.targets),
      samplePixelIds: sortedNumbers(group.samples),
    }));
}

function materializeOperations(
  descriptors: readonly RestorationOperationDescriptor[],
): RestorationPlanOperation[] {
  return descriptors.map((descriptor) =>
    descriptor.mode === "clear_outer"
      ? {
          operationId: descriptor.operationId,
          mode: descriptor.mode,
          mask: pixelIdsToMask(descriptor.pixelIds),
        }
      : {
          operationId: descriptor.operationId,
          mode: descriptor.mode,
          mask: pixelIdsToMask(descriptor.pixelIds),
          rgba: cloneRgba(descriptor.rgba),
        },
  );
}

function assertRevision(
  revision: RestorationSemanticRevision,
  label: string,
): void {
  if (!revision.revisionId || revision.revisionId !== revision.semanticState.document.revisionId) {
    throw new RangeError(`${label} revision id does not match its semantic document`);
  }
}

function assertDonors(
  donors: readonly RestorationSemanticRevision[],
  source: RestorationSemanticRevision,
  armType: ArmType,
): void {
  const ids = new Set<string>();
  for (const donor of donors) {
    assertRevision(donor, "donor");
    if (donor.revisionId === source.revisionId || ids.has(donor.revisionId)) {
      throw new RangeError(`Duplicate donor revision: ${donor.revisionId}`);
    }
    ids.add(donor.revisionId);
    if (donor.semanticState.document.source.armType !== armType) {
      throw new RangeError(
        `Donor ${donor.revisionId} uses a different arm model`,
      );
    }
    validateSemanticState(donor.semanticState, donor.image, getSkinLayout(armType));
  }
}

function sortedUniqueColors(colors: readonly Rgba[]): Rgba[] {
  const unique = new Map<string, Rgba>();
  for (const color of colors) {
    assertOpaqueRgba(color);
    unique.set(rgbaKey(color), cloneRgba(color));
  }
  return [...unique.values()].sort(compareRgba);
}

function sortedUniqueStrings(values: readonly string[], label: string): string[] {
  const result = [...values].sort(compareString);
  for (let index = 0; index < result.length; index += 1) {
    const value = result[index]!;
    if (!value.trim()) throw new RangeError(`${label} contains an empty id`);
    if (index > 0 && value === result[index - 1]) {
      throw new RangeError(`${label} contains duplicate id: ${value}`);
    }
  }
  return result;
}

function assertOpaqueRgba(rgba: Rgba): void {
  if (
    !Array.isArray(rgba) ||
    rgba.length !== 4 ||
    rgba.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
  ) {
    throw new RangeError("Manual RGBA must contain four byte values");
  }
  if (rgba[3] !== 255) throw new RangeError("Manual RGBA must be opaque");
}

function runHash(hashCanonical: RestorationHashCanonical, value: unknown): string {
  const hash = hashCanonical(canonicalRestorationJson(value));
  if (!HASH_PATTERN.test(hash)) {
    throw new TypeError("hashCanonical must return sha256:<64 lowercase hex>");
  }
  return hash;
}

function candidateId(hash: string): string {
  return `restore_${hashToken(hash)}`;
}

function operationId(hash: string, index: number): string {
  return `rest_${hashToken(hash)}_${index.toString().padStart(3, "0")}`;
}

function hashToken(hash: string): string {
  const match = HASH_PATTERN.exec(hash);
  if (!match) throw new TypeError("Invalid restoration hash");
  return match[1]!;
}

function groupFingerprint(group: RestorationTargetGroup): unknown {
  return {
    targetGroupId: group.targetGroupId,
    bodyPart: group.bodyPart,
    layer: group.layer,
    componentIds: group.componentIds,
    surfaceKeys: group.surfaceKeys,
    pixelIds: group.pixelIds,
  };
}

function candidateFingerprint(candidate: RestorationCandidate): unknown {
  return {
    candidateId: candidate.candidateId,
    kind: candidate.kind,
    targetGroupId: candidate.targetGroupId,
    targetGroupIds: candidate.targetGroupIds,
    sourceComponentIds: candidate.sourceComponentIds,
    sampleRevisionId: candidate.sampleRevisionId,
    manualRgba: candidate.manualRgba,
    operationDescriptors: candidate.operationDescriptors,
    requestedPixelIds: candidate.requestedPixelIds,
    coveredPixelIds: candidate.coveredPixelIds,
    missingPixelIds: candidate.missingPixelIds,
    evidenceHash: candidate.evidenceHash,
  };
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
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON rejects non-finite numbers");
    return value;
  }
  if (value instanceof Uint8Array) {
    throw new TypeError("Canonical restoration JSON excludes Uint8Array masks");
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object") {
    const object = value as Readonly<Record<string, unknown>>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(object).sort(compareString)) {
      const item = object[key];
      if (item === undefined) {
        throw new TypeError(`Canonical JSON rejects undefined property: ${key}`);
      }
      result[key] = canonicalValue(item);
    }
    return result;
  }
  throw new TypeError(`Canonical JSON rejects ${typeof value}`);
}

function targetGroupId(bodyPart: BodyPart, layer: Layer): string {
  return `${bodyPart}_${layer}`;
}

function exactTexelKey(surface: SurfaceKey, u: number, v: number): string {
  return `${surface}:${u}:${v}`;
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

function texelSurfaceDimensions(
  texel: SurfaceTexel,
  layout: SkinLayout,
): { readonly width: number; readonly height: number } {
  const definition = layout.surfaces[texel.surface];
  const rotate = definition.orientation.rotate;
  return rotate === 90 || rotate === 270
    ? { width: definition.atlasRect.height, height: definition.atlasRect.width }
    : { width: definition.atlasRect.width, height: definition.atlasRect.height };
}

function compareTexel(left: SurfaceTexel, right: SurfaceTexel): number {
  return left.pixelId - right.pixelId;
}

function compareScore(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

function compareRgba(left: Rgba, right: Rgba): number {
  return compareScore(left, right);
}

function compareString(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedNumbers(values: Iterable<number>): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function sortedUnique<T>(
  values: readonly T[],
  compare: (left: T, right: T) => number,
): T[] {
  const result: T[] = [];
  for (const value of [...values].sort(compare)) {
    if (result.length === 0 || compare(result[result.length - 1]!, value) !== 0) {
      result.push(value);
    }
  }
  return result;
}

function rgbaKey(rgba: Rgba): string {
  return rgba.join(",");
}

function cloneRgba(rgba: Rgba): Rgba {
  return [rgba[0], rgba[1], rgba[2], rgba[3]];
}
