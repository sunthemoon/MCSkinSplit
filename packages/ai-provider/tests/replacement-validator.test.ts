import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  PublicRestorationCandidate,
  ReplacementPlanningPack,
} from "@mc-skin-split/skin-analysis-pack";
import { describe, expect, it } from "vitest";
import { REPLACEMENT_PLAN_SCHEMA } from "../src/schema";
import { validateReplacementPlanProposal } from "../src/replacement-validator";
import type { ReplacementPlanProposal } from "../src/types";

describe("replacement plan validator", () => {
  it("keeps the repository replacement Skill schema structurally identical", async () => {
    const repositoryRoot = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../..",
    );
    const skillSchemaText = await readFile(
      resolve(
        repositoryRoot,
        ".agents/skills/mc-skin-replacement-planner/assets/replacement-plan.schema.json",
      ),
      "utf8",
    );
    const providerSchemaText = await readFile(
      resolve(repositoryRoot, "packages/ai-provider/src/replacement-plan.schema.json"),
      "utf8",
    );
    const skillSchema = JSON.parse(skillSchemaText) as unknown;
    expect(skillSchema).toEqual(REPLACEMENT_PLAN_SCHEMA);
    expect(providerSchemaText).toBe(skillSchemaText);
  });

  it("accepts one ordered exact ID-only decision per Base group", () => {
    const pack = replacementPack();
    const result = validateReplacementPlanProposal({
      proposal: validProposal(pack),
      pack,
    });

    expect(result.report).toMatchObject({
      valid: true,
      stats: {
        targetGroupCount: 2,
        decisionCount: 2,
        candidateCount: 3,
        selectedCount: 1,
        deferredCount: 1,
      },
    });
  });

  it("rejects unknown/cross-group IDs, incomplete selection, Outer, evidence, and extra fields", () => {
    const pack = replacementPack();
    const proposal = validProposal(pack);
    const invalid = {
      ...proposal,
      extra: "forbidden",
      decisions: [
        {
          ...proposal.decisions[1],
          targetGroupId: "torso_base",
          selectedCandidateId: id("2"),
          rankedCandidateIds: [id("f"), id("2"), id("9")],
          explanation: "Use RGBA [1, 2, 3, 255] at pixel ID 42.",
        },
        proposal.decisions[0],
      ],
    };
    const result = validateReplacementPlanProposal({ proposal: invalid, pack });

    expect(result.report.valid).toBe(false);
    expect(result.report.errors.map((item) => item.code)).toEqual(
      expect.arrayContaining(["SCHEMA_INVALID"]),
    );

    const withoutExtra = { ...invalid };
    delete (withoutExtra as { extra?: string }).extra;
    const semanticResult = validateReplacementPlanProposal({
      proposal: withoutExtra,
      pack,
    });
    expect(semanticResult.report.errors.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "TARGET_GROUP_ORDER_INVALID",
        "RANKING_NOT_EXACT_PERMUTATION",
        "UNKNOWN_CANDIDATE_ID",
        "OUTER_CANDIDATE_FORBIDDEN",
        "INCOMPLETE_SELECTED_CANDIDATE",
        "FORBIDDEN_PRIVATE_EVIDENCE",
      ]),
    );
  });

  it("rejects a selected partial candidate while allowing null deferral", () => {
    const pack = replacementPack();
    const proposal = validProposal(pack);
    const invalid: ReplacementPlanProposal = {
      ...proposal,
      decisions: [
        proposal.decisions[0]!,
        {
          ...proposal.decisions[1]!,
          selectedCandidateId: id("2"),
          rankedCandidateIds: [id("2"), id("1")],
        },
      ],
    };
    const result = validateReplacementPlanProposal({ proposal: invalid, pack });
    expect(result.report.errors.map((item) => item.code)).toContain(
      "INCOMPLETE_SELECTED_CANDIDATE",
    );
  });
});

function validProposal(pack: ReplacementPlanningPack): ReplacementPlanProposal {
  return {
    schemaVersion: "1.0",
    jobId: pack.job.jobId,
    compositionId: pack.candidateCatalog.compositionId,
    candidateSetHash: pack.candidateCatalog.candidateSetHash,
    decisions: [
      {
        targetGroupId: "rightArm_base",
        selectedCandidateId: null,
        rankedCandidateIds: [id("3")],
        confidence: 0.55,
        explanation: "The supplied mirror option is plausible, but the choice is deferred.",
      },
      {
        targetGroupId: "torso_base",
        selectedCandidateId: id("1"),
        rankedCandidateIds: [id("1"), id("2")],
        confidence: 0.92,
        explanation: "Complete local semantic evidence best matches the requested source.",
      },
    ],
    summary: "One complete local option is recommended and one group is deferred.",
  };
}

function replacementPack(): ReplacementPlanningPack {
  return {
    workspaceDirectory: "C:/isolated/replacement",
    job: {
      schemaVersion: "1.0",
      jobId: "replacement_job_1",
      userIntent: "Prefer current semantic evidence.",
    },
    candidateCatalog: {
      compositionId: "composition_1",
      version: 2,
      candidateSetHash: `sha256:${"a".repeat(64)}`,
      targetComponentIds: ["outfit.main"],
      outer: { pixelCount: 4, candidateId: id("f") },
      base: {
        pixelCount: 12,
        coveredPixelCount: 12,
        missingPixelCount: 0,
        candidates: [
          candidate(id("1"), "torso_base", 8, 8),
          candidate(id("2"), "torso_base", 8, 6),
          candidate(id("3"), "rightArm_base", 4, 4),
        ],
      },
    },
    inputHash: `sha256:${"b".repeat(64)}`,
    fileHashes: {},
    manifestHash: `sha256:${"c".repeat(64)}`,
    paths: {
      candidateCatalog: "input/restoration-candidates.json",
      manifest: "input/manifest.json",
      outputSchema: "schema/replacement-plan.schema.json",
      proposal: "output/replacement-plan.json",
      validatorReport: "logs/validator-report.json",
      previousValidatorReport: "logs/previous-validator-report.json",
    },
    imagePaths: [],
  };
}

function candidate(
  candidateId: string,
  targetGroupId: string,
  pixelCount: number,
  coveragePixelCount: number,
): PublicRestorationCandidate {
  return {
    id: candidateId,
    kind:
      targetGroupId === "rightArm_base"
        ? "mirrored_counterpart"
        : "current_same_surface",
    targetGroupId,
    label: "Candidate",
    description: "Public candidate description",
    pixelCount,
    coveragePixelCount,
  };
}

function id(character: string): string {
  return `restore_${character.repeat(64)}`;
}
