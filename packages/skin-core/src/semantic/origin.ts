import { createUsedUvMask, getSkinLayout } from "../layouts/layout";
import {
  SKIN_HEIGHT,
  SKIN_WIDTH,
  type ArmType,
  type RgbaImage,
} from "../types";
import { assertSkinImage } from "../uv/surface-model";
import {
  assertMask,
  maskToPixelIds,
  pixelIdsToMask,
  pixelIdsToSpans,
  spansToPixelIds,
} from "./mask";
import type {
  GeneratedCompletionPixelOriginEvidence,
  LegacyMixedPixelOriginEvidence,
  ManualAuthoredPixelOriginEvidence,
  PixelCopyLineageEntry,
  PixelCopySource,
  PixelIntrinsicOrigin,
  PixelOriginActor,
  PixelOriginAssignment,
  PixelOriginDocument,
  PixelOriginEntry,
  PixelOriginEvidence,
  PixelOriginRecord,
  PixelOriginSubject,
  PixelOriginSummary,
  SemanticPixelSpan,
  SourceVisiblePixelOriginEvidence,
} from "./types";

export const PIXEL_ORIGIN_SCHEMA_VERSION = "1.0" as const;
export const MAX_PIXEL_ORIGIN_ENTRIES = SKIN_WIDTH * SKIN_HEIGHT;
export const MAX_PIXEL_ORIGIN_SPANS = SKIN_WIDTH * SKIN_HEIGHT;
export const MAX_PIXEL_COPY_LINEAGE_ENTRIES = SKIN_WIDTH * SKIN_HEIGHT;

const SAFE_REFERENCE_ID = /^[a-z][a-z0-9_-]{2,100}$/u;
const COMPONENT_INSTANCE_ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const ORIGIN_ORDER: readonly PixelIntrinsicOrigin[] = [
  "source_visible",
  "manual_authored",
  "generated_completion",
  "legacy_mixed",
];

export type PixelOriginSeed =
  | {
      readonly intrinsicOrigin: "source_visible";
      readonly evidence: SourceVisiblePixelOriginEvidence;
    }
  | {
      readonly intrinsicOrigin: "manual_authored";
      readonly evidence: ManualAuthoredPixelOriginEvidence;
    }
  | {
      readonly intrinsicOrigin: "generated_completion";
      readonly evidence: GeneratedCompletionPixelOriginEvidence;
    }
  | {
      readonly intrinsicOrigin: "legacy_mixed";
      readonly evidence: LegacyMixedPixelOriginEvidence;
    };

export interface PropagatePixelOriginDocumentInput {
  readonly sourceDocument: PixelOriginDocument;
  readonly sourceImage: RgbaImage;
  readonly resultImage: RgbaImage;
  readonly resultSubject: PixelOriginSubject;
  readonly assignments?: readonly PixelOriginAssignment[];
}

export function createPixelOriginDocument(input: {
  readonly subject: PixelOriginSubject;
  readonly armType: ArmType;
  readonly image: RgbaImage;
  readonly intrinsicOrigin: PixelOriginSeed["intrinsicOrigin"];
  readonly evidence: PixelOriginSeed["evidence"];
}): PixelOriginDocument {
  assertSkinImage(input.image);
  const seed = normalizeOriginRecord({
    intrinsicOrigin: input.intrinsicOrigin,
    evidence: input.evidence,
    copyLineage: null,
  });
  const records = new Map<number, PixelOriginRecord>();
  for (const pixelId of visibleUsedPixelIds(input.image, input.armType)) {
    records.set(pixelId, seed);
  }
  const document = recordsToDocument(input.subject, input.armType, records);
  validatePixelOriginDocument(document, input.image);
  return document;
}

export function createSourceVisiblePixelOriginDocument(input: {
  readonly subject: Extract<PixelOriginSubject, { readonly kind: "revision" }>;
  readonly armType: ArmType;
  readonly image: RgbaImage;
}): PixelOriginDocument {
  return createPixelOriginDocument({
    ...input,
    intrinsicOrigin: "source_visible",
    evidence: { sourceRevisionId: input.subject.id },
  });
}

