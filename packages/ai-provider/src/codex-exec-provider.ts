import { spawn } from "node:child_process";
import { access, readFile, rm } from "node:fs/promises";
import { resolve, win32 } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type {
  ProviderAnalysisInput,
  ProviderAnalysisResult,
  ProviderProgressEvent,
  SkinSemanticAiProvider,
} from "./types";

const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
const MAX_PROGRESS_LINE_CHARS = 1024 * 1024;
export const CODEX_CONFIG_DEFAULT_MODEL = "codex-config-default";

export class AiProviderError extends Error {
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly rawEvents?: string;
  readonly stderr?: string;

  constructor(
    code: string,
    message: string,
    details?: Readonly<Record<string, unknown>>,
    diagnostics: {
      readonly rawEvents?: string;
      readonly stderr?: string;
    } = {},
  ) {
    super(message);
    this.name = "AiProviderError";
    this.code = code;
    this.details = details;
    this.rawEvents = diagnostics.rawEvents;
    this.stderr = diagnostics.stderr;
  }
}

export interface CommandExecutionInput {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly stdin?: string;
  readonly signal?: AbortSignal;
  readonly onStdout?: (chunk: string) => void;
}

export interface CommandExecutionResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandInvocation {
  readonly command: string;
  readonly args: readonly string[];
}

export interface CommandResolutionOptions {
  readonly platform?: NodeJS.Platform;
  readonly pathValue?: string;
  readonly nodeExecutable?: string;
  readonly cwd?: string;
  readonly fileExists?: (path: string) => Promise<boolean>;
}

export type CommandExecutor = (
  input: CommandExecutionInput,
) => Promise<CommandExecutionResult>;

export interface CodexExecProviderOptions {
  readonly command?: string;
  readonly timeoutMs?: number;
  readonly defaultModel?: string;
  readonly ignoreUserConfig?: boolean;
  readonly allowSchemaFallback?: boolean;
  readonly execute?: CommandExecutor;
}

export class CodexExecProvider implements SkinSemanticAiProvider {
  readonly providerName = "codex-exec";
  readonly command: string;
  readonly timeoutMs: number;
  readonly defaultModel: string;
  readonly ignoreUserConfig: boolean;
  readonly allowSchemaFallback: boolean;
  private readonly execute: CommandExecutor;

  constructor(options: CodexExecProviderOptions = {}) {
    this.command = options.command ?? (process.platform === "win32" ? "codex.cmd" : "codex");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.defaultModel = options.defaultModel?.trim() || CODEX_CONFIG_DEFAULT_MODEL;
    this.ignoreUserConfig = options.ignoreUserConfig ?? false;
    this.allowSchemaFallback = options.allowSchemaFallback ?? true;
    this.execute = options.execute ?? executeCommand;
  }

