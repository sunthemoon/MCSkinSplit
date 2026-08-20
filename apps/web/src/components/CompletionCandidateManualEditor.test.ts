import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type {
  ApiCompletionCandidate,
  ApiCompletionProposalDetail,
} from "../lib/revisionApi";
import { CompletionCandidateManualEditor } from "./CompletionCandidateManualEditor";

describe("CompletionCandidateManualEditor", () => {
  it("keeps expert identifiers hidden and exposes player pixel controls", () => {
    const detail = fixtureDetail();
    const html = renderToStaticMarkup(createElement(
      CompletionCandidateManualEditor,
      {
        armType: "slim",
        detail,
        candidate: detail.candidates[0]!,
        onEdited: vi.fn(),
      },
    ));

    expect(html).toContain("候选不太对？微调");
    expect(html).toContain("只改点到的像素");
    expect(html).toContain("未触碰像素继续保留系统候选");
    expect(html).toContain('aria-label="64×64 候选微调画布');
    expect(html).toContain("0 / 256");
    expect(html).toContain("撤销");
    expect(html).toContain("重做");
    expect(html).not.toContain("PIXEL ID");
    expect(html).not.toContain("proposal-hash");
  });
});

function fixtureDetail(): ApiCompletionProposalDetail {
  const candidate: ApiCompletionCandidate = {
    id: "candidate_1",
    proposalId: "proposal_1",
    representation: "skin_texel",
    strategy: "same_surface_continuation",
    baseCandidateId: null,
    confidence: "medium",
    originMode: "generated_completion",
    pixelCount: 1,
    generatedPixelCount: 1,
    candidateHash: "candidate-hash",
    evidenceHash: "evidence-hash",
    document: stored("application/json"),
    texture: stored("image/png"),
    writeMask: stored("image/png"),
    generatedMask: stored("image/png"),
    reviewRequired: true,
    automaticAcceptanceAllowed: false,
    createdAt: "2026-08-19T00:00:00.000Z",
  };
  return {
    proposal: {
      id: "proposal_1",
      jobId: "job_1",
      projectId: "project_1",
      sourceRevisionId: "revision_1",
      sourceResultHash: "source-result-hash",
      sourceSkinHash: "source-skin-hash",
      targetComponentId: "shirt.main",
      occludingComponentIds: ["hair.main"],
      representation: "skin_texel",
      allowedSpans: [],
      allowedGeneratedPixelCount: 1,
      evidence: {},
      evidenceHash: "evidence-hash",
      proposalHash: "proposal-hash",
      document: stored("application/json"),
      allowedMask: stored("image/png"),
      createdAt: "2026-08-19T00:00:00.000Z",
    },
    jobStatus: "succeeded",
    visible: true,
    status: "awaiting_decision",
    candidateCount: 1,
    candidates: [candidate],
    ranking: null,
    decision: null,
    result: null,
  };
}

function stored(mimeType: "application/json" | "image/png") {
  return { storagePath: "asset", mimeType, byteSize: 1, sha256: "hash" } as const;
}
