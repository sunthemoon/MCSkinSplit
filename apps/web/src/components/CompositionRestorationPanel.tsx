import {
  SEMANTIC_CATEGORY_LABELS,
  type Rgba,
  type SemanticComponent,
} from "@mc-skin-split/skin-core";
import {
  componentMatchesRestorationMode,
  restorationCandidateKindLabel,
  type RestorationTargetMode,
} from "../lib/compositionRestoration";
import type {
  ApiCompositionRestorationCandidates,
  ApiCompositionRestorationPlan,
} from "../lib/revisionApi";

interface CompositionRestorationPanelProps {
  readonly components: readonly SemanticComponent[];
  readonly mode: RestorationTargetMode;
  readonly selectedFineIds: readonly string[];
  readonly donorRevisionId: string;
  readonly manualColor: string;
  readonly includeManualColor: boolean;
  readonly candidates: ApiCompositionRestorationCandidates | null;
  readonly selectedCandidateIds: readonly string[];
  readonly plan: ApiCompositionRestorationPlan | null;
  readonly coveredPixelCount: number;
  readonly missingPixelCount: number;
  readonly disabled: boolean;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onModeChange: (mode: RestorationTargetMode) => void;
  readonly onToggleFine: (componentId: string) => void;
  readonly onDonorRevisionIdChange: (revisionId: string) => void;
  readonly onManualColorChange: (value: string) => void;
  readonly onIncludeManualColorChange: (enabled: boolean) => void;
  readonly onGenerate: () => void;
  readonly onToggleCandidate: (candidateId: string) => void;
  readonly onApply: () => void;
  readonly onClear: () => void;
}

const modeLabels: Readonly<Record<RestorationTargetMode, string>> = {
  fine: "精细组件",
  clothing: "完整衣服",
  hair: "完整头发",
  accessory: "完整饰品",
};

