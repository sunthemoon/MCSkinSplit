import type {
  ApiAiJobDetail,
  ApiAiJobEvent,
  ApiAiJobStatus,
} from "../lib/revisionApi";

type SemanticAiStepState =
  | "completed"
  | "current"
  | "pending"
  | "skipped"
  | "failed"
  | "cancelled";

interface SemanticAiStepDefinition {
  readonly id: "queue" | "pack" | "proposal" | "validation" | "repair";
  readonly label: string;
  readonly description: string;
}

interface SemanticAiProgressStep extends SemanticAiStepDefinition {
  readonly state: SemanticAiStepState;
  readonly stateLabel: string;
}

export interface SemanticAiProgressModel {
  readonly headline: string;
  readonly progressPercent: number;
  readonly progressText: string;
  readonly steps: readonly SemanticAiProgressStep[];
  readonly handoffState: "pending" | "ready" | "unavailable";
  readonly handoffTitle: string;
  readonly handoffDetail: string;
}

const stepDefinitions: readonly SemanticAiStepDefinition[] = [
  {
    id: "queue",
    label: "任务排队",
    description: "等待 Worker 接管任务",
  },
  {
    id: "pack",
    label: "隔离输入",
    description: "复制 Skill、纹理与候选摘要，校验输入哈希",
  },
  {
    id: "proposal",
    label: "Codex 分类",
    description: "模型生成结构化 JSON 语义提案",
  },
  {
    id: "validation",
    label: "确定性校验",
    description: "主机校验 Schema、UV、像素归属与快照",
  },
  {
    id: "repair",
    label: "修复与复检",
    description: "提案无效时依据报告重新生成并再次校验",
  },
] as const;

const activeStageByStatus: Readonly<
  Record<Exclude<ApiAiJobStatus, "succeeded" | "failed" | "cancelled">, number>
> = {
  queued: 0,
  preparing: 1,
  running: 2,
  validating: 3,
};

const stateLabels: Readonly<Record<SemanticAiStepState, string>> = {
  completed: "已完成",
  current: "进行中",
  pending: "待开始",
  skipped: "无需执行",
  failed: "此处失败",
  cancelled: "已停止",
};

export interface SemanticAiJobProgressProps {
  readonly detail: ApiAiJobDetail | null;
}

export function SemanticAiJobProgress({ detail }: SemanticAiJobProgressProps) {
  const model = buildSemanticAiProgress(detail);
  const currentStepIndex = model.steps.findIndex((step) => step.state === "current");

  return (
    <section className="semantic-ai-progress" aria-label="AI 自动识别进度大纲">
      <div className="semantic-ai-progress-heading">
        <span>AUTO PIPELINE</span>
        <strong>{model.headline}</strong>
        <small>{model.progressText}</small>
      </div>
      <div
        className="semantic-ai-progress-meter"
        role="progressbar"
        aria-label="AI 自动识别完成度"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={model.progressPercent}
        aria-valuetext={model.progressText}
      >
        <i style={{ width: `${model.progressPercent}%` }} />
      </div>
      <ol className="semantic-ai-steps" aria-label="AI 自动识别步骤">
        {model.steps.map((step, index) => (
          <li
            key={step.id}
            data-state={step.state}
            {...(index === currentStepIndex ? { "aria-current": "step" } : {})}
          >
            <span aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
            <div>
              <strong>{step.label}</strong>
              <small>{step.description}</small>
            </div>
            <em>{step.stateLabel}</em>
          </li>
        ))}
      </ol>
      <div
        className="semantic-ai-handoff"
        data-state={model.handoffState}
        {...(model.handoffState === "ready" ? { "aria-current": "step" } : {})}
      >
        <span>MANUAL REVIEW</span>
        <div>
          <strong>{model.handoffTitle}</strong>
          <p>{model.handoffDetail}</p>
        </div>
      </div>
    </section>
  );
}