export function createLegacyMixedPixelOriginDocument(input: {
  readonly subject: PixelOriginSubject;
  readonly sourceRevisionId: string;
  readonly armType: ArmType;
  readonly image: RgbaImage;
}): PixelOriginDocument {
  return createPixelOriginDocument({
    subject: input.subject,
    armType: input.armType,
    image: input.image,
    intrinsicOrigin: "legacy_mixed",
    evidence: { sourceRevisionId: input.sourceRevisionId },
  });
}

/**
 * Returns the unique serialized form for a structurally valid origin document.
 * Overlap is rejected rather than resolved, and equivalent entries are merged.
 */
export function canonicalizePixelOriginDocument(
  document: PixelOriginDocument,
): PixelOriginDocument {
  assertExactKeys(
    document,
    ["copyLineage", "entries", "schemaVersion", "source", "subject"],
    "Pixel origin document",
  );
  if (document.schemaVersion !== PIXEL_ORIGIN_SCHEMA_VERSION) {
    throw new TypeError(`Unsupported pixel origin schema: ${String(document.schemaVersion)}`);
  }
  const subject = normalizeSubject(document.subject, "Pixel origin subject");
  assertExactKeys(
    document.source,
    ["armType", "coordinateOrigin", "height", "width"],
    "Pixel origin source",
  );
  if (
    document.source.width !== SKIN_WIDTH ||
    document.source.height !== SKIN_HEIGHT ||
    document.source.coordinateOrigin !== "top-left" ||
    (document.source.armType !== "wide" && document.source.armType !== "slim")
  ) {
    throw new TypeError("Pixel origin source must describe a 64x64 top-left skin");
  }
  if (
    !Array.isArray(document.entries) ||
    document.entries.length > MAX_PIXEL_ORIGIN_ENTRIES
  ) {
    throw new RangeError(
      `Pixel origin entries must not exceed ${MAX_PIXEL_ORIGIN_ENTRIES}`,
    );
  }
  if (
    !Array.isArray(document.copyLineage) ||
    document.copyLineage.length > MAX_PIXEL_COPY_LINEAGE_ENTRIES
  ) {
    throw new RangeError(
      `Pixel copy lineage entries must not exceed ${MAX_PIXEL_COPY_LINEAGE_ENTRIES}`,
    );
  }

  const layout = getSkinLayout(document.source.armType);
  const occupied = new Set<number>();
  let spanCount = 0;
  const groups = new Map<
    string,
    {
      readonly intrinsicOrigin: PixelIntrinsicOrigin;
      readonly evidence: PixelOriginEvidence;
      readonly pixelIds: number[];
    }
  >();
  for (const entry of document.entries) {
    assertExactKeys(
      entry,
      ["evidence", "intrinsicOrigin", "spans"],
      "Pixel origin entry",
    );
    if (!Array.isArray(entry.spans) || entry.spans.length === 0) {
      throw new RangeError("Pixel origin entries must contain at least one span");
    }
    spanCount += entry.spans.length;
    if (spanCount > MAX_PIXEL_ORIGIN_SPANS) {
      throw new RangeError(
        `Pixel origin spans must not exceed ${MAX_PIXEL_ORIGIN_SPANS}`,
      );
    }
    for (const span of entry.spans) {
      assertExactKeys(span, ["surface", "x0", "x1", "y"], "Pixel origin span");
    }
    const normalized = normalizeOriginRecord({
      intrinsicOrigin: entry.intrinsicOrigin,
      evidence: entry.evidence,
      copyLineage: null,
    });
    const pixelIds = spansToPixelIds(entry.spans, layout);
    for (const pixelId of pixelIds) {
      if (occupied.has(pixelId)) {
        throw new RangeError(`Pixel origin entries overlap at pixel ${pixelId}`);
      }
      occupied.add(pixelId);
    }
    const key = originRecordKey(normalized);
    const group = groups.get(key);
    if (group) {
      group.pixelIds.push(...pixelIds);
    } else {
      groups.set(key, {
        intrinsicOrigin: normalized.intrinsicOrigin,
        evidence: normalized.evidence,
        pixelIds: [...pixelIds],
      });
    }
  }

  const entries = [...groups.entries()]
    .map(([key, group]) => ({
      key,
      firstPixelId: Math.min(...group.pixelIds),
      entry: originEntry(
        group.intrinsicOrigin,
        group.evidence,
        pixelIdsToSpans(group.pixelIds, layout),
      ),
    }))
    .sort(
      (left, right) =>
        left.firstPixelId - right.firstPixelId || left.key.localeCompare(right.key),
    )
    .map(({ entry }) => entry);

  const copyTargets = new Set<number>();
  const copyLineage = document.copyLineage
    .map((entry): PixelCopyLineageEntry => {
      assertExactKeys(
        entry,
        ["copiedFrom", "derivation", "pixelId"],
        "Pixel copy lineage entry",
      );
      assertPixelId(entry.pixelId, "Copy target pixel");
      if (entry.derivation !== "copied") {
        throw new TypeError("Pixel copy derivation must be copied");
      }
      if (!occupied.has(entry.pixelId)) {
        throw new RangeError(
          `Pixel copy lineage target ${entry.pixelId} has no intrinsic origin`,
        );
      }
      if (copyTargets.has(entry.pixelId)) {
        throw new RangeError(`Duplicate pixel copy lineage target ${entry.pixelId}`);
      }
      copyTargets.add(entry.pixelId);
      const copiedFrom = normalizeCopySource(entry.copiedFrom);
      if (subjectsEqual(copiedFrom.sourceSubject, subject)) {
        throw new RangeError("Pixel copy lineage cannot reference its own subject");
      }
      return {
        pixelId: entry.pixelId,
        derivation: "copied",
        copiedFrom,
      };
    })
    .sort((left, right) => left.pixelId - right.pixelId);

  return {
    schemaVersion: PIXEL_ORIGIN_SCHEMA_VERSION,
    subject,
    source: {
      width: SKIN_WIDTH,
      height: SKIN_HEIGHT,
      armType: document.source.armType,
      coordinateOrigin: "top-left",
    },
    entries,
    copyLineage,
  };
}

