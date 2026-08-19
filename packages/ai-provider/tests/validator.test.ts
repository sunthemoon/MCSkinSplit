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
import type { AnalysisProposal, AnalysisProposalV1_1 } from "../src/types";
import {
  isAnalysisProposalArtifact,
  validateAnalysisProposal,
} from "../src/validator";

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

  it("moves an override pixel only through a paired component transfer", async () => {
    const { pack, image } = await fixturePack();
    const [sourceRegion, destinationRegion] = transferRegions(pack);
    const pixelId = sourceRegion.pixelIds[0]!;
    const proposal = transferProposal(pack, sourceRegion.id, destinationRegion.id, pixelId);

    const result = validateAnalysisProposal({
      proposal,
      pack,
      image,
      aiRunId: "run_transfer",
    });

    expect(result.report.valid).toBe(true);
    expect(result.report.stats).toMatchObject({
      overrideUniquePixelCount: 1,
      overrideSpanCount: 2,
    });
    if (!result.state) throw new Error("expected valid transfer");
    expect(result.state.masks["source.main"]?.[pixelId]).toBe(0);
    expect(result.state.masks["destination.main"]?.[pixelId]).toBe(1);
  });

  it("allows an unmatched removal to become Unknown", async () => {
    const { pack, image } = await fixturePack();
    const sourceRegion = pack.candidateRegions.regions.find(
      (region) => region.pixelCount > 1,
    )!;
    const pixelId = sourceRegion.pixelIds[0]!;
    const proposal: AnalysisProposalV1_1 = {
      ...proposalFor(pack),
      components: [componentFor("source.main", "Source", [sourceRegion.id], {
        remove: [spanFor(pixelId)],
        add: [],
      })],
      unassignedCandidateRegionIds: pack.candidateRegions.regions
        .filter((region) => region.id !== sourceRegion.id)
        .map((region) => region.id),
    };

    const result = validateAnalysisProposal({
      proposal,
      pack,
      image,
      aiRunId: "run_unmatched_remove",
    });

    expect(result.report.valid).toBe(true);
    expect(result.report.stats.overrideUniquePixelCount).toBe(1);
    expect(result.report.stats.overrideSpanCount).toBe(1);
    if (!result.state) throw new Error("expected valid removal");
    expect(result.state.unknownMask[pixelId]).toBe(1);
  });

  it("rejects additions from unassigned regions and additions without a paired removal", async () => {
    const { pack, image } = await fixturePack();
    const [ownedRegion, unassignedRegion] = transferRegions(pack);
    const unassignedPixel = unassignedRegion.pixelIds[0]!;
    const proposal: AnalysisProposalV1_1 = {
      ...proposalFor(pack),
      components: [componentFor("destination.main", "Destination", [ownedRegion.id], {
        add: [spanFor(unassignedPixel)],
        remove: [],
      })],
      unassignedCandidateRegionIds: pack.candidateRegions.regions
        .filter((region) => region.id !== ownedRegion.id)
        .map((region) => region.id),
    };

    const result = validateAnalysisProposal({
      proposal,
      pack,
      image,
      aiRunId: "run_unassigned_add",
    });

    expect(result.report.valid).toBe(false);
    expect(result.report.errors.map((error) => error.code)).toEqual(
      expect.arrayContaining([
        "ADD_OVERRIDE_SOURCE_NOT_COMPONENT",
        "UNPAIRED_ADD_OVERRIDE",
      ]),
    );
  });

  it("enforces the proposal-wide unique-pixel and span limits", async () => {
    const { pack, image } = await fixturePack();
    const visiblePixels = [...new Set(
      pack.candidateRegions.regions.flatMap((region) => region.pixelIds),
    )].sort((left, right) => left - right);
    const allRegionIds = pack.candidateRegions.regions.map((region) => region.id);
    const pixelLimited: AnalysisProposalV1_1 = {
      ...proposalFor(pack),
      components: [componentFor("all.main", "All", allRegionIds, {
        add: [],
        remove: compactSpans(visiblePixels.slice(0, 65)),
      })],
      unassignedCandidateRegionIds: [],
    };
    expect(pixelLimited.components[0]!.pixelOverrides.remove.length).toBeLessThanOrEqual(32);

    const pixelResult = validateAnalysisProposal({
      proposal: pixelLimited,
      pack,
      image,
      aiRunId: "run_pixel_limit",
    });
    expect(pixelResult.report.errors.map((error) => error.code)).toContain(
      "OVERRIDE_PIXEL_LIMIT_EXCEEDED",
    );
    expect(pixelResult.report.stats.overrideUniquePixelCount).toBe(65);

    const spanLimited: AnalysisProposalV1_1 = {
      ...pixelLimited,
      components: [componentFor("all.main", "All", allRegionIds, {
        add: visiblePixels.slice(17, 33).map(spanFor),
        remove: visiblePixels.slice(0, 17).map(spanFor),
      })],
    };
    const spanResult = validateAnalysisProposal({
      proposal: spanLimited,
      pack,
      image,
      aiRunId: "run_span_limit",
    });
    expect(spanResult.report.errors.map((error) => error.code)).toContain(
      "OVERRIDE_SPAN_LIMIT_EXCEEDED",
    );
    expect(spanResult.report.stats.overrideSpanCount).toBe(33);
  });

  it("rejects more than 32 spans in one override array at the Schema boundary", async () => {
    const { pack, image } = await fixturePack();
    const visiblePixels = [...new Set(
      pack.candidateRegions.regions.flatMap((region) => region.pixelIds),
    )].sort((left, right) => left - right);
    const proposal: AnalysisProposalV1_1 = {
      ...proposalFor(pack),
      components: [componentFor(
        "all.main",
        "All",
        pack.candidateRegions.regions.map((region) => region.id),
        { add: [], remove: visiblePixels.slice(0, 33).map(spanFor) },
      )],
      unassignedCandidateRegionIds: [],
    };

    const result = validateAnalysisProposal({
      proposal,
      pack,
      image,
      aiRunId: "run_schema_span_limit",
    });

    expect(result.report.errors.map((error) => error.code)).toContain("SCHEMA_INVALID");
  });

  it("reads legacy 1.0 artifact shapes without accepting them as new submissions", async () => {
    const { pack, image } = await fixturePack();
    const current = proposalFor(pack);
    const legacy: AnalysisProposal = { ...current, schemaVersion: "1.0" };
    const legacyResult = validateAnalysisProposal({
      proposal: legacy,
      pack,
      image,
      aiRunId: "run_legacy",
    });
    expect(isAnalysisProposalArtifact(legacy)).toBe(true);
    expect(legacyResult.report.valid).toBe(false);
    expect(legacyResult.report.errors.map((error) => error.code)).toContain(
      "LEGACY_PROPOSAL_READ_ONLY",
    );

    const sourceRegion = pack.candidateRegions.regions.find(
      (region) => region.pixelCount > 1,
    )!;
    const legacySpans = pack.candidateRegions.regions
      .flatMap((region) => region.pixelIds)
      .slice(0, 65)
      .map(spanFor);
    const legacyWithOverride: AnalysisProposal = {
      ...legacy,
      components: [componentFor("source.main", "Source", [sourceRegion.id], {
        add: [],
        remove: legacySpans,
      })],
      unassignedCandidateRegionIds: pack.candidateRegions.regions
        .filter((region) => region.id !== sourceRegion.id)
        .map((region) => region.id),
    };
    const rejected = validateAnalysisProposal({
      proposal: legacyWithOverride,
      pack,
      image,
      aiRunId: "run_legacy_override",
    });
    expect(legacySpans).toHaveLength(65);
    expect(isAnalysisProposalArtifact(legacyWithOverride)).toBe(true);
    expect(rejected.report.errors.map((error) => error.code)).toContain(
      "LEGACY_PROPOSAL_READ_ONLY",
    );
  });

  it("excludes Unknown from the current component taxonomy", async () => {
    const { pack, image } = await fixturePack();
    const invalid = {
      ...proposalFor(pack),
      components: [{ ...proposalFor(pack).components[0], category: "unknown" }],
    };
    const result = validateAnalysisProposal({
      proposal: invalid,
      pack,
      image,
      aiRunId: "run_unknown_component",
    });
    expect(result.report.valid).toBe(false);
    expect(result.report.errors.map((error) => error.code)).toContain("SCHEMA_INVALID");
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

function proposalFor(pack: AnalysisPack): AnalysisProposalV1_1 {
  const first = pack.candidateRegions.regions[0]!;
  return {
    schemaVersion: "1.1",
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

function transferRegions(
  pack: AnalysisPack,
): readonly [
  AnalysisPack["candidateRegions"]["regions"][number],
  AnalysisPack["candidateRegions"]["regions"][number],
] {
  const source = pack.candidateRegions.regions.find((region) => region.pixelCount > 1)!;
  const destination = pack.candidateRegions.regions.find((region) => region.id !== source.id)!;
  return [source, destination];
}

function transferProposal(
  pack: AnalysisPack,
  sourceRegionId: string,
  destinationRegionId: string,
  pixelId: number,
): AnalysisProposalV1_1 {
  return {
    ...proposalFor(pack),
    components: [
      componentFor("source.main", "Source", [sourceRegionId], {
        remove: [spanFor(pixelId)],
        add: [],
      }),
      componentFor("destination.main", "Destination", [destinationRegionId], {
        remove: [],
        add: [spanFor(pixelId)],
      }),
    ],
    unassignedCandidateRegionIds: pack.candidateRegions.regions
      .filter((region) => region.id !== sourceRegionId && region.id !== destinationRegionId)
      .map((region) => region.id),
  };
}

function componentFor(
  instanceId: string,
  displayName: string,
  candidateRegionIds: readonly string[],
  pixelOverrides: AnalysisProposalV1_1["components"][number]["pixelOverrides"],
): AnalysisProposalV1_1["components"][number] {
  return {
    instanceId,
    displayName,
    category: "hair",
    subtype: null,
    confidence: 0.9,
    candidateRegionIds,
    pixelOverrides,
    relations: { attachedTo: null, pairedWith: [], sameOutfitGroup: null },
    notes: "",
  };
}

function spanFor(pixelId: number): { readonly y: number; readonly x0: number; readonly x1: number } {
  const x = pixelId % 64;
  return { y: Math.floor(pixelId / 64), x0: x, x1: x };
}

function compactSpans(
  pixelIds: readonly number[],
): readonly { readonly y: number; readonly x0: number; readonly x1: number }[] {
  const result: { y: number; x0: number; x1: number }[] = [];
  for (const pixelId of pixelIds) {
    const next = spanFor(pixelId);
    const previous = result.at(-1);
    if (previous && previous.y === next.y && previous.x1 + 1 === next.x0) {
      previous.x1 = next.x1;
    } else {
      result.push({ ...next });
    }
  }
  return result;
}