export function CompositionRestorationPanel({
  components,
  mode,
  selectedFineIds,
  donorRevisionId,
  manualColor,
  includeManualColor,
  candidates,
  selectedCandidateIds,
  plan,
  coveredPixelCount,
  missingPixelCount,
  disabled,
  busy,
  error,
  onModeChange,
  onToggleFine,
  onDonorRevisionIdChange,
  onManualColorChange,
  onIncludeManualColorChange,
  onGenerate,
  onToggleCandidate,
  onApply,
  onClear,
}: CompositionRestorationPanelProps) {
  const visibleComponents = components.filter((component) =>
    componentMatchesRestorationMode(component, mode),
  );
  const targetComponentCount = mode === "fine"
    ? visibleComponents.filter((component) =>
        selectedFineIds.includes(component.instanceId),
      ).length
    : visibleComponents.length;
  const outerSelected = Boolean(
    candidates?.outer.candidateId &&
      selectedCandidateIds.includes(candidates.outer.candidateId),
  );

  return (
    <section className="composition-restoration-panel" aria-label="目标皮肤残留清理与肤色还原">
      <header>
        <div className="composition-section-title">
          <span>RESTORE TARGET</span>
          <h3>残留清理与肤色候选</h3>
        </div>
        <p>Outer 自动透明；Base 必须明确选择可追溯的肤色候选。</p>
      </header>

      <div className="restoration-mode-tabs" role="group" aria-label="替换范围">
        {(Object.keys(modeLabels) as RestorationTargetMode[]).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={mode === value}
            disabled={disabled || busy}
            onClick={() => onModeChange(value)}
          >
            {modeLabels[value]}
          </button>
        ))}
      </div>

      <div className="restoration-targets" data-empty={visibleComponents.length === 0}>
        {visibleComponents.length ? visibleComponents.map((component) => (
          <label key={component.instanceId}>
            <input
              type="checkbox"
              checked={mode === "fine" ? selectedFineIds.includes(component.instanceId) : true}
              disabled={disabled || busy || mode !== "fine"}
              onChange={() => onToggleFine(component.instanceId)}
            />
            <span>
              <strong>{component.displayName}</strong>
              <small>{SEMANTIC_CATEGORY_LABELS[component.category]}</small>
            </span>
          </label>
        )) : <p>选定 Revision 中没有这一大类的已确认组件。</p>}
      </div>

      <div className="restoration-source-fields">
        <label>
          <span>DONOR REVISION · 可选</span>
          <input
            value={donorRevisionId}
            maxLength={100}
            disabled={disabled || busy}
            placeholder="revision_xxx"
            onChange={(event) => onDonorRevisionIdChange(event.target.value)}
          />
        </label>
        <label>
          <span>
            <input
              type="checkbox"
              checked={includeManualColor}
              disabled={disabled || busy}
              onChange={(event) => onIncludeManualColorChange(event.target.checked)}
            />
            MANUAL SKIN COLOR · 候选项
          </span>
          <input type="color" value={manualColor} disabled={disabled || busy || !includeManualColor} onChange={(event) => onManualColorChange(event.target.value)} />
        </label>
      </div>

      <button
        className="restoration-generate"
        type="button"
        disabled={disabled || busy || targetComponentCount === 0}
        onClick={onGenerate}
      >
        {busy ? "正在校验候选…" : "生成确定性清理候选"}
      </button>

      {candidates && (
        <div className="restoration-candidates">
          <article className="restoration-outer-card" data-active={outerSelected}>
            <span>AUTO</span>
            <div>
              <strong>Outer 自动清除</strong>
              <small>{candidates.outer.pixelCount} px · 强制随计划应用</small>
            </div>
          </article>

          <div className="restoration-base-cards">
            {candidates.base.candidates.map((candidate) => {
              const selected = selectedCandidateIds.includes(candidate.id);
              return (
                <button
                  key={candidate.id}
                  type="button"
                  aria-pressed={selected}
                  disabled={disabled || busy}
                  onClick={() => onToggleCandidate(candidate.id)}
                >
                  <CandidateSwatch rgba={candidate.rgba} />
                  <span>
                    <small>{restorationCandidateKindLabel(candidate)} · {candidate.targetGroupId}</small>
                    <strong>{candidate.label}</strong>
                    <em>{candidate.description}</em>
                  </span>
                  <b>{candidate.coveragePixelCount}/{candidates.base.pixelCount}</b>
                </button>
              );
            })}
          </div>

          <dl className="restoration-coverage">
            <div><dt>OUTER</dt><dd>{candidates.outer.pixelCount}<small> px</small></dd></div>
            <div><dt>BASE</dt><dd>{candidates.base.pixelCount}<small> px</small></dd></div>
            <div><dt>COVERED</dt><dd>{coveredPixelCount}<small> px</small></dd></div>
            <div data-missing={missingPixelCount > 0}><dt>MISSING</dt><dd>{missingPixelCount}<small> px</small></dd></div>
          </dl>
        </div>
      )}

      <div className="restoration-plan-actions">
        <button
          type="button"
          disabled={disabled || busy || !candidates || selectedCandidateIds.length === 0 || missingPixelCount > 0}
          onClick={onApply}
        >
          应用清理计划并刷新 2D / 3D
        </button>
        <button type="button" disabled={disabled || busy || !plan} onClick={onClear}>
          清除已应用计划
        </button>
      </div>
      {missingPixelCount > 0 && candidates && (
        <p className="restoration-warning">仍有 {missingPixelCount} 个 Base 像素没有肤色来源；请选择完整覆盖候选或加入手动肤色。</p>
      )}
      {plan && <p className="restoration-saved">PLAN v{plan.version} · {plan.candidateIds.length} 个候选已验证</p>}
      {error && <p className="composition-error" role="alert">{error}</p>}
    </section>
  );
}

function CandidateSwatch({ rgba }: { readonly rgba?: Rgba }) {
  return (
    <i
      aria-hidden="true"
      style={rgba ? { backgroundColor: `rgba(${rgba[0]}, ${rgba[1]}, ${rgba[2]}, ${rgba[3] / 255})` } : undefined}
    />
  );
}