/** Validates canonical form and, when supplied, exact visible used-UV coverage. */
export function validatePixelOriginDocument(
  document: PixelOriginDocument,
  image?: RgbaImage,
): void {
  const canonical = canonicalizePixelOriginDocument(document);
  if (!originDocumentsEqual(document, canonical)) {
    throw new RangeError("Pixel origin document is not canonical");
  }
  if (!image) return;
  assertSkinImage(image);
  const expected = visibleUsedPixelIds(image, document.source.armType);
  const actual = originDocumentPixelIds(canonical);
  if (!numberArraysEqual(actual, expected)) {
    throw new RangeError(
      "Pixel origin entries must cover every non-transparent used UV pixel exactly",
    );
  }
}

export function summarizePixelOrigins(
  document: PixelOriginDocument,
): PixelOriginSummary {
  validatePixelOriginDocument(document);
  const layout = getSkinLayout(document.source.armType);
  const counts: Record<PixelIntrinsicOrigin, number> = {
    source_visible: 0,
    manual_authored: 0,
    generated_completion: 0,
    legacy_mixed: 0,
  };
  for (const entry of document.entries) {
    counts[entry.intrinsicOrigin] += spansToPixelIds(entry.spans, layout).length;
  }
  return {
    counts,
    containsGeneratedPixels: counts.generated_completion > 0,
  };
}

export function summarizePixelOriginsForMask(
  document: PixelOriginDocument,
  mask: Uint8Array,
): PixelOriginSummary {
  validatePixelOriginDocument(document);
  assertMask(mask);
  const records = originRecordMap(document);
  const counts: Record<PixelIntrinsicOrigin, number> = {
    source_visible: 0,
    manual_authored: 0,
    generated_completion: 0,
    legacy_mixed: 0,
  };
  for (const pixelId of maskToPixelIds(mask)) {
    const record = records.get(pixelId);
    if (!record) {
      throw new RangeError(`Origin summary mask has no origin at pixel ${pixelId}`);
    }
    counts[record.intrinsicOrigin] += 1;
  }
  return {
    counts,
    containsGeneratedPixels: counts.generated_completion > 0,
  };
}

export function deriveGeneratedPixelMask(
  document: PixelOriginDocument,
): Uint8Array {
  validatePixelOriginDocument(document);
  const layout = getSkinLayout(document.source.armType);
  return pixelIdsToMask(
    document.entries.flatMap((entry) =>
      entry.intrinsicOrigin === "generated_completion"
        ? spansToPixelIds(entry.spans, layout)
        : [],
    ),
  );
}

