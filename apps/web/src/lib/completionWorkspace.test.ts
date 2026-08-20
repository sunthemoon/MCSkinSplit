import type { SemanticComponent } from "@mc-skin-split/skin-core";
import { describe, expect, it } from "vitest";
import type {
  ApiAiJob,
  ApiAnalyzedSkin,
  ApiCompletionCandidate,
  ApiCompletionProposalDetail,
  ApiCompletionProposalSummary,
} from "./revisionApi";
import {
  completionOccludingComponents,
  completionResultAppliesToRevision,
  completionTargetComponents,
  completionWorkspaceStep,
  findCompletionCatalogContext,
  hydrateSucceededCompletionJob,
  isCompletionWorkspaceEnabled,
  orderedCompletionCandidates,
  selectCompletionHydrationState,
} from "./completionWorkspace";

describe("completion workspace model", () => {
  it("enables the experiment only for the exact true flag", () => {
    expect(isCompletionWorkspaceEnabled("true")).toBe(true);
    expect(isCompletionWorkspaceEnabled(undefined)).toBe(false);
    expect(isCompletionWorkspaceEnabled("false")).toBe(false);
    expect(isCompletionWorkspaceEnabled("TRUE")).toBe(false);
    expect(isCompletionWorkspaceEnabled(true)).toBe(false);
  });

  it("offers visible hair and clothing targets with bounded occluders", () => {
    const shirt = component("shirt.main", "上衣", "upper_clothing");
    const hair = component("hair.main", "长发", "hair");
    const accessory = component("hat.main", "帽子", "head_accessory");
    const skin = component("skin.main", "皮肤", "skin");
    const emptyHair = component("hair.empty", "空头发", "hair", []);
    const components = [shirt, hair, accessory, skin, emptyHair];

    expect(completionTargetComponents(components).map((item) => item.instanceId))
      .toEqual(["shirt.main", "hair.main"]);
    expect(completionOccludingComponents(components, shirt.instanceId)
      .map((item) => item.instanceId)).toEqual(["hair.main", "hat.main"]);
    expect(completionOccludingComponents(components, hair.instanceId)
      .map((item) => item.instanceId)).toEqual(["hat.main"]);
  });

  it("derives the simple four-step state without skipping explicit review", () => {
    expect(completionWorkspaceStep({ jobStatus: null, detail: null })).toBe(1);
    expect(completionWorkspaceStep({ jobStatus: "running", detail: null })).toBe(2);
    expect(completionWorkspaceStep({
      jobStatus: "succeeded",
      detail: detail({ decision: null }),
    })).toBe(3);
    expect(completionWorkspaceStep({
      jobStatus: "succeeded",
      detail: detail({ decision: { action: "reject" } }),
    })).toBe(4);
  });

  it("uses advisory ranking order while retaining every host candidate", () => {
    const first = candidate("candidate_a");
    const second = candidate("candidate_b");
    const third = candidate("candidate_c");
    const proposal = detail({
      candidates: [first, second, third],
      ranking: {
        orderedCandidateIds: [second.id, "missing", first.id],
      },
    });

    expect(orderedCompletionCandidates(proposal).map((item) => item.id))
      .toEqual(["candidate_b", "candidate_a", "candidate_c"]);
  });

  it("binds hydration to the exact latest job instead of an older proposal", () => {
    const oldJob = job("job_old", "succeeded", "2026-08-19T09:00:00.000Z");
    const latestFailed = job("job_failed", "failed", "2026-08-19T10:00:00.000Z");
    const oldProposal = proposal("proposal_old", oldJob.id, true);

    expect(selectCompletionHydrationState(
      [oldJob, latestFailed],
      [oldProposal],
    )).toEqual({ job: latestFailed, proposal: null });
  });

  it("never hydrates a cancelled job's hidden proposal", () => {
    const cancelled = job("job_cancelled", "cancelled", "2026-08-19T11:00:00.000Z");
    const hidden = proposal("proposal_hidden", cancelled.id, false);

    expect(selectCompletionHydrationState([cancelled], [hidden]))
      .toEqual({ job: cancelled, proposal: null });
  });

  it("loads only the newest visible proposal associated with the latest job", () => {
    const latest = job("job_latest", "succeeded", "2026-08-19T12:00:00.000Z");
    const older = proposal("proposal_1", latest.id, true, "2026-08-19T12:01:00.000Z");
    const newer = proposal("proposal_2", latest.id, true, "2026-08-19T12:02:00.000Z");
    const unrelated = proposal("proposal_3", "job_other", true, "2026-08-19T12:03:00.000Z");

    expect(selectCompletionHydrationState([latest], [older, newer, unrelated]))
      .toEqual({ job: latest, proposal: newer });
  });

  it("finishes delayed proposal-detail hydration after a job reaches terminal success", async () => {
    let releaseDetail!: (value: ApiCompletionProposalDetail) => void;
    const delayedDetail = new Promise<ApiCompletionProposalDetail>((resolve) => {
      releaseDetail = resolve;
    });
    const summary = proposal(
      "proposal_terminal",
      "job_terminal",
      true,
      "2026-08-19T12:10:00.000Z",
    );
    const hydration = hydrateSucceededCompletionJob(
      "job_terminal",
      async () => [summary],
      async () => delayedDetail,
    );
    const baseExpected = detail({
      candidates: [candidate("candidate_1"), candidate("candidate_2")],
    });
    const expected = {
      ...baseExpected,
      proposal: {
        ...baseExpected.proposal,
        id: "proposal_terminal",
        jobId: "job_terminal",
      },
    };

    releaseDetail(expected);

    await expect(hydration).resolves.toMatchObject({ candidateCount: 2 });
    await expect(hydration).resolves.toHaveProperty("candidates", expected.candidates);
  });

  it("keeps original and repaired analyzed revisions as explicit choices", () => {
    const item = analyzedSkin();
    const repairedId = item.semanticFollowup!.appliedVariant!.revision.id;
    const context = findCompletionCatalogContext([item], repairedId);

    expect(context?.sourceKind).toBe("repaired");
    expect(context?.choices).toEqual([
      expect.objectContaining({ kind: "original", selected: false }),
      expect.objectContaining({ kind: "repaired", selected: true }),
    ]);
    expect(findCompletionCatalogContext([item], "unrelated")).toBeNull();
  });

  it("shows a completion result only on its source variants or accepted skin Revision", () => {
    const context = findCompletionCatalogContext(
      [analyzedSkin()],
      "revision_original",
    )!;
    const acceptedRevision = {
      ...detail({ decision: { action: "accept" } }),
      result: {
        representation: "skin_texel",
        revision: { id: "revision_completed" },
      },
    } as ApiCompletionProposalDetail;

    expect(completionResultAppliesToRevision(
      acceptedRevision,
      context,
      "revision_original",
    )).toBe(true);
    expect(completionResultAppliesToRevision(
      acceptedRevision,
      context,
      "revision_repaired",
    )).toBe(true);
    expect(completionResultAppliesToRevision(
      acceptedRevision,
      context,
      "revision_completed",
    )).toBe(true);
    expect(completionResultAppliesToRevision(
      acceptedRevision,
      context,
      "revision_unrelated",
    )).toBe(false);

    const latent = {
      ...acceptedRevision,
      result: {
        representation: "latent_component",
        revision: null,
      },
    } as ApiCompletionProposalDetail;
    expect(completionResultAppliesToRevision(
      latent,
      context,
      "revision_unrelated",
    )).toBe(false);
  });
});

