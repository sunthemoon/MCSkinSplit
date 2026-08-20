import { resolve } from "node:path";
import type {
  AnalysisProposal,
  ProviderAnalysisInput,
  ProviderAnalysisResult,
  SkinSemanticAiProvider,
} from "../../../packages/ai-provider/src/index";
import { buildApi } from "../../../apps/api/src/app";

class ReplaySemanticProvider implements SkinSemanticAiProvider {
  readonly providerName = "e2e-replay";

  async analyze(input: ProviderAnalysisInput): Promise<ProviderAnalysisResult> {
    input.onProgress?.({
      kind: "session",
      status: "started",
      message: "Deterministic replay session started",
    });
    input.onProgress?.({
      kind: "output",
      status: "completed",
      message: "Deterministic replay proposal prepared",
    });
    return {
      proposal: createReplayProposal(input),
      rawEvents:
        `${JSON.stringify({ type: "thread.started", thread_id: "e2e-replay-thread" })}\n` +
        `${JSON.stringify({ type: "turn.completed" })}\n`,
      stderr: "",
      threadId: "e2e-replay-thread",
      usage: { input_tokens: 8, output_tokens: 4 },
    };
  }
}

function createReplayProposal(input: ProviderAnalysisInput): AnalysisProposal {
  const regions = input.pack.candidateRegions.regions;
  const regionById = new Map(regions.map((region) => [region.id, region]));
  const [targetRegion, occludingRegion] = input.pack.job.model ===
    "deterministic-zero-candidates"
    ? selectSeparatedRegions(input, regionById)
    : selectContactingRegions(input, regionById);
  const assignedRegionIds = new Set([targetRegion.id, occludingRegion.id]);
  return {
    schemaVersion: "1.2",
    sourceRevisionId: input.pack.job.sourceRevisionId,
    modelAssessment: {
      armType: input.pack.job.armType,
      confidence: 0.9,
    },
    appearanceInventory: {
      observations: [],
      summary: "Deterministic browser replay fixture.",
    },
    components: [
      {
        instanceId: "clothing.e2e_completion",
        displayName: "E2E 待补全衣服",
        category: "upper_clothing",
        subtype: null,
        confidence: 0.8,
        candidateRegionIds: [targetRegion.id],
        pixelOverrides: { add: [], remove: [] },
        relations: {
          attachedTo: null,
          pairedWith: [],
          sameOutfitGroup: null,
        },
        notes: "",
      },
      {
        instanceId: "hair.e2e_occluder",
        displayName: "E2E 遮挡头发",
        category: "hair",
        subtype: null,
        confidence: 0.8,
        candidateRegionIds: [occludingRegion.id],
        pixelOverrides: { add: [], remove: [] },
        relations: {
          attachedTo: null,
          pairedWith: [],
          sameOutfitGroup: null,
        },
        notes: "",
      },
    ],
    unassignedCandidateRegionIds: regions
      .filter((region) => !assignedRegionIds.has(region.id))
      .map((region) => region.id),
    reviewItems: [],
    summary: "Deterministic replay result",
  };
}

type ReplayRegion =
  ProviderAnalysisInput["pack"]["candidateRegions"]["regions"][number];

function selectContactingRegions(
  input: ProviderAnalysisInput,
  regionById: ReadonlyMap<string, ReplayRegion>,
): readonly [ReplayRegion, ReplayRegion] {
  const contact = input.pack.candidateEvidenceGraph.edges.find(
    (edge) =>
      edge.kind === "same_surface_contact" &&
      edge.regionIds.every((regionId) => regionById.has(regionId)),
  );
  const ordered = contact?.regionIds
    .map((regionId) => regionById.get(regionId)!)
    .sort(
      (left, right) =>
        right.pixelCount - left.pixelCount || left.id.localeCompare(right.id),
    );
  const targetRegion = ordered?.[0];
  const occludingRegion = ordered?.[1];
  if (!targetRegion || !occludingRegion) {
    throw new Error(
      "Replay provider requires two contacting candidate regions on one surface",
    );
  }
  return [targetRegion, occludingRegion];
}

function selectSeparatedRegions(
  input: ProviderAnalysisInput,
  regionById: ReadonlyMap<string, ReplayRegion>,
): readonly [ReplayRegion, ReplayRegion] {
  const nodes = input.pack.candidateEvidenceGraph.nodes
    .filter((node) => regionById.has(node.id))
    .sort(
      (left, right) =>
        right.pixelCount - left.pixelCount || left.id.localeCompare(right.id),
    );
  for (const targetNode of nodes) {
    const occludingNode = nodes.find(
      (candidate) => candidate.bodyPart !== targetNode.bodyPart,
    );
    const targetRegion = regionById.get(targetNode.id);
    const occludingRegion = occludingNode
      ? regionById.get(occludingNode.id)
      : undefined;
    if (targetRegion && occludingRegion) {
      return [targetRegion, occludingRegion];
    }
  }
  throw new Error(
    "Replay provider requires candidate regions on two different body parts",
  );
}

const port = readPort(process.env.MC_SKIN_API_PORT);
const host = process.env.MC_SKIN_API_HOST?.trim() || "127.0.0.1";
const dataDirectory = resolve(requireValue("MC_SKIN_DATA_DIR"));
const app = buildApi({
  aiProviders: [new ReplaySemanticProvider()],
  dataDirectory,
  logger: true,
});

try {
  await app.listen({ host, port });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}

function requireValue(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function readPort(value: string | undefined): number {
  const portNumber = Number(value);
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65_535) {
    throw new Error(`MC_SKIN_API_PORT is invalid: ${value ?? "missing"}`);
  }
  return portNumber;
}