export function getPixelOrigin(
  document: PixelOriginDocument,
  pixelId: number,
): PixelOriginRecord | undefined {
  assertPixelId(pixelId, "Pixel origin lookup");
  validatePixelOriginDocument(document);
  return cloneRecord(originRecordMap(document).get(pixelId));
}

/** Selects exact origins without inventing a new copy event and rebinds ownership. */
export function selectPixelOriginDocument(input: {
  readonly document: PixelOriginDocument;
  readonly pixelIds: Iterable<number>;
  readonly subject: PixelOriginSubject;
}): PixelOriginDocument {
  validatePixelOriginDocument(input.document);
  const source = originRecordMap(input.document);
  const selected = new Map<number, PixelOriginRecord>();
  for (const pixelId of input.pixelIds) {
    assertPixelId(pixelId, "Selected origin pixel");
    if (selected.has(pixelId)) {
      throw new RangeError(`Pixel origin selection contains duplicate pixel ${pixelId}`);
    }
    const record = source.get(pixelId);
    if (!record) {
      throw new RangeError(`Pixel origin selection has no source at pixel ${pixelId}`);
    }
    selected.set(pixelId, record);
  }
  return recordsToDocument(
    input.subject,
    input.document.source.armType,
    selected,
  );
}

/**
 * Carries unchanged pixels and requires an explicit assignment for every new or
 * RGBA-modified visible pixel. Removed pixels are omitted. No default origin is inferred.
 */
export function propagatePixelOriginDocument(
  input: PropagatePixelOriginDocumentInput,
): PixelOriginDocument {
  validatePixelOriginDocument(input.sourceDocument, input.sourceImage);
  assertSkinImage(input.resultImage);
  const armType = input.sourceDocument.source.armType;
  const sourceRecords = originRecordMap(input.sourceDocument);
  const assignments = new Map<number, PixelOriginRecord>();
  if ((input.assignments?.length ?? 0) > MAX_PIXEL_ORIGIN_ENTRIES) {
    throw new RangeError(`Pixel origin assignments must not exceed ${MAX_PIXEL_ORIGIN_ENTRIES}`);
  }
  for (const assignment of input.assignments ?? []) {
    assertPixelId(assignment.pixelId, "Assigned origin pixel");
    if (assignments.has(assignment.pixelId)) {
      throw new RangeError(`Duplicate pixel origin assignment ${assignment.pixelId}`);
    }
    assignments.set(assignment.pixelId, normalizeOriginRecord(assignment));
  }

  const resultRecords = new Map<number, PixelOriginRecord>();
  const visibleResultIds = visibleUsedPixelIds(input.resultImage, armType);
  const visibleResultSet = new Set(visibleResultIds);
  for (const pixelId of assignments.keys()) {
    if (!visibleResultSet.has(pixelId)) {
      throw new RangeError(
        `Pixel origin assignment ${pixelId} does not target a visible used UV pixel`,
      );
    }
  }
  for (const pixelId of visibleResultIds) {
    const assigned = assignments.get(pixelId);
    if (assigned) {
      resultRecords.set(pixelId, assigned);
      continue;
    }
    const source = sourceRecords.get(pixelId);
    if (!source || !pixelRgbaEqual(input.sourceImage, input.resultImage, pixelId)) {
      throw new RangeError(
        `Changed or newly visible pixel ${pixelId} requires an explicit origin assignment`,
      );
    }
    resultRecords.set(pixelId, source);
  }
  const result = recordsToDocument(input.resultSubject, armType, resultRecords);
  validatePixelOriginDocument(result, input.resultImage);
  return result;
}

/** Creates one exact copy assignment while preserving the source intrinsic origin. */
export function createCopiedPixelOriginAssignment(input: {
  readonly sourceDocument: PixelOriginDocument;
  readonly sourcePixelId: number;
  readonly targetPixelId: number;
  readonly sourceComponentInstanceId: string | null;
}): PixelOriginAssignment {
  return createCopiedPixelOriginAssignments({
    sourceDocument: input.sourceDocument,
    mappings: [
      {
        sourcePixelId: input.sourcePixelId,
        targetPixelId: input.targetPixelId,
      },
    ],
    sourceComponentInstanceId: input.sourceComponentInstanceId,
  })[0]!;
}

