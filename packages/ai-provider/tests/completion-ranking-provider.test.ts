import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CODEX_CONFIG_DEFAULT_MODEL,
  CodexExecProvider,
  type CommandExecutionInput,
} from "../src/index";
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

describe("CodexExecProvider Completion ranking", () => {
  it("runs one read-only tool-free pass with ordered bounded previews", async () => {
    const root = await temporaryDirectory();
    const pack = await createCompletionRankingPackFixture(root);
    const proposal = validCompletionRankingProposal(pack);
    let commandInput: CommandExecutionInput | undefined;
    let executionCount = 0;
    const provider = new CodexExecProvider({
      command: "codex-test",
      execute: async (input) => {
        executionCount += 1;
        commandInput = input;
        const outputIndex = input.args.indexOf("--output-last-message");
        await writeFile(
          input.args[outputIndex + 1]!,
          JSON.stringify(proposal),
          "utf8",
        );
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            type: "turn.completed",
            usage: { input_tokens: 20, output_tokens: 10 },
          }),
          stderr: "",
        };
      },
    });

    const result = await provider.rankCompletion({
      jobId: pack.job.jobId,
      attempt: 1,
      model: CODEX_CONFIG_DEFAULT_MODEL,
      reasoningEffort: "medium",
      pack,
    });

    expect(executionCount).toBe(1);
    expect(result.proposal).toEqual(proposal);
    expect(commandInput?.args).toEqual(expect.arrayContaining([
      "--sandbox",
      "read-only",
      "--ignore-user-config",
      "--disable",
      "shell_tool",
      "--disable",
      "multi_agent",
      "--output-last-message",
      resolve(root, pack.paths.proposal),
    ]));
    expect(commandInput?.args).not.toContain("--output-schema");
    expect(imageArguments(commandInput?.args ?? [])).toEqual(
      pack.imagePaths.map((path) => resolve(root, path)),
    );
    expect(commandInput?.stdin).toContain("Do not call or request any tool");
    expect(commandInput?.stdin).toContain("status \"defer\" and candidateId null");
    expect(commandInput?.stdin).toContain("<completion_candidate_evidence>");
    expect(commandInput?.stdin).toContain("<attachment_manifest>");
    for (const candidate of pack.completionProposal.candidates) {
      expect(commandInput?.stdin).toContain(candidate.candidateId);
      expect(commandInput?.stdin).not.toContain(candidate.candidateHash);
      expect(commandInput?.stdin).not.toContain(candidate.evidenceHash);
    }
    expect(commandInput?.stdin).not.toContain('"pixelCount"');
    expect(commandInput?.stdin).not.toContain('"candidateHash"');
  });

  it("keeps native output schema opt-in", async () => {
    const root = await temporaryDirectory();
    const pack = await createCompletionRankingPackFixture(root);
    const proposal = validCompletionRankingProposal(pack);
    let commandInput: CommandExecutionInput | undefined;
    const provider = new CodexExecProvider({
      command: "codex-test",
      useOutputSchema: true,
      allowSchemaFallback: false,
      execute: async (input) => {
        commandInput = input;
        const outputIndex = input.args.indexOf("--output-last-message");
        await writeFile(input.args[outputIndex + 1]!, JSON.stringify(proposal), "utf8");
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    await provider.rankCompletion({
      jobId: pack.job.jobId,
      attempt: 1,
      model: CODEX_CONFIG_DEFAULT_MODEL,
      reasoningEffort: "medium",
      pack,
    });

    const schemaIndex = commandInput?.args.indexOf("--output-schema") ?? -1;
    expect(schemaIndex).toBeGreaterThan(-1);
    expect(commandInput?.args[schemaIndex + 1]).toBe(
      resolve(root, pack.paths.outputSchema),
    );
  });

  it("rejects relabelled candidate previews before execution", async () => {
    const root = await temporaryDirectory();
    const pack = await createCompletionRankingPackFixture(root);
    let executionCount = 0;
    const provider = new CodexExecProvider({
      command: "codex-test",
      execute: async () => {
        executionCount += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    const corrupted = {
      ...pack,
      imageAttachments: pack.imageAttachments.map((attachment, index) =>
        index === 1 ? { ...attachment, candidateId: null } : attachment),
    };

    await expect(provider.rankCompletion({
      jobId: pack.job.jobId,
      attempt: 1,
      model: CODEX_CONFIG_DEFAULT_MODEL,
      reasoningEffort: "medium",
      pack: corrupted,
    })).rejects.toMatchObject({
      code: "COMPLETION_RANKING_ATTACHMENT_MISMATCH",
    });
    expect(executionCount).toBe(0);
  });
});

function imageArguments(args: readonly string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--image") result.push(args[index + 1]!);
  }
  return result;
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), "mcskinsplit-rank-provider-"));
  temporaryDirectories.push(directory);
  return directory;
}
