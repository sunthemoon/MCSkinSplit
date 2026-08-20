import { SEMANTIC_CATEGORY_LABELS } from "@mc-skin-split/skin-core";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  acceptCompletionCandidate,
  cancelAiJob,
  completionAllowedMaskUrl,
  completionCandidateGeneratedMaskUrl,
  completionCandidateTextureUrl,
  completionCandidateWriteMaskUrl,
  listAiJobs,
  listCompletionProposals,
  loadAiJobDetail,
  loadCompletionProposal,
  rejectCompletionProposal,
  startCompletionProposal,
  type ApiAiJob,
  type ApiCompletionCandidate,
  type ApiCompletionCandidateEditOutcome,
  type ApiCompletionProposalDetail,
  type ApiRevision,
  type ApiSegmentation,
  RevisionApiError,
} from "../lib/revisionApi";
import { CompletionCandidateManualEditor } from "./CompletionCandidateManualEditor";
import {
  COMPLETION_CONFIDENCE_LABELS,
  COMPLETION_STRATEGY_LABELS,
  completionOccludingComponents,
  completionTargetComponents,
  completionWorkspaceStep,
  componentPixelCount,
  hydrateSucceededCompletionJob,
  orderedCompletionCandidates,
  selectCompletionHydrationState,
  type CompletionCatalogContext,
} from "../lib/completionWorkspace";

const TERMINAL_JOB_STATUSES: ReadonlySet<ApiAiJob["status"]> = new Set([
  "succeeded",
  "failed",
  "cancelled",
] as const);

const COMPLETION_STEP_LABELS = [
  ["选择部件", "告诉系统要补哪里"],
  ["生成候选", "系统检查安全范围"],
  ["逐张对照", "查看纹理与两张蒙版"],
  ["选择结果", "接受或保留原结果"],
] as const;

export interface HiddenContentCompletionWorkspaceProps {
  readonly sourceRevision: ApiRevision | null;
  readonly sourceSkinUrl: string | null;
  readonly segmentation: ApiSegmentation | null;
  readonly catalogContext: CompletionCatalogContext | null;
  readonly disabled?: boolean;
  readonly onOpenRevision: (
    revisionId: string,
    destination: "source" | "result",
  ) => Promise<void>;
  readonly onDecision: (
    detail: ApiCompletionProposalDetail,
    catalogContext: CompletionCatalogContext,
    navigateToResult: boolean,
  ) => Promise<void>;
}