/** Batch copy assignment builder; validates and expands the source document once. */
export function createCopiedPixelOriginAssignments(input: {
  readonly sourceDocument: PixelOriginDocument;
  readonly mappings: readonly {
    readonly sourcePixelId: number;
    readonly targetPixelId: number;
  }[];
  readonly sourceComponentInstanceId: string | null;
}): PixelOriginAssignment[] {
  validatePixelOriginDocument(input.sourceDocument);
  if (input.mappings.length > MAX_PIXEL_ORIGIN_ENTRIES) {
    throw new RangeError(`Pixel copy mappings must not exceed ${MAX_PIXEL_ORIGIN_ENTRIES}`);
  }
  const records = originRecordMap(input.sourceDocument);
  const componentInstanceId = normalizeComponentInstanceId(
    input.sourceComponentInstanceId,
  );
  const targetPixelIds = new Set<number>();
  return input.mappings.map((mapping) => {
    const sourcePixelId = checkedPixelId(mapping.sourcePixelId, "Copied source pixel");
    const targetPixelId = checkedPixelId(mapping.targetPixelId, "Copied target pixel");
    if (targetPixelIds.has(targetPixelId)) {
      throw new RangeError(`Duplicate copied target pixel ${targetPixelId}`);
    }
    targetPixelIds.add(targetPixelId);
    const source = records.get(sourcePixelId);
    if (!source) {
      throw new RangeError(`Copied source pixel ${sourcePixelId} has no origin`);
    }
    return {
      pixelId: targetPixelId,
      intrinsicOrigin: source.intrinsicOrigin,
      evidence: cloneEvidence(source.intrinsicOrigin, source.evidence),
      copyLineage: {
        sourceSubject: cloneSubject(input.sourceDocument.subject),
        sourceComponentInstanceId: componentInstanceId,
        sourcePixelId,
      },
    };
  });
}

export function createManualPixelOriginAssignment(input: {
  readonly pixelId: number;
  readonly actor: PixelOriginActor;
  readonly operationId: string;
}): PixelOriginAssignment {
  return {
    pixelId: checkedPixelId(input.pixelId, "Manual origin pixel"),
    intrinsicOrigin: "manual_authored",
    evidence: normalizeManualEvidence({
      actor: input.actor,
      operationId: input.operationId,
    }),
    copyLineage: null,
  };
}

export function createGeneratedPixelOriginAssignment(input: {
  readonly pixelId: number;
  readonly evidence: GeneratedCompletionPixelOriginEvidence;
}): PixelOriginAssignment {
  return {
    pixelId: checkedPixelId(input.pixelId, "Generated origin pixel"),
    intrinsicOrigin: "generated_completion",
    evidence: normalizeGeneratedEvidence(input.evidence),
    copyLineage: null,
  };
}

function recordsToDocument(
  subjectInput: PixelOriginSubject,
  armType: ArmType,
  records: ReadonlyMap<number, PixelOriginRecord>,
): PixelOriginDocument {
  const subject = normalizeSubject(subjectInput, "Pixel origin subject");
  const layout = getSkinLayout(armType);
  const groups = new Map<
    string,
    {
      readonly intrinsicOrigin: PixelIntrinsicOrigin;
      readonly evidence: PixelOriginEvidence;
      readonly pixelIds: number[];
    }
  >();
  const copyLineage: PixelCopyLineageEntry[] = [];
  for (const [pixelId, rawRecord] of [...records].sort(([left], [right]) => left - right)) {
    assertPixelId(pixelId, "Pixel origin record");
    const record = normalizeOriginRecord(rawRecord);
    const key = originRecordKey(record);
    const group = groups.get(key);
    if (group) {
      group.pixelIds.push(pixelId);
    } else {
      groups.set(key, {
        intrinsicOrigin: record.intrinsicOrigin,
        evidence: record.evidence,
        pixelIds: [pixelId],
      });
    }
    if (record.copyLineage) {
      if (subjectsEqual(record.copyLineage.sourceSubject, subject)) {
        throw new RangeError("Pixel copy lineage cannot reference its own subject");
      }
      copyLineage.push({
        pixelId,
        derivation: "copied",
        copiedFrom: record.copyLineage,
      });
    }
  }
  const entries = [...groups.entries()]
    .map(([key, group]) => ({
      key,
      firstPixelId: Math.min(...group.pixelIds),
      entry: originEntry(
        group.intrinsicOrigin,
        group.evidence,
        pixelIdsToSpans(group.pixelIds, layout),
      ),
    }))
    .sort(
      (left, right) =>
        left.firstPixelId - right.firstPixelId || left.key.localeCompare(right.key),
    )
    .map(({ entry }) => entry);
  return {
    schemaVersion: PIXEL_ORIGIN_SCHEMA_VERSION,
    subject,
    source: {
      width: SKIN_WIDTH,
      height: SKIN_HEIGHT,
      armType,
      coordinateOrigin: "top-left",
    },
    entries,
    copyLineage,
  };
}

