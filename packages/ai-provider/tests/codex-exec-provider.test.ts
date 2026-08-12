import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { AnalysisPack } from "@mc-skin-split/skin-analysis-pack";
import { afterEach, describe, expect, it } from "vitest";
import {
  CODEX_CONFIG_DEFAULT_MODEL,
  CodexExecProvider,
  projectCodexProgressEvent,
  resolveCommandInvocation,
  type CommandExecutionInput,
} from "../src/codex-exec-provider";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("CodexExecProvider", () => {
  it("uses an isolated structured-output invocation and parses diagnostics", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "mcskinsplit-codex-"));
    temporaryDirectories.push(root);
    await Promise.all([
      mkdir(resolve(root, "output"), { recursive: true }),
      mkdir(resolve(root, "schema"), { recursive: true }),
    ]);
    let commandInput: CommandExecutionInput | undefined;
    const proposal = { schemaVersion: "1.0", marker: "fixture" };
    const provider = new CodexExecProvider({
      command: "codex-test",
      defaultModel: CODEX_CONFIG_DEFAULT_MODEL,
      execute: async (input) => {
        commandInput = input;
        const outputIndex = input.args.indexOf("--output-last-message");
        await writeFile(
          input.args[outputIndex + 1]!,
          JSON.stringify(proposal),
          "utf8",
        );
        return {
          exitCode: 0,
          stdout: [
            JSON.stringify({ type: "thread.started", thread_id: "thread_1" }),
            JSON.stringify({ type: "turn.completed", usage: { input_tokens: 12 } }),
          ].join("\n"),
          stderr: "",
        };
      },
    });
    const result = await provider.analyze({
      jobId: "job_1",
      runId: "run_1",
      attempt: 1,
      model: CODEX_CONFIG_DEFAULT_MODEL,
      pack: minimalPack(root),
    });

    expect(result.proposal).toEqual(proposal);
    expect(result.threadId).toBe("thread_1");
    expect(result.usage).toEqual({ input_tokens: 12 });
    expect(commandInput?.command).toBe("codex-test");
    expect(commandInput?.args).toEqual(
      expect.arrayContaining([
        "exec",
        "--sandbox",
        "workspace-write",
        "--ephemeral",
        "--ignore-rules",
        "--skip-git-repo-check",
        "--json",
        "--output-schema",
      ]),
    );
    expect(commandInput?.args).not.toContain("--model");
    expect(commandInput?.args).toEqual(
      expect.arrayContaining([
        "--config",
        'model_reasoning_effort="medium"',
      ]),
    );
    expect(commandInput?.args).not.toContain("--ignore-user-config");
    expect(commandInput?.stdin).toContain("Use $mc-skin-segmenter");
    expect(commandInput?.args).not.toContain(commandInput?.stdin);
  });

  it("runs the Windows npm shim through Node without enabling a shell", async () => {
    const invocation = await resolveCommandInvocation(
      "codex.cmd",
      ["exec", "--json"],
      {
        platform: "win32",
        pathValue: "C:\\unrelated;D:\\npm-bin",
        nodeExecutable: "D:\\Node\\node.exe",
        cwd: "C:\\workspace",
        fileExists: async (path) => path.startsWith("D:\\npm-bin"),
      },
    );

    expect(invocation).toEqual({
      command: "D:\\Node\\node.exe",
      args: [
        "D:\\npm-bin\\node_modules\\@openai\\codex\\bin\\codex.js",
        "exec",
        "--json",
      ],
    });
  });

  it("falls back to host validation when a provider rejects structured output", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "mcskinsplit-fallback-"));
    temporaryDirectories.push(root);
    await Promise.all([
      mkdir(resolve(root, "output"), { recursive: true }),
      mkdir(resolve(root, "schema"), { recursive: true }),
    ]);
    const invocations: CommandExecutionInput[] = [];
    const progress: string[] = [];
    const provider = new CodexExecProvider({
      command: "codex-test",
      execute: async (input) => {
        invocations.push(input);
        if (invocations.length === 1) {
          return {
            exitCode: 1,
            stdout: `${JSON.stringify({ type: "turn.failed", error: { type: "upstream_error" } })}\n`,
            stderr: "",
          };
        }
        const outputIndex = input.args.indexOf("--output-last-message");
        await writeFile(
          input.args[outputIndex + 1]!,
          JSON.stringify({ schemaVersion: "1.0", marker: "fallback" }),
          "utf8",
        );
        return {
          exitCode: 0,
          stdout: `${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 3 } })}\n`,
          stderr: "",
        };
      },
    });

    const result = await provider.analyze({
      jobId: "job_fallback",
      runId: "run_fallback",
      attempt: 1,
      model: CODEX_CONFIG_DEFAULT_MODEL,
      pack: minimalPack(root),
      onProgress: (event) => progress.push(event.message),
    });

    expect(invocations).toHaveLength(2);
    expect(invocations[0]?.args).toContain("--output-schema");
    expect(invocations[1]?.args).not.toContain("--output-schema");
    expect(result.proposal).toMatchObject({ marker: "fallback" });
    expect(result.rawEvents).toContain("provider.schema_fallback");
    expect(progress).toContain("结构化输出不可用，已切换本地 JSON 校验");
  });

  it("streams safe progress projections and excludes reasoning content", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "mcskinsplit-progress-"));
    temporaryDirectories.push(root);
    await Promise.all([
      mkdir(resolve(root, "output"), { recursive: true }),
      mkdir(resolve(root, "schema"), { recursive: true }),
    ]);
    const progress: Array<{ readonly kind: string; readonly message: string }> = [];
    const provider = new CodexExecProvider({
      command: "codex-test",
      execute: async (input) => {
        const outputIndex = input.args.indexOf("--output-last-message");
        await writeFile(
          input.args[outputIndex + 1]!,
          JSON.stringify({ schemaVersion: "1.0" }),
          "utf8",
        );
        const lines = [
          { type: "thread.started", thread_id: "thread_stream" },
          { type: "turn.started" },
          {
            type: "item.completed",
            item: { type: "reasoning", text: "private chain of thought" },
          },
          {
            type: "item.started",
            item: { type: "command_execution", command: "inspect skin" },
          },
          {
            type: "item.completed",
            item: { type: "agent_message", text: "full proposal details" },
          },
          {
            type: "turn.completed",
            usage: { input_tokens: 12, output_tokens: 5 },
          },
        ].map((event) => JSON.stringify(event));
        input.onStdout?.(`${lines[0]}\n${lines[1]}\n${lines[2]}\n${lines[3]!.slice(0, 18)}`);
        input.onStdout?.(`${lines[3]!.slice(18)}\n${lines[4]}\n${lines[5]}\n`);
        return { exitCode: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
      },
    });

    await provider.analyze({
      jobId: "job_progress",
      runId: "run_progress",
      attempt: 1,
      model: CODEX_CONFIG_DEFAULT_MODEL,
      pack: minimalPack(root),
      onProgress: (event) => {
        progress.push(event);
        if (event.kind === "turn") throw new Error("observer failed");
      },
    });

    expect(progress).toEqual([
      { kind: "session", status: "started", message: "Codex 会话已建立" },
      { kind: "turn", status: "started", message: "模型开始分析候选区域" },
      { kind: "tool", status: "started", message: "正在运行本地分析工具" },
      { kind: "output", status: "completed", message: "候选分类提案已生成" },
      { kind: "usage", status: "completed", message: "模型分析完成 · 输入 12 / 输出 5 tokens" },
    ]);
    expect(JSON.stringify(progress)).not.toContain("private chain of thought");
    expect(JSON.stringify(progress)).not.toContain("full proposal details");
  });

  it("ignores malformed, unknown, and reasoning JSONL events", () => {
    expect(projectCodexProgressEvent("not json")).toBeNull();
    expect(
      projectCodexProgressEvent(
        JSON.stringify({ type: "item.started", item: { type: "reasoning" } }),
      ),
    ).toBeNull();
    expect(projectCodexProgressEvent(JSON.stringify({ type: "unknown" }))).toBeNull();
  });
});

