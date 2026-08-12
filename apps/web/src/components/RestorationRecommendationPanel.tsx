import type {
  ApiAiJobDetail,
  ApiAiJobStatus,
  ApiAiReasoningEffort,
  ApiCompositionRestorationCandidates,
} from "../lib/revisionApi";

export interface RestorationRecommendationPanelProps {
  readonly candidates: ApiCompositionRestorationCandidates | null;
  readonly jobDetail: ApiAiJobDetail | null;
  readonly userIntent: string;
  readonly providers: readonly string[];
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort: ApiAiReasoningEffort;
  readonly staleReason: string | null;
  readonly disabled: boolean;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onUserIntentChange: (value: string) => void;
  readonly onProviderChange: (provider: string) => void;
  readonly onStart: () => void;
  readonly onCancel: () => void;
  readonly onLoad: () => void;
}

const statusLabels: Readonly<Record<ApiAiJobStatus, string>> = {
  queued: "排队中",
  preparing: "准备输入",
  running: "正在推荐",
  validating: "校验建议",
  succeeded: "推荐完成",
  failed: "推荐失败",
  cancelled: "已取消",
};

const terminalStatuses = new Set<ApiAiJobStatus>([
  "succeeded",
  "failed",
  "cancelled",
]);

export function RestorationRecommendationPanel({
  candidates,
  jobDetail,
  userIntent,
  providers,
  provider,
  model,
  reasoningEffort,
  staleReason,
  disabled,
  busy,
  error,
  onUserIntentChange,
  onProviderChange,
  onStart,
  onCancel,
  onLoad,
}: RestorationRecommendationPanelProps) {
  const job = jobDetail?.job ?? null;
  const running = Boolean(job && !terminalStatuses.has(job.status));
  const result = job?.kind === "restoration_recommendation"
    ? job.advisoryResult
    : null;
  const displayProvider = job?.provider ?? provider;
  const displayModel = job?.model ?? model;
  const displayReasoning = job?.options.reasoningEffort ?? reasoningEffort;
  const canLoad = Boolean(
    job?.status === "succeeded" && result && !staleReason && !disabled && !busy,
  );
  const recentEvents = jobDetail?.events.slice(-5) ?? [];

  return (
    <section className="restoration-ai-panel" aria-label="AI 修补候选建议">
      <header>
        <div>
          <span>AI ADVISORY</span>
          <h4>AI 修补候选建议</h4>
        </div>
        <small>{displayProvider || "未配置 Provider"} / {displayModel || "未配置 Model"} / {displayReasoning}</small>
      </header>

      <label className="restoration-ai-provider">
        <span>RECOMMENDATION PROVIDER</span>
        <select
          value={provider}
          disabled={disabled || busy || running || providers.length === 0}
          onChange={(event) => onProviderChange(event.target.value)}
        >
          {providers.length === 0 && <option value="">无可用推荐 Provider</option>}
          {providers.map((item) => (
            <option key={item} value={item}>{item}</option>
          ))}
        </select>
      </label>

      <label className="restoration-ai-intent">
        <span>USER INTENT · 只推荐服务端候选，不直接改皮肤</span>
        <textarea
          value={userIntent}
          maxLength={1_000}
          rows={2}
          disabled={disabled || busy || running}
          placeholder="例如：优先使用当前皮肤同表面肤色，无法完整覆盖时选择手动肤色。"
          onChange={(event) => onUserIntentChange(event.target.value)}
        />
      </label>

      <div className="restoration-ai-actions">
        <button
          type="button"
          disabled={
            disabled ||
            busy ||
            running ||
            !candidates ||
            !provider ||
            !providers.includes(provider) ||
            !model.trim() ||
            !userIntent.trim()
          }
          onClick={onStart}
        >
          {running ? statusLabels[job?.status ?? "queued"] : "生成 AI 候选建议"}
        </button>
        {running && (
          <button type="button" disabled={busy} onClick={onCancel}>
            取消推荐
          </button>
        )}
      </div>

      {!candidates && (
        <p className="restoration-ai-note">请先生成确定性清理候选，再让 AI 在候选 ID 中给出建议。</p>
      )}
      {providers.length === 0 && (
        <p className="restoration-warning">当前没有支持修补候选推荐的 AI Provider。</p>
      )}

      {job && (
        <div className="restoration-ai-status" data-status={job.status}>
          <strong>{statusLabels[job.status]}</strong>
          <span>JOB {job.id}</span>
          {recentEvents.length > 0 && (
            <ol aria-label="AI 推荐实时事件">
              {recentEvents.map((event) => (
                <li key={event.id}>
                  <time>{formatEventTime(event.createdAt)}</time>
                  <span>{event.message}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}

      {result && (
        <div className="restoration-ai-result">
          <p>{result.summary}</p>
          <div className="restoration-ai-decisions">
            {result.decisions.map((decision) => {
              const selected = candidates?.base.candidates.find(
                (candidate) => candidate.id === decision.selectedCandidateId,
              );
              return (
                <article key={decision.targetGroupId}>
                  <header>
                    <span>{decision.targetGroupId}</span>
                    <b>{Math.round(decision.confidence * 100)}%</b>
                  </header>
                  <strong>{selected?.label ?? decision.selectedCandidateId ?? "不建议自动选择"}</strong>
                  <p>{decision.explanation}</p>
                </article>
              );
            })}
          </div>
          <button
            className="restoration-ai-load"
            type="button"
            disabled={!canLoad}
            onClick={onLoad}
          >
            载入建议到本地候选选择
          </button>
          <p className="restoration-ai-note">载入不会应用计划；仍需使用下方“应用清理计划”显式保存。</p>
        </div>
      )}

      {staleReason && result && <p className="restoration-warning">推荐已过期：{staleReason}</p>}
      {job?.error && <p className="composition-error" role="alert">{job.error.message}</p>}
      {error && <p className="composition-error" role="alert">{error}</p>}
    </section>
  );
}

function formatEventTime(value: string): string {
  const match = value.match(/T(\d{2}:\d{2}:\d{2})/);
  return match?.[1] ?? value;
}