export function buildSemanticAiProgress(
  detail: ApiAiJobDetail | null,
): SemanticAiProgressModel {
  if (!detail || detail.job.kind !== "semantic_analysis") {
    return {
      headline: "尚未开始",
      progressPercent: 0,
      progressText: "自动流程 0 / 5 · 启动任务后按步骤更新",
      steps: createSteps(null),
      handoffState: "pending",
      handoffTitle: "任务完成后进入人工审核",
      handoffDetail: "AI 只生成分类提案；组件确认和修改仍由用户完成。",
    };
  }

  const { job, runs, events } = detail;
  const maximumAttempt = runs.reduce(
    (maximum, run) => Math.max(maximum, run.attempt),
    0,
  );
  const repairActive = maximumAttempt >= 2;

  if (job.status === "succeeded") {
    const steps = createSteps(null, repairActive ? "completed" : "skipped");
    const createdRevision = job.resultRevisionId !== null;
    return {
      headline: "机器识别已完成",
      progressPercent: 100,
      progressText: `自动流程 5 / 5 · ${repairActive ? `完成 ${maximumAttempt} 次模型调用` : "首轮提案通过，无需自动修复"}`,
      steps,
      handoffState: createdRevision ? "ready" : "unavailable",
      handoffTitle: createdRevision
        ? "提案已写入 Revision，等待人工确认"
        : "提案仅保留为审计记录，未创建 Revision",
      handoffDetail: createdRevision
        ? reviewHandoffDetail(job.reviewItems.length)
        : "历史输入的只读重跑不会写入语义编辑器；请在 Branch HEAD 上启动或重试识别，创建可审核的 Revision。",
    };
  }

  if (job.status === "failed" || job.status === "cancelled") {
    const stoppedStage = terminalStage(events, maximumAttempt);
    const terminalState = job.status === "failed" ? "failed" : "cancelled";
    const steps = createSteps(stoppedStage, undefined, terminalState);
    return {
      headline: job.status === "failed" ? "机器识别未完成" : "机器识别已停止",
      progressPercent: Math.round((stoppedStage / stepDefinitions.length) * 100),
      progressText: `自动流程 ${stoppedStage} / 5 · ${stepDefinitions[stoppedStage]!.label}${job.status === "failed" ? "失败" : "取消"}`,
      steps,
      handoffState: "unavailable",
      handoffTitle: "尚无可交付的人工审核提案",
      handoffDetail: job.status === "failed"
        ? "查看下方错误和实时日志，修正输入或配置后重试。"
        : "任务已取消；重新运行后会从新的 Job 开始记录。",
    };
  }

  const currentStage = repairActive ? 4 : activeStageByStatus[job.status];
  const steps = createSteps(currentStage);
  if (job.cancelRequested) {
    steps[currentStage] = { ...steps[currentStage]!, stateLabel: "正在取消" };
  }
  return {
    headline: repairActive
      ? `自动修复中 · 第 ${maximumAttempt} 次模型调用`
      : stepDefinitions[currentStage]!.label,
    progressPercent: Math.round((currentStage / stepDefinitions.length) * 100),
    progressText: `自动流程 ${currentStage + 1} / 5 · ${job.cancelRequested ? "正在取消当前步骤" : "当前步骤进行中"}`,
    steps,
    handoffState: "pending",
    handoffTitle: "机器提案通过校验后进入人工审核",
    handoffDetail: repairActive
      ? "首轮提案未通过，正在按校验报告修复；此前成功步骤不会回退。"
      : "实时日志显示当前步骤的详细事件，流程大纲只表示确定性阶段。",
  };
}

function createSteps(
  currentStage: number | null,
  repairTerminalState?: "completed" | "skipped",
  stoppedState?: "failed" | "cancelled",
): SemanticAiProgressStep[] {
  return stepDefinitions.map((definition, index) => {
    let state: SemanticAiStepState = "pending";
    if (repairTerminalState && index < stepDefinitions.length - 1) state = "completed";
    if (repairTerminalState && index === stepDefinitions.length - 1) {
      state = repairTerminalState;
    } else if (currentStage !== null && index < currentStage) {
      state = "completed";
    } else if (currentStage !== null && index === currentStage) {
      state = stoppedState ?? "current";
    }
    return { ...definition, state, stateLabel: stateLabels[state] };
  });
}

function terminalStage(
  events: readonly ApiAiJobEvent[],
  maximumAttempt: number,
): number {
  if (maximumAttempt >= 2) return 4;
  for (const event of events.toReversed()) {
    if (event.eventType === "validating") return 3;
    if (event.eventType === "running" || event.eventType === "run_started") return 2;
    if (event.eventType === "preparing") return 1;
    if (event.eventType === "queued") return 0;
  }
  return maximumAttempt > 0 ? 2 : 0;
}

function reviewHandoffDetail(reviewItemCount: number): string {
  return reviewItemCount > 0
    ? `系统标记了 ${reviewItemCount} 项重点审核问题；其余组件仍可在语义编辑器中逐项确认。`
    : "系统没有标记重点审核问题；这不等于审核完成，仍需确认组件边界与分类。";
}