function originRecordMap(
  document: PixelOriginDocument,
): ReadonlyMap<number, PixelOriginRecord> {
  const layout = getSkinLayout(document.source.armType);
  const lineage = new Map(
    document.copyLineage.map((entry) => [entry.pixelId, entry.copiedFrom]),
  );
  const records = new Map<number, PixelOriginRecord>();
  for (const entry of document.entries) {
    for (const pixelId of spansToPixelIds(entry.spans, layout)) {
      records.set(pixelId, {
        intrinsicOrigin: entry.intrinsicOrigin,
        evidence: cloneEvidence(entry.intrinsicOrigin, entry.evidence),
        copyLineage: cloneCopySource(lineage.get(pixelId) ?? null),
      });
    }
  }
  return records;
}

function originDocumentPixelIds(document: PixelOriginDocument): number[] {
  const layout = getSkinLayout(document.source.armType);
  return document.entries
    .flatMap((entry) => spansToPixelIds(entry.spans, layout))
    .sort((left, right) => left - right);
}

function visibleUsedPixelIds(image: RgbaImage, armType: ArmType): number[] {
  assertSkinImage(image);
  const usedUv = createUsedUvMask(getSkinLayout(armType));
  const pixelIds: number[] = [];
  for (let pixelId = 0; pixelId < usedUv.length; pixelId += 1) {
    if (usedUv[pixelId] !== 0 && image.data[pixelId * 4 + 3] !== 0) {
      pixelIds.push(pixelId);
    }
  }
  return pixelIds;
}

function normalizeOriginRecord(
  record: Pick<
    PixelOriginRecord,
    "intrinsicOrigin" | "evidence" | "copyLineage"
  >,
): PixelOriginRecord {
  if (!ORIGIN_ORDER.includes(record.intrinsicOrigin)) {
    throw new TypeError(`Unknown intrinsic pixel origin: ${String(record.intrinsicOrigin)}`);
  }
  return {
    intrinsicOrigin: record.intrinsicOrigin,
    evidence: normalizeEvidence(record.intrinsicOrigin, record.evidence),
    copyLineage:
      record.copyLineage === null
        ? null
        : normalizeCopySource(record.copyLineage),
  };
}

function normalizeEvidence(
  origin: PixelIntrinsicOrigin,
  evidence: PixelOriginEvidence,
): PixelOriginEvidence {
  switch (origin) {
    case "source_visible":
      return normalizeSourceEvidence(evidence as SourceVisiblePixelOriginEvidence);
    case "manual_authored":
      return normalizeManualEvidence(evidence as ManualAuthoredPixelOriginEvidence);
    case "generated_completion":
      return normalizeGeneratedEvidence(
        evidence as GeneratedCompletionPixelOriginEvidence,
      );
    case "legacy_mixed":
      return normalizeLegacyEvidence(evidence as LegacyMixedPixelOriginEvidence);
  }
}

function normalizeSourceEvidence(
  evidence: SourceVisiblePixelOriginEvidence,
): SourceVisiblePixelOriginEvidence {
  assertExactKeys(evidence, ["sourceRevisionId"], "Source-visible origin evidence");
  return {
    sourceRevisionId: safeReferenceId(
      evidence.sourceRevisionId,
      "Source-visible revision id",
    ),
  };
}

