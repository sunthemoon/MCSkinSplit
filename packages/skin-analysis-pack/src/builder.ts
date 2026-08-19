import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import {
  decodeSkinPng,
  encodePngRgba,
  getSkinLayout,
} from "@mc-skin-split/skin-core";
import {
  createAnalysisDocuments,
  createCandidateRegionSummary,
} from "./candidate-regions";
import {
  buildCandidateEvidenceGraph,
  CANDIDATE_EVIDENCE_GRAPH_ALGORITHM_VERSION,
  createCandidateEvidenceGraphSummary,
} from "./candidate-evidence-graph";
import {
  CANDIDATE_GROUNDING_RENDERER_VERSION,
  renderAnalysisImages,
  renderCandidateRegionGrounding,
} from "./render-analysis";
import {
  ANALYSIS_IMAGE_ATTACHMENT_CONTRACT,
  CANDIDATE_REGION_ALGORITHM_VERSION,
  PROMPT_VERSION,
  TAXONOMY_VERSION,
  type AnalysisJobDocument,
  type AnalysisPack,
  type BuildAnalysisPackInput,
} from "./types";

export async function buildAnalysisPack(
  input: BuildAnalysisPackInput,
): Promise<AnalysisPack> {
  const root = resolve(input.workspaceDirectory);
  const inputDirectory = resolveWithin(root, "input");
  const viewsDirectory = resolveWithin(inputDirectory, "views");
  const groundingDirectory = resolveWithin(inputDirectory, "grounding");
  await Promise.all([
    mkdir(viewsDirectory, { recursive: true }),
    mkdir(groundingDirectory, { recursive: true }),
    mkdir(resolveWithin(root, "output"), { recursive: true }),
    mkdir(resolveWithin(root, "logs"), { recursive: true }),
  ]);

  const image = decodeSkinPng(input.skinPng);
  const layout = getSkinLayout(input.armType);
  const { candidateRegions, pixelMap, palette } = createAnalysisDocuments(
    image,
    layout,
  );
  const rendered = renderAnalysisImages(image, input.armType);
  const candidateEvidenceGraph = buildCandidateEvidenceGraph(candidateRegions);
  const candidateEvidenceSummary = createCandidateEvidenceGraphSummary(
    candidateEvidenceGraph,
  );
  const candidateGrounding = renderCandidateRegionGrounding(
    image,
    input.armType,
    candidateRegions,
  );
  const candidateSummary = createCandidateRegionSummary(candidateRegions);
  const imageAttachments = ANALYSIS_IMAGE_ATTACHMENT_CONTRACT;
  const job: AnalysisJobDocument = {
    schemaVersion: "1.1",
    jobId: input.jobId,
    runId: input.runId,
    projectId: input.projectId,
    sourceRevisionId: input.sourceRevisionId,
    sourceResultHash: input.sourceResultHash,
    sourceSkinHash: input.previousSegmentation.source.sourceHash,
    armType: input.armType,
    provider: input.provider,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    semanticBaseline: input.semanticBaseline,
    mode: "full",
    taxonomyLevel: "coarse",
    focus: [...input.focus],
    createRevisionOnSuccess: input.createRevisionOnSuccess,
    candidateRegionAlgorithmVersion: CANDIDATE_REGION_ALGORITHM_VERSION,
    candidateEvidenceGraphAlgorithmVersion:
      CANDIDATE_EVIDENCE_GRAPH_ALGORITHM_VERSION,
    candidateGroundingRendererVersion: CANDIDATE_GROUNDING_RENDERER_VERSION,
    taxonomyVersion: TAXONOMY_VERSION,
    skillName: "mc-skin-segmenter",
    skillVersion: input.skillVersion,
    promptVersion: PROMPT_VERSION,
    imageAttachments,
    paths: {
      source: "input/source.png",
      atlas: "input/atlas-16x.png",
      atlasGrid: "input/atlas-grid-16x.png",
      contactSheet: "input/face-contact-sheet.png",
      pixelMap: "input/pixel-map.json",
      palette: "input/palette.json",
      candidateSummary: "input/candidate-summary.json",
      candidateRegions: "input/candidate-regions.json",
      candidateEvidenceGraph: "input/candidate-evidence-graph.json",
      candidateEvidenceSummary: "input/candidate-evidence-summary.json",
      candidateGroundingManifest: "input/candidate-grounding-manifest.json",
      candidateGroundingAtlas: "input/grounding/candidate-atlas-16x.png",
      candidateGroundingFaceContact:
        "input/grounding/candidate-face-contact-sheet.png",
      candidateGroundingAllSurfacePair:
        "input/grounding/all-surface-natural-candidate-pair.png",
      candidateGroundingLegend: "input/grounding/legend.png",
      candidateGroundingCompositeNatural:
        "input/grounding/composite-natural.png",
      candidateGroundingCompositeRegions:
        "input/grounding/composite-regions.png",
      candidateGroundingBaseNatural: "input/grounding/base-natural.png",
      candidateGroundingBaseRegions: "input/grounding/base-regions.png",
      candidateGroundingOuterNatural: "input/grounding/outer-natural.png",
      candidateGroundingOuterRegions: "input/grounding/outer-regions.png",
      previousSegmentation: "input/previous-segmentation.json",
      outputSchema: "schema/analysis-proposal.schema.json",
      proposal: "output/analysis-proposal.json",
      validatorReport: "logs/validator-report.json",
    },
  };

  const files: Readonly<Record<string, Uint8Array>> = {
    "job.json": utf8(canonicalJson(job)),
    "input/source.png": input.skinPng,
    "input/atlas-16x.png": encodePngRgba(rendered.atlas),
    "input/atlas-grid-16x.png": encodePngRgba(rendered.atlasGrid),
    "input/face-contact-sheet.png": encodePngRgba(rendered.contactSheet),
    "input/views/front.png": encodePngRgba(rendered.views.front),
    "input/views/back.png": encodePngRgba(rendered.views.back),
    "input/views/left.png": encodePngRgba(rendered.views.left),
    "input/views/right.png": encodePngRgba(rendered.views.right),
    "input/views/front-right-contact.png": encodePngRgba(
      rendered.views.frontRightContact,
    ),
    "input/pixel-map.json": utf8(canonicalJson(pixelMap)),
    "input/palette.json": utf8(canonicalJson(palette)),
    "input/candidate-summary.json": utf8(compactJson(candidateSummary)),
    "input/candidate-regions.json": utf8(canonicalJson(candidateRegions)),
    "input/candidate-evidence-graph.json": utf8(
      canonicalJson(candidateEvidenceGraph),
    ),
    "input/candidate-evidence-summary.json": utf8(
      compactJson(candidateEvidenceSummary),
    ),
    "input/candidate-grounding-manifest.json": utf8(
      canonicalJson(candidateGrounding.manifest),
    ),
    "input/grounding/candidate-atlas-16x.png": encodePngRgba(
      candidateGrounding.candidateAtlas,
    ),
    "input/grounding/candidate-face-contact-sheet.png": encodePngRgba(
      candidateGrounding.allSurfaceContactSheet.candidateRegions,
    ),
    "input/grounding/all-surface-natural-candidate-pair.png": encodePngRgba(
      candidateGrounding.allSurfacePairedContactSheet,
    ),
    "input/grounding/composite-natural.png": encodePngRgba(
      candidateGrounding.contactSheet.naturalColor,
    ),
    "input/grounding/composite-regions.png": encodePngRgba(
      candidateGrounding.contactSheet.candidateRegions,
    ),
    "input/grounding/base-natural.png": encodePngRgba(
      candidateGrounding.layerContactSheets.base.naturalColor,
    ),
    "input/grounding/base-regions.png": encodePngRgba(
      candidateGrounding.layerContactSheets.base.candidateRegions,
    ),
    "input/grounding/outer-natural.png": encodePngRgba(
      candidateGrounding.layerContactSheets.outer.naturalColor,
    ),
    "input/grounding/outer-regions.png": encodePngRgba(
      candidateGrounding.layerContactSheets.outer.candidateRegions,
    ),
    "input/grounding/legend.png": encodePngRgba(
      candidateGrounding.legendImage,
    ),
    "input/previous-segmentation.json": utf8(
      canonicalJson(input.previousSegmentation),
    ),
    "schema/analysis-proposal.schema.json": utf8(
      canonicalJson(input.proposalSchema),
    ),
  };

  for (const [relativePath, bytes] of Object.entries(files)) {
    const path = resolveWithin(root, ...relativePath.split("/"));
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, bytes, { flag: "wx" });
  }
  await copySkill(input.skillDirectory, root);

  const skillFiles = await collectSkillFileHashes(
    resolveWithin(root, ".agents", "skills", "mc-skin-segmenter"),
  );
  const fileHashes = {
    ...Object.fromEntries(
      Object.entries(files).map(([path, bytes]) => [path, sha256(bytes)]),
    ),
    ...skillFiles,
  };
  const cacheFiles = Object.fromEntries(
    Object.entries(fileHashes).filter(([path]) => path !== "job.json"),
  );
  const inputHash = sha256(
    utf8(
      canonicalJson({
        sourceRevisionResultHash: input.sourceResultHash,
        candidateRegionAlgorithmVersion: CANDIDATE_REGION_ALGORITHM_VERSION,
        candidateEvidenceGraphAlgorithmVersion:
          CANDIDATE_EVIDENCE_GRAPH_ALGORITHM_VERSION,
        candidateGroundingRendererVersion: CANDIDATE_GROUNDING_RENDERER_VERSION,
        taxonomyVersion: TAXONOMY_VERSION,
        skillVersion: input.skillVersion,
        promptVersion: PROMPT_VERSION,
        provider: input.provider,
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        semanticBaseline: input.semanticBaseline,
        focus: [...input.focus].sort(),
        createRevisionOnSuccess: input.createRevisionOnSuccess,
        imageAttachments,
        files: cacheFiles,
      }),
    ),
  );
  await writeFile(
    resolveWithin(inputDirectory, "manifest.json"),
    canonicalJson({ schemaVersion: "1.0", inputHash, files: fileHashes }),
    { encoding: "utf8", flag: "wx" },
  );

  return {
    workspaceDirectory: root,
    job,
    candidateRegions,
    candidateEvidenceGraph,
    candidateEvidenceSummary,
    candidateGroundingManifest: candidateGrounding.manifest,
    pixelMap,
    palette,
    previousSegmentation: input.previousSegmentation,
    inputHash,
    fileHashes,
    imageAttachments,
    imagePaths: imageAttachments.map((attachment) => attachment.path),
  };
}