export function HiddenContentCompletionWorkspace({
  sourceRevision,
  sourceSkinUrl,
  segmentation,
  catalogContext,
  disabled = false,
  onOpenRevision,
  onDecision,
}: HiddenContentCompletionWorkspaceProps) {
  const [targetComponentId, setTargetComponentId] = useState<string | null>(null);
  const [occludingComponentIds, setOccludingComponentIds] =
    useState<readonly string[]>([]);
  const [job, setJob] = useState<ApiAiJob | null>(null);
  const [detail, setDetail] =
    useState<ApiCompletionProposalDetail | null>(null);
  const [selectedCandidateId, setSelectedCandidateId] =
    useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [sourceSwitching, setSourceSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const hydrationIdRef = useRef(0);

  const components = segmentation?.components ?? [];
  const targets = useMemo(
    () => completionTargetComponents(components),
    [components],
  );
  const occluders = useMemo(
    () => completionOccludingComponents(components, targetComponentId),
    [components, targetComponentId],
  );
  const candidates = useMemo(
    () => detail ? orderedCompletionCandidates(detail) : [],
    [detail],
  );
  const selectedCandidate = candidates.find(
    (candidate) => candidate.id === selectedCandidateId,
  ) ?? null;
  const step = completionWorkspaceStep({
    jobStatus: job?.status ?? null,
    detail,
  });
  const canUseSource = Boolean(
    sourceRevision && segmentation && sourceSkinUrl && catalogContext,
  );

  useEffect(() => {
    const hydrationId = ++hydrationIdRef.current;
    setTargetComponentId(null);
    setOccludingComponentIds([]);
    setSelectedCandidateId(null);
    setJob(null);
    setDetail(null);
    setError(null);
    setNotice(null);
    if (!sourceRevision || !catalogContext) return;

    let cancelled = false;
    setLoading(true);
    void Promise.all([
      listAiJobs({
        revisionId: sourceRevision.id,
        kind: "completion_proposal",
      }),
      listCompletionProposals({
        revisionId: sourceRevision.id,
        status: "all",
      }),
    ])
      .then(async ([jobs, proposals]) => {
        if (cancelled || hydrationId !== hydrationIdRef.current) return;
        const { job: latestJob, proposal: latestProposal } =
          selectCompletionHydrationState(jobs, proposals);
        setJob(latestJob ?? null);
        if (!latestProposal) return;
        const loaded = await loadCompletionProposal(latestProposal.proposal.id);
        if (cancelled || hydrationId !== hydrationIdRef.current) return;
        if (
          loaded.proposal.id !== latestProposal.proposal.id ||
          (latestJob && loaded.proposal.jobId !== latestJob.id)
        ) {
          throw new Error("补全详情与最新任务不匹配");
        }
        applyLoadedDetail(loaded);
      })
      .catch((caught: unknown) => {
        if (!cancelled && hydrationId === hydrationIdRef.current) {
          setError(errorMessage(caught, "补全记录读取失败"));
        }
      })
      .finally(() => {
        if (!cancelled && hydrationId === hydrationIdRef.current) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };

    function applyLoadedDetail(loaded: ApiCompletionProposalDetail) {
      setDetail(loaded);
      setTargetComponentId(loaded.proposal.targetComponentId);
      setOccludingComponentIds(loaded.proposal.occludingComponentIds);
      setSelectedCandidateId(loaded.decision?.candidateId ?? null);
      if (loaded.decision && catalogContext) {
        void onDecision(loaded, catalogContext, false);
      }
    }
  }, [
    catalogContext?.item.revision.id,
    catalogContext?.sourceKind,
    sourceRevision?.id,
  ]);

  useEffect(() => {
    if (!job || TERMINAL_JOB_STATUSES.has(job.status)) return;
    let stopped = false;
    let polling = false;
    let terminalReached = false;
    let timer: number | null = null;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const next = await loadAiJobDetail(job.id);
        if (stopped) return;
        if (next.job.kind !== "completion_proposal") {
          throw new Error("API 返回的任务不是隐藏内容候选任务");
        }
        if (next.job.status === "succeeded") {
          const loaded = await hydrateSucceededCompletionJob(
            next.job.id,
            (jobId) => listCompletionProposals({ jobId, status: "all" }),
            loadCompletionProposal,
          );
          if (!loaded) {
            throw new Error("任务已完成，但没有可审核的候选记录");
          }
          if (stopped) return;
          setDetail(loaded);
          setTargetComponentId(loaded.proposal.targetComponentId);
          setOccludingComponentIds(loaded.proposal.occludingComponentIds);
          setSelectedCandidateId(loaded.decision?.candidateId ?? null);
          setNotice(
            loaded.candidateCount > 0
              ? `已生成 ${loaded.candidateCount} 个候选，等待用户逐张对照`
              : "没有找到证据足够的候选，原结果保持不变",
          );
        }
        if (stopped) return;
        setJob(next.job);
        if (TERMINAL_JOB_STATUSES.has(next.job.status)) {
          terminalReached = true;
          if (timer !== null) window.clearInterval(timer);
        }
      } catch (caught) {
        if (!stopped) {
          setError(errorMessage(caught, "候选生成状态读取失败"));
        }
      } finally {
        polling = false;
      }
    };
    void poll();
    timer = window.setInterval(() => void poll(), 1_250);
    if (terminalReached) window.clearInterval(timer);
    return () => {
      stopped = true;
      if (timer !== null) window.clearInterval(timer);
    };
  }, [job?.id]);

  const chooseTarget = (componentId: string) => {
    setTargetComponentId(componentId);
    setOccludingComponentIds([]);
    setError(null);
  };

  const toggleOccluder = (componentId: string) => {
    setOccludingComponentIds((current) =>
      current.includes(componentId)
        ? current.filter((id) => id !== componentId)
        : [...current, componentId]);
  };

  const begin = async () => {
    if (!sourceRevision || !targetComponentId || occludingComponentIds.length === 0) {
      setError("请先选择一个目标部件和至少一个遮挡部件");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    setDetail(null);
    setSelectedCandidateId(null);
    try {
      const started = await startCompletionProposal(sourceRevision.id, {
        targetComponentId,
        occludingComponentIds,
        representation: "auto",
      });
      if (started.kind !== "completion_proposal") {
        throw new Error("API 返回的任务不是隐藏内容候选任务");
      }
      setJob(started);
      setNotice("候选生成已开始；不会自动接受，也不会改动当前结果");
    } catch (caught) {
      setError(errorMessage(caught, "候选生成启动失败"));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!job) return;
    setBusy(true);
    setError(null);
    try {
      const cancelled = await cancelAiJob(job.id);
      setJob(cancelled);
      setDetail(null);
      setNotice("候选生成已取消；未完成的提案不会出现在审核区");
    } catch (caught) {
      setError(errorMessage(caught, "取消候选生成失败"));
    } finally {
      setBusy(false);
    }
  };

  const accept = async () => {
    if (!detail || !selectedCandidate) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await acceptCompletionCandidate(
        detail.proposal,
        selectedCandidate,
        {
          summary: "接受玩家审核的隐藏内容候选",
        },
      );
      setDetail(outcome);
      if (catalogContext) {
        await onDecision(outcome, catalogContext, true);
      }
      setNotice(
        outcome.changed
          ? "已按用户选择创建不可变完成结果"
          : "这项选择已经记录，没有重复创建结果",
      );
    } catch (caught) {
      setError(decisionErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const keepOriginal = async () => {
    if (!detail) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await rejectCompletionProposal(detail.proposal, {
        reason: "玩家选择保留原分析结果",
      });
      setDetail(outcome);
      setSelectedCandidateId(null);
      if (catalogContext) {
        await onDecision(outcome, catalogContext, true);
      }
      setNotice(
        outcome.changed
          ? "已保留原结果；没有创建新版本或部件资产"
          : "保留原结果的选择已经记录，没有重复写入",
      );
    } catch (caught) {
      setError(decisionErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const applyEditedCandidate = (outcome: ApiCompletionCandidateEditOutcome) => {
    setDetail(outcome);
    setSelectedCandidateId(outcome.editedCandidateId);
    setNotice(
      outcome.changed
        ? "手工微调已生成派生候选；请继续精确对照后再决定是否接受"
        : "这组手工微调已经存在；已切换到同一张派生候选",
    );
  };

  const openRevision = async (
    revisionId: string,
    destination: "source" | "result",
  ) => {
    if (sourceSwitching || revisionId === sourceRevision?.id) return;
    setSourceSwitching(true);
    setError(null);
    try {
      await onOpenRevision(revisionId, destination);
    } finally {
      setSourceSwitching(false);
    }
  };

  return (
    <section
      id="workspace-completion"
      className="completion-workspace"
      aria-label="隐藏内容补全实验工作区"
      data-testid="completion-workspace"
      tabIndex={-1}
    >
      <header className="completion-heading">
        <div className="panel-heading">
          <span>EX</span>
          <div>
            <p>HIDDEN CONTENT · FEATURE PREVIEW</p>
            <h2>检查可能被遮住的衣服或头发</h2>
          </div>
        </div>
        <div className="completion-gate-badge">
          <strong>M21 前保持实验功能</strong>
          <span>仅在实验功能明确开启时出现</span>
        </div>
      </header>

      <div className="completion-inference-disclosure" role="note">
        <strong>这里展示的是有证据的推测，不是原作者隐藏像素的真实恢复。</strong>
        <p>
          候选由系统在固定 UV 和安全范围内生成。任何可信度或 AI 排序都不会自动接受、发布部件或修改当前版本。
        </p>
      </div>

      <CompletionProgress activeStep={step} />

      {!canUseSource ? (
        <div className="completion-source-required">
          <strong>请先载入一个已分析结果</strong>
          <p>
            从“已分析皮肤目录”选择原识别或分类修复版。普通上传或尚未完成识别的版本不会启动隐藏内容推测。
          </p>
        </div>
      ) : (
        <>
          <div className="completion-source-strip">
            <div className="completion-current-source">
              <span>正在使用</span>
              <strong>
                {catalogContext!.sourceKind === "repaired"
                  ? "分类修复版"
                  : "原识别"}
              </strong>
              <small>
                {sourceRevision!.branchName} #{sourceRevision!.sequence}
              </small>
            </div>
            <div
              className="completion-source-choices"
              role="group"
              aria-label="选择隐藏内容检查使用的分析版本"
            >
              {catalogContext!.choices.map((choice) => (
                <button
                  key={choice.kind}
                  type="button"
                  aria-pressed={choice.selected}
                  disabled={
                    disabled || busy || sourceSwitching || choice.selected
                  }
                  onClick={() =>
                    void openRevision(choice.revisionId, "source")}
                >
                  <strong>{choice.label}</strong>
                  <small>{choice.detail}</small>
                </button>
              ))}
            </div>
            <p>
              目标与遮挡部件都来自所选版本；切换后会重新读取对应组件。
              {sourceSwitching ? " 正在切换…" : ""}
            </p>
          </div>

          {!detail?.decision && (
            <CompletionSetup
              targets={targets}
              occluders={occluders}
              targetComponentId={targetComponentId}
              occludingComponentIds={occludingComponentIds}
              disabled={disabled || busy || Boolean(job && !TERMINAL_JOB_STATUSES.has(job.status)) || Boolean(detail)}
              busy={busy}
              onChooseTarget={chooseTarget}
              onToggleOccluder={toggleOccluder}
              onBegin={() => void begin()}
            />
          )}

          {job && !detail && (
            <CompletionJobStatus
              job={job}
              busy={busy}
              onCancel={() => void cancel()}
              onStartAgain={() => {
                setJob(null);
                setError(null);
                setNotice(null);
              }}
            />
          )}

          {detail && !detail.decision && (
            <CompletionCandidateReview
              armType={segmentation!.source.armType}
              detail={detail}
              sourceSkinUrl={sourceSkinUrl!}
              selectedCandidateId={selectedCandidateId}
              busy={busy || disabled}
              onSelectCandidate={setSelectedCandidateId}
              onAccept={() => void accept()}
              onKeepOriginal={() => void keepOriginal()}
              onEdited={applyEditedCandidate}
            />
          )}

          {detail?.decision && (
            <CompletionResultChoice
              detail={detail}
              catalogContext={catalogContext!}
              switching={sourceSwitching}
              onOpenRevision={(revisionId) =>
                void openRevision(revisionId, "result")}
            />
          )}
        </>
      )}

      {loading && <p className="completion-status" role="status">正在读取已有补全记录…</p>}
      {notice && <p className="completion-notice" role="status">{notice}</p>}
      {error && <p className="completion-error" role="alert">{error}</p>}
    </section>
  );
}

function CompletionProgress({ activeStep }: { readonly activeStep: number }) {
  return (
    <ol className="completion-progress" aria-label="隐藏内容补全四步进度">
      {COMPLETION_STEP_LABELS.map(([label, detail], index) => {
        const step = index + 1;
        const state = step < activeStep
          ? "complete"
          : step === activeStep
            ? "current"
            : "upcoming";
        return (
          <li key={label} data-state={state} aria-current={state === "current" ? "step" : undefined}>
            <span>{String(step).padStart(2, "0")}</span>
            <div><strong>{label}</strong><small>{detail}</small></div>
          </li>
        );
      })}
    </ol>
  );
}

interface CompletionSetupProps {
  readonly targets: ReturnType<typeof completionTargetComponents>;
  readonly occluders: ReturnType<typeof completionOccludingComponents>;
  readonly targetComponentId: string | null;
  readonly occludingComponentIds: readonly string[];
  readonly disabled: boolean;
  readonly busy: boolean;
  readonly onChooseTarget: (componentId: string) => void;
  readonly onToggleOccluder: (componentId: string) => void;
  readonly onBegin: () => void;
}

function CompletionSetup({
  targets,
  occluders,
  targetComponentId,
  occludingComponentIds,
  disabled,
  busy,
  onChooseTarget,
  onToggleOccluder,
  onBegin,
}: CompletionSetupProps) {
  return (
    <div className="completion-setup">
      <fieldset disabled={disabled}>
        <legend>1. 要补全哪个部件？</legend>
        <p>只能选择已有可见证据的衣服或头发。</p>
        <div className="completion-component-options">
          {targets.map((component) => (
            <label key={component.instanceId}>
              <input
                type="radio"
                name="completion-target"
                checked={targetComponentId === component.instanceId}
                onChange={() => onChooseTarget(component.instanceId)}
              />
              <span>
                <strong>{component.displayName}</strong>
                <small>{SEMANTIC_CATEGORY_LABELS[component.category]} · {componentPixelCount(component)} px 可见</small>
              </span>
            </label>
          ))}
          {targets.length === 0 && <p className="completion-empty">这个结果里没有可用的衣服或头发组件。</p>}
        </div>
      </fieldset>

      <fieldset disabled={disabled || !targetComponentId}>
        <legend>2. 是什么挡住了它？</legend>
        <p>衣服可由头发或饰品遮挡；头发只由饰品遮挡。</p>
        <div className="completion-component-options">
          {occluders.map((component) => (
            <label key={component.instanceId}>
              <input
                type="checkbox"
                checked={occludingComponentIds.includes(component.instanceId)}
                onChange={() => onToggleOccluder(component.instanceId)}
              />
              <span>
                <strong>{component.displayName}</strong>
                <small>{SEMANTIC_CATEGORY_LABELS[component.category]} · {componentPixelCount(component)} px 可见</small>
              </span>
            </label>
          ))}
          {targetComponentId && occluders.length === 0 && (
            <p className="completion-empty">没有找到符合规则的可见遮挡部件。</p>
          )}
        </div>
      </fieldset>

      <div className="completion-start-row">
        <div>
          <strong>组件编号由系统记录</strong>
          <p>普通流程只选择名称；技术编号和运行参数由系统记录。</p>
        </div>
        <button
          type="button"
          disabled={disabled || !targetComponentId || occludingComponentIds.length === 0}
          onClick={onBegin}
        >
          {busy ? "正在启动…" : "生成补全候选"}
        </button>
      </div>
      <details className="completion-advanced-ids">
        <summary>高级信息 · 组件原始 ID</summary>
        <dl>
          <div><dt>目标</dt><dd><code>{targetComponentId ?? "未选择"}</code></dd></div>
          <div><dt>遮挡</dt><dd><code>{occludingComponentIds.join(", ") || "未选择"}</code></dd></div>
        </dl>
      </details>
    </div>
  );
}

function CompletionJobStatus({
  job,
  busy,
  onCancel,
  onStartAgain,
}: {
  readonly job: ApiAiJob;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onStartAgain: () => void;
}) {
  const running = !TERMINAL_JOB_STATUSES.has(job.status);
  const labels = {
    queued: "等待系统检查",
    preparing: "读取版本证据",
    running: "生成有界候选",
    validating: "校验纹理、蒙版与来源",
    succeeded: "候选已经生成",
    failed: "候选生成失败",
    cancelled: "候选生成已取消",
  } as const;
  return (
    <div className="completion-job" data-status={job.status} role="status">
      <span>{running ? "STEP 02" : "GENERATION RECORD"}</span>
      <strong>{labels[job.status]}</strong>
      <p>
        {running
          ? "当前版本不会在后台被修改；只有用户之后明确接受候选才会创建结果。"
          : job.error?.message ?? "运行记录已保存。"}
      </p>
      {running ? (
        <button type="button" disabled={busy} onClick={onCancel}>取消生成</button>
      ) : job.status !== "succeeded" ? (
        <button type="button" disabled={busy} onClick={onStartAgain}>重新选择部件</button>
      ) : null}
      <details>
        <summary>高级信息 · 任务记录</summary>
        <code>{job.id}</code>
      </details>
    </div>
  );
}

export interface CompletionCandidateReviewProps {
  readonly armType: ApiSegmentation["source"]["armType"];
  readonly detail: ApiCompletionProposalDetail;
  readonly sourceSkinUrl: string;
  readonly selectedCandidateId: string | null;
  readonly busy: boolean;
  readonly onSelectCandidate: (candidateId: string) => void;
  readonly onAccept: () => void;
  readonly onKeepOriginal: () => void;
  readonly onEdited: (outcome: ApiCompletionCandidateEditOutcome) => void;
}

export function CompletionCandidateReview({
  armType,
  detail,
  sourceSkinUrl,
  selectedCandidateId,
  busy,
  onSelectCandidate,
  onAccept,
  onKeepOriginal,
  onEdited,
}: CompletionCandidateReviewProps) {
  const [hasPendingManualEdits, setHasPendingManualEdits] = useState(false);
  const candidates = orderedCompletionCandidates(detail);
  const selected = candidates.find((candidate) =>
    candidate.id === selectedCandidateId) ?? null;
  useEffect(() => {
    setHasPendingManualEdits(false);
  }, [selectedCandidateId]);
  return (
    <div className="completion-review">
      <header>
        <div>
          <span>STEP 03 · EXACT REVIEW</span>
          <h3>逐张选择，不会自动采用推荐</h3>
        </div>
        <dl>
          <div><dt>表示方式</dt><dd>{representationLabel(detail.proposal.representation)}</dd></div>
          <div><dt>允许范围</dt><dd>{detail.proposal.allowedGeneratedPixelCount} px</dd></div>
          <div><dt>候选</dt><dd>{detail.candidateCount}</dd></div>
        </dl>
      </header>

      {detail.ranking && (
        <div className="completion-ranking" data-status={detail.ranking.recommendation.status}>
          <strong>
            {detail.ranking.recommendation.status === "recommend"
              ? "AI 仅建议优先查看一个候选"
              : "AI 建议暂缓选择"}
          </strong>
          <p>{detail.ranking.recommendation.explanation}</p>
          <small>这是只读排序意见；界面不会预选，也不会自动接受。</small>
        </div>
      )}

      {candidates.length === 0 ? (
        <div className="completion-zero-candidates">
          <strong>没有证据足够的候选</strong>
          <p>这是正常结果。系统不会用任意颜色填满缺口，原版本完全不变。</p>
        </div>
      ) : (
        <fieldset className="completion-candidate-list" disabled={busy}>
          <legend>选择一张候选进行精确对照</legend>
          {candidates.map((candidate, index) => (
            <label key={candidate.id} data-selected={selectedCandidateId === candidate.id}>
              <input
                type="radio"
                name="completion-candidate"
                checked={selectedCandidateId === candidate.id}
                onChange={() => onSelectCandidate(candidate.id)}
              />
              <span>
                <strong>候选 {index + 1} · {COMPLETION_STRATEGY_LABELS[candidate.strategy]}</strong>
                <small>{candidate.pixelCount} px · {COMPLETION_CONFIDENCE_LABELS[candidate.confidence]}</small>
              </span>
              {detail.ranking?.recommendation.candidateId === candidate.id && (
                <em>建议先看</em>
              )}
            </label>
          ))}
        </fieldset>
      )}

      {selected && (
        <>
          <CompletionCandidateComparison
            detail={detail}
            candidate={selected}
            sourceSkinUrl={sourceSkinUrl}
          />
          <CompletionCandidateManualEditor
            key={selected.id}
            armType={armType}
            detail={detail}
            candidate={selected}
            disabled={busy}
            onEdited={onEdited}
            onPendingChange={setHasPendingManualEdits}
          />
        </>
      )}

      <div className="completion-decision-actions">
        <button
          className="completion-accept"
          type="button"
          disabled={busy || !selected || hasPendingManualEdits}
          onClick={onAccept}
        >
          {busy
            ? "正在记录…"
            : hasPendingManualEdits
              ? "先应用或取消微调"
              : "接受所选候选"}
        </button>
        <button
          className="completion-keep"
          type="button"
          disabled={busy}
          onClick={onKeepOriginal}
        >
          保留原结果
        </button>
      </div>
      <p className="completion-decision-note">
        接受只处理当前明确选择且已提交的候选；保留原结果只记录决定，不创建新版本或部件资产。
      </p>
    </div>
  );
}

function CompletionCandidateComparison({
  detail,
  candidate,
  sourceSkinUrl,
}: {
  readonly detail: ApiCompletionProposalDetail;
  readonly candidate: ApiCompletionCandidate;
  readonly sourceSkinUrl: string;
}) {
  const proposalId = detail.proposal.id;
  const textureUrl = completionCandidateTextureUrl(proposalId, candidate.id);
  return (
    <section className="completion-comparison" aria-label="所选候选精确纹理与遮罩对照">
      <div className="completion-asset-card">
        <span>ORIGINAL</span>
        <strong>当前结果纹理</strong>
        <PixelAssetImage src={sourceSkinUrl} alt="当前已分析版本的原始纹理" />
      </div>
      <div className="completion-asset-card">
        <span>CANDIDATE TEXTURE</span>
        <strong>候选新增纹理</strong>
        <PixelAssetImage src={textureUrl} alt="所选候选的精确新增纹理" />
      </div>
      <div className="completion-asset-card">
        <span>WRITE AREA</span>
        <strong>将写入的位置</strong>
        <PixelAssetImage
          src={completionCandidateWriteMaskUrl(proposalId, candidate.id)}
          alt="所选候选的精确写入遮罩"
        />
      </div>
      <div className="completion-asset-card">
        <span>INFERRED AREA</span>
        <strong>推测生成的位置</strong>
        <PixelAssetImage
          src={completionCandidateGeneratedMaskUrl(proposalId, candidate.id)}
          alt="所选候选的精确推测来源遮罩"
        />
      </div>
      {candidate.representation === "skin_texel" ? (
        <div className="completion-asset-card completion-result-overlay">
          <span>EXPECTED RESULT</span>
          <strong>接受后的像素叠加</strong>
          <div>
            <PixelAssetImage src={sourceSkinUrl} alt="接受前的当前纹理" />
            <PixelAssetImage src={textureUrl} alt="叠加到当前纹理上的候选新增像素" />
          </div>
        </div>
      ) : (
        <div className="completion-latent-preview-note">
          <strong>同层隐藏内容不能叠进一张皮肤 PNG</strong>
          <p>这里精确展示新增纹理和位置蒙版；接受后得到未发布的完成版组件，不会覆盖遮挡物或伪装成单层皮肤。</p>
        </div>
      )}
      <details className="completion-allowed-mask">
        <summary>高级对照 · 系统允许生成的完整范围</summary>
        <PixelAssetImage
          src={completionAllowedMaskUrl(proposalId)}
          alt="系统校验的完整允许生成遮罩"
        />
        <dl>
          <div><dt>Proposal</dt><dd><code>{proposalId}</code></dd></div>
          <div><dt>Candidate</dt><dd><code>{candidate.id}</code></dd></div>
          <div><dt>Candidate Hash</dt><dd><code>{candidate.candidateHash}</code></dd></div>
        </dl>
      </details>
    </section>
  );
}

export function CompletionResultChoice({
  detail,
  catalogContext,
  switching = false,
  onOpenRevision,
}: {
  readonly detail: ApiCompletionProposalDetail;
  readonly catalogContext: CompletionCatalogContext;
  readonly switching?: boolean;
  readonly onOpenRevision: (revisionId: string) => void;
}) {
  const accepted = detail.decision?.action === "accept" ? detail.result : null;
  return (
    <section
      className="completion-result-choice"
      aria-label="选择要继续使用的结果"
      data-testid="completion-result-choice"
      tabIndex={-1}
    >
      <header>
        <span>STEP 04 · RESULT</span>
        <h3>{accepted ? "完成结果已按用户选择创建" : "已保留原分析结果"}</h3>
        <p>下面每项都绑定明确的不可变版本或部件资产，不会把不同结果混在一起。</p>
      </header>
      <div className="completion-result-options">
        {catalogContext.choices.map((choice) => (
          <button
            key={choice.kind}
            type="button"
            aria-pressed={!accepted && choice.selected}
            disabled={switching}
            onClick={() => onOpenRevision(choice.revisionId)}
          >
            <span>{choice.kind === "original" ? "01" : "02"}</span>
            <strong>{choice.label}</strong>
            <small>{choice.detail}</small>
          </button>
        ))}
        {!catalogContext.choices.some((choice) => choice.kind === "repaired") && (
          <button type="button" disabled>
            <span>02</span>
            <strong>分类修复版</strong>
            <small>这次识别没有创建分类修复版本</small>
          </button>
        )}
        {accepted ? (
          accepted.representation === "skin_texel" && accepted.revision ? (
            <button
              className="completion-result-completed"
              type="button"
              aria-pressed="true"
              disabled={switching}
              onClick={() => onOpenRevision(accepted.revision!.id)}
            >
              <span>03</span>
              <strong>已接受补全版</strong>
              <small>{accepted.revision.branchName} #{accepted.revision.sequence} · 可表示为 PNG</small>
            </button>
          ) : accepted.latentPart ? (
            <article className="completion-result-latent" aria-current="true">
              <span>03</span>
              <strong>已接受完成版组件</strong>
              <small>
                {accepted.latentPart.name} · {accepted.publishedAt ? "已发布部件资产" : "未发布部件资产"}
              </small>
              <p>源版本与皮肤 PNG 没有变化；该组件不会自动进入普通部件库或完整大类组合包。</p>
              <div>
                <p>
                  {accepted.publishedAt
                    ? "已在保存/导出步骤明确发布到部件库。"
                    : "可在保存/导出步骤明确发布到部件库。"}
                </p>
                <button type="button" disabled>保存完整大类 · 需先有对应组合包</button>
              </div>
            </article>
          ) : null
        ) : (
          <article className="completion-result-none">
            <span>03</span>
            <strong>没有创建补全版</strong>
            <small>保留原结果不会创建新版本或部件资产</small>
          </article>
        )}
      </div>
      {accepted?.representation === "latent_component" && (
        <p className="completion-latent-boundary">
          同层遮挡结果只能作为组件或未来的完整大类组合包明确发布，不能下载成同时包含遮挡物与隐藏像素的单层 PNG。
        </p>
      )}
      <details className="completion-result-technical">
        <summary>高级信息 · 不可变决定与结果 ID</summary>
        <dl>
          <div><dt>Decision</dt><dd><code>{detail.decision?.id}</code></dd></div>
          <div><dt>Result</dt><dd><code>{detail.result?.id ?? "没有结果资产"}</code></dd></div>
          <div><dt>Source</dt><dd><code>{detail.proposal.sourceRevisionId}</code></dd></div>
        </dl>
      </details>
    </section>
  );
}

function PixelAssetImage({ src, alt }: { readonly src: string; readonly alt: string }) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const resolvedSrc = attempt === 0 ? src : appendRetry(src, attempt);
  return (
    <div className="completion-pixel-asset" data-error={failed}>
      <img
        src={resolvedSrc}
        alt={alt}
        onLoad={() => setFailed(false)}
        onError={() => setFailed(true)}
      />
      {failed && (
        <button
          type="button"
          onClick={() => {
            setFailed(false);
            setAttempt((current) => current + 1);
          }}
        >
          重新读取图片
        </button>
      )}
    </div>
  );
}

function representationLabel(value: "skin_texel" | "latent_component"): string {
  return value === "skin_texel"
    ? "安全写入透明皮肤像素"
    : "独立完成版组件";
}

function decisionErrorMessage(error: unknown): string {
  if (error instanceof RevisionApiError && error.status === 409) {
    return `来源或候选已经变化，本次没有写入任何结果：${error.message}`;
  }
  return errorMessage(error, "结果选择保存失败");
}

function errorMessage(error: unknown, prefix: string): string {
  return `${prefix}：${error instanceof Error ? error.message : String(error)}`;
}

function appendRetry(url: string, attempt: number): string {
  return `${url}${url.includes("?") ? "&" : "?"}retry=${attempt}`;
}
