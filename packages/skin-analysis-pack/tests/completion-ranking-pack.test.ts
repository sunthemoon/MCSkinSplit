import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyManualSemanticOperation,
  buildSurfaceTexels,
  createInitialSemanticState,
  createRgbaImage,
  createSourceVisiblePixelOriginDocument,
  decodePngRgba,
  generateCompletionProposalCandidates,
  getPixel,
  getSkinLayout,
  pixelIdsToSpans,
  setPixel,
  type CompletionHashCanonical,
  type CompletionProposal,
  type CompletionSourceSnapshot,
  type Rgba,
  type RgbaImage,
  type SemanticState,
  type SurfaceTexel,
} from "@mc-skin-split/skin-core";
import {
  MAX_COMPLETION_RANKING_CANDIDATES,
  buildCompletionRankingPack,
  verifyCompletionRankingPackIntegrity,
} from "../src/index";

const temporaryDirectories: string[] = [];
const SOURCE_HASH = `sha256:${"1".repeat(64)}`;
const RESULT_HASH = `sha256:${"2".repeat(64)}`;
const hashCanonical: CompletionHashCanonical = (canonicalJson) =>
  `sha256:${createHash("sha256").update(canonicalJson).digest("hex")}`;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("Completion ranking pack", () => {
  it("writes deterministic bounded source/candidate previews and verifies integrity", async () => {
    const fixture = completionFixture();
    const firstRoot = await temporaryDirectory();
    const secondRoot = await temporaryDirectory();
    const common = {
      proposalSchema: {},
      jobId: "completion_ranking_job",
      completionProposal: fixture.proposal,
      source: fixture.source,
      provider: "codex-exec",
      model: "codex-config-default",
      reasoningEffort: "medium" as const,
    };
    const first = await buildCompletionRankingPack({
      ...common,
      workspaceDirectory: firstRoot,
    });
    const second = await buildCompletionRankingPack({
      ...common,
      workspaceDirectory: secondRoot,
    });

    expect(first.inputHash).toBe(second.inputHash);
    expect(first.fileHashes).toEqual(second.fileHashes);
    expect(first.imageAttachments).toHaveLength(
      fixture.proposal.candidates.length + 1,
    );
    expect(first.imageAttachments.length).toBeLessThanOrEqual(
      MAX_COMPLETION_RANKING_CANDIDATES + 1,
    );
    expect(first.imageAttachments[0]).toEqual({
      role: "source_skin",
      path: "input/previews/000-source.png",
      candidateId: null,
    });
    expect(first.imagePaths).toEqual(
      first.imageAttachments.map((attachment) => attachment.path),
    );

    const evidenceText = await readFile(
      resolve(firstRoot, first.paths.evidence),
      "utf8",
    );
    expect(evidenceText).toContain(fixture.proposal.proposalHash);
    expect(evidenceText).toContain(fixture.proposal.candidates[0]!.candidateHash);
    expect(evidenceText).not.toMatch(
      /"(?:assignments|spans|pixelIds|missingPixelIds|texture|writeMask|generatedMask|rgba)"/u,
    );

    const sourcePreview = decodePngRgba(
      await readFile(resolve(firstRoot, first.paths.sourcePreview)),
    );
    const firstCandidate = fixture.proposal.candidates[0]!;
    const candidatePreview = decodePngRgba(
      await readFile(resolve(firstRoot, first.imagePaths[1]!)),
    );
    expect(sourcePreview).toMatchObject({ width: 512, height: 512 });
    expect(candidatePreview).toMatchObject({ width: 512, height: 512 });
    const assignment = firstCandidate.assignments[0]!;
    const x = assignment.targetPixelId % 64;
    const y = Math.floor(assignment.targetPixelId / 64);
    expect(getPixel(candidatePreview, x * 8, y * 8)).toEqual(assignment.rgba);
    expect(getPixel(sourcePreview, x * 8, y * 8)).toEqual(
      getPixel(fixture.source.image, x, y),
    );

    await expect(
      verifyCompletionRankingPackIntegrity(first),
    ).resolves.toBeUndefined();
    await writeFile(
      resolve(firstRoot, first.imagePaths[1]!),
      "provider mutation",
      "utf8",
    );
    await expect(verifyCompletionRankingPackIntegrity(first)).rejects.toThrow(
      "Completion ranking input file changed during provider run",
    );
  });

  it("rejects a candidate whose host content hash was changed", async () => {
    const fixture = completionFixture();
    const firstCandidate = fixture.proposal.candidates[0]!;
    const corruptProposal = {
      ...fixture.proposal,
      candidates: [
        {
          ...firstCandidate,
          candidateHash: `sha256:${"f".repeat(64)}`,
        },
        ...fixture.proposal.candidates.slice(1),
      ],
    } as CompletionProposal;

    await expect(
      buildCompletionRankingPack({
        workspaceDirectory: await temporaryDirectory(),
        proposalSchema: {},
        jobId: "completion_ranking_corrupt",
        completionProposal: corruptProposal,
        source: fixture.source,
        provider: "codex-exec",
        model: "codex-config-default",
        reasoningEffort: "medium",
      }),
    ).rejects.toThrow(/hash|scoped id/iu);
  });
});

