import { useEffect, useMemo, useRef, useState } from "react";
import type { AggregateKind } from "@mc-skin-split/skin-core";
import type {
  ApiAnalyzedSkin,
  ApiAnalyzedSkinGroup,
  ApiAnalyzedSkinCatalogStatusFilter,
} from "../lib/revisionApi";

const kindLabels: Readonly<Record<AggregateKind, string>> = {
  hair: "完整头发",
  clothing: "完整衣服",
  accessory: "饰品组合",
};

type CatalogFilter = "all" | AggregateKind;
export type CatalogStatusFilter = ApiAnalyzedSkinCatalogStatusFilter;

export interface AnalyzedSkinCatalogFilters {
  readonly kind: CatalogFilter;
  readonly status: CatalogStatusFilter;
  readonly query: string;
}

interface AnalyzedSkinCatalogProps {
  readonly items: readonly ApiAnalyzedSkin[];
  readonly busyGroupKey: string | null;
  readonly busyRevisionIds: ReadonlySet<string>;
  readonly loading: boolean;
  readonly error: string | null;
  readonly selectedRevisionId: string | null;
  readonly initialStatusFilter?: CatalogStatusFilter;
  readonly onActivate: (item: ApiAnalyzedSkin) => void;
  readonly onExportGroup: (
    item: ApiAnalyzedSkin,
    group: ApiAnalyzedSkinGroup,
  ) => void;
  readonly onArchive: (
    item: ApiAnalyzedSkin,
    reason?: string,
  ) => Promise<boolean>;
  readonly onRestore: (item: ApiAnalyzedSkin) => Promise<boolean>;
}

export function filterAnalyzedSkinCatalog(
  items: readonly ApiAnalyzedSkin[],
  filters: AnalyzedSkinCatalogFilters,
): readonly ApiAnalyzedSkin[] {
  const normalizedQuery = filters.query.trim().toLocaleLowerCase();
  return items
    .filter(
      (item) =>
        filters.status === "all" || item.catalogStatus === filters.status,
    )
    .map((item) => ({
      ...item,
      groups:
        filters.kind === "all"
          ? item.groups
          : item.groups.filter((group) => group.kind === filters.kind),
    }))
    .filter((item) => {
      if (filters.kind !== "all" && item.groups.length === 0) return false;
      if (!normalizedQuery) return true;
      return [
        item.project.name,
        item.revision.branchName,
        `#${item.revision.sequence}`,
        item.aiJob.provider,
        item.aiJob.model,
        item.archivedReason ?? "",
      ].some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
    });
}

export function analyzedSkinArchiveDescription(item: ApiAnalyzedSkin): string {
  return `归档后默认目录会隐藏“${item.project.name} · ${item.revision.branchName} #${item.revision.sequence}”。Revision、AI 运行记录以及已入库组件/完整大类不会删除。`;
}

