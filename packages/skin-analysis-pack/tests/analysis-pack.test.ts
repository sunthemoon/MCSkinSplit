import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createInitialSemanticState,
  decodePngRgba,
  decodeSkinPng,
  getSkinLayout,
} from "@mc-skin-split/skin-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildAnalysisPack,
  createAnalysisDocuments,
  verifyAnalysisPackIntegrity,
} from "../src/index";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const fixtureDirectory = resolve(repositoryRoot, "tests/fixtures/skins");
const skillDirectory = resolve(
  repositoryRoot,
  ".agents/skills/mc-skin-segmenter",
);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("analysis pack", () => {
  it("partitions every visible UV pixel for all six real Slim skins", async () => {
    const manifest = JSON.parse(
      await readFile(resolve(fixtureDirectory, "real-skins.json"), "utf8"),
    ) as { skins: readonly { file: string }[] };
    for (const fixture of manifest.skins) {
      const image = decodeSkinPng(await readFile(resolve(fixtureDirectory, fixture.file)));
      const documents = createAnalysisDocuments(image, getSkinLayout("slim"));
      const ids = documents.candidateRegions.regions.flatMap(
        (region) => region.pixelIds,
      );
      expect(new Set(ids).size, fixture.file).toBe(ids.length);
      expect(ids.length, fixture.file).toBe(
        documents.candidateRegions.visiblePixelCount,
      );
      expect(documents.pixelMap.items).toHaveLength(3_136);
      expect(documents.palette.visiblePixelCount).toBe(ids.length);
      expect(documents.candidateRegions.regions.length, fixture.file).toBeLessThan(
        450,
      );
    }
  });

  it("writes a deterministic isolated workspace with inspectable images", async () => {
    const skinPng = new Uint8Array(
      await readFile(resolve(fixtureDirectory, "ab87de696cfca859.png")),
    );
    const image = decodeSkinPng(skinPng);
    const semantic = createInitialSemanticState({
      revisionId: "rev_source",
      sourceHash: `sha256:${"1".repeat(64)}`,
      armType: "slim",
      image,
    });
    const schema = JSON.parse(
      await readFile(
        resolve(skillDirectory, "assets/analysis-proposal.schema.json"),
        "utf8",
      ),
    );
    const firstRoot = await temporaryDirectory();
    const secondRoot = await temporaryDirectory();
    const common = {
      skillDirectory,
      proposalSchema: schema,
      projectId: "project_real",
      sourceRevisionId: "rev_source",
      sourceResultHash: `sha256:${"2".repeat(64)}`,
      skinPng,
      armType: "slim" as const,
      previousSegmentation: semantic.document,
      provider: "codex-exec",
      model: "codex-config-default",
      reasoningEffort: "medium" as const,
      focus: ["hair", "face", "upper_clothing", "shoe"] as const,
      createRevisionOnSuccess: true,
      skillVersion: "1.0.0",
    };
    const first = await buildAnalysisPack({
      ...common,
      workspaceDirectory: firstRoot,
      jobId: "job_one",
      runId: "run_one",
    });
    const second = await buildAnalysisPack({
      ...common,
      workspaceDirectory: secondRoot,
      jobId: "job_two",
      runId: "run_two",
    });

    expect(first.inputHash).toBe(second.inputHash);
    expect(first.candidateRegions.visiblePixelCount).toBeGreaterThan(1_000);
    expect(first.imagePaths).toHaveLength(5);
    expect(
      decodePngRgba(await readFile(resolve(firstRoot, "input/atlas-grid-16x.png"))),
    ).toMatchObject({ width: 1_024, height: 1_024 });
    expect(
      decodePngRgba(await readFile(resolve(firstRoot, "input/views/front.png"))),
    ).toMatchObject({ width: 144, height: 272 });
    expect(
      await readFile(
        resolve(
          firstRoot,
          ".agents/skills/mc-skin-segmenter/SKILL.md",
        ),
        "utf8",
      ),
    ).toContain("Produce one semantic proposal");
    const summary = JSON.parse(
      await readFile(resolve(firstRoot, "input/candidate-summary.json"), "utf8"),
    ) as { readonly regionCount: number; readonly surfaces: object };
    expect(summary.regionCount).toBe(first.candidateRegions.regions.length);
    expect(Object.keys(summary.surfaces).length).toBeGreaterThan(40);
    expect(
      (await readFile(resolve(firstRoot, "input/candidate-summary.json"))).byteLength,
    ).toBeLessThan(
      (await readFile(resolve(firstRoot, "input/candidate-regions.json"))).byteLength / 3,
    );

    await expect(verifyAnalysisPackIntegrity(first)).resolves.toBeUndefined();
    await writeFile(
      resolve(firstRoot, "input/candidate-regions.json"),
      "provider mutation",
      "utf8",
    );
    await expect(verifyAnalysisPackIntegrity(first)).rejects.toThrow(
      "Analysis input file changed during provider run: input/candidate-regions.json",
    );
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), "mcskinsplit-pack-"));
  temporaryDirectories.push(directory);
  return directory;
}