export async function verifyAnalysisPackIntegrity(
  pack: AnalysisPack,
): Promise<void> {
  for (const [relativePath, expectedHash] of Object.entries(pack.fileHashes)) {
    const path = resolveWithin(
      pack.workspaceDirectory,
      ...relativePath.split("/"),
    );
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(path));
    } catch (error) {
      throw new Error(`Analysis input file is missing: ${relativePath}`, {
        cause: error,
      });
    }
    if (sha256(bytes) !== expectedHash) {
      throw new Error(`Analysis input file changed during provider run: ${relativePath}`);
    }
  }
}

async function copySkill(sourceDirectory: string, root: string): Promise<void> {
  const source = resolve(sourceDirectory);
  const target = resolveWithin(root, ".agents", "skills", "mc-skin-segmenter");
  await mkdir(resolve(target, ".."), { recursive: true });
  await cp(source, target, { recursive: true, errorOnExist: true, force: false });
}

async function collectSkillFileHashes(
  skillDirectory: string,
): Promise<Record<string, string>> {
  const { readdir } = await import("node:fs/promises");
  const result: Record<string, string> = {};
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const relativePath = relative(skillDirectory, path).split(sep).join("/");
        result[`.agents/skills/mc-skin-segmenter/${relativePath}`] = sha256(
          new Uint8Array(await readFile(path)),
        );
      }
    }
  }
  await visit(skillDirectory);
  return result;
}

function resolveWithin(root: string, ...segments: string[]): string {
  const candidate = resolve(root, ...segments);
  const relation = relative(root, candidate);
  if (relation === ".." || relation.startsWith(`..${sep}`)) {
    throw new TypeError(`Analysis path escapes workspace: ${candidate}`);
  }
  return candidate;
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`;
}

function compactJson(value: unknown): string {
  return `${JSON.stringify(sortJson(value))}\n`;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
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
