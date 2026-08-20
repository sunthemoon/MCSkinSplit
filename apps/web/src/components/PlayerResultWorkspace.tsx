import {
  SEMANTIC_CATEGORY_LABELS,
  aggregateKindForCategory,
  type AggregateKind,
  type SemanticComponent,
} from "@mc-skin-split/skin-core";
import type {
  ApiCompletionProposalDetail,
  ApiRevision,
} from "../lib/revisionApi";
import type { CompletionCatalogContext } from "../lib/completionWorkspace";

export type PlayerResultSelection =
  | "current"
  | "original"
  | "repaired"
  | "completed"
  | "latent";

export interface PlayerCompletionResultSnapshot {
  readonly detail: ApiCompletionProposalDetail;
  readonly catalogContext: CompletionCatalogContext;
}

export interface PlayerResultWorkspaceProps {
  readonly revision: ApiRevision | null;
  readonly projectName: string | null;
  readonly completion: PlayerCompletionResultSnapshot | null;
  readonly selection: PlayerResultSelection;
  readonly components: readonly SemanticComponent[];
  readonly activeComponentId: string | null;
  readonly busy: boolean;
  readonly onSelectResult: (
    selection: PlayerResultSelection,
    revisionId?: string,
  ) => void;
  readonly onSelectComponent: (componentId: string) => void;
  readonly onDownloadPng: () => void;
  readonly onSavePart: () => void;
  readonly onSaveBundle: (kind: AggregateKind) => void;
  readonly onPublishLatentPart: () => void;
}

const BUNDLE_LABELS: Readonly<Record<AggregateKind, string>> = {
  hair: "完整头发",
  clothing: "完整衣服",
  accessory: "完整配饰",
};

