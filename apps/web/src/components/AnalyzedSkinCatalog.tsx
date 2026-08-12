import { useMemo, useState } from "react";
import type { AggregateKind } from "@mc-skin-split/skin-core";
import type {
  ApiAnalyzedSkin,
  ApiAnalyzedSkinGroup,
} from "../lib/revisionApi";

const kindLabels: Readonly<Record<AggregateKind, string>> = {
  hair: "完整头发",
  clothing: "完整衣服",
  accessory: "饰品组合",
};

type CatalogFilter = "all" | AggregateKind;

interface AnalyzedSkinCatalogProps {
  readonly items: readonly ApiAnalyzedSkin[];
  readonly busyGroupKey: string | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly selectedRevisionId: string | null;
  readonly onActivate: (item: ApiAnalyzedSkin) => void;
  readonly onExportGroup: (
    item: ApiAnalyzedSkin,
    group: ApiAnalyzedSkinGroup,
  ) => void;
}

export function AnalyzedSkinCatalog({
  items,
  busyGroupKey,
  loading,
  error,
  selectedRevisionId,
  onActivate,
  onExportGroup,
}: AnalyzedSkinCatalogProps) {
  const [filter, setFilter] = useState<CatalogFilter>("all");
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleItems = useMemo(
    () =>
      items
        .map((item) => ({
          ...item,
          groups:
            filter === "all"
              ? item.groups
              : item.groups.filter((group) => group.kind === filter),
        }))
        .filter((item) => {
          if (filter !== "all" && item.groups.length === 0) return false;
          if (!normalizedQuery) return true;
          return [
            item.project.name,
            item.revision.branchName,
            item.aiJob.provider,
            item.aiJob.model,
          ].some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
        }),
    [filter, items, normalizedQuery],
  );

  return (
    <section className="analyzed-catalog" aria-label="已分析皮肤目录">
      <header className="analyzed-catalog-heading">
        <div className="panel-heading">
          <span>A+</span>
          <div>
            <p>ANALYZED SKIN CATALOG</p>
            <h2>已分析皮肤与完整大类</h2>
          </div>
        </div>
        <p>
          展示每个结果 Revision 的最新成功识别；完整大类可整组入库，原有细分类仍单独保留。
        </p>
      </header>

      <div className="analyzed-catalog-tools">
        <div className="catalog-filter" aria-label="完整大类筛选">
          {(["all", "hair", "clothing", "accessory"] as const).map(
            (kind) => (
              <button
                key={kind}
                type="button"
                aria-pressed={filter === kind}
                onClick={() => setFilter(kind)}
              >
                {kind === "all" ? "全部" : kindLabels[kind]}
              </button>
            ),
          )}
        </div>
        <label>
          <span>SEARCH</span>
          <input
            type="search"
            value={query}
            placeholder="项目 / 模型 / 分支"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>

      <div
        className="analyzed-skin-grid"
        data-empty={!loading && visibleItems.length === 0}
      >
        {loading ? (
          <p className="catalog-empty">正在读取已分析 Revision…</p>
        ) : visibleItems.length === 0 ? (
          <p className="catalog-empty">
            尚无匹配的成功识别结果。完成一次 AI 识别后会自动进入这里。
          </p>
        ) : (
          visibleItems.map((item) => (
            <article
              key={item.revision.id}
              className="analyzed-skin-card"
              data-active={item.revision.id === selectedRevisionId}
            >
              <button
                className="analyzed-skin-select"
                type="button"
                aria-label={`载入 ${item.project.name} ${item.revision.branchName} #${item.revision.sequence}`}
                onClick={() => onActivate(item)}
              >
                <img src={item.skinUrl} alt="" />
                <span className="analyzed-skin-index">
                  {item.revision.branchName} / {String(item.revision.sequence).padStart(2, "0")}
                </span>
              </button>

              <div className="analyzed-skin-body">
                <div className="analyzed-skin-title">
                  <div>
                    <strong>{item.project.name}</strong>
                    <small>
                      {item.aiJob.provider} / {item.aiJob.model}
                    </small>
                  </div>
                  <time dateTime={item.aiJob.finishedAt}>
                    {formatCatalogTime(item.aiJob.finishedAt)}
                  </time>
                </div>

                <dl className="analyzed-skin-facts">
                  <div>
                    <dt>MODEL</dt>
                    <dd>{item.armType === "slim" ? "Slim / Alex" : "Wide / Classic"}</dd>
                  </div>
                  <div>
                    <dt>PARTS</dt>
                    <dd>{item.componentCount}</dd>
                  </div>
                  <div>
                    <dt>REVIEW</dt>
                    <dd>{item.reviewItemCount}</dd>
                  </div>
                  <div>
                    <dt>UNKNOWN</dt>
                    <dd>{item.unknownPixelCount} px</dd>
                  </div>
                </dl>

                <div className="aggregate-group-list" data-empty={item.groups.length === 0}>
                  {item.groups.length === 0 ? (
                    <p>此筛选下没有可组成完整大类的组件。</p>
                  ) : (
                    item.groups.map((group) => {
                      const busyKey = `${item.revision.id}:${group.key}`;
                      return (
                        <div key={group.key} className="aggregate-group-chip">
                          <span>
                            <strong>{group.displayName || kindLabels[group.kind]}</strong>
                            <small>
                              {group.componentCount} 组件 · {group.pixelCount} px
                            </small>
                          </span>
                          <button
                            type="button"
                            disabled={
                              Boolean(group.exportedBundleId) ||
                              busyGroupKey !== null
                            }
                            onClick={() => onExportGroup(item, group)}
                          >
                            {group.exportedBundleId
                              ? "已入库"
                              : busyGroupKey === busyKey
                                ? "入库中…"
                                : "整组入库"}
                          </button>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </article>
          ))
        )}
      </div>
      {error && (
        <p className="catalog-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function formatCatalogTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}
