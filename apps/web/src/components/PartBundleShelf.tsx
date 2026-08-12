import type { ArmType } from "@mc-skin-split/skin-core";
import type { PreviewMotion } from "./SkinPreview";
import { SkinPreview } from "./SkinPreview";
import {
  partBundleMannequinUrl,
  partBundlePreviewUrl,
  type ApiPartBundle,
} from "../lib/revisionApi";

const kindLabels = {
  hair: "完整头发",
  clothing: "完整衣服",
  accessory: "饰品组合",
} as const;

interface PartBundleShelfProps {
  readonly bundles: readonly ApiPartBundle[];
  readonly selectedBundle: ApiPartBundle | null;
  readonly targetArmType: ArmType;
  readonly draftReady: boolean;
  readonly busy: boolean;
  readonly allMembersLayered: boolean;
  readonly motion: PreviewMotion;
  readonly onSelect: (bundleId: string) => void;
  readonly onAdd: (bundle: ApiPartBundle) => void;
  readonly onMotionChange: (motion: PreviewMotion) => void;
}

export function PartBundleShelf({
  bundles,
  selectedBundle,
  targetArmType,
  draftReady,
  busy,
  allMembersLayered,
  motion,
  onSelect,
  onAdd,
  onMotionChange,
}: PartBundleShelfProps) {
  const selectedCompatible = Boolean(
    selectedBundle?.armTypes.includes(targetArmType),
  );

  return (
    <section className="bundle-shelf" aria-label="完整大类部件集">
      <div className="composition-section-title bundle-shelf-title">
        <span>COMPLETE SETS</span>
        <h3>完整大类一键入场</h3>
        <small>Bundle 保留内部细组件，加入后仍可逐层调整。</small>
      </div>

      <div className="bundle-card-strip" data-empty={bundles.length === 0}>
        {bundles.length === 0 ? (
          <p>从“已分析皮肤”将完整头发、衣服或饰品整组入库后，会显示在这里。</p>
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
                aria-pressed={bundle.id === selectedBundle?.id}
                onClick={() => onSelect(bundle.id)}
              >
                <img src={partBundlePreviewUrl(bundle.id)} alt="" />
                <span>
                  <small>{kindLabels[bundle.kind]}</small>
                  <strong>{bundle.name}</strong>
                  <em>{bundle.members.length} 个细组件</em>
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
              <button
                type="button"
                aria-pressed={motion === "idle"}
                onClick={() => onMotionChange("idle")}
              >
                静止
              </button>
              <button
                type="button"
                aria-pressed={motion === "walk"}
                onClick={() => onMotionChange("walk")}
              >
                走动
              </button>
            </div>
          </div>
          <div className="bundle-inspector-copy">
            <span>{kindLabels[selectedBundle.kind]}</span>
            <strong>{selectedBundle.name}</strong>
            <small>
              {selectedBundle.members.map((member) => member.part.name).join(" / ")}
            </small>
            <button
              type="button"
              disabled={
                !draftReady || busy || allMembersLayered || !selectedCompatible
              }
              onClick={() => onAdd(selectedBundle)}
            >
              {!selectedCompatible
                ? `不兼容 ${targetArmType}`
                : allMembersLayered
                  ? "整组已在图层中"
                  : `整组加入 ${selectedBundle.members.length} 个组件`}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
