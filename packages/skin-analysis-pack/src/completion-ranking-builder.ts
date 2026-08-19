import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import {
  assertRgbaImage,
  createRgbaImage,
  encodePngRgba,
  scaleNearest,
  validateCompletionProposalHashes,
  validateCompletionProposalSource,
  type CompletionCandidate,
  type CompletionHashCanonical,
  type RgbaImage,
} from "@mc-skin-split/skin-core";
import {
  COMPLETION_RANKING_PACK_SCHEMA_VERSION,
  COMPLETION_RANKING_PREVIEW_RENDERER_VERSION,
  COMPLETION_RANKING_PROMPT_VERSION,
  MAX_COMPLETION_RANKING_CANDIDATES,
  type BuildCompletionRankingPackInput,
  type CompletionRankingEvidenceDocument,
  type CompletionRankingImageAttachment,
  type CompletionRankingPack,
  type CompletionRankingPackManifest,
  type CompletionRankingPackPaths,
} from "./completion-ranking-types";

const PREVIEW_SCALE = 8;
const MAX_PREVIEW_PNG_BYTES = 2 * 1024 * 1024;
const JOB_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{2,119}$/u;
const CANDIDATE_ID_PATTERN = /^completioncandidate_[0-9a-f]{64}$/u;
const PATHS: CompletionRankingPackPaths = {
  evidence: "input/completion-ranking-evidence.json",
  manifest: "input/manifest.json",
  sourcePreview: "input/previews/000-source.png",
  outputSchema: "schema/completion-ranking.schema.json",
  proposal: "output/completion-ranking.json",
  validatorReport: "logs/validator-report.json",
  previousValidatorReport: "logs/previous-validator-report.json",
};
const hashCanonical: CompletionHashCanonical = (canonicalJson) =>
  sha256(utf8(canonicalJson));

