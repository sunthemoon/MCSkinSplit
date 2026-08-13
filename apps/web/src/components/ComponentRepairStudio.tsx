import {
  SEMANTIC_CATEGORIES,
  SEMANTIC_CATEGORY_LABELS,
  getSkinLayout,
  type ArmType,
  type SurfaceKey,
} from "@mc-skin-split/skin-core";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  applyPartEditOperation,
  commitPartEdit,
  createPartEdit,
  listPartEdits,
  loadPartEdit,
  partEditMannequinUrl,
  partEditTextureUrl,
  partTextureUrl,
  type ApiPart,
  type ApiPartEditDetail,
  type ApiPartEditOperation,
  type ApiPartEditProject,
} from "../lib/revisionApi";
import {
  createPartRepairPreview,
  derivePartRepairCommitGuard,
  ImmutablePartTextureCache,
  LatestPartRepairPreviewTask,
  PartRepairPreviewUrlStore,
  type PartRepairDraftPreviewState,
  type PartRepairPreviewUrls,
} from "../lib/partRepairPreview";
import { PartRepairCanvas } from "./PartRepairCanvas";
import { SkinPreview, type PreviewMotion } from "./SkinPreview";
import { LibraryToolbar } from "./LibraryToolbar";
import {
  buildPartRepairOperation,
  resolveRepairBasePart,
  type RepairTool,
} from "../lib/partRepairOperations";
import {
  DEFAULT_LIBRARY_FILTERS,
  filterLibraryAssets,
  librarySourceLabel,
  type LibraryFilters,
  type LibraryProjectOption,
} from "../lib/libraryCatalog";

interface ComponentRepairStudioProps {
  readonly parts: readonly ApiPart[];
  readonly projectOptions: readonly LibraryProjectOption[];
  readonly defaultArmType: ArmType;
  readonly onCommittedPart: (part: ApiPart) => void | Promise<void>;
  readonly onNotice?: (message: string) => void;
}

