import type { ApiSemanticFollowup } from "../lib/revisionApi";

export interface SemanticFollowupReviewProps {
  readonly followup: ApiSemanticFollowup | null;
  readonly busy: boolean;
  readonly onApply: (suggestionId: string) => void;
  readonly onDismiss: () => void;
}

export function SemanticFollowupReview({
  followup,
  busy,
  onApply,
  onDismiss,
}: SemanticFollowupReviewProps) {
  if (!followup) return null;

  if (followup.status === "awaiting_review") {
    const isLegacy = !followup.applicable;
    return (
      <section className="semantic-followup-review" aria-label="分类修复确认">
        <header>
          <span>{isLegacy ? "历史分类建议" : "可选分类修复"}</span>
          <strong>{isLegacy ? "请使用当前规则重新分析" : "发现可能分错的跨部位区域"}</strong>
          <p>
            {isLegacy
              ? "这份旧建议仅供对照，不能直接改动皮肤。重新点击“智能分析皮肤”即可用当前规则复核。"
              : "这里只调整现有像素属于哪个部件，不会凭空绘制被遮挡的内容；确认前不会修改结果。"}
          </p>
        </header>
        <div className="semantic-followup-suggestions">
          {followup.suggestions.map((suggestion, index) => (
            <article key={suggestion.id}>
              <div>
                <strong>{suggestion.label || `推荐方案 ${index + 1}`}</strong>
                <small>{suggestion.pixelCount} 个候选像素 · 可信度 {Math.round(suggestion.confidence * 100)}%</small>
                <p>{suggestion.reason}</p>
              </div>
              {!isLegacy && (
                <button type="button" disabled={busy} onClick={() => onApply(suggestion.id)}>
                  {busy ? "处理中…" : "使用推荐分类修复版"}
                </button>
              )}
            </article>
          ))}
        </div>
        <button className="semantic-followup-dismiss" type="button" disabled={busy} onClick={onDismiss}>
          保留原识别
        </button>
        {followup.notices.map((notice) => <p className="semantic-followup-notice" key={`${notice.kind}:${notice.message}`}>{notice.message}</p>)}
      </section>
    );
  }

  const message = {
    no_repair: "未发现可安全建议的跨部位分类调整；原识别已保留，被遮挡的隐藏内容仍可能需要后续补全。",
    applied: "已生成分类修复版；原识别仍然保留。",
    dismissed: "已按用户选择保留原识别。",
    assessment_failed: "跨部位分类复核未完成，但已经生成的识别结果仍可使用。",
  }[followup.status];

  return (
    <div
      className="semantic-followup-result"
      data-status={followup.status}
      role="status"
      aria-live="polite"
    >
      <strong>{message}</strong>
      {followup.notices.map((notice) => <p key={`${notice.kind}:${notice.message}`}>{notice.message}</p>)}
    </div>
  );
}
