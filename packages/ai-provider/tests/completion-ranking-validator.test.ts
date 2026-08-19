import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { CompletionRankingPack } from "@mc-skin-split/skin-analysis-pack";
import type { CompletionProposal } from "@mc-skin-split/skin-core";
import { afterEach, describe, expect, it } from "vitest";
import { validateCompletionRankingProposal } from "../src/index";
import {
  createCompletionRankingPackFixture,
  validCompletionRankingProposal,
} from "./completion-ranking-fixture";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("Completion ranking validator", () => {
  it("accepts a hash-bound exact candidate permutation and explicit recommendation", async () => {
    const pack = await packFixture();
    const result = validateCompletionRankingProposal({
      proposal: validCompletionRankingProposal(pack),
      pack,
    });

    expect(result.report).toMatchObject({
      valid: true,
      validatorVersion: "completion-ranking-validator-v1",
      stats: {
        candidateCount: pack.completionProposal.candidates.length,
        rankingCount: pack.completionProposal.candidates.length,
        recommendationCount: 1,
        deferred: false,
      },
    });
  });

  it("accepts defer only with a null recommendation and keeps the full ranking", async () => {
    const pack = await packFixture();
    const proposal = validCompletionRankingProposal(pack);
    const result = validateCompletionRankingProposal({
      proposal: {
        ...proposal,
        recommendation: {
          status: "defer",
          candidateId: null,
          confidence: 0.8,
          explanation: "The previews do not establish a reliable visual preference.",
        },
      },
      pack,
    });

    expect(result.report).toMatchObject({
      valid: true,
      stats: { recommendationCount: 0, deferred: true },
    });
  });

  it("rejects defer with a candidate and schema-bounds confidence and explanations", async () => {
    const pack = await packFixture();
    const proposal = validCompletionRankingProposal(pack);
    const inconsistent = validateCompletionRankingProposal({
      proposal: {
        ...proposal,
        recommendation: {
          status: "defer",
          candidateId: proposal.rankings[0]!.candidateId,
          confidence: 0.8,
          explanation: "The visual evidence remains ambiguous.",
        },
      },
      pack,
    });
    expect(inconsistent.report.errors.map((error) => error.code)).toContain(
      "DEFER_CANDIDATE_NOT_NULL",
    );

    const outOfBounds = validateCompletionRankingProposal({
      proposal: {
        ...proposal,
        rankings: proposal.rankings.map((ranking, index) => index === 0
          ? { ...ranking, confidence: 1.01, explanation: "x".repeat(241) }
          : ranking),
      },
      pack,
    });
    expect(outOfBounds.report.valid).toBe(false);
    expect(outOfBounds.report.errors.map((error) => error.code)).toContain(
      "SCHEMA_INVALID",
    );
  });

  it("rejects duplicate, missing, unknown, and non-first candidate references", async () => {
    const pack = await packFixture();
    const proposal = validCompletionRankingProposal(pack);
    const first = proposal.rankings[0]!;
    const second = proposal.rankings[1] ?? first;
    const invalid = {
      ...proposal,
      rankings: [
        first,
        { ...second, candidateId: first.candidateId },
        {
          candidateId: `completioncandidate_${"f".repeat(64)}`,
          confidence: 0.1,
          explanation: "The preview has weak visual continuity.",
        },
      ],
      recommendation: {
        ...proposal.recommendation,
        candidateId: second.candidateId,
      },
    };
    const result = validateCompletionRankingProposal({ proposal: invalid, pack });
    const codes = result.report.errors.map((error) => error.code);

    expect(result.report.valid).toBe(false);
    expect(codes).toEqual(expect.arrayContaining([
      "DUPLICATE_CANDIDATE_ID",
      "UNKNOWN_CANDIDATE_ID",
      "RANKING_NOT_EXACT_PERMUTATION",
      "RECOMMENDATION_NOT_FIRST",
    ]));
  });

  it("rejects stale job/proposal/source identities and private Completion output", async () => {
    const pack = await packFixture();
    const proposal = validCompletionRankingProposal(pack);
    const result = validateCompletionRankingProposal({
      proposal: {
        ...proposal,
        jobId: "stale_completion_job",
        proposalHash: `sha256:${"a".repeat(64)}`,
        sourceResultHash: `sha256:${"b".repeat(64)}`,
        rankings: proposal.rankings.map((ranking, index) => index === 0
          ? {
              ...ranking,
              explanation: "Use pixel 42 from the latent_component representation.",
            }
          : ranking),
        recommendation: {
          ...proposal.recommendation,
          candidateHash: `sha256:${"c".repeat(64)}`,
        },
      },
      pack,
    });
    const codes = result.report.errors.map((error) => error.code);

    expect(result.report.valid).toBe(false);
    expect(codes).toContain("SCHEMA_INVALID");
    // Schema rejection happens before typed identity/output checks.
    expect(result.proposal).toBeNull();
  });

  it("rejects stale job, proposal, and source identity echoes", async () => {
    const pack = await packFixture();
    const proposal = validCompletionRankingProposal(pack);
    const result = validateCompletionRankingProposal({
      proposal: {
        ...proposal,
        jobId: "stale_completion_job",
        proposalId: "completionproposal_stale",
        proposalHash: `sha256:${"a".repeat(64)}`,
        sourceRevisionId: "rev_stale",
        sourceResultHash: `sha256:${"b".repeat(64)}`,
        sourceSkinHash: `sha256:${"c".repeat(64)}`,
      },
      pack,
    });

    expect(result.report.errors.map((error) => error.code)).toEqual(
      expect.arrayContaining([
        "JOB_ID_MISMATCH",
        "PROPOSAL_ID_MISMATCH",
        "PROPOSAL_HASH_MISMATCH",
        "SOURCE_REVISION_MISMATCH",
        "SOURCE_RESULT_HASH_MISMATCH",
        "SOURCE_SKIN_HASH_MISMATCH",
      ]),
    );
  });

  it("rejects forbidden evidence text even when the schema is otherwise valid", async () => {
    const pack = await packFixture();
    const proposal = validCompletionRankingProposal(pack);
    const result = validateCompletionRankingProposal({
      proposal: {
        ...proposal,
        rankings: proposal.rankings.map((ranking, index) => index === 0
          ? { ...ranking, explanation: "Copy pixel 42 into the mask." }
          : ranking),
      },
      pack,
    });

    expect(result.report.valid).toBe(false);
    expect(result.report.errors.map((error) => error.code)).toContain(
      "FORBIDDEN_COMPLETION_OUTPUT",
    );
  });

  it("rejects a pack whose Host candidate hash no longer verifies", async () => {
    const pack = await packFixture();
    const first = pack.completionProposal.candidates[0]!;
    const corruptedProposal = {
      ...pack.completionProposal,
      candidates: [
        { ...first, candidateHash: `sha256:${"f".repeat(64)}` },
        ...pack.completionProposal.candidates.slice(1),
      ],
    } as CompletionProposal;
    const corruptedPack = {
      ...pack,
      completionProposal: corruptedProposal,
    } as CompletionRankingPack;
    const result = validateCompletionRankingProposal({
      proposal: validCompletionRankingProposal(pack),
      pack: corruptedPack,
    });

    expect(result.report.valid).toBe(false);
    expect(result.report.errors.map((error) => error.code)).toEqual(
      expect.arrayContaining([
        "PACK_PROPOSAL_HASH_INVALID",
        "PACK_CANDIDATE_EVIDENCE_MISMATCH",
      ]),
    );
  });
});

async function packFixture(): Promise<CompletionRankingPack> {
  const directory = await mkdtemp(resolve(tmpdir(), "mcskinsplit-rank-validator-"));
  temporaryDirectories.push(directory);
  return await createCompletionRankingPackFixture(directory);
}