export async function buildCompletionRankingPack(
  input: BuildCompletionRankingPackInput,
): Promise<CompletionRankingPack> {
  assertCompletionRankingPackInput(input);
  const root = resolve(input.workspaceDirectory);
  const candidateAttachments = input.completionProposal.candidates.map(
    (candidate, index): CompletionRankingImageAttachment => ({
      role: "candidate_preview",
      path: candidatePreviewPath(index, candidate.candidateId),
      candidateId: candidate.candidateId,
    }),
  );
  const imageAttachments: readonly CompletionRankingImageAttachment[] = [
    {
      role: "source_skin",
      path: PATHS.sourcePreview,
      candidateId: null,
    },
    ...candidateAttachments,
  ];
  const job = {
    schemaVersion: COMPLETION_RANKING_PACK_SCHEMA_VERSION,
    jobId: input.jobId,
    provider: input.provider,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    promptVersion: COMPLETION_RANKING_PROMPT_VERSION,
    previewRendererVersion: COMPLETION_RANKING_PREVIEW_RENDERER_VERSION,
    imageAttachments,
  } as const;
  const evidence: CompletionRankingEvidenceDocument = {
    schemaVersion: COMPLETION_RANKING_PACK_SCHEMA_VERSION,
    proposalId: input.completionProposal.proposalId,
    proposalHash: input.completionProposal.proposalHash,
    proposalEvidenceHash: input.completionProposal.evidenceHash,
    sourceRevisionId: input.completionProposal.sourceRevisionId,
    sourceResultHash: input.completionProposal.sourceResultHash,
    sourceSkinHash: input.completionProposal.sourceSkinHash,
    armType: input.completionProposal.armType,
    targetComponentId: input.completionProposal.targetComponentId,
    occludingComponentIds: [...input.completionProposal.occludingComponentIds],
    requestedRepresentation: input.completionProposal.requestedRepresentation,
    representation: input.completionProposal.representation,
    allowedGeneratedPixelCount:
      input.completionProposal.allowedGeneratedPixelCount,
    candidateCount: input.completionProposal.candidates.length,
    candidates: input.completionProposal.candidates.map((candidate, index) => ({
      candidateId: candidate.candidateId,
      candidateHash: candidate.candidateHash,
      evidenceHash: candidate.evidenceHash,
      strategy: candidate.strategy,
      complete: candidate.complete,
      confidence: candidate.confidence,
      confidenceScore: candidate.confidenceScore,
      pixelCount: candidate.pixelCount,
      missingPixelCount: candidate.missingPixelCount,
      previewPath: candidatePreviewPath(index, candidate.candidateId),
    })),
  };

  const sourcePreview = encodeBoundedPreview(
    scaleNearest(cloneImage(input.source.image), PREVIEW_SCALE),
    "source",
  );
  const candidatePreviews = input.completionProposal.candidates.map(
    (candidate) =>
      encodeBoundedPreview(
        scaleNearest(
          renderCandidatePreview(input.source.image, candidate),
          PREVIEW_SCALE,
        ),
        candidate.candidateId,
      ),
  );
  const files: Record<string, Uint8Array> = {
    "job.json": utf8(canonicalJson(job)),
    [PATHS.evidence]: utf8(canonicalJson(evidence)),
    [PATHS.outputSchema]: utf8(canonicalJson(input.proposalSchema)),
    [PATHS.sourcePreview]: sourcePreview,
  };
  for (const [index, candidate] of input.completionProposal.candidates.entries()) {
    files[candidatePreviewPath(index, candidate.candidateId)] =
      candidatePreviews[index]!;
  }

  await Promise.all([
    mkdir(resolveWithin(root, "input", "previews"), { recursive: true }),
    mkdir(resolveWithin(root, "output"), { recursive: true }),
    mkdir(resolveWithin(root, "schema"), { recursive: true }),
    mkdir(resolveWithin(root, "logs"), { recursive: true }),
  ]);
  for (const [relativePath, bytes] of Object.entries(files)) {
    await writeFile(
      resolveWithin(root, ...relativePath.split("/")),
      bytes,
      { flag: "wx" },
    );
  }

  const fileHashes = Object.fromEntries(
    Object.entries(files)
      .sort(([left], [right]) => compareString(left, right))
      .map(([path, bytes]) => [path, sha256(bytes)]),
  );
  const immutableFiles = Object.fromEntries(
    Object.entries(fileHashes).filter(([path]) => path !== "job.json"),
  );
  const inputHash = sha256(
    utf8(
      canonicalJson({
        proposalHash: input.completionProposal.proposalHash,
        proposalEvidenceHash: input.completionProposal.evidenceHash,
        sourceRevisionId: input.completionProposal.sourceRevisionId,
        sourceResultHash: input.completionProposal.sourceResultHash,
        sourceSkinHash: input.completionProposal.sourceSkinHash,
        provider: input.provider,
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        promptVersion: COMPLETION_RANKING_PROMPT_VERSION,
        previewRendererVersion: COMPLETION_RANKING_PREVIEW_RENDERER_VERSION,
        files: immutableFiles,
      }),
    ),
  );
  const manifest: CompletionRankingPackManifest = {
    schemaVersion: COMPLETION_RANKING_PACK_SCHEMA_VERSION,
    inputHash,
    files: fileHashes,
  };
  const manifestBytes = utf8(canonicalJson(manifest));
  await writeFile(
    resolveWithin(root, ...PATHS.manifest.split("/")),
    manifestBytes,
    { flag: "wx" },
  );

  return {
    workspaceDirectory: root,
    job,
    evidence,
    completionProposal: input.completionProposal,
    source: input.source,
    inputHash,
    fileHashes,
    manifestHash: sha256(manifestBytes),
    paths: PATHS,
    imageAttachments,
    imagePaths: imageAttachments.map((attachment) => attachment.path),
  };
}

