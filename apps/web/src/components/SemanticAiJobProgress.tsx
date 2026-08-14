import type {
  ApiAiJobDetail,
  ApiAiJobEvent,
  ApiAiJobStatus,
  ApiSemanticFollowupStatus,
} from "../lib/revisionApi";

type SemanticAiStepState =
  | "completed"
  | "current"
  | "pending"
  | "skipped"
  | "failed"
  | "cancelled";

interface SemanticAiStepDefinition {
  readonly id: "prepare" | "identify" | "validate" | "assess" | "preview" | "catalog";
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
  { id: "prepare", label: "准备识别", description: "读取皮肤并准备独立识别输入" },
  { id: "identify", label: "识别皮肤部件", description: "识别头发、衣服、饰品等部件" },
  { id: "validate", label: "校验识别结果", description: "检查分类、边界和像素归属" },
  { id: "assess", label: "复核跨部位分类", description: "检查长发等区域是否被错分" },
  { id: "preview", label: "确认分类修复", description: "有安全建议时由用户确认" },
  { id: "catalog", label: "准备分析目录", description: "保存原版或已确认的分类修复版" },
] as const;

const activeStageByStatus: Readonly<
  Record<Exclude<ApiAiJobStatus, "succeeded" | "failed" | "cancelled">, number>
> = { queued: 0, preparing: 0, running: 1, validating: 2 };

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
    <section className="semantic-ai-progress" aria-label="智能分析进度">
      <div className="semantic-ai-progress-heading">
        <span>SMART ANALYSIS</span>
        <strong>{model.headline}</strong>
        <small>{model.progressText}</small>
      </div>
      <div
        className="semantic-ai-progress-meter"
        role="progressbar"
        aria-label="智能分析完成度"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={model.progressPercent}
        aria-valuetext={model.progressText}
      >
        <i style={{ width: `${model.progressPercent}%` }} />
      </div>
      <ol className="semantic-ai-steps" aria-label="智能分析步骤">
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
      <div className="semantic-ai-handoff" data-state={model.handoffState}>
        <span>RESULT</span>
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
    return progressModel(
      "尚未开始",
      createSteps(null),
      "pending",
      "智能分析后自动复核跨部位分类",
      "发现可能错分的区域时，用户可选择分类修复版或保留原版。",
    );
  }

  const { job, runs, events, semanticFollowup } = detail;
  const maximumAttempt = runs.reduce(
    (maximum, run) => Math.max(maximum, run.attempt),
    0,
  );

  if (job.status === "failed" || job.status === "cancelled") {
    const stoppedStage = terminalStage(events);
    const terminalState = job.status === "failed" ? "failed" : "cancelled";
    return progressModel(
      job.status === "failed" ? "智能分析未完成" : "智能分析已停止",
      createSteps(stoppedStage, terminalState),
      "unavailable",
      "尚无可用结果",
      job.status === "failed"
        ? "可在高级信息中查看错误，修正后重新分析。"
        : "重新点击智能分析皮肤会创建新任务。",
    );
  }

  if (job.status !== "succeeded") {
    const currentStage = activeStageByStatus[job.status];
    const steps = createSteps(currentStage);
    if (job.cancelRequested) {
      steps[currentStage] = { ...steps[currentStage]!, stateLabel: "正在取消" };
    }
    const correctingProposal = maximumAttempt >= 2 && currentStage >= 1;
    return progressModel(
      correctingProposal ? "正在纠正识别结果" : stepDefinitions[currentStage]!.label,
      steps,
      "pending",
      "识别完成后继续复核跨部位分类",
      correctingProposal
        ? "模型正在根据校验结果重新整理分类，不会把这一步当作像素修补。"
        : "页面关闭后任务仍由服务器继续处理。",
    );
  }

  if (!job.resultRevisionId) {
    const steps = createCompletedSemanticSteps();
    steps[3] = withState(steps[3]!, "skipped");
    steps[4] = withState(steps[4]!, "skipped");
    steps[5] = withState(steps[5]!, "skipped");
    return progressModel(
      "识别提案已保存",
      steps,
      "unavailable",
      "历史提案不会替换皮肤",
      "对皮肤最新版本运行智能分析，才能继续检查跨部位错分并准备入库。",
    );
  }

  const eventState = latestFollowupEvent(events);
  const followupStatus = semanticFollowup?.status ?? eventState.status;
  return completedSemanticProgress(
    followupStatus,
    eventState.catalogReady,
    semanticFollowup?.notices.map((notice) => notice.message) ?? [],
    semanticFollowup?.applicable ?? true,
  );
}