function minimalPack(root: string): AnalysisPack {
  return {
    workspaceDirectory: root,
    job: {
      schemaVersion: "1.0",
      jobId: "job_1",
      runId: "run_1",
      projectId: "project_1",
      sourceRevisionId: "rev_1",
      sourceResultHash: `sha256:${"1".repeat(64)}`,
      sourceSkinHash: `sha256:${"2".repeat(64)}`,
      armType: "slim",
      provider: "codex-exec",
      model: CODEX_CONFIG_DEFAULT_MODEL,
      reasoningEffort: "medium",
      mode: "full",
      taxonomyLevel: "coarse",
      focus: [],
      createRevisionOnSuccess: true,
      candidateRegionAlgorithmVersion: "bounded-color80-surface-cc-v2",
      taxonomyVersion: "coarse-v1",
      skillName: "mc-skin-segmenter",
      skillVersion: "1.0.0",
      promptVersion: "semantic-proposal-v2",
      paths: {
        source: "input/source.png",
        atlas: "input/atlas-16x.png",
        atlasGrid: "input/atlas-grid-16x.png",
        contactSheet: "input/face-contact-sheet.png",
        pixelMap: "input/pixel-map.json",
        palette: "input/palette.json",
        candidateSummary: "input/candidate-summary.json",
        candidateRegions: "input/candidate-regions.json",
        previousSegmentation: "input/previous-segmentation.json",
        outputSchema: "schema/analysis-proposal.schema.json",
        proposal: "output/analysis-proposal.json",
        validatorReport: "logs/validator-report.json",
      },
    },
    candidateRegions: {
      schemaVersion: "1.0",
      algorithmVersion: "bounded-color80-surface-cc-v2",
      armType: "slim",
      visiblePixelCount: 0,
      regions: [],
    },
    pixelMap: {
      schemaVersion: "1.0",
      atlasWidth: 64,
      atlasHeight: 64,
      coordinateOrigin: "top-left",
      armType: "slim",
      items: [],
    },
    palette: { schemaVersion: "1.0", visiblePixelCount: 0, colors: [] },
    previousSegmentation: {
      schemaVersion: "1.0",
      revisionId: "rev_1",
      source: {
        width: 64,
        height: 64,
        armType: "slim",
        coordinateOrigin: "top-left",
        sourceHash: `sha256:${"2".repeat(64)}`,
      },
      components: [],
      unknown: { maskFile: "components/unknown.mask.png", pixelCount: 0 },
    },
    inputHash: `sha256:${"3".repeat(64)}`,
    fileHashes: {},
    imagePaths: [],
  };
}