export function AnalyzedSkinCatalog({
  items,
  busyGroupKey,
  busyRevisionIds,
  loading,
  error,
  selectedRevisionId,
  initialStatusFilter = "active",
  onActivate,
  onExportGroup,
  onArchive,
  onRestore,
}: AnalyzedSkinCatalogProps) {
  const [filter, setFilter] = useState<CatalogFilter>("all");
  const [statusFilter, setStatusFilter] =
    useState<CatalogStatusFilter>(initialStatusFilter);
  const [query, setQuery] = useState("");
  const [archiveArmedRevisionId, setArchiveArmedRevisionId] =
    useState<string | null>(null);
  const [archiveReason, setArchiveReason] = useState("");
  const [pendingFocusRevisionId, setPendingFocusRevisionId] =
    useState<string | null>(null);
  const archiveReasonInputRef = useRef<HTMLInputElement>(null);
  const lifecycleButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const statusFilterButtonRefs = useRef(
    new Map<CatalogStatusFilter, HTMLButtonElement>(),
  );
  const visibleItems = useMemo(
    () =>
      filterAnalyzedSkinCatalog(items, {
        kind: filter,
        status: statusFilter,
        query,
      }),
    [filter, items, query, statusFilter],
  );
  const statusCounts = useMemo(
    () => ({
      active: items.filter((item) => item.catalogStatus === "active").length,
      archived: items.filter((item) => item.catalogStatus === "archived").length,
      all: items.length,
    }),
    [items],
  );

  useEffect(() => {
    if (archiveArmedRevisionId) archiveReasonInputRef.current?.focus();
  }, [archiveArmedRevisionId]);

  useEffect(() => {
    if (!pendingFocusRevisionId) return;
    const button = lifecycleButtonRefs.current.get(pendingFocusRevisionId);
    if (!button) {
      statusFilterButtonRefs.current.get(statusFilter)?.focus();
      setPendingFocusRevisionId(null);
      return;
    }
    button.focus();
    setPendingFocusRevisionId(null);
  }, [items, pendingFocusRevisionId, statusFilter]);

  const rememberLifecycleButton = (
    revisionId: string,
    button: HTMLButtonElement | null,
  ) => {
    if (button) lifecycleButtonRefs.current.set(revisionId, button);
    else lifecycleButtonRefs.current.delete(revisionId);
  };

  const armArchive = (revisionId: string) => {
    setArchiveArmedRevisionId(revisionId);
    setArchiveReason("");
  };

  const cancelArchive = () => {
    if (archiveArmedRevisionId) {
      setPendingFocusRevisionId(archiveArmedRevisionId);
    }
    setArchiveArmedRevisionId(null);
    setArchiveReason("");
  };

  const archiveItem = async (item: ApiAnalyzedSkin) => {
    const succeeded = await onArchive(
      item,
      archiveReason.trim() || undefined,
    );
    if (!succeeded) return;
    setPendingFocusRevisionId(item.revision.id);
    cancelArchive();
    setStatusFilter("archived");
  };

  const restoreItem = async (item: ApiAnalyzedSkin) => {
    const succeeded = await onRestore(item);
    if (succeeded) {
      setPendingFocusRevisionId(item.revision.id);
      setStatusFilter("active");
    }
  };

  return (
    <section
      id="workspace-catalog"
      className="analyzed-catalog"
      aria-label="已分析皮肤目录"
      data-workflow-section
      tabIndex={-1}
    >
      <header className="analyzed-catalog-heading">
        <div className="panel-heading">
          <span>A+</span>
          <div>
            <p>ANALYZED SKIN CATALOG</p>
            <h2>已分析皮肤与完整大类</h2>
          </div>
        </div>
        <p>
          默认展示目录中的成功识别；重复结果可归档并随时恢复，Revision、AI 记录和已入库资产保持不变。
        </p>
      </header>

      <div className="analyzed-catalog-tools">
        <div className="analyzed-catalog-tool-groups">
          <div className="catalog-filter-group">
            <span>STATUS</span>
            <div className="catalog-filter" aria-label="目录状态筛选">
              {([
                ["active", "当前目录"],
                ["archived", "已归档"],
                ["all", "全部"],
              ] as const).map(([status, label]) => (
                <button
                  key={status}
                  type="button"
                  ref={(button) => {
                    if (button) statusFilterButtonRefs.current.set(status, button);
                    else statusFilterButtonRefs.current.delete(status);
                  }}
                  aria-pressed={statusFilter === status}
                  onClick={() => setStatusFilter(status)}
                >
                  {label} {statusCounts[status]}
                </button>
              ))}
            </div>
          </div>
          <div className="catalog-filter-group">
            <span>COMPLETE SET</span>
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
          </div>
        </div>
        <label>
          <span>SEARCH</span>
          <input
            type="search"
            value={query}
            placeholder="项目 / 模型 / 分支 / 归档原因"
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
            {statusFilter === "archived"
              ? "尚无匹配的已归档结果。"
              : "尚无匹配的成功识别结果。完成一次 AI 识别后会自动进入这里。"}
          </p>
        ) : (
          visibleItems.map((item) => {
            const revisionId = item.revision.id;
            const lifecycleBusy = busyRevisionIds.has(revisionId);
            const archiveArmed = archiveArmedRevisionId === revisionId;
            const confirmationId = `catalog-archive-${revisionId.replace(/[^a-zA-Z0-9_-]/gu, "-")}`;
            return (
              <article
                key={revisionId}
                className="analyzed-skin-card"
                data-active={revisionId === selectedRevisionId}
                data-catalog-status={item.catalogStatus}
                aria-busy={lifecycleBusy || undefined}
              >
                <button
                  className="analyzed-skin-select"
                  type="button"
                  aria-label={`${item.catalogStatus === "archived" ? "载入历史" : "载入"} ${item.project.name} ${item.revision.branchName} #${item.revision.sequence}`}
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

                  {item.catalogStatus === "archived" && (
                    <p className="analyzed-skin-archive-state">
                      <strong>已归档</strong>
                      {item.archivedAt && ` · ${formatCatalogTime(item.archivedAt)}`}
                      {item.archivedReason && ` · ${item.archivedReason}`}
                    </p>
                  )}

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
                        const busyKey = `${revisionId}:${group.key}`;
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
                                lifecycleBusy ||
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

                  <div
                    className="analyzed-catalog-lifecycle"
                    data-status={item.catalogStatus}
                  >
                    {item.catalogStatus === "archived" ? (
                      <button
                        ref={(button) => rememberLifecycleButton(revisionId, button)}
                        type="button"
                        disabled={lifecycleBusy}
                        onClick={() => void restoreItem(item)}
                      >
                        {lifecycleBusy ? "恢复中…" : "恢复到目录"}
                      </button>
                    ) : !archiveArmed ? (
                      <button
                        ref={(button) => rememberLifecycleButton(revisionId, button)}
                        type="button"
                        disabled={lifecycleBusy}
                        onClick={() => armArchive(revisionId)}
                      >
                        归档此结果…
                      </button>
                    ) : (
                      <div
                        id={confirmationId}
                        className="analyzed-catalog-archive-confirm"
                        role="group"
                        aria-label={`归档 ${item.project.name} ${item.revision.branchName} #${item.revision.sequence}`}
                      >
                        <p>{analyzedSkinArchiveDescription(item)}</p>
                        <label>
                          <span>归档原因（可选）</span>
                          <input
                            ref={archiveReasonInputRef}
                            value={archiveReason}
                            maxLength={300}
                            placeholder="例如：重复分析"
                            disabled={lifecycleBusy}
                            onChange={(event) => setArchiveReason(event.target.value)}
                          />
                        </label>
                        <div>
                          <button
                            type="button"
                            disabled={lifecycleBusy}
                            onClick={() => void archiveItem(item)}
                          >
                            {lifecycleBusy ? "归档中…" : "确认归档"}
                          </button>
                          <button
                            type="button"
                            disabled={lifecycleBusy}
                            onClick={cancelArchive}
                          >
                            取消
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </article>
            );
          })
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