  async analyze(input: ProviderAnalysisInput): Promise<ProviderAnalysisResult> {
    const root = resolve(input.pack.workspaceDirectory);
    const outputPath = resolve(root, input.pack.job.paths.proposal);
    const schemaPath = resolve(root, input.pack.job.paths.outputSchema);
    const args = [
      "exec",
      "--cd",
      root,
      "--sandbox",
      "workspace-write",
      "--ephemeral",
      "--ignore-rules",
      "--skip-git-repo-check",
      "--color",
      "never",
      "--json",
      "--output-schema",
      schemaPath,
      "--output-last-message",
      outputPath,
    ];
    if (this.ignoreUserConfig) args.push("--ignore-user-config");
    args.push(
      "--config",
      `model_reasoning_effort=${JSON.stringify(input.pack.job.reasoningEffort)}`,
    );
    const model = input.model === CODEX_CONFIG_DEFAULT_MODEL ? this.defaultModel : input.model;
    if (model !== CODEX_CONFIG_DEFAULT_MODEL) args.push("--model", model);
    for (const imagePath of input.pack.imagePaths) {
      args.push("--image", resolve(root, imagePath));
    }

    const prompt = buildPrompt(input);
    const startedAt = Date.now();
    const execute = async (commandArgs: readonly string[]) => {
      const progress = createCodexProgressStream(input.onProgress);
      let streamed = false;
      let executed: CommandExecutionResult;
      try {
        executed = await this.execute({
          command: this.command,
          args: commandArgs,
          cwd: root,
          timeoutMs: Math.max(1_000, this.timeoutMs - (Date.now() - startedAt)),
          stdin: prompt,
          ...(input.signal ? { signal: input.signal } : {}),
          onStdout: (chunk) => {
            streamed = true;
            progress.push(chunk);
          },
        });
      } finally {
        if (streamed) progress.flush();
      }
      if (!streamed) {
        progress.push(executed.stdout);
        progress.flush();
      }
      return executed;
    };

    let executed: CommandExecutionResult;
    try {
      executed = await execute(args);
      if (
        executed.exitCode !== 0 &&
        this.allowSchemaFallback &&
        isStructuredOutputTransportFailure(executed)
      ) {
        emitProgress(input.onProgress, {
          kind: "warning",
          status: "completed",
          message: "结构化输出不可用，已切换本地 JSON 校验",
        });
        await rm(outputPath, { force: true });
        const fallback = await execute(removeOptionWithValue(args, "--output-schema"));
        executed = {
          exitCode: fallback.exitCode,
          stdout: [
            executed.stdout.trimEnd(),
            JSON.stringify({
              type: "provider.schema_fallback",
              reason: "structured_output_transport_failure",
            }),
            fallback.stdout.trimStart(),
          ]
            .filter(Boolean)
            .join("\n"),
          stderr: [executed.stderr.trimEnd(), fallback.stderr.trimStart()]
            .filter(Boolean)
            .join("\n"),
        };
      }
    } catch (error) {
      if (error instanceof AiProviderError) throw error;
      throw new AiProviderError("CODEX_EXEC_FAILED", error instanceof Error ? error.message : "Codex CLI 无法启动");
    }
    if (executed.exitCode !== 0) {
      throw new AiProviderError("CODEX_EXEC_FAILED", `Codex CLI 退出码为 ${executed.exitCode}`, {
        exitCode: executed.exitCode,
        stdout: executed.stdout.slice(-4_000),
        stderr: executed.stderr.slice(-4_000),
      }, {
        rawEvents: executed.stdout,
        stderr: executed.stderr,
      });
    }

    let proposal: unknown;
    try {
      proposal = JSON.parse(await readFile(outputPath, "utf8"));
    } catch (error) {
      throw new AiProviderError("CODEX_OUTPUT_INVALID", error instanceof Error ? error.message : "Codex 输出不是有效 JSON");
    }
    const diagnostics = parseEventDiagnostics(executed.stdout);
    return {
      proposal,
      rawEvents: executed.stdout,
      stderr: executed.stderr,
      ...(diagnostics.threadId ? { threadId: diagnostics.threadId } : {}),
      ...(diagnostics.usage ? { usage: diagnostics.usage } : {}),
    };
  }
}

function isStructuredOutputTransportFailure(
  executed: CommandExecutionResult,
): boolean {
  const diagnostics = `${executed.stdout}\n${executed.stderr}`;
  return /upstream_error|output[_ -]?schema|structured[_ -]?output|response[_ -]?format/iu.test(
    diagnostics,
  );
}

function removeOptionWithValue(
  args: readonly string[],
  option: string,
): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === option) {
      index += 1;
      continue;
    }
    result.push(args[index]!);
  }
  return result;
}

function buildPrompt(input: ProviderAnalysisInput): string {
  if (input.attempt > 1 && input.repairReport) {
    return "Use $mc-skin-segmenter to repair the proposal for ./job.json using ./logs/previous-validator-report.json. Start from the compact candidate summary; do not load the full pixel map or candidate-region document into context. Produce one schema-valid semantic proposal and do not modify input or application files.";
  }
  return "Use $mc-skin-segmenter to analyze ./job.json. Start from input/candidate-summary.json and the attached views; do not load the full pixel map or candidate-region document into context. Produce one schema-valid semantic proposal and do not modify input or application files.";
}