export async function verifyCompletionRankingPackIntegrity(
  pack: CompletionRankingPack,
): Promise<void> {
  const manifestPath = resolveWithin(
    pack.workspaceDirectory,
    ...pack.paths.manifest.split("/"),
  );
  let manifestBytes: Uint8Array;
  try {
    manifestBytes = new Uint8Array(await readFile(manifestPath));
  } catch (error) {
    throw new Error("Completion ranking manifest is missing", { cause: error });
  }
  if (sha256(manifestBytes) !== pack.manifestHash) {
    throw new Error("Completion ranking manifest changed during provider run");
  }
  let manifest: CompletionRankingPackManifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as
      CompletionRankingPackManifest;
  } catch (error) {
    throw new Error("Completion ranking manifest is invalid", { cause: error });
  }
  if (
    manifest.schemaVersion !== COMPLETION_RANKING_PACK_SCHEMA_VERSION ||
    manifest.inputHash !== pack.inputHash ||
    canonicalJson(manifest.files) !== canonicalJson(pack.fileHashes)
  ) {
    throw new Error("Completion ranking manifest does not match the pack");
  }

  for (const [relativePath, expectedHash] of Object.entries(pack.fileHashes)) {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(
        await readFile(
          resolveWithin(pack.workspaceDirectory, ...relativePath.split("/")),
        ),
      );
    } catch (error) {
      throw new Error(`Completion ranking input file is missing: ${relativePath}`, {
        cause: error,
      });
    }
    if (sha256(bytes) !== expectedHash) {
      throw new Error(
        `Completion ranking input file changed during provider run: ${relativePath}`,
      );
    }
  }
}

function assertCompletionRankingPackInput(
  input: BuildCompletionRankingPackInput,
): void {
  if (!JOB_ID_PATTERN.test(input.jobId)) throw new TypeError("jobId is invalid");
  assertText(input.provider, 1, 80, "provider");
  assertText(input.model, 1, 120, "model");
  if (![
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ].includes(input.reasoningEffort)) {
    throw new TypeError("reasoningEffort is invalid");
  }
  if (!isPlainObject(input.proposalSchema)) {
    throw new TypeError("proposalSchema must be a JSON object");
  }
  assertRgbaImage(input.source.image);
  if (input.source.image.width !== 64 || input.source.image.height !== 64) {
    throw new TypeError("Completion ranking source must be a 64x64 RGBA image");
  }
  if (
    input.completionProposal.candidates.length >
    MAX_COMPLETION_RANKING_CANDIDATES
  ) {
    throw new RangeError(
      `Completion ranking candidates must not exceed ${MAX_COMPLETION_RANKING_CANDIDATES}`,
    );
  }
  const candidateIds = new Set<string>();
  for (const candidate of input.completionProposal.candidates) {
    if (!CANDIDATE_ID_PATTERN.test(candidate.candidateId)) {
      throw new TypeError(`Completion ranking candidate ID is invalid: ${candidate.candidateId}`);
    }
    if (candidateIds.has(candidate.candidateId)) {
      throw new TypeError(`Duplicate Completion ranking candidate: ${candidate.candidateId}`);
    }
    candidateIds.add(candidate.candidateId);
  }
  validateCompletionProposalSource(input.completionProposal, input.source);
  validateCompletionProposalHashes(input.completionProposal, hashCanonical);
}

function renderCandidatePreview(
  source: RgbaImage,
  candidate: CompletionCandidate,
): RgbaImage {
  const preview = cloneImage(source);
  for (let pixelId = 0; pixelId < candidate.writeMask.length; pixelId += 1) {
    if (candidate.writeMask[pixelId] === 0) continue;
    const offset = pixelId * 4;
    preview.data.set(candidate.texture.data.subarray(offset, offset + 4), offset);
  }
  return preview;
}

function cloneImage(image: RgbaImage): RgbaImage {
  return createRgbaImage(image.width, image.height, image.data.slice());
}

function encodeBoundedPreview(image: RgbaImage, label: string): Uint8Array {
  const encoded = encodePngRgba(image);
  if (encoded.byteLength > MAX_PREVIEW_PNG_BYTES) {
    throw new RangeError(`Completion ranking preview is too large: ${label}`);
  }
  return encoded;
}

function candidatePreviewPath(index: number, candidateId: string): string {
  return `input/previews/${String(index + 1).padStart(3, "0")}-${candidateId}.png`;
}

function assertText(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): void {
  if (
    typeof value !== "string" ||
    value.trim().length < minimum ||
    value.length > maximum ||
    value.includes("\0")
  ) {
    throw new TypeError(`${label} must contain ${minimum}-${maximum} characters`);
  }
}

function resolveWithin(root: string, ...segments: string[]): string {
  const candidate = resolve(root, ...segments);
  const relation = relative(root, candidate);
  if (relation === ".." || relation.startsWith(`..${sep}`)) {
    throw new TypeError(`Completion ranking path escapes workspace: ${candidate}`);
  }
  return candidate;
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => compareString(left, right))
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }
  return value;
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compareString(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
