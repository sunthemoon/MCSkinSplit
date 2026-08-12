import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildReplacementPlanningPack,
  verifyReplacementPlanningPackIntegrity,
  type PublicRestorationCandidateCatalog,
} from "../src/index";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const skillDirectory = resolve(
  repositoryRoot,
  ".agents/skills/mc-skin-replacement-planner",
);
const proposalSchemaPath = resolve(
  skillDirectory,
  "assets/replacement-plan.schema.json",
);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("replacement planning pack", () => {
  it("writes a deterministic isolated ID-only workspace and verifies integrity", async () => {
    const schema = JSON.parse(await readFile(proposalSchemaPath, "utf8")) as unknown;
    const firstRoot = await temporaryDirectory();
    const secondRoot = await temporaryDirectory();
    const common = {
      skillDirectory,
      proposalSchema: schema,
      userIntent: "Prefer current skin evidence and avoid the manual candidate.",
      candidateCatalog: catalog(),
      skillVersion: "1.0.0",
      provider: "codex-exec",
      model: "codex-config-default",
      reasoningEffort: "medium" as const,
    };
    const first = await buildReplacementPlanningPack({
      ...common,
      workspaceDirectory: firstRoot,
      jobId: "replace_job_one",
    });
    const second = await buildReplacementPlanningPack({
      ...common,
      workspaceDirectory: secondRoot,
      jobId: "replace_job_two",
    });

    expect(first.inputHash).toBe(second.inputHash);
    expect(first.imagePaths).toEqual([]);
    expect(first.job).toEqual({
      schemaVersion: "1.0",
      jobId: "replace_job_one",
      userIntent: common.userIntent,
    });
    expect(first.fileHashes).toHaveProperty("job.json");
    expect(first.fileHashes).toHaveProperty("input/restoration-candidates.json");
    expect(first.fileHashes).toHaveProperty("schema/replacement-plan.schema.json");
    expect(first.fileHashes).toHaveProperty(
      ".agents/skills/mc-skin-replacement-planner/SKILL.md",
    );
    expect(Object.keys(first.fileHashes)).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining(".png"),
        expect.stringContaining("pixel-map"),
      ]),
    );
    const job = JSON.parse(await readFile(resolve(firstRoot, "job.json"), "utf8")) as object;
    expect(Object.keys(job).sort()).toEqual(["jobId", "schemaVersion", "userIntent"]);
    const serializedCatalog = await readFile(
      resolve(firstRoot, "input/restoration-candidates.json"),
      "utf8",
    );
    expect(serializedCatalog).not.toContain("pixelIds");
    expect(serializedCatalog).not.toContain("operations");
    expect(serializedCatalog).not.toContain("mask");

    await expect(verifyReplacementPlanningPackIntegrity(first)).resolves.toBeUndefined();
    await writeFile(
      resolve(firstRoot, "input/restoration-candidates.json"),
      "provider mutation",
      "utf8",
    );
    await expect(verifyReplacementPlanningPackIntegrity(first)).rejects.toThrow(
      "Replacement planning input file changed during provider run: input/restoration-candidates.json",
    );
  });

  it("rejects public catalogs that hide an unrepresented Base group", async () => {
    const input = catalog();
    await expect(
      buildReplacementPlanningPack({
        workspaceDirectory: await temporaryDirectory(),
        skillDirectory,
        proposalSchema: {},
        jobId: "replace_job_invalid",
        userIntent: "Use current semantic evidence.",
        candidateCatalog: {
          ...input,
          base: {
            ...input.base,
            pixelCount: input.base.pixelCount + 1,
            missingPixelCount: input.base.missingPixelCount + 1,
          },
        },
        skillVersion: "1.0.0",
        provider: "codex-exec",
        model: "codex-config-default",
        reasoningEffort: "medium",
      }),
    ).rejects.toThrow("does not expose every Base target group");
  });
});

function catalog(): PublicRestorationCandidateCatalog {
  return {
    compositionId: "composition_1",
    version: 3,
    candidateSetHash: `sha256:${"a".repeat(64)}`,
    targetComponentIds: ["outfit.main"],
    outer: { pixelCount: 4, candidateId: id("f") },
    base: {
      pixelCount: 12,
      coveredPixelCount: 12,
      missingPixelCount: 0,
      candidates: [
        candidate(id("1"), "torso_base", "current_same_surface", 8, 8),
        candidate(id("2"), "torso_base", "current_same_body_part", 8, 6),
        candidate(id("3"), "rightArm_base", "mirrored_counterpart", 4, 4),
      ],
    },
  };
}

function candidate(
  candidateId: string,
  targetGroupId: string,
  kind: "current_same_surface" | "current_same_body_part" | "mirrored_counterpart",
  pixelCount: number,
  coveragePixelCount: number,
) {
  return {
    id: candidateId,
    kind,
    targetGroupId,
    label: kind,
    description: `Candidate ${kind}`,
    pixelCount,
    coveragePixelCount,
  } as const;
}

function id(character: string): string {
  return `restore_${character.repeat(64)}`;
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), "mcskinsplit-replace-pack-"));
  temporaryDirectories.push(directory);
  return directory;
}