export function ComponentRepairStudio({
  parts,
  projectOptions,
  defaultArmType,
  onCommittedPart,
  onNotice,
}: ComponentRepairStudioProps) {
  const [projects, setProjects] = useState<readonly ApiPartEditProject[]>([]);
  const [detail, setDetail] = useState<ApiPartEditDetail | null>(null);
  const [basePartId, setBasePartId] = useState("");
  const [donorPartId, setDonorPartId] = useState("");
  const [projectName, setProjectName] = useState("组件修补草稿");
  const [libraryFilters, setLibraryFilters] = useState<LibraryFilters>({
    ...DEFAULT_LIBRARY_FILTERS,
  });
  const [committedName, setCommittedName] = useState("修补后的组件");
  const [tool, setTool] = useState<RepairTool>("paint");
  const [selectedPixelIds, setSelectedPixelIds] = useState<readonly number[]>([]);
  const [paintColor, setPaintColor] = useState("#d6a17b");
  const [paintAlpha, setPaintAlpha] = useState(255);
  const [replaceFrom, setReplaceFrom] = useState("#000000");
  const [replaceFromAlpha, setReplaceFromAlpha] = useState(255);
  const [replaceTo, setReplaceTo] = useState("#d6a17b");
  const [replaceAlpha, setReplaceAlpha] = useState(255);
  const [sourceSide, setSourceSide] = useState<"left" | "right">("left");
  const [limb, setLimb] = useState<"arm" | "leg">("arm");
  const [layer, setLayer] = useState<"base" | "outer">("outer");
  const [sourceSurface, setSourceSurface] = useState<SurfaceKey>("torso.outer.front");
  const [targetSurface, setTargetSurface] = useState<SurfaceKey>("torso.outer.back");
  const [overwrite, setOverwrite] = useState<"all" | "transparent_only">("transparent_only");
  const [motion, setMotion] = useState<PreviewMotion>("idle");
  const [localPreview, setLocalPreview] = useState<PartRepairPreviewUrls | null>(null);
  const [previewState, setPreviewState] = useState<PartRepairDraftPreviewState>("committed");
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textureCacheRef = useRef<ImmutablePartTextureCache | null>(null);
  const previewUrlStoreRef = useRef<PartRepairPreviewUrlStore | null>(null);
  const previewTaskRef = useRef<LatestPartRepairPreviewTask | null>(null);
  textureCacheRef.current ??= new ImmutablePartTextureCache();
  previewUrlStoreRef.current ??= new PartRepairPreviewUrlStore();
  previewTaskRef.current ??= new LatestPartRepairPreviewTask();

  const filteredParts = useMemo(
    () => filterLibraryAssets(parts, libraryFilters),
    [libraryFilters, parts],
  );

  useEffect(() => {
    if (!detail) {
      setBasePartId((current) =>
        filteredParts.some((part) => part.id === current) ? current : (filteredParts[0]?.id ?? ""),
      );
    }
    setDonorPartId((current) =>
      filteredParts.some((part) => part.id === current)
        ? current
        : (filteredParts[1]?.id ?? filteredParts[0]?.id ?? ""),
    );
  }, [detail, filteredParts]);

  useEffect(() => {
    let cancelled = false;
    void listPartEdits()
      .then((nextProjects) => {
        if (!cancelled) setProjects(nextProjects);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(errorMessage(caught));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedBasePart = resolveRepairBasePart(detail, filteredParts, basePartId);
  const selectableBaseParts = detail && !filteredParts.some((part) => part.id === detail.basePart.id)
    ? [detail.basePart, ...filteredParts]
    : filteredParts;
  const armType = compatibleArmType(selectedBasePart, defaultArmType);
  const surfaceKeys = useMemo(
    () => getSkinLayout(armType).surfaceOrder,
    [armType],
  );
  const draft = detail?.project.status === "draft" ? detail : null;
  const textureUrl = detail
    ? partEditTextureUrl(detail.headRevision.id)
    : selectedBasePart
      ? partTextureUrl(selectedBasePart.id)
      : "";
  const selectedDonorPart = filteredParts.find((part) => part.id === donorPartId);
  const groupedSelectableBaseParts = groupPartsBySource(selectableBaseParts, projectOptions);
  const groupedDonorParts = groupPartsBySource(filteredParts, projectOptions);
  const canApply = Boolean(draft && !busy);

  const hasConfiguredOperation = Boolean(
    draft && hasPreviewableOperation(tool, selectedPixelIds),
  );
  let configuredOperation: ApiPartEditOperation | null = null;
  if (hasConfiguredOperation && draft) {
    try {
      configuredOperation = buildPartRepairOperation({
        tool,
        armType,
        selectedPixelIds,
        headRevisionId: draft.headRevision.id,
        paintColor,
        paintAlpha,
        replaceFrom,
        replaceFromAlpha,
        replaceTo,
        replaceAlpha,
        sourceSide,
        limb,
        layer,
        donorPartId,
        sourceSurface,
        targetSurface,
        overwrite,
      });
    } catch {
      // Invalid form values are reported by the explicit Apply action.
    }
  }
  const previewOperationKey = configuredOperation
    ? JSON.stringify(configuredOperation)
    : "";

  useEffect(() => {
    const task = previewTaskRef.current!;
    const urlStore = previewUrlStoreRef.current!;
    const cache = textureCacheRef.current!;
    task.invalidate();
    if (!hasConfiguredOperation || !draft || !textureUrl) {
      urlStore.clear();
      setLocalPreview(null);
      setPreviewState("committed");
      setPreviewError(null);
      return undefined;
    }
    if (!configuredOperation) {
      urlStore.clear();
      setLocalPreview(null);
      setPreviewState("error");
      setPreviewError("修补参数无效");
      return undefined;
    }

    const operation = configuredOperation;
    setPreviewState("loading");
    setPreviewError(null);
    void task.run(async () => {
      const targetTexture = await cache.load(textureUrl);
      const donor = operation.type === "copy_surfaces" && operation.source.kind === "part"
        ? await cache.load(partTextureUrl(operation.source.partId)).then((texture) => ({
            texture,
            armType: selectedDonorPart?.armType ?? armType,
          }))
        : undefined;
      return createPartRepairPreview(
        { texture: targetTexture, armType },
        operation,
        donor,
      );
    }).then((result) => {
      if (result.status !== "current") return;
      setLocalPreview(urlStore.replace(result.value));
      setPreviewState("ready");
      setPreviewError(null);
    }).catch((caught: unknown) => {
      urlStore.clear();
      setLocalPreview(null);
      setPreviewState("error");
      setPreviewError(errorMessage(caught));
    });

    return () => {
      task.invalidate();
    };
  }, [
    armType,
    draft,
    hasConfiguredOperation,
    previewOperationKey,
    selectedDonorPart?.armType,
    textureUrl,
  ]);

  useEffect(() => () => {
    previewTaskRef.current?.invalidate();
    previewUrlStoreRef.current?.clear();
    textureCacheRef.current?.clear();
  }, []);

  const commitGuard = derivePartRepairCommitGuard({
    hasConfiguredOperation,
    previewState,
    ...(localPreview
      ? { changedPixelCount: localPreview.changedPixelIds.length }
      : {}),
  });

  const report = (message: string) => {
    onNotice?.(message);
  };

  const refreshProjects = async () => {
    const nextProjects = await listPartEdits();
    setProjects(nextProjects);
  };

  const createDraft = async () => {
    if (!selectedBasePart) return;
    setBusy(true);
    setError(null);
    try {
      const created = await createPartEdit({
        basePartId: selectedBasePart.id,
        ...(projectName.trim() ? { name: projectName.trim() } : {}),
      });
      setDetail(created);
      setSelectedPixelIds([]);
      setCommittedName(`${selectedBasePart.name} · 修补`);
      await refreshProjects();
      report(`已从 ${selectedBasePart.name} 创建不可变修补草稿`);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const openProject = async (projectId: string) => {
    if (!projectId) {
      setDetail(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const opened = await loadPartEdit(projectId);
      setDetail(opened);
      setBasePartId(opened.basePart.id);
      setSelectedPixelIds([]);
      setCommittedName(`${opened.basePart.name} · 修补`);
      report(`已载入 ${opened.project.name} #${opened.headRevision.sequence}`);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const applyOperation = async () => {
    if (!draft) return;
    let operation: ApiPartEditOperation;
    try {
      operation = buildPartRepairOperation({
        tool,
        armType,
        selectedPixelIds,
        headRevisionId: draft.headRevision.id,
        paintColor,
        paintAlpha,
        replaceFrom,
        replaceFromAlpha,
        replaceTo,
        replaceAlpha,
        sourceSide,
        limb,
        layer,
        donorPartId,
        sourceSurface,
        targetSurface,
        overwrite,
      });
    } catch (caught) {
      setError(errorMessage(caught));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await applyPartEditOperation(draft.project.id, {
        headRevisionId: draft.headRevision.id,
        operation,
        summary: operationSummary(operation),
      });
      setDetail(next);
      setSelectedPixelIds([]);
      await refreshProjects();
      report(`修补操作已创建 #${next.headRevision.sequence}，原 Revision 保持不变`);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const commitDraft = async () => {
    if (!draft || commitGuard.blocked) return;
    setBusy(true);
    setError(null);
    try {
      const result = await commitPartEdit(draft.project.id, {
        headRevisionId: draft.headRevision.id,
        ...(committedName.trim() ? { name: committedName.trim() } : {}),
      });
      setDetail(result.partEdit);
      await onCommittedPart(result.part);
      await refreshProjects();
      report(`已保存新部件 ${result.part.name}；基础部件未修改`);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const displayedTextureUrl = localPreview?.textureUrl ?? textureUrl;
  const committedMannequinUrl = detail
    ? partEditMannequinUrl(detail.headRevision.id, armType)
    : selectedBasePart
      ? `/api/parts/${encodeURIComponent(selectedBasePart.id)}/mannequin.png?armType=${armType}`
      : "";
  const displayedMannequinUrl = localPreview?.mannequinUrl ?? committedMannequinUrl;

  return (
    <section
      id="workspace-repair"
      className="component-repair-studio"
      aria-label="单一组件像素修补工作台"
      data-workflow-section
      tabIndex={-1}
    >
      <header className="repair-heading">
        <div className="panel-heading">
          <span>07</span>
          <div>
            <p>IMMUTABLE PART REPAIR</p>
            <h2>组件修补与白模校验</h2>
          </div>
        </div>
        <p>
          透明但有效的 UV 也能选中；每次操作保存新 Revision，提交时另存为新部件。
        </p>
      </header>

      <LibraryToolbar
        filters={libraryFilters}
        projects={projectOptions}
        typeLabel="CATEGORY"
        typeOptions={SEMANTIC_CATEGORIES.map((category) => ({
          value: category,
          label: SEMANTIC_CATEGORY_LABELS[category],
        }))}
        showStatus={false}
        onChange={setLibraryFilters}
      />

      <div className="repair-project-bar">
        <label>
          <span>OPEN REPAIR</span>
          <select
            value={detail?.project.id ?? ""}
            disabled={busy}
            onChange={(event) => void openProject(event.target.value)}
          >
            <option value="">新建修补工程</option>
            {projects.toReversed().map((project) => (
              <option key={project.id} value={project.id}>
                {project.name} · {project.status === "draft" ? "草稿" : "已入库"}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>BASE PART</span>
          <select
            value={basePartId}
            disabled={busy || Boolean(detail)}
            onChange={(event) => setBasePartId(event.target.value)}
          >
            {selectableBaseParts.length === 0 && <option value="">暂无已保存组件</option>}
            {groupedSelectableBaseParts.map((group) => (
              <optgroup key={group.key} label={group.label}>
                {group.parts.map((part) => (
                  <option key={part.id} value={part.id}>
                    {part.name} · {SEMANTIC_CATEGORY_LABELS[part.category]}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <label>
          <span>PROJECT NAME</span>
          <input
            value={projectName}
            maxLength={120}
            disabled={busy || Boolean(detail)}
            onChange={(event) => setProjectName(event.target.value)}
          />
        </label>
        <button type="button" disabled={!selectedBasePart || busy || Boolean(detail)} onClick={() => void createDraft()}>
          创建修补工程
        </button>
      </div>

      <div className="repair-grid">
        <section className="repair-tools-panel">
          <div className="repair-section-title">
            <span>TOOLS</span>
            <h3>精确像素操作</h3>
          </div>
          <div className="repair-tool-tabs" role="group" aria-label="修补工具">
            {([
              ["paint", "补色"],
              ["erase", "擦除"],
              ["replace", "换色"],
              ["mirror", "肢体镜像"],
              ["donor", "组件借色"],
            ] as const).map(([value, label]) => (
              <button key={value} type="button" aria-pressed={tool === value} onClick={() => setTool(value)}>
                {label}
              </button>
            ))}
          </div>

          {(tool === "paint" || tool === "erase" || tool === "replace") && (
            <p className="repair-selection-count">
              SELECTED <strong>{selectedPixelIds.length}</strong> px
              <button type="button" disabled={selectedPixelIds.length === 0} onClick={() => setSelectedPixelIds([])}>
                清空
              </button>
            </p>
          )}

          {tool === "paint" && (
            <div className="repair-fields">
              <ColorField label="补全颜色" value={paintColor} onChange={setPaintColor} />
              <NumberField label="ALPHA" value={paintAlpha} min={1} onChange={setPaintAlpha} />
              <small>可直接点透明 UV；皮肤色、布料色都由用户明确选择。</small>
            </div>
          )}
          {tool === "erase" && (
            <p className="repair-tool-help">擦除选区会把 RGBA 写成透明，并同步移出写入遮罩。</p>
          )}
          {tool === "replace" && (
            <div className="repair-fields">
              <ColorField label="原色" value={replaceFrom} onChange={setReplaceFrom} />
              <NumberField label="原 ALPHA" value={replaceFromAlpha} onChange={setReplaceFromAlpha} />
              <ColorField label="新色" value={replaceTo} onChange={setReplaceTo} />
              <NumberField label="新 ALPHA" value={replaceAlpha} min={1} onChange={setReplaceAlpha} />
              <small>有选区时只替换选区；无选区时替换部件内全部完全同色像素。</small>
            </div>
          )}
          {tool === "mirror" && (
            <div className="repair-fields repair-fields-grid">
              <SelectField label="来源侧" value={sourceSide} onChange={(value) => setSourceSide(value as "left" | "right")} options={["left", "right"]} />
              <SelectField label="肢体" value={limb} onChange={(value) => setLimb(value as "arm" | "leg")} options={["arm", "leg"]} />
              <SelectField label="图层" value={layer} onChange={(value) => setLayer(value as "base" | "outer")} options={["base", "outer"]} />
              <SelectField label="覆盖" value={overwrite} onChange={(value) => setOverwrite(value as "all" | "transparent_only")} options={["transparent_only", "all"]} />
            </div>
          )}
          {tool === "donor" && (
            <div className="repair-fields">
              <label>
                <span>DONOR PART</span>
                <select value={donorPartId} onChange={(event) => setDonorPartId(event.target.value)}>
                  {filteredParts.length === 0 && <option value="">当前检索条件下没有可用来源</option>}
                  {groupedDonorParts.map((group) => (
                    <optgroup key={group.key} label={group.label}>
                      {group.parts.map((part) => (
                        <option key={part.id} value={part.id}>{part.name}</option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </label>
              <label>
                <span>SOURCE SURFACE</span>
                <select value={sourceSurface} onChange={(event) => setSourceSurface(event.target.value as SurfaceKey)}>
                  {surfaceKeys.map((surface) => <option key={surface} value={surface}>{surface}</option>)}
                </select>
              </label>
              <label>
                <span>TARGET SURFACE</span>
                <select value={targetSurface} onChange={(event) => setTargetSurface(event.target.value as SurfaceKey)}>
                  {surfaceKeys.map((surface) => <option key={surface} value={surface}>{surface}</option>)}
                </select>
              </label>
              <SelectField label="覆盖" value={overwrite} onChange={(value) => setOverwrite(value as "all" | "transparent_only")} options={["transparent_only", "all"]} />
            </div>
          )}

          <button className="repair-apply-button" type="button" disabled={!canApply || requiresPixels(tool) && selectedPixelIds.length === 0} onClick={() => void applyOperation()}>
            {busy ? "正在创建 Revision…" : "应用为新 Revision"}
          </button>
          {error && <p className="repair-error" role="alert">{error}</p>}
        </section>

        <section className="repair-canvas-panel">
          <div className="repair-section-title">
            <span>64×64 TEXTURE</span>
            <h3>透明 UV 可编辑画布</h3>
          </div>
          <div className="part-repair-canvas-frame">
            {displayedTextureUrl ? (
              <PartRepairCanvas
                armType={armType}
                textureUrl={displayedTextureUrl}
                selectedPixelIds={selectedPixelIds}
                disabled={!draft || busy || (tool !== "paint" && tool !== "erase" && tool !== "replace")}
                onSelectionChange={setSelectedPixelIds}
              />
            ) : (
              <p>部件入库后可从这里直接创建修补工程。</p>
            )}
          </div>
          <dl className="repair-revision-facts">
            <div><dt>MODEL</dt><dd>{armType === "slim" ? "Slim / Alex" : "Wide / Classic"}</dd></div>
            <div><dt>REVISION</dt><dd>{detail ? `#${detail.headRevision.sequence}` : "NOT STARTED"}</dd></div>
            <div><dt>CHANGED</dt><dd>{detail?.headRevision.changedPixelCount ?? 0} px</dd></div>
            <div><dt>DRAFT</dt><dd>{previewState === "ready" ? `${localPreview?.changedPixelIds.length ?? 0} px` : previewState.toUpperCase()}</dd></div>
          </dl>
        </section>

        <section className="repair-preview-panel">
          <div className="repair-section-title">
            <span>LIVE MANNEQUIN</span>
            <h3>单组件白模效果</h3>
          </div>
          <div className="repair-preview-frame">
            {displayedMannequinUrl ? (
              <SkinPreview
                armType={armType}
                skinUrl={displayedMannequinUrl}
                motion={motion}
                className="repair-skin-stage"
                ariaLabel="组件白模三维预览，可拖拽旋转和滚轮缩放"
              />
            ) : <p>暂无白模纹理</p>}
            {draft && configuredOperation && (
              <p className="repair-preview-status" data-state={previewState}>
                {previewStatusLabel(
                  previewState,
                  localPreview?.changedPixelIds.length ?? 0,
                  previewError,
                )}
              </p>
            )}
            <div className="repair-motion-switch" aria-label="白模动作">
              <button type="button" aria-pressed={motion === "idle"} onClick={() => setMotion("idle")}>静止</button>
              <button type="button" aria-pressed={motion === "walk"} onClick={() => setMotion("walk")}>走动</button>
            </div>
          </div>
          <div className="repair-commit-box">
            <label>
              <span>NEW PART NAME</span>
              <input value={committedName} maxLength={120} disabled={!draft || busy} onChange={(event) => setCommittedName(event.target.value)} />
            </label>
            <button type="button" disabled={!draft || busy || !committedName.trim() || commitGuard.blocked} onClick={() => void commitDraft()}>
              {detail?.project.status === "committed" ? "已另存入库" : "另存为新组件"}
            </button>
            <small className={commitGuard.blocked ? "repair-commit-warning" : undefined}>
              {commitGuard.message ?? "提交只新增组件，不会覆盖来源组件。"}
            </small>
          </div>
        </section>
      </div>
    </section>
  );
}

function requiresPixels(tool: RepairTool): boolean {
  return tool === "paint" || tool === "erase";
}

function groupPartsBySource(
  parts: readonly ApiPart[],
  projectOptions: readonly LibraryProjectOption[],
): readonly {
  readonly key: string;
  readonly label: string;
  readonly parts: readonly ApiPart[];
}[] {
  const groups = new Map<string, { label: string; parts: ApiPart[] }>();
  for (const part of parts) {
    const key = `${part.sourceProjectId}:${part.sourceRevisionId}`;
    const group = groups.get(key) ?? {
      label: librarySourceLabel(part, projectOptions),
      parts: [],
    };
    group.parts.push(part);
    groups.set(key, group);
  }
  return [...groups].map(([key, group]) => ({ key, ...group }));
}

function hasPreviewableOperation(
  tool: RepairTool,
  selectedPixelIds: readonly number[],
): boolean {
  return !requiresPixels(tool) || selectedPixelIds.length > 0;
}

function previewStatusLabel(
  state: PartRepairDraftPreviewState,
  changedPixelCount: number,
  previewError: string | null,
): string {
  switch (state) {
    case "loading":
      return "正在生成本地草稿预览…";
    case "ready":
      return `未应用预览 · ${changedPixelCount} px`;
    case "error":
      return previewError
        ? `本地草稿预览不可用：${previewError}`
        : "本地草稿预览不可用，仍显示已保存 Revision";
    case "committed":
      return "已保存 Revision";
  }
}

function compatibleArmType(part: ApiPart | undefined, preferred: ArmType): ArmType {
  return part?.armType ?? preferred;
}

function operationSummary(operation: ApiPartEditOperation): string {
  const labels: Readonly<Record<ApiPartEditOperation["type"], string>> = {
    paint_color: "补色",
    erase_pixels: "擦除",
    replace_color: "精确换色",
    copy_surfaces: "表面复制",
  };
  return `组件修补：${labels[operation.type]}`;
}

function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

function ColorField({ label, value, onChange }: { readonly label: string; readonly value: string; readonly onChange: (value: string) => void }) {
  return <label><span>{label}</span><input type="color" value={value} onChange={(event) => onChange(event.target.value)} /></label>;
}

function NumberField({ label, value, min = 0, onChange }: { readonly label: string; readonly value: number; readonly min?: number; readonly onChange: (value: number) => void }) {
  return <label><span>{label}</span><input type="number" min={min} max={255} value={value} onChange={(event) => onChange(Number(event.target.value))} /></label>;
}

function SelectField({ label, value, options, onChange }: { readonly label: string; readonly value: string; readonly options: readonly string[]; readonly onChange: (value: string) => void }) {
  return <label><span>{label}</span><select value={value} onChange={(event) => onChange(event.target.value)}>{options.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>;
}
