import type {
  PartManifest,
  PixelOriginSummary,
} from "@mc-skin-split/skin-core";
import type { ApiRevisionOrigin } from "../lib/revisionApi";

const ORIGIN_LABELS = [
  ["source_visible", "原图"],
  ["manual_authored", "手动修改"],
  ["generated_completion", "推测补全"],
  ["legacy_mixed", "历史来源不明"],
] as const;

export interface PixelOriginSummaryPanelProps {
  readonly origin: ApiRevisionOrigin | null;
  readonly activeComponentId: string | null;
}

export function PixelOriginSummaryPanel({
  origin,
  activeComponentId,
}: PixelOriginSummaryPanelProps) {
  if (!origin) return null;

  if (origin.availability === "legacy_unavailable") {
    return (
      <aside className="pixel-origin-summary" data-availability="legacy">
        <div>
          <span>PIXEL SOURCE</span>
          <strong>旧版本没有逐像素来源记录</strong>
        </div>
        <p>
          继续生成新版本时只保留不可变历史能够证明的来源；无法证明的像素会标为“历史来源不明”，不会冒充原图。
        </p>
      </aside>
    );
  }

  const componentSummary = activeComponentId
    ? origin.componentSummaries[activeComponentId] ?? null
    : null;
  const copiedPixelCount = origin.document.copyLineage.length;

  return (
    <aside className="pixel-origin-summary" data-availability="recorded">
      <div className="pixel-origin-heading">
        <div>
          <span>PIXEL SOURCE</span>
          <strong>像素来源已记录</strong>
        </div>
        <small>{copiedPixelCount} px 含复制关系</small>
      </div>
      <OriginCounts summary={origin.summary} />
      {componentSummary ? (
        <p className="pixel-origin-component">
          所选组件 · {compactPixelOriginSummary(componentSummary)}
        </p>
      ) : (
        <p className="pixel-origin-component">选择一个组件可查看它自己的来源分布。</p>
      )}
      <p className="pixel-origin-help">
        复制只记录来自哪里，不会把手动画的或推测补全的像素改写成原图来源。
      </p>
    </aside>
  );
}

export function compactPixelOriginSummary(summary: PixelOriginSummary): string {
  return ORIGIN_LABELS.map(
    ([key, label]) => `${label} ${summary.counts[key]} px`,
  ).join(" · ");
}

export function partOriginStatusLabel(manifest: PartManifest): string {
  if (manifest.schemaVersion !== "2.0") {
    return "旧资产 · 来源未逐像素记录";
  }
  if (manifest.origin.summary.counts.legacy_mixed > 0) {
    return `历史来源不明 ${manifest.origin.summary.counts.legacy_mixed} px`;
  }
  return manifest.origin.containsGeneratedPixels
    ? `含推测补全 ${manifest.origin.summary.counts.generated_completion} px`
    : "逐像素来源已记录";
}

export function partOriginDetailLabel(manifest: PartManifest): string {
  return manifest.schemaVersion === "2.0"
    ? `来源记录 · ${compactPixelOriginSummary(manifest.origin.summary)}`
    : "旧版部件没有逐像素来源记录";
}

function OriginCounts({ summary }: { readonly summary: PixelOriginSummary }) {
  return (
    <dl className="pixel-origin-counts">
      {ORIGIN_LABELS.map(([key, label]) => (
        <div key={key} data-origin={key}>
          <dt>{label}</dt>
          <dd>{summary.counts[key]} px</dd>
        </div>
      ))}
    </dl>
  );
}