function normalizeLegacyEvidence(
  evidence: LegacyMixedPixelOriginEvidence,
): LegacyMixedPixelOriginEvidence {
  assertExactKeys(evidence, ["sourceRevisionId"], "Legacy origin evidence");
  return {
    sourceRevisionId: safeReferenceId(evidence.sourceRevisionId, "Legacy revision id"),
  };
}

function normalizeManualEvidence(
  evidence: ManualAuthoredPixelOriginEvidence,
): ManualAuthoredPixelOriginEvidence {
  assertExactKeys(evidence, ["actor", "operationId"], "Manual origin evidence");
  return {
    actor: normalizeActor(evidence.actor),
    operationId: safeReferenceId(evidence.operationId, "Manual operation id"),
  };
}

function normalizeGeneratedEvidence(
  evidence: GeneratedCompletionPixelOriginEvidence,
): GeneratedCompletionPixelOriginEvidence {
  assertExactKeys(
    evidence,
    ["actor", "candidateId", "decisionId", "evidenceHash"],
    "Generated origin evidence",
  );
  if (!SHA256.test(evidence.evidenceHash)) {
    throw new TypeError("Generated origin evidence hash must be canonical SHA-256");
  }
  return {
    candidateId: safeReferenceId(evidence.candidateId, "Completion candidate id"),
    evidenceHash: evidence.evidenceHash,
    decisionId: safeReferenceId(evidence.decisionId, "Completion decision id"),
    actor: normalizeActor(evidence.actor),
  };
}

function normalizeActor(actor: PixelOriginActor): PixelOriginActor {
  assertExactOptionalKeys(actor, ["type"], ["id"], "Pixel origin actor");
  if (actor.type !== "user" && actor.type !== "ai" && actor.type !== "system") {
    throw new TypeError(`Unknown pixel origin actor: ${String(actor.type)}`);
  }
  return {
    type: actor.type,
    ...(actor.id === undefined
      ? {}
      : { id: actorId(actor.id) }),
  };
}

function normalizeSubject(subject: PixelOriginSubject, label: string): PixelOriginSubject {
  assertExactKeys(subject, ["id", "kind"], label);
  if (
    subject.kind !== "revision" &&
    subject.kind !== "part" &&
    subject.kind !== "part_edit_revision"
  ) {
    throw new TypeError(
      `${label} kind is invalid: ${String((subject as { readonly kind: unknown }).kind)}`,
    );
  }
  return { kind: subject.kind, id: safeReferenceId(subject.id, `${label} id`) };
}

function normalizeCopySource(source: PixelCopySource): PixelCopySource {
  assertExactKeys(
    source,
    ["sourceComponentInstanceId", "sourcePixelId", "sourceSubject"],
    "Copied-from source",
  );
  return {
    sourceSubject: normalizeSubject(source.sourceSubject, "Copied-from subject"),
    sourceComponentInstanceId: normalizeComponentInstanceId(
      source.sourceComponentInstanceId,
    ),
    sourcePixelId: checkedPixelId(source.sourcePixelId, "Copied-from pixel"),
  };
}

function normalizeComponentInstanceId(value: string | null): string | null {
  if (value === null) return null;
  if (
    value === "unknown" ||
    value.length > 100 ||
    !COMPONENT_INSTANCE_ID.test(value)
  ) {
    throw new TypeError(`Invalid copied-from component instance id: ${String(value)}`);
  }
  return value;
}

function originEntry(
  intrinsicOrigin: PixelIntrinsicOrigin,
  evidence: PixelOriginEvidence,
  spans: readonly SemanticPixelSpan[],
): PixelOriginEntry {
  switch (intrinsicOrigin) {
    case "source_visible":
      return {
        intrinsicOrigin,
        evidence: evidence as SourceVisiblePixelOriginEvidence,
        spans,
      };
    case "manual_authored":
      return {
        intrinsicOrigin,
        evidence: evidence as ManualAuthoredPixelOriginEvidence,
        spans,
      };
    case "generated_completion":
      return {
        intrinsicOrigin,
        evidence: evidence as GeneratedCompletionPixelOriginEvidence,
        spans,
      };
    case "legacy_mixed":
      return {
        intrinsicOrigin,
        evidence: evidence as LegacyMixedPixelOriginEvidence,
        spans,
      };
  }
}

function originRecordKey(record: PixelOriginRecord): string {
  return `${String(ORIGIN_ORDER.indexOf(record.intrinsicOrigin))}:${JSON.stringify(
    record.evidence,
  )}`;
}

