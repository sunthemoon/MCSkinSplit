import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createInitialSemanticState,
  decodeSkinPng,
  getSkinLayout,
} from "@mc-skin-split/skin-core";
import {
  CANDIDATE_REGION_ALGORITHM_VERSION,
  PROMPT_VERSION,
  TAXONOMY_VERSION,
  createAnalysisDocuments,
  type AnalysisPack,
} from "@mc-skin-split/skin-analysis-pack";
import { describe, expect, it } from "vitest";
import { ANALYSIS_PROPOSAL_SCHEMA } from "../src/schema";
import type { AnalysisProposal } from "../src/types";
import { validateAnalysisProposal } from "../src/validator";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("analysis proposal validator", () => {
  it("keeps low-confidence components reviewable and exact", async () => {
    const { pack, image } = await fixturePack();
    const proposal = proposalFor(pack);
    const result = validateAnalysisProposal({
      proposal,
      pack,
      image,
      aiRunId: "run_ai_1",
    });

    expect(result.report.valid).toBe(true);
    if (!result.state) throw new Error("expected valid proposal");
    expect(result.state.document.components).toHaveLength(1);
    expect(result.state.document.components[0]).toMatchObject({
      instanceId: "hair.main",
      reviewState: "needs_review",
      provenance: { actorType: "ai", aiRunId: "run_ai_1" },
    });
    expect(result.report.stats.assignedPixelCount).toBe(
      pack.candidateRegions.regions[0]!.pixelCount,
    );
    expect(
      result.report.stats.assignedPixelCount + result.report.stats.unknownPixelCount,
    ).toBe(pack.candidateRegions.visiblePixelCount);
  });

  it("accepts an outfit group identifier that is not a component identifier", async () => {
    const { pack, image } = await fixturePack();
    const proposal = proposalFor(pack);
    const grouped: AnalysisProposal = {
      ...proposal,
      components: [
        {
          ...proposal.components[0]!,
          relations: {
            ...proposal.components[0]!.relations,
            sameOutfitGroup: "outfit.green-white",
          },
        },
      ],
    };

    const result = validateAnalysisProposal({
      proposal: grouped,
      pack,
      image,
      aiRunId: "run_ai_group",
    });

    expect(result.report.valid).toBe(true);
  });

  it("rejects unknown regions, duplicate ownership, and uncovered regions", async () => {
    const { pack, image } = await fixturePack();
    const proposal = proposalFor(pack);
    const duplicated: AnalysisProposal = {
      ...proposal,
      components: [
        proposal.components[0]!,
        {
          ...proposal.components[0]!,
          instanceId: "hair.second",
          candidateRegionIds: [proposal.components[0]!.candidateRegionIds[0]!],
        },
      ],
      unassignedCandidateRegionIds: [
        "region_missing_001",
        ...proposal.unassignedCandidateRegionIds.slice(1),
      ],
    };
    const result = validateAnalysisProposal({
      proposal: duplicated,
      pack,
      image,
      aiRunId: "run_ai_2",
    });
    expect(result.report.valid).toBe(false);
    expect(result.report.errors.map((error) => error.code)).toEqual(
      expect.arrayContaining([
        "REGION_MULTIPLE_OWNERS",
        "UNKNOWN_REGION",
        "UNCOVERED_REGION",
      ]),
    );
  });

  it("keeps the repository Skill schema byte-for-byte equivalent", async () => {
    const skillSchema = JSON.parse(
      await readFile(
        resolve(
          repositoryRoot,
          ".agents/skills/mc-skin-segmenter/assets/analysis-proposal.schema.json",
        ),
        "utf8",
      ),
    );
    expect(skillSchema).toEqual(ANALYSIS_PROPOSAL_SCHEMA);
  });
});

async function fixturePack(): Promise<{
  readonly pack: AnalysisPack;
  readonly image: ReturnType<typeof decodeSkinPng>;
}> {
  const skinPng = new Uint8Array(
    await readFile(
      resolve(repositoryRoot, "tests/fixtures/skins/ab87de696cfca859.png"),
    ),
  );
  const image = decodeSkinPng(skinPng);
  const documents = createAnalysisDocuments(image, getSkinLayout("slim"));
  const previous = createInitialSemanticState({
    revisionId: "rev_source",
    sourceHash: `sha256:${"1".repeat(64)}`,
    armType: "slim",
    image,
  }).document;
  const job: AnalysisPack["job"] = {
    schemaVersion: "1.0" as const,
    jobId: "job_1",
    runId: "run_1",
    projectId: "project_1",
    sourceRevisionId: "rev_source",
    sourceResultHash: `sha256:${"2".repeat(64)}`,
    sourceSkinHash: previous.source.sourceHash,
    armType: "slim" as const,
    provider: "test-provider",
    model: "test-model",
    reasoningEffort: "medium" as const,
    semanticBaseline: "current" as const,
    mode: "full" as const,
    taxonomyLevel: "coarse" as const,
    focus: ["hair"] as const,
    createRevisionOnSuccess: true,
    candidateRegionAlgorithmVersion: CANDIDATE_REGION_ALGORITHM_VERSION,
    taxonomyVersion: TAXONOMY_VERSION,
    skillName: "mc-skin-segmenter" as const,
    skillVersion: "1.0.0",
    promptVersion: PROMPT_VERSION,
    paths: {
      source: "input/source.png" as const,
      atlas: "input/atlas-16x.png" as const,
      atlasGrid: "input/atlas-grid-16x.png" as const,
      contactSheet: "input/face-contact-sheet.png" as const,
      pixelMap: "input/pixel-map.json" as const,
      palette: "input/palette.json" as const,
      candidateSummary: "input/candidate-summary.json" as const,
      candidateRegions: "input/candidate-regions.json" as const,
      previousSegmentation: "input/previous-segmentation.json" as const,
      outputSchema: "schema/analysis-proposal.schema.json" as const,
      proposal: "output/analysis-proposal.json" as const,
      validatorReport: "logs/validator-report.json" as const,
    },
  };
  return {
    image,
    pack: {
      workspaceDirectory: "C:/isolated/run",
      job,
      candidateRegions: documents.candidateRegions,
      pixelMap: documents.pixelMap,
      palette: documents.palette,
      previousSegmentation: previous,
      inputHash: `sha256:${"3".repeat(64)}`,
      fileHashes: {},
      imagePaths: [],
    },
  };
}

function proposalFor(pack: AnalysisPack): AnalysisProposal {
  const first = pack.candidateRegions.regions[0]!;
  return {
    schemaVersion: "1.0",
    sourceRevisionId: pack.job.sourceRevisionId,
    modelAssessment: { armType: pack.job.armType, confidence: 0.9 },
    components: [
      {
        instanceId: "hair.main",
        displayName: "主头发",
        category: "hair",
        subtype: null,
        confidence: 0.5,
        candidateRegionIds: [first.id],
        pixelOverrides: { add: [], remove: [] },
        relations: {
          attachedTo: null,
          pairedWith: [],
          sameOutfitGroup: null,
        },
        notes: "",
      },
    ],
    unassignedCandidateRegionIds: pack.candidateRegions.regions
      .slice(1)
      .map((region) => region.id),
    reviewItems: [],
    summary: "测试提案",
  };
}