function completionFixture(): {
  readonly source: CompletionSourceSnapshot;
  readonly proposal: CompletionProposal;
} {
  const image = createRgbaImage(64, 64);
  const visibleTarget = texel("torso.base.front", 0, 2);
  const occluders = [
    texel("torso.outer.front", 1, 2),
    texel("torso.outer.front", 2, 2),
  ];
  setTexels(image, [visibleTarget], [31, 61, 91, 255]);
  setTexels(image, occluders, [8, 18, 28, 255]);
  let semanticState: SemanticState = createInitialSemanticState({
    revisionId: "rev_completion_ranking",
    armType: "slim",
    sourceHash: SOURCE_HASH,
    image,
  });
  semanticState = assignComponent(
    semanticState,
    image,
    "outfit.main",
    "upper_clothing",
    [visibleTarget],
  );
  semanticState = assignComponent(
    semanticState,
    image,
    "hair.long",
    "hair",
    occluders,
  );
  const source: CompletionSourceSnapshot = {
    sourceRevisionId: "rev_completion_ranking",
    sourceResultHash: RESULT_HASH,
    sourceSkinHash: SOURCE_HASH,
    image,
    semanticState,
    originDocument: createSourceVisiblePixelOriginDocument({
      subject: { kind: "revision", id: "rev_completion_ranking" },
      armType: "slim",
      image,
    }),
  };
  return {
    source,
    proposal: generateCompletionProposalCandidates({
      ...source,
      proposalId: "completionproposal_ranking",
      targetComponentId: "outfit.main",
      occludingComponentIds: ["hair.long"],
      representation: "auto",
      hashCanonical,
    }),
  };
}

function assignComponent(
  state: SemanticState,
  image: RgbaImage,
  instanceId: string,
  category: "upper_clothing" | "hair",
  texels: readonly SurfaceTexel[],
): SemanticState {
  return applyManualSemanticOperation(
    state,
    {
      type: "assign_pixels",
      target: { instanceId, displayName: instanceId, category },
      spans: pixelIdsToSpans(
        texels.map((item) => item.pixelId),
        getSkinLayout("slim"),
      ),
    },
    image,
  );
}

function texel(
  surface: SurfaceTexel["surface"],
  localU: number,
  localV: number,
): SurfaceTexel {
  const match = buildSurfaceTexels(
    createRgbaImage(64, 64),
    getSkinLayout("slim"),
  ).find(
    (item) =>
      item.surface === surface &&
      item.localU === localU &&
      item.localV === localV,
  );
  if (!match) throw new Error(`Missing fixture texel ${surface}:${localU},${localV}`);
  return match;
}

function setTexels(
  image: RgbaImage,
  texels: readonly SurfaceTexel[],
  rgba: Rgba,
): void {
  for (const item of texels) setPixel(image, item.atlasX, item.atlasY, rgba);
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), "mcskinsplit-completion-rank-"));
  temporaryDirectories.push(directory);
  return directory;
}