function completedSemanticProgress(
  status: ApiSemanticFollowupStatus | "assessing" | "assessed" | null,
  catalogReady: boolean,
  notices: readonly string[],
  applicable: boolean,
): SemanticAiProgressModel {
  const steps = createCompletedSemanticSteps();
  const notice = notices[0];
  if (status === "no_repair") {
    steps[3] = withState(steps[3]!, "completed");
    steps[4] = withState(steps[4]!, "skipped");
    steps[5] = withState(steps[5]!, "completed");
    return progressModel(
      "跨部位分类复核完成",
      steps,
      "ready",
      "原识别已准备入库",
      notice ?? "未发现可安全建议的跨部位分类调整；被遮挡的隐藏内容仍可能需要后续补全。",
    );
  }
  if (status === "awaiting_review") {
    steps[3] = withState(steps[3]!, "completed");
    if (!applicable) {
      steps[4] = withState(steps[4]!, "skipped");
      steps[5] = withState(steps[5]!, "completed");
      return progressModel(
        "旧版分类建议仅供对照",
        steps,
        "ready",
        "请重新运行智能分析",
        "原识别仍可载入和入库；重新分析后才能使用当前分类调整规则。",
      );
    }
    steps[4] = withState(steps[4]!, "current");
    return progressModel("发现可选分类调整", steps, "ready", "请选择是否使用分类修复版", notice ?? "分类调整不会自动写入皮肤，确认前原版保持不变。");
  }
  if (status === "applied") {
    steps[3] = withState(steps[3]!, "completed");
    steps[4] = withState(steps[4]!, "completed");
    steps[5] = withState(steps[5]!, catalogReady ? "completed" : "current");
    return progressModel(catalogReady ? "分类修复版已准备入库" : "正在保存分类修复版", steps, "ready", "已使用确认的分类调整", notice ?? "分类修复版和原识别都会保留，方便随时对照。");
  }
  if (status === "dismissed") {
    steps[3] = withState(steps[3]!, "completed");
    steps[4] = withState(steps[4]!, "skipped");
    steps[5] = withState(steps[5]!, "completed");
    return progressModel("已保留原识别", steps, "ready", "原识别已准备入库", notice ?? "分类调整建议已跳过，未改动皮肤像素。");
  }
  if (status === "assessment_failed") {
    steps[3] = withState(steps[3]!, "failed");
    steps[4] = withState(steps[4]!, "skipped");
    steps[5] = withState(steps[5]!, catalogReady ? "completed" : "current");
    return progressModel("识别完成，跨部位复核未完成", steps, "ready", "原识别仍可使用", notice ?? "复核失败不会撤销已经完成的识别结果。");
  }
  if (status === "assessed") {
    steps[3] = withState(steps[3]!, "completed");
    steps[4] = withState(steps[4]!, "current");
    return progressModel("正在准备跨部位复核结果", steps, "pending", "识别结果已保存", "系统正在判断是否需要显示分类调整建议。");
  }
  steps[3] = withState(steps[3]!, "current");
  return progressModel("正在复核跨部位分类", steps, "pending", "识别结果已保存", "系统正在检查长发等区域是否被分到错误部位。");
}

function progressModel(
  headline: string,
  steps: readonly SemanticAiProgressStep[],
  handoffState: SemanticAiProgressModel["handoffState"],
  handoffTitle: string,
  handoffDetail: string,
): SemanticAiProgressModel {
  const completed = steps.filter((step) => step.state === "completed" || step.state === "skipped").length;
  const progressPercent = Math.round((completed / stepDefinitions.length) * 100);
  return {
    headline,
    progressPercent,
    progressText: `智能流程 ${completed} / ${stepDefinitions.length}`,
    steps,
    handoffState,
    handoffTitle,
    handoffDetail,
  };
}

function createSteps(
  currentStage: number | null,
  stoppedState?: "failed" | "cancelled",
): SemanticAiProgressStep[] {
  return stepDefinitions.map((definition, index) => {
    const state: SemanticAiStepState = currentStage === null
      ? "pending"
      : index < currentStage
        ? "completed"
        : index === currentStage
          ? stoppedState ?? "current"
          : "pending";
    return { ...definition, state, stateLabel: stateLabels[state] };
  });
}

function createCompletedSemanticSteps(): SemanticAiProgressStep[] {
  const steps = createSteps(null);
  for (let index = 0; index < 3; index += 1) steps[index] = withState(steps[index]!, "completed");
  return steps;
}

function withState(step: SemanticAiProgressStep, state: SemanticAiStepState): SemanticAiProgressStep {
  return { ...step, state, stateLabel: stateLabels[state] };
}

function terminalStage(events: readonly ApiAiJobEvent[]): number {
  for (const event of events.toReversed()) {
    if (event.eventType === "validating") return 2;
    if (event.eventType === "running" || event.eventType === "run_started") return 1;
    if (event.eventType === "preparing" || event.eventType === "queued") return 0;
  }
  return 0;
}

function latestFollowupEvent(events: readonly ApiAiJobEvent[]): {
  readonly status: ApiSemanticFollowupStatus | "assessing" | "assessed" | null;
  readonly catalogReady: boolean;
} {
  let status: ApiSemanticFollowupStatus | "assessing" | "assessed" | null = null;
  let catalogReady = false;
  for (const event of events) {
    if (event.eventType === "occlusion_assessing") status = "assessing";
    if (event.eventType === "occlusion_assessed") status = "assessed";
    if (event.eventType === "occlusion_assessment_failed") status = "assessment_failed";
    if (event.eventType === "repair_review_ready") status = "awaiting_review";
    if (event.eventType === "repair_review_skipped") status = "no_repair";
    if (event.eventType === "semantic_repair_applied") status = "applied";
    if (event.eventType === "semantic_repair_dismissed") status = "dismissed";
    if (event.eventType === "catalog_ready") catalogReady = true;
  }
  return { status, catalogReady };
}