export async function executeCommand(
  input: CommandExecutionInput,
): Promise<CommandExecutionResult> {
  const invocation = await resolveCommandInvocation(input.command, input.args, {
    cwd: input.cwd,
  });
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(invocation.command, [...invocation.args], {
      cwd: input.cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const stdoutDecoder = new StringDecoder("utf8");
    let captured = 0;
    let timedOut = false;
    let cancelled = false;
    const terminate = () => child.kill();
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, input.timeoutMs);
    const abort = () => {
      cancelled = true;
      terminate();
    };
    input.signal?.addEventListener("abort", abort, { once: true });

    child.stdin.on("error", () => {
      // Process exit and stderr provide the actionable failure information.
    });
    child.stdin.end(input.stdin ?? "");
    child.stdout.on("data", (chunk: Buffer) => {
      if (!capture(chunk, stdout)) return;
      const decoded = stdoutDecoder.write(chunk);
      if (decoded) input.onStdout?.(decoded);
    });
    child.stderr.on("data", (chunk: Buffer) => capture(chunk, stderr));
    child.once("error", finishError);
    child.once("close", (code) => {
      cleanup();
      const stdoutTail = stdoutDecoder.end();
      if (stdoutTail) input.onStdout?.(stdoutTail);
      if (timedOut) {
        reject(new AiProviderError("AI_TIMEOUT", `Codex CLI 超过 ${input.timeoutMs} ms`));
      } else if (cancelled || input.signal?.aborted) {
        reject(new AiProviderError("AI_CANCELLED", "Codex CLI 任务已取消"));
      } else {
        resolvePromise({
          exitCode: code ?? 1,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
      }
    });

    function capture(chunk: Buffer, target: Buffer[]): boolean {
      captured += chunk.byteLength;
      if (captured > MAX_CAPTURE_BYTES) {
        terminate();
        finishError(new AiProviderError("AI_OUTPUT_TOO_LARGE", "Codex CLI 日志超过 16 MiB"));
        return false;
      }
      target.push(Buffer.from(chunk));
      return true;
    }

    function finishError(error: Error): void {
      cleanup();
      reject(error);
    }

    function cleanup(): void {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
    }
  });
}

interface CodexProgressStream {
  push(chunk: string): void;
  flush(): void;
}

function createCodexProgressStream(
  onProgress?: (event: ProviderProgressEvent) => void,
): CodexProgressStream {
  let pending = "";
  const consume = (line: string) => {
    if (line.length > MAX_PROGRESS_LINE_CHARS) return;
    const event = projectCodexProgressEvent(line);
    if (event) emitProgress(onProgress, event);
  };
  return {
    push(chunk) {
      pending += chunk;
      if (!pending.includes("\n") && pending.length > MAX_PROGRESS_LINE_CHARS) {
        pending = "";
        return;
      }
      const lines = pending.split(/\r?\n/u);
      pending = lines.pop() ?? "";
      for (const line of lines) consume(line);
    },
    flush() {
      if (pending.trim()) consume(pending);
      pending = "";
    },
  };
}

function emitProgress(
  onProgress: ((event: ProviderProgressEvent) => void) | undefined,
  event: ProviderProgressEvent,
): void {
  try {
    onProgress?.(event);
  } catch {
    // Progress observers are telemetry only and must not decide the run result.
  }
}

export function projectCodexProgressEvent(
  line: string,
): ProviderProgressEvent | null {
  let event: Readonly<Record<string, unknown>>;
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!isRecord(parsed)) return null;
    event = parsed;
  } catch {
    return null;
  }

  if (event.type === "thread.started") {
    return { kind: "session", status: "started", message: "Codex 会话已建立" };
  }
  if (event.type === "turn.started") {
    return { kind: "turn", status: "started", message: "模型开始分析候选区域" };
  }
  if (event.type === "turn.completed") {
    return {
      kind: "usage",
      status: "completed",
      message: formatUsageMessage(event.usage),
    };
  }
  if (event.type === "turn.failed" || event.type === "error") {
    return { kind: "error", status: "failed", message: "Codex 报告运行错误" };
  }
  if (event.type === "provider.schema_fallback") {
    return {
      kind: "warning",
      status: "completed",
      message: "结构化输出不可用，已切换本地 JSON 校验",
    };
  }
  if (event.type !== "item.started" && event.type !== "item.completed") {
    return null;
  }

  const item = isRecord(event.item) ? event.item : null;
  const itemType = item?.type;
  if (typeof itemType !== "string" || itemType === "reasoning") return null;
  const started = event.type === "item.started";
  const status = started ? "started" : item?.status === "failed" ? "failed" : "completed";
  const messages: Readonly<Record<string, readonly [string, string]>> = {
    command_execution: ["正在运行本地分析工具", "本地分析工具执行完成"],
    mcp_tool_call: ["正在调用分析工具", "分析工具调用完成"],
    web_search: ["正在检索辅助资料", "辅助资料检索完成"],
    file_change: ["正在生成分析文件", "分析文件已更新"],
    plan: ["正在更新分析步骤", "分析步骤已更新"],
    agent_message: ["正在整理候选分类提案", "候选分类提案已生成"],
  };
  const message = messages[itemType];
  if (!message) return null;
  return {
    kind: itemType === "agent_message" ? "output" : "tool",
    status,
    message: status === "failed" ? `${message[1]}（失败）` : message[started ? 0 : 1],
  };
}