function originDocumentsEqual(
  left: PixelOriginDocument,
  right: PixelOriginDocument,
): boolean {
  if (
    !subjectsEqual(left.subject, right.subject) ||
    left.source.width !== right.source.width ||
    left.source.height !== right.source.height ||
    left.source.armType !== right.source.armType ||
    left.source.coordinateOrigin !== right.source.coordinateOrigin ||
    left.entries.length !== right.entries.length ||
    left.copyLineage.length !== right.copyLineage.length
  ) {
    return false;
  }
  for (let index = 0; index < left.entries.length; index += 1) {
    const a = left.entries[index]!;
    const b = right.entries[index]!;
    if (
      a.intrinsicOrigin !== b.intrinsicOrigin ||
      JSON.stringify(normalizeEvidence(a.intrinsicOrigin, a.evidence)) !==
        JSON.stringify(normalizeEvidence(b.intrinsicOrigin, b.evidence)) ||
      !spansEqual(a.spans, b.spans)
    ) {
      return false;
    }
  }
  return left.copyLineage.every((entry, index) => {
    const other = right.copyLineage[index];
    return (
      other !== undefined &&
      entry.pixelId === other.pixelId &&
      entry.derivation === other.derivation &&
      copySourcesEqual(entry.copiedFrom, other.copiedFrom)
    );
  });
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

function subjectsEqual(left: PixelOriginSubject, right: PixelOriginSubject): boolean {
  return left.kind === right.kind && left.id === right.id;
}

function copySourcesEqual(left: PixelCopySource, right: PixelCopySource): boolean {
  return (
    subjectsEqual(left.sourceSubject, right.sourceSubject) &&
    left.sourceComponentInstanceId === right.sourceComponentInstanceId &&
    left.sourcePixelId === right.sourcePixelId
  );
}

function cloneRecord(record: PixelOriginRecord | undefined): PixelOriginRecord | undefined {
  if (!record) return undefined;
  return {
    intrinsicOrigin: record.intrinsicOrigin,
    evidence: cloneEvidence(record.intrinsicOrigin, record.evidence),
    copyLineage: cloneCopySource(record.copyLineage),
  };
}

function cloneEvidence(
  origin: PixelIntrinsicOrigin,
  evidence: PixelOriginEvidence,
): PixelOriginEvidence {
  return normalizeEvidence(origin, evidence);
}

function cloneCopySource(source: PixelCopySource | null): PixelCopySource | null {
  return source === null
    ? null
    : {
        sourceSubject: cloneSubject(source.sourceSubject),
        sourceComponentInstanceId: source.sourceComponentInstanceId,
        sourcePixelId: source.sourcePixelId,
      };
}

function cloneSubject(subject: PixelOriginSubject): PixelOriginSubject {
  return { kind: subject.kind, id: subject.id };
}

function pixelRgbaEqual(left: RgbaImage, right: RgbaImage, pixelId: number): boolean {
  const offset = pixelId * 4;
  return (
    left.data[offset] === right.data[offset] &&
    left.data[offset + 1] === right.data[offset + 1] &&
    left.data[offset + 2] === right.data[offset + 2] &&
    left.data[offset + 3] === right.data[offset + 3]
  );
}

function safeReferenceId(value: string, label: string): string {
  if (typeof value !== "string" || !SAFE_REFERENCE_ID.test(value)) {
    throw new TypeError(`${label} must be a path-safe reference id`);
  }
  return value;
}

function actorId(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 120 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError("Pixel origin actor id must be 1-120 visible characters");
  }
  return value;
}

function checkedPixelId(pixelId: number, label: string): number {
  assertPixelId(pixelId, label);
  return pixelId;
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

function assertExactKeys(
  value: unknown,
  keys: readonly string[],
  label: string,
): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} has unexpected or missing fields`);
  }
}

function assertExactOptionalKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const keys = Object.keys(value);
  if (
    required.some((key) => !keys.includes(key)) ||
    keys.some((key) => !required.includes(key) && !optional.includes(key))
  ) {
    throw new TypeError(`${label} has unexpected or missing fields`);
  }
}

function numberArraysEqual(left: readonly number[], right: readonly number[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
