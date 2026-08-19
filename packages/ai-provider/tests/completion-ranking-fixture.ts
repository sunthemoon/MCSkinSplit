import { createHash } from "node:crypto";
import {
  COMPLETION_RANKING_SCHEMA,
  type CompletionRankingProposal,
} from "../src/index";
import {
  buildCompletionRankingPack,
  type CompletionRankingPack,
} from "@mc-skin-split/skin-analysis-pack";
import {
  applyManualSemanticOperation,
  buildSurfaceTexels,
  createInitialSemanticState,
  createRgbaImage,
  createSourceVisiblePixelOriginDocument,
  generateCompletionProposalCandidates,
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

const SOURCE_HASH = `sha256:${"1".repeat(64)}`;
const RESULT_HASH = `sha256:${"2".repeat(64)}`;
const hashCanonical: CompletionHashCanonical = (canonicalJson) =>
  `sha256:${createHash("sha256").update(canonicalJson).digest("hex")}`;

export async function createCompletionRankingPackFixture(
  workspaceDirectory: string,
): Promise<CompletionRankingPack> {
  const { source, proposal } = completionFixture();
  return await buildCompletionRankingPack({
    workspaceDirectory,
    proposalSchema: COMPLETION_RANKING_SCHEMA,
    jobId: "completion_ranking_job",
    completionProposal: proposal,
    source,
    provider: "codex-exec",
    model: "codex-config-default",
    reasoningEffort: "medium",
  });
}

export function validCompletionRankingProposal(
  pack: CompletionRankingPack,
): CompletionRankingProposal {
  const rankings = pack.completionProposal.candidates.map((candidate, index) => ({
    candidateId: candidate.candidateId,
    confidence: Math.max(0, 0.9 - index * 0.1),
    explanation: `Visual continuity evidence rank ${index + 1}.`,
  }));
  return {
    schemaVersion: "1.0",
    jobId: pack.job.jobId,
    proposalId: pack.evidence.proposalId,
    proposalHash: pack.evidence.proposalHash,
    sourceRevisionId: pack.evidence.sourceRevisionId,
    sourceResultHash: pack.evidence.sourceResultHash,
    sourceSkinHash: pack.evidence.sourceSkinHash,
    rankings,
    recommendation: rankings[0]
      ? {
          status: "recommend",
          candidateId: rankings[0].candidateId,
          confidence: rankings[0].confidence,
          explanation: "The first preview best matches the visible source pattern.",
        }
      : {
          status: "defer",
          candidateId: null,
          confidence: 1,
          explanation: "No Host candidate is available for ranking.",
        },
  };
}

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
