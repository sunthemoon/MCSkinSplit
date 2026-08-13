import {
  categoryBelongsToAggregate,
  type ArmType,
} from "@mc-skin-split/skin-core";
import { useEffect, useMemo, useState } from "react";
import type { PreviewMotion } from "./SkinPreview";
import { SkinPreview } from "./SkinPreview";
import { LibraryLifecycleControls } from "./LibraryLifecycleControls";
import { LibraryToolbar } from "./LibraryToolbar";
import {
  partBundleMannequinUrl,
  partBundlePreviewUrl,
  type ApiPart,
  type ApiPartBundle,
} from "../lib/revisionApi";
import {
  BUNDLE_KIND_LABELS,
  librarySourceLabel,
  type LibraryFilters,
  type LibraryProjectOption,
} from "../lib/libraryCatalog";

interface PartBundleShelfProps {
  readonly bundles: readonly ApiPartBundle[];
  readonly allParts: readonly ApiPart[];
  readonly filters: LibraryFilters;
  readonly projectOptions: readonly LibraryProjectOption[];
  readonly selectedBundle: ApiPartBundle | null;
  readonly targetArmType: ArmType;
  readonly draftReady: boolean;
  readonly busy: boolean;
  readonly lifecycleBusy: boolean;
  readonly allMembersLayered: boolean;
  readonly motion: PreviewMotion;
  readonly onSelect: (bundleId: string) => void;
  readonly onAdd: (bundle: ApiPartBundle) => void;
  readonly onMotionChange: (motion: PreviewMotion) => void;
  readonly onFiltersChange: (filters: LibraryFilters) => void;
  readonly onRetire: (bundle: ApiPartBundle, reason?: string) => void | Promise<void>;
  readonly onRestore: (bundle: ApiPartBundle) => void | Promise<void>;
  readonly onReplaceMember: (
    bundle: ApiPartBundle,
    memberPartId: string,
    replacementPartId: string,
    reason?: string,
  ) => void | Promise<void>;
}