function component(
  instanceId: string,
  displayName: string,
  category: SemanticComponent["category"],
  spans: SemanticComponent["spans"] = [
    { surface: "torso.base.front", y: 20, x0: 20, x1: 22 },
  ],
): SemanticComponent {
  return {
    instanceId,
    displayName,
    category,
    confidence: 1,
    reviewState: "confirmed",
    maskFile: `${instanceId}.png`,
    spans,
    palette: { dominant: "#ffffff", colors: ["#ffffff"] },
    relations: {
      attachedTo: null,
      pairedWith: [],
      sameOutfitGroup: null,
      conflictsWith: [],
    },
    provenance: { actorType: "ai", containsGeneratedPixels: false },
  };
}

function job(
  id: string,
  status: ApiAiJob["status"],
  createdAt: string,
): ApiAiJob {
  return {
    id,
    kind: "completion_proposal",
    projectId: "project_1",
    inputRevisionId: "revision_1",
    resultRevisionId: null,
    compositionId: null,
    retryOfJobId: null,
    status,
    provider: "host",
    model: "deterministic",
    skillName: "completion",
    skillVersion: "1",
    promptVersion: "1",
    inputHash: null,
    outputHash: null,
    options: {
      mode: "completion_proposal",
      provider: "host",
      model: "deterministic",
      targetComponentId: "shirt.main",
      occludingComponentIds: ["hair.main"],
      representation: "auto",
      rankingMode: "host_only",
    },
    reviewItems: [],
    proposalSummary: null,
    advisoryResult: null,
    cancelRequested: status === "cancelled",
    createdAt,
    startedAt: null,
    finishedAt: null,
    error: status === "failed" ? { code: "FAILED", message: "failed" } : null,
  };
}

