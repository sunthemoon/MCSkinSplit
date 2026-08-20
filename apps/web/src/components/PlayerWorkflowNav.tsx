export type PlayerWorkflowStep =
  | "import"
  | "analyze"
  | "review"
  | "save";

export const PLAYER_WORKFLOW_HASHES: Readonly<
  Record<PlayerWorkflowStep, `#player-${PlayerWorkflowStep}`>
> = {
  import: "#player-import",
  analyze: "#player-analyze",
  review: "#player-review",
  save: "#player-save",
};

export function resolvePlayerWorkflowStepFromHash(
  hash: string,
): PlayerWorkflowStep | null {
  return (Object.entries(PLAYER_WORKFLOW_HASHES) as readonly [
    PlayerWorkflowStep,
    string,
  ][]).find(([, value]) => value === hash)?.[0] ?? null;
}

const PLAYER_STEPS = [
  {
    id: "import",
    label: "导入皮肤",
    detail: "创建可回退的版本",
  },
  {
    id: "analyze",
    label: "智能识别",
    detail: "识别可见部件",
  },
  {
    id: "review",
    label: "检查修正",
    detail: "确认分类与候选",
  },
  {
    id: "save",
    label: "保存导出",
    detail: "选择明确的结果",
  },
] as const satisfies readonly {
  readonly id: PlayerWorkflowStep;
  readonly label: string;
  readonly detail: string;
}[];

export interface PlayerWorkflowNavProps {
  readonly mode: "player" | "advanced";
  readonly step: PlayerWorkflowStep;
  readonly onSelectStep: (step: PlayerWorkflowStep) => void;
  readonly onChangeMode: (mode: "player" | "advanced") => void;
}

export function PlayerWorkflowNav({
  mode,
  step,
  onSelectStep,
  onChangeMode,
}: PlayerWorkflowNavProps) {
  return (
    <nav
      className="player-workflow-nav"
      aria-label="玩家四步工作流"
      data-testid="player-workflow-nav"
      data-mode={mode}
    >
      <div className="player-workflow-intro">
        <span>PLAYER WORKFLOW</span>
        <strong>四步完成皮肤拆分</strong>
        <small>普通流程只需按任务选择，不必填写技术编号或运行参数</small>
      </div>
      <ol>
        {PLAYER_STEPS.map((item, index) => (
          <li key={item.id}>
            <button
              type="button"
              aria-current={mode === "player" && step === item.id ? "step" : undefined}
              data-step={item.id}
              onClick={() => onSelectStep(item.id)}
            >
              <span>{String(index + 1).padStart(2, "0")}</span>
              <strong>{item.label}</strong>
              <small>{item.detail}</small>
            </button>
          </li>
        ))}
      </ol>
      <button
        className="player-workflow-mode"
        type="button"
        data-testid="advanced-studio-toggle"
        aria-expanded={mode === "advanced"}
        onClick={() => onChangeMode(mode === "advanced" ? "player" : "advanced")}
      >
        {mode === "advanced" ? "返回玩家四步" : "高级工作室 / 资产管理"}
      </button>
    </nav>
  );
}

export { PLAYER_STEPS };