function formatUsageMessage(usage: unknown): string {
  if (!isRecord(usage)) return "模型分析完成";
  const inputTokens = numericUsage(usage.input_tokens);
  const outputTokens = numericUsage(usage.output_tokens);
  if (inputTokens === null && outputTokens === null) return "模型分析完成";
  const details = [
    inputTokens === null ? null : `输入 ${inputTokens}`,
    outputTokens === null ? null : `输出 ${outputTokens}`,
  ].filter(Boolean);
  return `模型分析完成 · ${details.join(" / ")} tokens`;
}

function numericUsage(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}

export async function resolveCommandInvocation(
  command: string,
  args: readonly string[],
  options: CommandResolutionOptions = {},
): Promise<CommandInvocation> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32" || !/\.(?:cmd|bat)$/iu.test(command)) {
    return { command, args };
  }

  const fileExists = options.fileExists ?? pathExists;
  const shimPath = await findWindowsShim(
    command,
    options.pathValue ?? process.env.PATH ?? "",
    options.cwd ?? process.cwd(),
    fileExists,
  );
  if (!shimPath) {
    throw new AiProviderError(
      "CODEX_EXEC_NOT_FOUND",
      `Windows CLI shim 不存在：${command}`,
    );
  }
  if (win32.basename(shimPath).replace(/\.(?:cmd|bat)$/iu, "").toLowerCase() !== "codex") {
    throw new AiProviderError(
      "CODEX_EXEC_UNSUPPORTED",
      `拒绝通过 shell 执行 Windows 脚本：${shimPath}`,
    );
  }

  const codexScript = win32.resolve(
    win32.dirname(shimPath),
    "node_modules",
    "@openai",
    "codex",
    "bin",
    "codex.js",
  );
  if (!(await fileExists(codexScript))) {
    throw new AiProviderError(
      "CODEX_EXEC_NOT_FOUND",
      `Windows Codex npm 入口不存在：${codexScript}`,
    );
  }
  return {
    command: options.nodeExecutable ?? process.execPath,
    args: [codexScript, ...args],
  };
}

async function findWindowsShim(
  command: string,
  pathValue: string,
  cwd: string,
  fileExists: (path: string) => Promise<boolean>,
): Promise<string | null> {
  const candidates = /[\\/]/u.test(command)
    ? [win32.resolve(cwd, command)]
    : pathValue
        .split(";")
        .map((directory) => directory.trim().replace(/^"|"$/gu, ""))
        .filter(Boolean)
        .map((directory) => win32.resolve(directory, command));
  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function parseEventDiagnostics(rawEvents: string): {
  readonly threadId?: string;
  readonly usage?: Readonly<Record<string, unknown>>;
} {
  let threadId: string | undefined;
  let usage: Readonly<Record<string, unknown>> | undefined;
  for (const line of rawEvents.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type === "thread.started" && typeof event.thread_id === "string") {
        threadId = event.thread_id;
      }
      if (event.type === "turn.completed" && isRecord(event.usage)) usage = event.usage;
    } catch {
      continue;
    }
  }
  return { ...(threadId ? { threadId } : {}), ...(usage ? { usage } : {}) };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