export function PartBundleShelf({
  bundles,
  allParts,
  filters,
  projectOptions,
  selectedBundle,
  targetArmType,
  draftReady,
  busy,
  lifecycleBusy,
  allMembersLayered,
  motion,
  onSelect,
  onAdd,
  onMotionChange,
  onFiltersChange,
  onRetire,
  onRestore,
  onReplaceMember,
}: PartBundleShelfProps) {
  const [memberPartId, setMemberPartId] = useState("");
  const [replacementPartId, setReplacementPartId] = useState("");
  const [replacementReason, setReplacementReason] = useState("");
  const selectedCompatible = Boolean(
    selectedBundle?.armTypes.includes(targetArmType),
  );
  const replacementCandidates = useMemo(() => {
    if (!selectedBundle) return [];
    const memberPartIds = new Set(selectedBundle.members.map((member) => member.partId));
    return allParts.filter((part) =>
      part.sourceProjectId === selectedBundle.sourceProjectId &&
      part.sourceRevisionId === selectedBundle.sourceRevisionId &&
      categoryBelongsToAggregate(part.category, selectedBundle.kind) &&
      !memberPartIds.has(part.id) &&
      part.manifest.compatibility.armTypes.some((armType) =>
        selectedBundle.armTypes.includes(armType)),
    );
  }, [allParts, selectedBundle]);

  useEffect(() => {
    const firstMember = selectedBundle?.members[0]?.partId ?? "";
    setMemberPartId(firstMember);
    setReplacementReason("");
  }, [selectedBundle?.id]);

  useEffect(() => {
    setReplacementPartId((current) =>
      replacementCandidates.some((part) => part.id === current)
        ? current
        : (replacementCandidates[0]?.id ?? ""),
    );
  }, [replacementCandidates]);

  return (
    <section className="bundle-shelf" aria-label="完整大类部件集">
      <div className="composition-section-title bundle-shelf-title">
        <span>COMPLETE SETS</span>
        <h3>完整大类一键入场</h3>
        <small>Bundle 保留内部细组件，加入后仍可逐层调整。</small>
      </div>

      <LibraryToolbar
        filters={filters}
        projects={projectOptions}
        typeLabel="KIND"
        typeOptions={Object.entries(BUNDLE_KIND_LABELS).map(([value, label]) => ({ value, label }))}
        onChange={onFiltersChange}
      />

      <div className="bundle-card-strip" data-empty={bundles.length === 0}>
        {bundles.length === 0 ? (
          <p>当前检索条件下没有完整大类；可从已分析皮肤或修正后的 HEAD 重新入库。</p>
        ) : (
          bundles.map((bundle) => {
            const compatible = bundle.armTypes.includes(targetArmType);
            return (
              <button
                key={bundle.id}
                type="button"
                className="bundle-card"
                data-active={bundle.id === selectedBundle?.id}
                data-compatible={compatible}
                data-library-status={bundle.libraryStatus}
                aria-pressed={bundle.id === selectedBundle?.id}
                onClick={() => onSelect(bundle.id)}
              >
                <img src={partBundlePreviewUrl(bundle.id)} alt="" />
                <span>
                  <small>{BUNDLE_KIND_LABELS[bundle.kind]}</small>
                  <strong>{bundle.name}</strong>
                  <em>{bundle.members.length} 个细组件</em>
                  <em className="library-source-chip">
                    {librarySourceLabel(bundle, projectOptions)}
                  </em>
                </span>
              </button>
            );
          })
        )}
      </div>

      {selectedBundle && (
        <div className="bundle-inspector" data-compatible={selectedCompatible}>
          <div className="bundle-3d-frame">
            <SkinPreview
              className="compact-skin-stage"
              skinUrl={partBundleMannequinUrl(
                selectedBundle.id,
                selectedCompatible
                  ? targetArmType
                  : (selectedBundle.armTypes[0] ?? "slim"),
              )}
              armType={
                selectedCompatible
                  ? targetArmType
                  : (selectedBundle.armTypes[0] ?? "slim")
              }
              motion={motion}
              ariaLabel={`${selectedBundle.name} 完整大类白模三维预览`}
            />
            <div className="preview-chip-controls" aria-label="完整大类预览动作">
              <button type="button" aria-pressed={motion === "idle"} onClick={() => onMotionChange("idle")}>静止</button>
              <button type="button" aria-pressed={motion === "walk"} onClick={() => onMotionChange("walk")}>走动</button>
            </div>
          </div>
          <div className="bundle-inspector-copy">
            <span>{BUNDLE_KIND_LABELS[selectedBundle.kind]}</span>
            <strong>{selectedBundle.name}</strong>
            <small>{librarySourceLabel(selectedBundle, projectOptions)}</small>
            <small>{selectedBundle.members.map((member) => member.part.name).join(" / ")}</small>
            <button
              type="button"
              disabled={
                selectedBundle.libraryStatus === "retired" ||
                !draftReady || busy || allMembersLayered || !selectedCompatible
              }
              onClick={() => onAdd(selectedBundle)}
            >
              {selectedBundle.libraryStatus === "retired"
                ? "已退役，不能加入"
                : !selectedCompatible
                  ? `不兼容 ${targetArmType}`
                  : allMembersLayered
                    ? "整组已在图层中"
                    : `整组加入 ${selectedBundle.members.length} 个组件`}
            </button>

            {selectedBundle.libraryStatus === "active" && (
              <div className="bundle-revision-controls">
                <strong>替换成员生成新版</strong>
                <label>
                  <span>原成员</span>
                  <select value={memberPartId} onChange={(event) => setMemberPartId(event.target.value)}>
                    {selectedBundle.members.map((member) => (
                      <option key={member.partId} value={member.partId}>{member.part.name}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>替换组件</span>
                  <select value={replacementPartId} onChange={(event) => setReplacementPartId(event.target.value)}>
                    {replacementCandidates.length === 0 && <option value="">没有同来源、同大类的新组件</option>}
                    {replacementCandidates.map((part) => (
                      <option key={part.id} value={part.id}>
                        {part.name} · {librarySourceLabel(part, projectOptions)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>替换原因（可选）</span>
                  <input
                    value={replacementReason}
                    maxLength={240}
                    placeholder="例如：换用已修补版本"
                    onChange={(event) => setReplacementReason(event.target.value)}
                  />
                </label>
                <button
                  type="button"
                  disabled={lifecycleBusy || !memberPartId || !replacementPartId}
                  onClick={() => void onReplaceMember(
                    selectedBundle,
                    memberPartId,
                    replacementPartId,
                    replacementReason,
                  )}
                >
                  生成新 Bundle 并退役旧版
                </button>
              </div>
            )}

            <LibraryLifecycleControls
              assetId={selectedBundle.id}
              name={selectedBundle.name}
              status={selectedBundle.libraryStatus}
              retiredReason={selectedBundle.retiredReason}
              busy={lifecycleBusy}
              onRetire={(reason) => onRetire(selectedBundle, reason)}
              onRestore={() => onRestore(selectedBundle)}
            />
          </div>
        </div>
      )}
    </section>
  );
}