export function PlayerResultWorkspace({
  revision,
  projectName,
  completion,
  selection,
  components,
  activeComponentId,
  busy,
  onSelectResult,
  onSelectComponent,
  onDownloadPng,
  onSavePart,
  onSaveBundle,
  onPublishLatentPart,
}: PlayerResultWorkspaceProps) {
  const accepted = completion?.detail.decision?.action === "accept"
    ? completion.detail.result
    : null;
  const latentSelected = selection === "latent" &&
    accepted?.representation === "latent_component";
  const expectedRevisionId = expectedSelectionRevisionId(
    selection,
    completion,
    revision?.id ?? null,
  );
  const exactRevisionLoaded = Boolean(
    revision && expectedRevisionId && revision.id === expectedRevisionId,
  );
  const selectedComponent = components.find(
    (component) => component.instanceId === activeComponentId,
  ) ?? null;
  const bundleCounts = countAggregateComponents(components);
  const canPersistRevisionAssets = exactRevisionLoaded && !latentSelected;
  const inferredSelection = selection === "completed" || latentSelected;

  return (
    <section
      id="workspace-result"
      className="player-result-workspace"
      aria-label="保存与导出所选结果"
      data-testid="player-result-workspace"
      data-player-result-surface
      tabIndex={-1}
    >
      <header className="player-result-heading">
        <div className="panel-heading">
          <span>04</span>
          <div>
            <p>CHOOSE · SAVE · EXPORT</p>
            <h2>保存明确选择的结果</h2>
          </div>
        </div>
        <p>
          先确认版本，再选择 PNG、单个组件或完整大类。这里只保存用户当前明确选择的结果。
        </p>
      </header>

      {completion ? (
        <ResultVariantChoices
          completion={completion}
          selection={selection}
          busy={busy}
          onSelectResult={onSelectResult}
        />
      ) : (
        <div className="player-result-single-choice">
          <span>CURRENT RESULT</span>
          <strong>{revision ? "当前版本" : "尚未选择结果"}</strong>
          <small>
            {revision
              ? `${revision.branchName} #${revision.sequence}`
              : "完成导入与识别后再保存"}
          </small>
        </div>
      )}

      <div className="player-result-summary" data-inferred={inferredSelection}>
        <div>
          <span>所选结果</span>
          <strong>{selectionLabel(selection, completion)}</strong>
        </div>
        <dl>
          <div><dt>项目</dt><dd>{projectName ?? "未选择项目"}</dd></div>
          <div>
            <dt>版本</dt>
            <dd>{revision ? `${revision.branchName} #${revision.sequence}` : "未载入"}</dd>
          </div>
          <div>
            <dt>来源</dt>
            <dd>{inferredSelection ? "包含推测生成内容" : "识别 / 玩家修正"}</dd>
          </div>
        </dl>
        {inferredSelection && (
          <p role="note">
            这个结果含有系统推测的隐藏内容，并非原作者不可见像素的真实恢复。
          </p>
        )}
        {!exactRevisionLoaded && !latentSelected && revision && (
          <p role="status">正在等待所选不可变版本载入；完成前不会导出其他版本。</p>
        )}
      </div>

      {latentSelected ? (
        <div className="player-result-latent-boundary">
          <strong>
            {accepted?.publishedAt
              ? "完成版组件已发布到部件库"
              : "完成版组件尚未发布"}
          </strong>
          <p>
            接受的是独立部件资产，源皮肤没有变化，也不能伪装成同时包含遮挡物与隐藏内容的单层 PNG。
          </p>
          <button
            type="button"
            data-testid="publish-latent-part"
            disabled={busy || Boolean(accepted?.publishedAt)}
            onClick={onPublishLatentPart}
          >
            {accepted?.publishedAt ? "已发布到部件库" : "发布完成版组件到部件库"}
          </button>
          <button type="button" disabled>
            完整大类组合包 · 尚未找到可验证的兼容项
          </button>
          <small>
            只有同一来源版本、同一大类且能明确替换原成员的现有组合包（Bundle）才能启用；当前尚未完成这种兼容性验证。
          </small>
        </div>
      ) : (
        <div className="player-result-actions">
          <article>
            <span>PNG</span>
            <strong>当前完整皮肤</strong>
            <p>仅可表示为单层 64×64 皮肤时下载。</p>
            <button
              type="button"
              disabled={busy || !canPersistRevisionAssets}
              onClick={onDownloadPng}
            >
              下载所选结果 PNG
            </button>
          </article>

          <article>
            <span>PART</span>
            <strong>所选组件</strong>
            <label>
              <span>组件名称</span>
              <select
                value={activeComponentId ?? ""}
                disabled={busy || !canPersistRevisionAssets || components.length === 0}
                onChange={(event) => onSelectComponent(event.target.value)}
              >
                {!activeComponentId && components.length > 0 && (
                  <option value="">选择一个组件</option>
                )}
                {components.length === 0 && <option value="">没有可保存组件</option>}
                {components.map((component) => (
                  <option key={component.instanceId} value={component.instanceId}>
                    {component.displayName} · {SEMANTIC_CATEGORY_LABELS[component.category]}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              disabled={busy || !canPersistRevisionAssets || !selectedComponent}
              onClick={onSavePart}
            >
              保存所选组件为部件资产
            </button>
          </article>

          <article>
            <span>BUNDLE</span>
            <strong>完整大类</strong>
            <p>按所选版本中同一大类的全部组件保存为组合包。</p>
            <div>
              {(Object.keys(BUNDLE_LABELS) as readonly AggregateKind[]).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  disabled={
                    busy ||
                    !canPersistRevisionAssets ||
                    !revision?.isBranchHead ||
                    bundleCounts[kind] === 0
                  }
                  onClick={() => onSaveBundle(kind)}
                >
                  {BUNDLE_LABELS[kind]} · {bundleCounts[kind]}
                </button>
              ))}
            </div>
            {!revision?.isBranchHead && revision && (
              <small>完整大类只能从当前分支的最新版本保存。</small>
            )}
          </article>
        </div>
      )}

      <details className="player-result-technical">
        <summary>高级信息 · 精确来源 ID</summary>
        <dl>
          <div><dt>Revision</dt><dd><code>{revision?.id ?? "未选择"}</code></dd></div>
          <div>
            <dt>Completion Result</dt>
            <dd><code>{accepted?.id ?? "没有补全结果"}</code></dd>
          </div>
        </dl>
      </details>
    </section>
  );
}

function ResultVariantChoices({
  completion,
  selection,
  busy,
  onSelectResult,
}: {
  readonly completion: PlayerCompletionResultSnapshot;
  readonly selection: PlayerResultSelection;
  readonly busy: boolean;
  readonly onSelectResult: (
    selection: PlayerResultSelection,
    revisionId?: string,
  ) => void;
}) {
  const accepted = completion.detail.decision?.action === "accept"
    ? completion.detail.result
    : null;
  return (
    <div className="player-result-variants" role="group" aria-label="选择要保存的结果版本">
      {completion.catalogContext.choices.map((choice) => (
        <button
          key={choice.kind}
          type="button"
          aria-pressed={selection === choice.kind}
          disabled={busy}
          onClick={() => onSelectResult(choice.kind, choice.revisionId)}
        >
          <span>{choice.kind === "original" ? "01" : "02"}</span>
          <strong>{choice.label}</strong>
          <small>{choice.detail}</small>
        </button>
      ))}
      {!completion.catalogContext.choices.some((choice) => choice.kind === "repaired") && (
        <button type="button" disabled>
          <span>02</span><strong>分类修复版</strong><small>没有创建这个版本</small>
        </button>
      )}
      {accepted?.representation === "skin_texel" && accepted.revision ? (
        <button
          type="button"
          aria-pressed={selection === "completed"}
          disabled={busy}
          onClick={() => onSelectResult("completed", accepted.revision!.id)}
        >
          <span>03</span><strong>已接受补全版</strong>
          <small>{accepted.revision.branchName} #{accepted.revision.sequence} · 可表示为 PNG</small>
        </button>
      ) : accepted?.representation === "latent_component" && accepted.latentPart ? (
        <button
          type="button"
          aria-pressed={selection === "latent"}
          disabled={busy}
          onClick={() => onSelectResult("latent")}
        >
          <span>03</span><strong>已接受完成版组件</strong>
          <small>
            {accepted.latentPart.name} · {accepted.publishedAt ? "已发布部件资产" : "未发布部件资产"}
          </small>
        </button>
      ) : (
        <button type="button" disabled>
          <span>03</span><strong>没有补全版</strong><small>保留原结果未创建新资产</small>
        </button>
      )}
    </div>
  );
}

function expectedSelectionRevisionId(
  selection: PlayerResultSelection,
  completion: PlayerCompletionResultSnapshot | null,
  currentRevisionId: string | null,
): string | null {
  if (!completion || selection === "current") return currentRevisionId;
  if (selection === "completed") {
    return completion.detail.result?.revision?.id ?? null;
  }
  if (selection === "latent") return null;
  return completion.catalogContext.choices.find((choice) =>
    choice.kind === selection)?.revisionId ?? null;
}

function selectionLabel(
  selection: PlayerResultSelection,
  completion: PlayerCompletionResultSnapshot | null,
): string {
  if (selection === "completed") return "已接受补全版本";
  if (selection === "latent") {
    return completion?.detail.result?.publishedAt
      ? "已接受完成版组件 · 已发布"
      : "已接受完成版组件 · 未发布";
  }
  if (selection === "original") return "原识别版本";
  if (selection === "repaired") return "分类修复版本";
  return completion ? "当前明确选择" : "当前版本";
}

function countAggregateComponents(
  components: readonly SemanticComponent[],
): Readonly<Record<AggregateKind, number>> {
  const counts: Record<AggregateKind, number> = {
    hair: 0,
    clothing: 0,
    accessory: 0,
  };
  for (const component of components) {
    const kind = aggregateKindForCategory(component.category);
    if (kind) counts[kind] += 1;
  }
  return counts;
}