function proposal(
  id: string,
  jobId: string,
  visible: boolean,
  createdAt = "2026-08-19T09:01:00.000Z",
): ApiCompletionProposalSummary {
  return {
    proposal: {
      id,
      jobId,
      projectId: "project_1",
      sourceRevisionId: "revision_1",
      sourceResultHash: "source-hash",
      sourceSkinHash: "skin-hash",
      targetComponentId: "shirt.main",
      occludingComponentIds: ["hair.main"],
      representation: "skin_texel",
      allowedSpans: [],
      allowedGeneratedPixelCount: 0,
      evidence: {},
      evidenceHash: "evidence-hash",
      proposalHash: "proposal-hash",
      document: storedFile("application/json"),
      allowedMask: storedFile("image/png"),
      createdAt,
    },
    jobStatus: "succeeded",
    visible,
    status: "awaiting_decision",
    candidateCount: 0,
    ranking: null,
    decision: null,
    result: null,
  };
}

function candidate(id: string): ApiCompletionCandidate {
  return {
    id,
    proposalId: "proposal_1",
    representation: "skin_texel",
    strategy: "same_surface_continuation",
    confidence: "medium",
    originMode: "generated_completion",
    pixelCount: 2,
    generatedPixelCount: 2,
    candidateHash: `${id}-hash`,
    evidenceHash: "evidence-hash",
    document: storedFile("application/json"),
    texture: storedFile("image/png"),
    writeMask: storedFile("image/png"),
    generatedMask: storedFile("image/png"),
    reviewRequired: true,
    automaticAcceptanceAllowed: false,
    createdAt: "2026-08-19T09:02:00.000Z",
  };
}

function detail(overrides: {
  readonly candidates?: readonly ApiCompletionCandidate[];
  readonly ranking?: { readonly orderedCandidateIds: readonly string[] } | null;
  readonly decision?: { readonly action: "accept" | "reject" } | null;
} = {}): ApiCompletionProposalDetail {
  const candidates = overrides.candidates ?? [];
  return {
    ...proposal("proposal_1", "job_1", true),
    candidateCount: candidates.length,
    candidates,
    ranking: overrides.ranking
      ? ({ orderedCandidateIds: overrides.ranking.orderedCandidateIds } as ApiCompletionProposalDetail["ranking"])
      : null,
    decision: overrides.decision
      ? ({ action: overrides.decision.action } as ApiCompletionProposalDetail["decision"])
      : null,
  };
}

function analyzedSkin(): ApiAnalyzedSkin {
  return {
    project: { id: "project_1", name: "Red skin" },
    revision: {
      id: "revision_original",
      branchId: "branch_main",
      branchName: "main",
      sequence: 2,
      createdAt: "2026-08-19T08:00:00.000Z",
    },
    aiJob: {
      id: "job_analysis",
      provider: "host",
      model: "deterministic",
      finishedAt: "2026-08-19T08:01:00.000Z",
    },
    armType: "slim",
    componentCount: 2,
    unknownPixelCount: 0,
    reviewItemCount: 0,
    catalogStatus: "active",
    archivedAt: null,
    archivedReason: null,
    groups: [],
    skinUrl: "/api/revisions/revision_original/skin.png",
    semanticFollowup: {
      jobId: "job_analysis",
      status: "applied",
      evidenceHash: "followup-hash",
      suggestionCount: 1,
      suggestedPixelCount: 2,
      notices: [],
      appliedVariant: {
        revision: {
          id: "revision_repaired",
          branchId: "branch_main",
          branchName: "main",
          sequence: 3,
          createdAt: "2026-08-19T08:02:00.000Z",
        },
        groups: [],
        skinUrl: "/api/revisions/revision_repaired/skin.png",
        label: "分类修复版",
      },
    },
  };
}

function storedFile(
  mimeType: "application/json" | "image/png",
) {
  return {
    storagePath: "asset",
    mimeType,
    byteSize: 1,
    sha256: "asset-hash",
  } as const;
}
