import {
  SEMANTIC_CATEGORIES,
  SEMANTIC_CATEGORY_LABELS,
  categoryBelongsToAggregate,
  encodeSkinPng,
  getSkinLayout,
  pixelIdsToSpans,
  type ArmType,
  type ArmTypeAssessment,
  type ManualSemanticOperation,
  type RgbaImage,
  type SemanticCategory,
} from "@mc-skin-split/skin-core";
import {
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AtlasCanvas, type PixelView } from "./components/AtlasCanvas";
import { AnalyzedSkinCatalog } from "./components/AnalyzedSkinCatalog";
import { ComponentRepairStudio } from "./components/ComponentRepairStudio";
import { CompositionRestorationPanel } from "./components/CompositionRestorationPanel";
import { PartBundleShelf } from "./components/PartBundleShelf";
import { SemanticAiEventLog } from "./components/SemanticAiEventLog";
import { SemanticAiJobProgress } from "./components/SemanticAiJobProgress";
import {
  SkinPreview,
  type PreviewMotion,
  type PreviewState,
} from "./components/SkinPreview";
import { SemanticEditorCanvas } from "./components/SemanticEditorCanvas";
import {
  decodeMinecraftSkinBytes,
  decodeMinecraftSkinFile,
} from "./lib/skinFile";
import {
  addCompositionPart,
  applyCompositionBundle,
  branchRevision,
  applySemanticOperation,
  cancelAiJob,
  commitComposition as commitCompositionProject,
  clearCompositionRestorationPlan,
  commitRevisionPart,
  compositionPreviewUrl,
  createComposition,
  createProject,
  exportRevisionPart,
  exportRevisionBundle,
  generateCompositionRestorationCandidates,
  getProject,
  importProjectSkin,
  listAiJobs,
  listAnalyzedSkins,
  listAiProviders,
  listBranches,
  listCompositions,
  listParts,
  listPartBundles,
  listProjects,
  listRevisions,
  loadAiJobDetail,
  loadComposition,
  loadRevisionSegmentation,
  loadRevisionSkin,
  partMannequinUrl,
  partPreviewUrl,
  previewRevisionPart,
  retryAiJob,
  removeCompositionLayer,
  reorderCompositionLayers,
  resolveCompositionConflicts,
  setCompositionRestorationPlan,
  revertRevision,
  startAiAnalysis,
  startAiRestorationRecommendation,
  type ApiAiJobDetail,
  type ApiAiJobStatus,
  type ApiAiAnalysisOptions,
  type ApiBranch,
  type ApiAnalyzedSkin,
  type ApiAnalyzedSkinGroup,
  type ApiCompositionDetail,
  type ApiCompositionRestorationCandidates,
  type ApiProject,
  type ApiPart,
  type ApiPartBundle,
  type ApiPartPreview,
  type ApiRevision,
  type ApiSegmentation,
} from "./lib/revisionApi";
import {
  defaultRestorationCandidateIds,
  loadRestorationRecommendationSelection,
  parseOpaqueHexColor,
  restorationRecommendationStaleReason,
  selectedRestorationCoverage,
  targetComponentIdsForMode,
  toggleRestorationCandidateId,
  type RestorationTargetMode,
} from "./lib/compositionRestoration";

type ModelChoice = "auto" | ArmType;

interface SkinFixture {
  readonly id: string;
  readonly label: string;
  readonly name: string;
  readonly url: string;
}

interface ActiveSkin {
  readonly assessment: ArmTypeAssessment;
  readonly fixtureId?: string;
  readonly image: RgbaImage;
  readonly name: string;
  readonly source: "fixture" | "revision" | "upload";
  readonly url: string;
}

const SKIN_FIXTURES: readonly SkinFixture[] = [
  {
    id: "alex-mix-01",
    label: "MIX",
    name: "alex-mix-real.png",
    url: "/skins/alex-mix-real.png",
  },
  {
    id: "actual-01",
    label: "A1",
    name: "ab87de696cfca859.png",
    url: "/skins/ab87de696cfca859.png",
  },
  {
    id: "actual-02",
    label: "A2",
    name: "354359a2c2f33777.png",
    url: "/skins/354359a2c2f33777.png",
  },
  {
    id: "actual-03",
    label: "A3",
    name: "bad5dea368e72b05.png",
    url: "/skins/bad5dea368e72b05.png",
  },
  {
    id: "actual-04",
    label: "A4",
    name: "bc1a12c777b45e7b.png",
    url: "/skins/bc1a12c777b45e7b.png",
  },
  {
    id: "actual-05",
    label: "A5",
    name: "8d9ecb2e49f9d3df.png",
    url: "/skins/8d9ecb2e49f9d3df.png",
  },
  {
    id: "actual-06",
    label: "A6",
    name: "9058f3af3ffb104c.png",
    url: "/skins/9058f3af3ffb104c.png",
  },
  {
    id: "wide",
    label: "Wide",
    name: "wide-basic.png",
    url: "/skins/wide-basic.png",
  },
  {
    id: "slim",
    label: "Slim",
    name: "slim-basic.png",
    url: "/skins/slim-basic.png",
  },
];

const DEFAULT_FIXTURE = SKIN_FIXTURES[0]!;
const HISTORY_PROJECT_KEY = "mc-skin-split.active-project";

const operationLabels: Readonly<Record<string, string>> = {
  import: "IMPORT",
  revert: "REVERT",
  branch: "BRANCH",
  ai_segment: "AI SEGMENT",
  manual_edit: "MANUAL",
  merge_components: "MERGE",
  split_component: "SPLIT",
  reclassify_component: "RECLASSIFY",
  apply_part: "APPLY PART",
  compose: "COMPOSE",
  palette_change: "PALETTE",
};

const previewLabels: Record<PreviewState, string> = {
  loading: "正在载入纹理",
  ready: "3D 预览已就绪",
  error: "3D 预览载入失败",
};

const armLabels: Record<ArmType, string> = {
  wide: "Wide / Classic",
  slim: "Slim / Alex",
};

const inferenceLabels: Record<ArmTypeAssessment["reason"], string> = {
  "transparent-slim-markers": "透明 Slim 标记区",
  "black-slim-markers": "纯黑 Slim 标记区",
  "white-slim-markers": "纯白 Slim 标记区",
  "wide-default": "无 Slim 标记，按 Wide",
};

const aiStatusLabels: Readonly<Record<ApiAiJobStatus, string>> = {
  queued: "等待执行",
  preparing: "生成隔离分析包",
  running: "Codex 正在识别",
  validating: "校验结构与像素",
  succeeded: "识别完成",
  failed: "识别失败",
  cancelled: "已取消",
};

const terminalAiStatuses = new Set<ApiAiJobStatus>([
  "succeeded",
  "failed",
  "cancelled",
]);

const aiFocus = SEMANTIC_CATEGORIES.filter(
  (category) => category !== "unknown",
);

export function App() {
  const [activeSkin, setActiveSkin] = useState<ActiveSkin | null>(null);
  const [modelChoice, setModelChoice] = useState<ModelChoice>("slim");
  const [pixelView, setPixelView] = useState<PixelView>("atlas");
  const [previewState, setPreviewState] = useState<PreviewState>("loading");
  const [notice, setNotice] = useState("正在完整解码 Alex/Slim 混搭皮肤");
  const [isDragging, setIsDragging] = useState(false);
  const [isLoadingSkin, setIsLoadingSkin] = useState(true);
  const [historyProjects, setHistoryProjects] = useState<readonly ApiProject[]>([]);
  const [historyProject, setHistoryProject] = useState<ApiProject | null>(null);
  const [historyBranches, setHistoryBranches] = useState<readonly ApiBranch[]>([]);
  const [historyRevisions, setHistoryRevisions] = useState<readonly ApiRevision[]>([]);
  const [selectedRevisionId, setSelectedRevisionId] = useState<string | null>(null);
  const [branchFilter, setBranchFilter] = useState("all");
  const [branchName, setBranchName] = useState("experiment-slim");
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [segmentation, setSegmentation] = useState<ApiSegmentation | null>(null);
  const [draftPixelIds, setDraftPixelIds] = useState<readonly number[]>([]);
  const [activeComponentId, setActiveComponentId] = useState<string | null>(null);
  const [checkedComponentIds, setCheckedComponentIds] = useState<readonly string[]>([]);
  const [componentId, setComponentId] = useState("hair.main");
  const [componentName, setComponentName] = useState("主头发");
  const [componentCategory, setComponentCategory] =
    useState<SemanticCategory>("hair");
  const [componentSubtype, setComponentSubtype] = useState("");
  const [semanticBusy, setSemanticBusy] = useState(false);
  const [partLibrary, setPartLibrary] = useState<readonly ApiPart[]>([]);
  const [partBundles, setPartBundles] = useState<readonly ApiPartBundle[]>([]);
  const [selectedBundleId, setSelectedBundleId] = useState<string | null>(null);
  const [analyzedSkins, setAnalyzedSkins] =
    useState<readonly ApiAnalyzedSkin[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [busyCatalogGroupKey, setBusyCatalogGroupKey] = useState<string | null>(
    null,
  );
  const [selectedPartId, setSelectedPartId] = useState<string | null>(null);
  const [partPreview, setPartPreview] = useState<ApiPartPreview | null>(null);
  const [compositionPartId, setCompositionPartId] = useState<string | null>(null);
  const [componentInspectorMotion, setComponentInspectorMotion] =
    useState<PreviewMotion>("idle");
  const [bundleInspectorMotion, setBundleInspectorMotion] =
    useState<PreviewMotion>("idle");
  const [compositionPreviewMotion, setCompositionPreviewMotion] =
    useState<PreviewMotion>("idle");
  const [compositionPreviewMode, setCompositionPreviewMode] =
    useState<"3d" | "texture">("3d");
  const [compositionDetail, setCompositionDetail] =
    useState<ApiCompositionDetail | null>(null);
  const [compositionName, setCompositionName] = useState("Slim 真实皮肤混搭");
  const [compositionBusy, setCompositionBusy] = useState(false);
  const [compositionError, setCompositionError] = useState<string | null>(null);
  const [restorationMode, setRestorationMode] =
    useState<RestorationTargetMode>("fine");
  const [restorationFineIds, setRestorationFineIds] =
    useState<readonly string[]>([]);
  const [restorationDonorRevisionId, setRestorationDonorRevisionId] =
    useState("");
  const [restorationManualColor, setRestorationManualColor] =
    useState("#d6a17b");
  const [restorationIncludeManualColor, setRestorationIncludeManualColor] =
    useState(false);
  const [restorationCandidates, setRestorationCandidates] =
    useState<ApiCompositionRestorationCandidates | null>(null);
  const [restorationCandidateIds, setRestorationCandidateIds] =
    useState<readonly string[]>([]);
  const [restorationBusy, setRestorationBusy] = useState(false);
  const [restorationError, setRestorationError] = useState<string | null>(null);
  const [restorationRecommendationUserIntent, setRestorationRecommendationUserIntent] =
    useState("优先选择来源可追溯且完整覆盖 Base 的肤色候选。");
  const [restorationRecommendationJobDetail, setRestorationRecommendationJobDetail] =
    useState<ApiAiJobDetail | null>(null);
  const [restorationRecommendationBusy, setRestorationRecommendationBusy] =
    useState(false);
  const [restorationRecommendationError, setRestorationRecommendationError] =
    useState<string | null>(null);
  const [restorationRecommendationProviders, setRestorationRecommendationProviders] =
    useState<readonly string[]>([]);
  const [restorationRecommendationProvider, setRestorationRecommendationProvider] =
    useState("");
  const [aiProviders, setAiProviders] = useState<readonly string[]>([]);
  const [aiProvider, setAiProvider] = useState("codex-exec");
  const [aiModel, setAiModel] = useState("codex-config-default");
  const [aiReasoningEffort, setAiReasoningEffort] =
    useState<ApiAiAnalysisOptions["reasoningEffort"]>("medium");
  const [aiJobDetail, setAiJobDetail] = useState<ApiAiJobDetail | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const requestIdRef = useRef(0);
  const aiJobDetailRef = useRef<ApiAiJobDetail | null>(null);
  const restorationRecommendationJobDetailRef = useRef<ApiAiJobDetail | null>(null);
  const restorationRecommendationContextRef = useRef(0);
  const handledAiJobsRef = useRef(new Set<string>());
  const aiEventLogRef = useRef<HTMLOListElement>(null);

  const releaseObjectUrl = useCallback(() => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  }, []);

  const refreshReusableCatalog = useCallback(async () => {
    const [parts, bundles, catalog] = await Promise.all([
      listParts(),
      listPartBundles(),
      listAnalyzedSkins(),
    ]);
    setPartLibrary(parts);
    setPartBundles(bundles);
    setAnalyzedSkins(catalog);
    setSelectedPartId((current) => current ?? parts[0]?.id ?? null);
    setCompositionPartId((current) => current ?? parts[0]?.id ?? null);
    setSelectedBundleId((current) =>
      bundles.some((bundle) => bundle.id === current)
        ? current
        : (bundles[0]?.id ?? null),
    );
  }, []);

  const activateFixture = useCallback(
    async (fixture: SkinFixture) => {
      const requestId = ++requestIdRef.current;
      setIsLoadingSkin(true);
      setNotice(`正在解码 ${fixture.label}`);

      try {
        const response = await fetch(fixture.url);
        if (!response.ok) {
          throw new Error(`内置皮肤读取失败：HTTP ${response.status}`);
        }

        const decoded = decodeMinecraftSkinBytes(await response.arrayBuffer());
        if (requestId !== requestIdRef.current) {
          return;
        }

        releaseObjectUrl();
        setActiveSkin({
          assessment: decoded.assessment,
          fixtureId: fixture.id,
          image: decoded.image,
          name: fixture.name,
          source: "fixture",
          url: fixture.url,
        });
        setSelectedRevisionId(null);
        setSegmentation(null);
        setDraftPixelIds([]);
        setActiveComponentId(null);
        setCheckedComponentIds([]);
        setPartPreview(null);
        setNotice(
          `RGBA 解码通过 · 自动识别 ${armLabels[decoded.assessment.armType]}`,
        );
      } catch (error) {
        if (requestId === requestIdRef.current) {
          setNotice(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (requestId === requestIdRef.current) {
          setIsLoadingSkin(false);
        }
      }
    },
    [releaseObjectUrl],
  );

  const activateRevision = useCallback(
    async (revision: ApiRevision) => {
      const requestId = ++requestIdRef.current;
      setIsLoadingSkin(true);
      setHistoryBusy(true);
      setHistoryError(null);
      setNotice(`正在校验并载入 ${revision.branchName} #${revision.sequence}`);

      try {
        const [skinBytes, segmentation] = await Promise.all([
          loadRevisionSkin(revision.id),
          loadRevisionSegmentation(revision.id),
        ]);
        const decoded = decodeMinecraftSkinBytes(skinBytes);
        if (requestId !== requestIdRef.current) {
          return;
        }

        const copiedBytes = new Uint8Array(skinBytes.byteLength);
        copiedBytes.set(skinBytes);
        const nextUrl = URL.createObjectURL(
          new Blob([copiedBytes.buffer], { type: "image/png" }),
        );
        releaseObjectUrl();
        objectUrlRef.current = nextUrl;
        setModelChoice(segmentation.source.armType);
        setActiveSkin({
          assessment: decoded.assessment,
          image: decoded.image,
          name: `${revision.branchName}-r${revision.sequence}.png`,
          source: "revision",
          url: nextUrl,
        });
        setSegmentation(segmentation);
        setDraftPixelIds([]);
        setActiveComponentId((current) =>
          segmentation.components.some(
            (component) => component.instanceId === current,
          )
            ? current
            : null,
        );
        setCheckedComponentIds((current) =>
          current.filter((componentId) =>
            segmentation.components.some(
              (component) => component.instanceId === componentId,
            ),
          ),
        );
        setPartPreview(null);
        setSelectedRevisionId(null);
        setSelectedRevisionId(revision.id);
        setBranchFilter(revision.branchId);
        setNotice(
          `已载入 ${revision.branchName} #${revision.sequence} · ${armLabels[segmentation.source.armType]} · Hash 校验通过`,
        );
      } catch (error) {
        if (requestId === requestIdRef.current) {
          const message = error instanceof Error ? error.message : String(error);
          setHistoryError(message);
          setNotice(`Revision 载入失败：${message}`);
        }
      } finally {
        if (requestId === requestIdRef.current) {
          setIsLoadingSkin(false);
          setHistoryBusy(false);
        }
      }
    },
    [releaseObjectUrl],
  );

  const refreshHistory = useCallback(
    async (projectId: string, preferredRevisionId?: string | null) => {
      const [project, branches, revisions, projects] = await Promise.all([
        getProject(projectId),
        listBranches(projectId),
        listRevisions(projectId),
        listProjects(),
      ]);
      setHistoryProject(project);
      setHistoryBranches(branches);
      setHistoryRevisions(revisions);
      setHistoryProjects(projects);
      window.localStorage.setItem(HISTORY_PROJECT_KEY, project.id);

      const revisionId = preferredRevisionId ?? project.headRevisionId;
      const selected = revisions.find((revision) => revision.id === revisionId);
      if (selected) {
        await activateRevision(selected);
      } else {
        setSelectedRevisionId(null);
        setBranchFilter(project.defaultBranchId);
      }
    },
    [activateRevision],
  );

  const createHistoryProject = useCallback(
    async (
      image: RgbaImage,
      fileName: string,
      armType: ArmType,
    ) => {
      setHistoryBusy(true);
      setHistoryError(null);
      setNotice(`正在创建 ${fileName} 的 Import Revision`);
      try {
        const created = await createProject(projectNameFromFile(fileName));
        const imported = await importProjectSkin(
          created.project.id,
          encodeSkinPng(image),
          { fileName, armType },
        );
        await refreshHistory(created.project.id, imported.revisionId);
        setNotice(
          `Import Revision 已创建 · ${armLabels[imported.armType]} · 快照已校验`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setHistoryError(message);
        setNotice(`版本项目创建失败：${message}`);
      } finally {
        setHistoryBusy(false);
      }
    },
    [refreshHistory],
  );

  const synchronizeAiJob = useCallback(
    async (jobId: string, followSuccessfulRevision: boolean) => {
      const detail = await loadAiJobDetail(jobId);
      if (detail.job.kind !== "semantic_analysis") {
        throw new Error("API 返回的 Job 不是语义识别任务");
      }
      aiJobDetailRef.current = detail;
      setAiJobDetail(detail);

      const { job } = detail;
      if (
        !followSuccessfulRevision ||
        !terminalAiStatuses.has(job.status) ||
        handledAiJobsRef.current.has(job.id)
      ) {
        return detail;
      }

      if (job.status === "succeeded" && job.resultRevisionId) {
        await refreshHistory(job.projectId, job.resultRevisionId);
        await refreshReusableCatalog();
        setNotice(
          `AI 识别完成 · 已创建 Revision · ${job.reviewItems.length} 项待审核`,
        );
      } else if (job.status === "succeeded") {
        setNotice(`AI 提案验证完成 · ${job.reviewItems.length} 项待审核 · 未创建 Revision`);
      } else {
        setNotice(
          job.error
            ? `AI ${aiStatusLabels[job.status]}：${job.error.message}`
            : `AI ${aiStatusLabels[job.status]}`,
        );
      }
      handledAiJobsRef.current.add(job.id);
      return detail;
    },
    [refreshHistory, refreshReusableCatalog],
  );

  const synchronizeRestorationRecommendationJob = useCallback(
    async (
      jobId: string,
      expectedContextId = restorationRecommendationContextRef.current,
    ) => {
      const detail = await loadAiJobDetail(jobId);
      if (detail.job.kind !== "restoration_recommendation") {
        throw new Error("API 返回的 Job 不是修补候选推荐任务");
      }
      if (expectedContextId !== restorationRecommendationContextRef.current) {
        return null;
      }
      restorationRecommendationJobDetailRef.current = detail;
      setRestorationRecommendationJobDetail(detail);
      return detail;
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    void listAiProviders()
      .then((catalog) => {
        if (cancelled) {
          return;
        }
        const normalized = Array.isArray(catalog)
          ? {
              providers: catalog as readonly string[],
              restorationRecommendationProviders: [] as readonly string[],
              defaultModel: "codex-config-default",
              defaultReasoningEffort: "medium" as const,
            }
          : catalog;
        setAiProviders(normalized.providers);
        setRestorationRecommendationProviders(
          normalized.restorationRecommendationProviders,
        );
        setAiModel(normalized.defaultModel);
        setAiReasoningEffort(normalized.defaultReasoningEffort);
        setAiProvider((current) =>
          normalized.providers.includes(current)
            ? current
            : (normalized.providers[0] ?? ""),
        );
        setRestorationRecommendationProvider((current) =>
          normalized.restorationRecommendationProviders.includes(current)
            ? current
            : (normalized.restorationRecommendationProviders[0] ?? ""),
        );
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setAiError(
            `AI Provider 读取失败：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!selectedRevisionId) {
      aiJobDetailRef.current = null;
      setAiJobDetail(null);
      return;
    }
    const current = aiJobDetailRef.current?.job;
    if (
      current?.inputRevisionId === selectedRevisionId ||
      current?.resultRevisionId === selectedRevisionId
    ) {
      return;
    }

    let cancelled = false;
    void listAiJobs({
      revisionId: selectedRevisionId,
      kind: "semantic_analysis",
    })
      .then(async (jobs) => {
        const latest = jobs.at(-1);
        if (!latest) {
          if (!cancelled) {
            aiJobDetailRef.current = null;
            setAiJobDetail(null);
          }
          return;
        }
        const detail = await loadAiJobDetail(latest.id);
        if (!cancelled) {
          aiJobDetailRef.current = detail;
          setAiJobDetail(detail);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setAiError(
            `AI Job 读取失败：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRevisionId]);

  useEffect(() => {
    if (!selectedRevisionId) {
      setCompositionDetail(null);
      setCompositionError(null);
      setRestorationCandidates(null);
      setRestorationCandidateIds([]);
      setRestorationError(null);
      return;
    }

    let cancelled = false;
    setCompositionError(null);
    void listCompositions(selectedRevisionId)
      .then(async (compositions) => {
        const latest =
          compositions.findLast((composition) => composition.status === "draft") ??
          compositions.at(-1);
        return latest ? loadComposition(latest.id) : null;
      })
      .then((detail) => {
        if (!cancelled) {
          setCompositionDetail(detail);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setCompositionDetail(null);
          setCompositionError(
            `混搭工程读取失败：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedRevisionId]);

  useEffect(() => {
    setRestorationCandidates(null);
    setRestorationCandidateIds([]);
    setRestorationError(null);
  }, [compositionDetail?.composition.id]);

  useEffect(() => {
    const compositionId = compositionDetail?.composition.id;
    restorationRecommendationContextRef.current += 1;
    if (!compositionId) {
      restorationRecommendationJobDetailRef.current = null;
      setRestorationRecommendationJobDetail(null);
      setRestorationRecommendationError(null);
      return;
    }
    const current = restorationRecommendationJobDetailRef.current?.job;
    if (
      current?.kind === "restoration_recommendation" &&
      current.compositionId === compositionId
    ) {
      return;
    }

    let cancelled = false;
    setRestorationRecommendationError(null);
    void listAiJobs({ kind: "restoration_recommendation", compositionId })
      .then(async (jobs) => {
        const latest = jobs.at(-1);
        return latest ? loadAiJobDetail(latest.id) : null;
      })
      .then((detail) => {
        if (cancelled) return;
        if (detail && detail.job.kind !== "restoration_recommendation") {
          throw new Error("API 返回的 Job 不是修补候选推荐任务");
        }
        restorationRecommendationJobDetailRef.current = detail;
        setRestorationRecommendationJobDetail(detail);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setRestorationRecommendationJobDetail(null);
          setRestorationRecommendationError(
            `AI 推荐记录读取失败：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [compositionDetail?.composition.id]);

  useEffect(() => {
    const job = aiJobDetail?.job;
    if (!job || terminalAiStatuses.has(job.status)) {
      return;
    }

    let stopped = false;
    let polling = false;
    const poll = () => {
      if (polling) {
        return;
      }
      polling = true;
      void synchronizeAiJob(job.id, true)
        .catch((error: unknown) => {
          if (!stopped) {
            setAiError(
              `AI Job 轮询失败：${error instanceof Error ? error.message : String(error)}`,
            );
          }
        })
        .finally(() => {
          polling = false;
        });
    };
    const timer = window.setInterval(poll, 1_500);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [aiJobDetail?.job, synchronizeAiJob]);

  useEffect(() => {
    const job = restorationRecommendationJobDetail?.job;
    if (!job || terminalAiStatuses.has(job.status)) {
      return;
    }

    let stopped = false;
    let polling = false;
    const poll = () => {
      if (polling) return;
      polling = true;
      void loadAiJobDetail(job.id)
        .then((detail) => {
          if (stopped) return;
          if (detail.job.kind !== "restoration_recommendation") {
            throw new Error("API 返回的 Job 不是修补候选推荐任务");
          }
          restorationRecommendationJobDetailRef.current = detail;
          setRestorationRecommendationJobDetail(detail);
        })
        .catch((error: unknown) => {
          if (!stopped) {
            setRestorationRecommendationError(
              `AI 推荐轮询失败：${error instanceof Error ? error.message : String(error)}`,
            );
          }
        })
        .finally(() => {
          polling = false;
        });
    };
    const timer = window.setInterval(poll, 1_500);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [
    restorationRecommendationJobDetail?.job,
    compositionDetail?.composition.id,
  ]);

  useEffect(() => {
    const log = aiEventLogRef.current;
    if (!log) return;
    log.scrollTop = log.scrollHeight;
  }, [aiJobDetail?.events.length, aiJobDetail?.job.id]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      await activateFixture(DEFAULT_FIXTURE);
      try {
        const projects = await listProjects();
        await refreshReusableCatalog();
        if (cancelled) {
          return;
        }
        setHistoryProjects(projects);
        setCatalogError(null);
        const storedProjectId = window.localStorage.getItem(HISTORY_PROJECT_KEY);
        const storedProject = projects.find(
          (project) => project.id === storedProjectId,
        );
        const latestProject = storedProject ?? projects.at(-1);
        if (latestProject) {
          await refreshHistory(latestProject.id, latestProject.headRevisionId);
        }
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : String(error);
          setHistoryError(`Revision API 未连接：${message}`);
          setCatalogError(`目录读取失败：${message}`);
        }
      } finally {
        if (!cancelled) setCatalogLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      requestIdRef.current += 1;
      releaseObjectUrl();
    };
  }, [activateFixture, refreshHistory, refreshReusableCatalog, releaseObjectUrl]);

  const selectFile = useCallback(
    async (file: File) => {
      const requestId = ++requestIdRef.current;
      setIsLoadingSkin(true);
      setNotice(`正在解码 ${file.name}`);

      try {
        const decoded = await decodeMinecraftSkinFile(file);
        if (requestId !== requestIdRef.current) {
          return;
        }

        const nextUrl = URL.createObjectURL(file);
        releaseObjectUrl();
        objectUrlRef.current = nextUrl;
        setActiveSkin({
          assessment: decoded.assessment,
          image: decoded.image,
          name: file.name,
          source: "upload",
          url: nextUrl,
        });
        setNotice(
          `64×64 RGBA 解码通过 · 自动识别 ${armLabels[decoded.assessment.armType]}`,
        );
        await createHistoryProject(
          decoded.image,
          file.name,
          modelChoice === "auto" ? decoded.assessment.armType : modelChoice,
        );
      } catch (error) {
        if (requestId === requestIdRef.current) {
          setNotice(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (requestId === requestIdRef.current) {
          setIsLoadingSkin(false);
        }
      }
    },
    [createHistoryProject, modelChoice, releaseObjectUrl],
  );

  const resolvedArmType =
    modelChoice === "auto"
      ? (activeSkin?.assessment.armType ?? "slim")
      : modelChoice;
  const layout = useMemo(() => getSkinLayout(resolvedArmType), [resolvedArmType]);
  const skinUrl = activeSkin?.url ?? DEFAULT_FIXTURE.url;
  const skinName = activeSkin?.name ?? DEFAULT_FIXTURE.name;
  const selectedRevision = historyRevisions.find(
    (revision) => revision.id === selectedRevisionId,
  );
  const activeComponent = segmentation?.components.find(
    (component) => component.instanceId === activeComponentId,
  );
  const selectedPart = partLibrary.find((part) => part.id === selectedPartId);
  const compositionPart = partLibrary.find(
    (part) => part.id === compositionPartId,
  );
  const selectedBundle =
    partBundles.find((bundle) => bundle.id === selectedBundleId) ?? null;
  const composition = compositionDetail?.composition ?? null;
  const compositionReport = compositionDetail?.report ?? null;
  const compositionDraft = composition?.status === "draft";
  const compositionTargetArmType = composition?.armType ?? resolvedArmType;
  const inspectedPartArmType: ArmType =
    compositionPart?.manifest.compatibility.armTypes.includes(
      compositionTargetArmType,
    )
      ? compositionTargetArmType
      : (compositionPart?.manifest.compatibility.armTypes[0] ?? "slim");
  const compositionPartAlreadyLayered = Boolean(
    compositionPart &&
      compositionDetail?.layers.some(
        (layer) => layer.partId === compositionPart.id,
      ),
  );
  const selectedBundleAlreadyLayered = Boolean(
    selectedBundle &&
      selectedBundle.members.every((member) =>
        compositionDetail?.layers.some(
          (layer) => layer.partId === member.partId,
        ),
      ),
  );
  const unresolvedCompositionConflicts =
    compositionReport?.conflicts.filter(
      (conflict) => conflict.blocking && !conflict.resolved,
    ) ?? [];
  const compositionLayerNames = new Map(
    compositionDetail?.layers.map((layer) => [layer.id, layer.part.name]) ?? [],
  );
  const restorationComponents = segmentation?.components.filter(
    (component) => component.category !== "skin" && component.category !== "unknown",
  ) ?? [];
  const restorationTargetComponentIds = targetComponentIdsForMode(
    restorationComponents,
    restorationMode,
    restorationFineIds,
  );
  const restorationCoverage = restorationCandidates
    ? selectedRestorationCoverage(restorationCandidates, restorationCandidateIds)
    : { coveredPixelCount: 0, missingPixelCount: 0 };
  const restorationRecommendationJob = restorationRecommendationJobDetail?.job ?? null;
  const restorationRecommendationRunning = Boolean(
    restorationRecommendationJob &&
      !terminalAiStatuses.has(restorationRecommendationJob.status),
  );
  const restorationRecommendationStale = restorationRecommendationJob
    ? restorationRecommendationStaleReason(
        composition,
        restorationCandidates,
        restorationRecommendationJob,
      )
    : null;
  const canEditSemantic = Boolean(
    selectedRevision?.isBranchHead && segmentation && activeSkin,
  );
  const visibleRevisions = historyRevisions
    .filter(
      (revision) => branchFilter === "all" || revision.branchId === branchFilter,
    )
    .toReversed();
  const aiJob = aiJobDetail?.job ?? null;
  const aiJobRunning = Boolean(
    aiJob && !terminalAiStatuses.has(aiJob.status),
  );
  const aiSourceRevision = historyRevisions.find(
    (revision) => revision.id === aiJob?.inputRevisionId,
  );
  const canStartAi = Boolean(
    selectedRevision?.isBranchHead && aiProvider && aiModel.trim() && !aiJobRunning,
  );

  const handleFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      void selectFile(file);
    }
    event.target.value = "";
  };

  const handleDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setIsDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) {
      void selectFile(file);
    }
  };

  const handlePreviewState = useCallback(
    (state: PreviewState, detail?: string) => {
      setPreviewState(state);
      if (state === "error" && detail) {
        setNotice(`3D 预览错误：${detail}`);
      }
    },
    [],
  );

  const chooseModel = (choice: ModelChoice) => {
    setModelChoice(choice);
    if (choice === "auto") {
      setNotice(
        `使用像素标记自动识别：${armLabels[activeSkin?.assessment.armType ?? "slim"]}`,
      );
    } else {
      setNotice(`手动覆盖模型为 ${armLabels[choice]}`);
    }
  };

  const importActiveSkin = () => {
    if (activeSkin) {
      void createHistoryProject(activeSkin.image, activeSkin.name, resolvedArmType);
    }
  };

  const chooseHistoryProject = async (projectId: string) => {
    if (!projectId) {
      return;
    }
    setHistoryBusy(true);
    setHistoryError(null);
    try {
      const project = historyProjects.find((candidate) => candidate.id === projectId);
      await refreshHistory(projectId, project?.headRevisionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setHistoryError(message);
      setNotice(`Project 载入失败：${message}`);
    } finally {
      setHistoryBusy(false);
    }
  };

  const createBranchFromSelection = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedName = branchName.trim();
    if (!selectedRevision || !normalizedName) {
      return;
    }

    setHistoryBusy(true);
    setHistoryError(null);
    try {
      const result = await branchRevision(selectedRevision.id, normalizedName);
      await refreshHistory(result.project.id, result.revision.id);
      setBranchName(`experiment-${historyBranches.length + 1}`);
      setNotice(
        `已从 ${selectedRevision.branchName} #${selectedRevision.sequence} 创建分支 ${result.branch.name}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setHistoryError(message);
      setNotice(`创建 Branch 失败：${message}`);
    } finally {
      setHistoryBusy(false);
    }
  };

  const revertToSelection = async () => {
    if (!selectedRevision) {
      return;
    }

    setHistoryBusy(true);
    setHistoryError(null);
    try {
      const result = await revertRevision(
        selectedRevision.id,
        selectedRevision.branchId,
      );
      await refreshHistory(result.project.id, result.revision.id);
      setNotice(
        `已创建 Revert Revision · ${result.branch.name} #${result.revision.sequence}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setHistoryError(message);
      setNotice(`恢复 Revision 失败：${message}`);
    } finally {
      setHistoryBusy(false);
    }
  };

  const beginAiAnalysis = async () => {
    if (!selectedRevision || !canStartAi) {
      return;
    }
    setAiBusy(true);
    setAiError(null);
    try {
      const job = await startAiAnalysis(selectedRevision.id, {
        mode: "full",
        provider: aiProvider,
        model: aiModel.trim(),
        reasoningEffort: aiReasoningEffort,
        taxonomyLevel: "coarse",
        focus: aiFocus,
        createRevisionOnSuccess: true,
      });
      handledAiJobsRef.current.delete(job.id);
      await synchronizeAiJob(job.id, true);
      setNotice(
        `AI Job 已创建 · ${aiProvider} / ${aiModel.trim()} · 源 Revision 保持只读`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setAiError(message);
      setNotice(`AI 分析启动失败：${message}`);
    } finally {
      setAiBusy(false);
    }
  };

  const cancelActiveAiJob = async () => {
    if (!aiJob || !aiJobRunning) {
      return;
    }
    setAiBusy(true);
    setAiError(null);
    try {
      await cancelAiJob(aiJob.id);
      await synchronizeAiJob(aiJob.id, true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setAiError(message);
      setNotice(`AI Job 取消失败：${message}`);
    } finally {
      setAiBusy(false);
    }
  };

  const retrySelectedAiJob = async () => {
    if (!aiJob || aiJobRunning || !aiProvider || !aiModel.trim()) {
      return;
    }
    setAiBusy(true);
    setAiError(null);
    try {
      const createRevisionOnSuccess = Boolean(aiSourceRevision?.isBranchHead);
      const retry = await retryAiJob(aiJob.id, {
        provider: aiProvider,
        model: aiModel.trim(),
        reasoningEffort: aiReasoningEffort,
        createRevisionOnSuccess,
      });
      handledAiJobsRef.current.delete(retry.id);
      await synchronizeAiJob(retry.id, true);
      setNotice(
        createRevisionOnSuccess
          ? "AI 重试已创建；验证成功后生成新 Revision"
          : "AI 重试已创建；历史输入只生成可审计提案，不修改 Branch",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setAiError(message);
      setNotice(`AI Job 重试失败：${message}`);
    } finally {
      setAiBusy(false);
    }
  };

  const semanticTarget = () => {
    const instanceId = componentId.trim();
    const displayName = componentName.trim();
    if (!instanceId || !displayName) {
      throw new Error("组件 ID 与名称不能为空");
    }
    return {
      instanceId,
      displayName,
      category: componentCategory,
      ...(componentSubtype.trim()
        ? { subtype: componentSubtype.trim() }
        : {}),
    } as const;
  };

  const commitSemanticOperation = async (
    operation: ManualSemanticOperation,
    successMessage: string,
  ) => {
    if (!selectedRevision) {
      return;
    }
    setSemanticBusy(true);
    setHistoryError(null);
    try {
      const result = await applySemanticOperation(
        selectedRevision.id,
        operation,
        { branchId: selectedRevision.branchId, summary: successMessage },
      );
      setDraftPixelIds([]);
      setCheckedComponentIds([]);
      await refreshHistory(result.project.id, result.revision.id);
      setNotice(
        `${successMessage} · 已创建 ${result.branch.name} #${result.revision.sequence}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setHistoryError(message);
      setNotice(`语义编辑失败：${message}`);
    } finally {
      setSemanticBusy(false);
    }
  };

  const assignDraftPixels = () => {
    if (draftPixelIds.length === 0) {
      setNotice("先在语义 Atlas 上选择至少 1 个有效像素");
      return;
    }
    try {
      void commitSemanticOperation(
        {
          type: "assign_pixels",
          target: semanticTarget(),
          spans: pixelIdsToSpans(draftPixelIds, layout),
        },
        `分类 ${draftPixelIds.length} 个像素`,
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const unassignDraftPixels = () => {
    if (draftPixelIds.length === 0) {
      setNotice("先选择要退回 unknown 的已分类像素");
      return;
    }
    void commitSemanticOperation(
      {
        type: "unassign_pixels",
        spans: pixelIdsToSpans(draftPixelIds, layout),
      },
      `标记 ${draftPixelIds.length} 个像素为 unknown`,
    );
  };

  const splitActiveComponent = () => {
    if (!activeComponent || draftPixelIds.length === 0) {
      setNotice("拆分需要先选中来源组件，并在 Atlas 选择其部分像素");
      return;
    }
    try {
      void commitSemanticOperation(
        {
          type: "split_component",
          sourceComponentId: activeComponent.instanceId,
          target: semanticTarget(),
          spans: pixelIdsToSpans(draftPixelIds, layout),
        },
        `从 ${activeComponent.displayName} 拆分新组件`,
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const mergeCheckedComponents = () => {
    if (checkedComponentIds.length < 2) {
      setNotice("合并至少需要勾选 2 个组件");
      return;
    }
    try {
      void commitSemanticOperation(
        {
          type: "merge_components",
          componentIds: checkedComponentIds,
          target: semanticTarget(),
        },
        `合并 ${checkedComponentIds.length} 个组件`,
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const reclassifyActiveComponent = () => {
    if (!activeComponent) {
      setNotice("先在组件树中选择要改分类的组件");
      return;
    }
    void commitSemanticOperation(
      {
        type: "reclassify_component",
        componentId: activeComponent.instanceId,
        category: componentCategory,
        ...(componentSubtype.trim()
          ? { subtype: componentSubtype.trim() }
          : {}),
      },
      `重分类 ${activeComponent.displayName}`,
    );
  };

  const chooseComponent = (instanceId: string) => {
    const component = segmentation?.components.find(
      (candidate) => candidate.instanceId === instanceId,
    );
    if (!component) {
      return;
    }
    setActiveComponentId(component.instanceId);
    setComponentId(component.instanceId);
    setComponentName(component.displayName);
    setComponentCategory(component.category);
    setComponentSubtype(component.subtype ?? "");
  };

  const activateAnalyzedSkin = async (item: ApiAnalyzedSkin) => {
    setHistoryBusy(true);
    setHistoryError(null);
    try {
      const [project, branches, revisions, projects] = await Promise.all([
        getProject(item.project.id),
        listBranches(item.project.id),
        listRevisions(item.project.id),
        listProjects(),
      ]);
      setHistoryProject(project);
      setHistoryBranches(branches);
      setHistoryRevisions(revisions);
      setHistoryProjects(projects);
      window.localStorage.setItem(HISTORY_PROJECT_KEY, project.id);
      const revision = revisions.find(
        (candidate) => candidate.id === item.revision.id,
      );
      if (!revision) {
        throw new Error("目录中的 Revision 已不存在");
      }
      await activateRevision(revision);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setHistoryError(message);
      setNotice(`已分析皮肤载入失败：${message}`);
    } finally {
      setHistoryBusy(false);
    }
  };

  const exportAnalyzedGroup = async (
    item: ApiAnalyzedSkin,
    group: ApiAnalyzedSkinGroup,
  ) => {
    const busyKey = `${item.revision.id}:${group.key}`;
    setBusyCatalogGroupKey(busyKey);
    setCatalogError(null);
    setNotice(`正在将 ${group.displayName} 的 ${group.componentCount} 个组件整组入库`);
    try {
      const bundle = await exportRevisionBundle(item.revision.id, {
        name: group.displayName,
        kind: group.kind,
        componentIds: group.componentIds,
        ...(group.sourceGroupKey
          ? { sourceGroupKey: group.sourceGroupKey }
          : {}),
      });
      await refreshReusableCatalog();
      setSelectedBundleId(bundle.id);
      setNotice(
        `已入库 ${bundle.name} · 保留 ${bundle.members.length} 个可独立调整的细组件`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCatalogError(message);
      setNotice(`完整大类入库失败：${message}`);
    } finally {
      setBusyCatalogGroupKey(null);
    }
  };

  const exportActiveComponent = async () => {
    if (!selectedRevision || !activeComponent) {
      return;
    }
    setSemanticBusy(true);
    setHistoryError(null);
    try {
      const part = await exportRevisionPart(
        selectedRevision.id,
        activeComponent.instanceId,
        activeComponent.displayName,
      );
      await refreshReusableCatalog();
      setSelectedPartId(part.id);
      setCompositionPartId(part.id);
      setPartPreview(null);
      setNotice(`已保存部件 ${part.name} · 64×64 texture + write mask`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setHistoryError(message);
      setNotice(`部件导出失败：${message}`);
    } finally {
      setSemanticBusy(false);
    }
  };

  const previewSelectedPart = async () => {
    if (!selectedRevision || !selectedPart) {
      return;
    }
    setSemanticBusy(true);
    setHistoryError(null);
    try {
      const preview = await previewRevisionPart(
        selectedRevision.id,
        selectedPart.id,
      );
      setPartPreview(preview);
      setNotice(
        `冲突预览：${preview.report.hardConflictCount} 个硬冲突，尚未创建 Revision`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setHistoryError(message);
      setNotice(`部件冲突分析失败：${message}`);
    } finally {
      setSemanticBusy(false);
    }
  };

  const commitSelectedPart = async (
    strategy: "use_part" | "keep_base",
  ) => {
    if (!selectedRevision || !selectedPart || !partPreview) {
      return;
    }
    setSemanticBusy(true);
    setHistoryError(null);
    try {
      const result = await commitRevisionPart(
        selectedRevision.id,
        selectedPart.id,
        strategy,
      );
      setPartPreview(null);
      await refreshHistory(result.project.id, result.revision.id);
      setNotice(
        `已应用 ${selectedPart.name} · ${result.branch.name} #${result.revision.sequence}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setHistoryError(message);
      setNotice(`部件应用失败：${message}`);
    } finally {
      setSemanticBusy(false);
    }
  };

  const updateComposition = async (
    operation: () => Promise<ApiCompositionDetail>,
    pendingNotice: string,
    successNotice: (detail: ApiCompositionDetail) => string,
  ) => {
    setCompositionBusy(true);
    setCompositionError(null);
    setNotice(pendingNotice);
    try {
      const detail = await operation();
      setCompositionDetail(detail);
      setNotice(successNotice(detail));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCompositionError(message);
      setNotice(`混搭操作失败：${message}`);
    } finally {
      setCompositionBusy(false);
    }
  };

  const createNewComposition = async () => {
    if (!selectedRevision?.isBranchHead) {
      return;
    }
    await updateComposition(
      () =>
        createComposition(
          selectedRevision.id,
          compositionName.trim() || undefined,
        ),
      `正在基于 ${selectedRevision.branchName} #${selectedRevision.sequence} 创建混搭工程`,
      (detail) =>
        `已创建 ${detail.composition.name} · ${armLabels[detail.composition.armType]} · 等待添加图层`,
    );
  };

  const addPartToComposition = async (part: ApiPart) => {
    if (
      !composition ||
      !compositionDraft ||
      compositionDetail?.layers.some((layer) => layer.partId === part.id)
    ) {
      return;
    }
    setCompositionPartId(part.id);
    await updateComposition(
      () => addCompositionPart(composition.id, part.id),
      `正在添加部件 ${part.name}`,
      (detail) =>
        `已添加 ${part.name} · ${detail.report.unresolvedConflictCount} 项冲突待确认`,
    );
  };

  const addBundleToComposition = async (bundle: ApiPartBundle) => {
    if (!composition || !compositionDraft || selectedBundleAlreadyLayered) {
      return;
    }
    setSelectedBundleId(bundle.id);
    await updateComposition(
      () => applyCompositionBundle(composition.id, bundle.id),
      `正在整组添加 ${bundle.name}`,
      (detail) =>
        `已添加 ${bundle.name} 的 ${bundle.members.length} 个组件 · ${detail.report.unresolvedConflictCount} 项冲突待确认`,
    );
  };

  const moveCompositionLayer = async (layerId: string, delta: -1 | 1) => {
    if (!composition || !compositionDetail || !compositionDraft) {
      return;
    }
    const layerIds = compositionDetail.layers.map((layer) => layer.id);
    const sourceIndex = layerIds.indexOf(layerId);
    const targetIndex = sourceIndex + delta;
    if (sourceIndex < 0 || targetIndex < 0 || targetIndex >= layerIds.length) {
      return;
    }
    [layerIds[sourceIndex], layerIds[targetIndex]] = [
      layerIds[targetIndex]!,
      layerIds[sourceIndex]!,
    ];
    await updateComposition(
      () => reorderCompositionLayers(composition.id, layerIds),
      "正在调整图层覆盖顺序",
      (detail) =>
        `图层顺序已更新 · ${detail.report.unresolvedConflictCount} 项冲突待确认`,
    );
  };

  const deleteCompositionLayer = async (layerId: string) => {
    if (!composition || !compositionDraft) {
      return;
    }
    await updateComposition(
      () => removeCompositionLayer(composition.id, layerId),
      "正在移除混搭图层",
      (detail) =>
        `图层已移除 · 当前 ${detail.layers.length} 个可复用部件`,
    );
  };

  const resolveAllCompositionConflicts = async () => {
    if (!composition || !compositionDraft) {
      return;
    }
    await updateComposition(
      () =>
        resolveCompositionConflicts(composition.id, {
          strategy: "layer_order",
        }),
      "正在确认由上层图层覆盖冲突像素",
      (detail) =>
        detail.report.committable
          ? "图层顺序已明确确认，可以创建 Compose Revision"
          : `仍有 ${detail.report.unresolvedConflictCount} 项模型或语义边界冲突`,
    );
  };

  const clearCompositionResolutions = async () => {
    if (!composition || !compositionDraft) {
      return;
    }
    await updateComposition(
      () =>
        resolveCompositionConflicts(composition.id, { strategy: "clear" }),
      "正在清除冲突确认",
      (detail) =>
        `冲突确认已清除 · ${detail.report.unresolvedConflictCount} 项等待处理`,
    );
  };

  const chooseCompositionConflictWinner = async (
    conflictId: string,
    winnerLayerId: string,
  ) => {
    if (!composition || !compositionDraft) {
      return;
    }
    await updateComposition(
      () =>
        resolveCompositionConflicts(composition.id, {
          strategy: "winner",
          conflictId,
          winnerLayerId,
        }),
      "正在保存逐像素胜出图层",
      (detail) =>
        `像素处理已保存 · ${detail.report.unresolvedConflictCount} 项冲突待确认`,
    );
  };

  const changeRestorationMode = (mode: RestorationTargetMode) => {
    setRestorationMode(mode);
    setRestorationCandidates(null);
    setRestorationCandidateIds([]);
    setRestorationError(null);
    if (mode !== "fine") {
      const componentIds = restorationComponents
        .filter((component) => categoryBelongsToAggregate(component.category, mode))
        .map((component) => component.instanceId);
      setRestorationFineIds(componentIds);
    }
  };

  const toggleRestorationFineComponent = (componentId: string) => {
    setRestorationFineIds((current) =>
      current.includes(componentId)
        ? current.filter((id) => id !== componentId)
        : [...current, componentId],
    );
    setRestorationCandidates(null);
    setRestorationCandidateIds([]);
    setRestorationError(null);
  };

  const restorationGenerationInput = () => ({
    targetComponentIds: restorationTargetComponentIds,
    ...(restorationDonorRevisionId.trim()
      ? { donorRevisionId: restorationDonorRevisionId.trim() }
      : {}),
    ...(restorationIncludeManualColor
      ? { manualRgba: parseOpaqueHexColor(restorationManualColor) }
      : {}),
  });

  const generateRestorationCandidates = async () => {
    if (!composition || !compositionDraft || restorationTargetComponentIds.length === 0) {
      setRestorationError("请先明确选择要替换的精细组件或完整大类");
      return;
    }
    setRestorationBusy(true);
    setRestorationError(null);
    setNotice("正在从目标语义与已验证纹理生成还原候选");
    try {
      const next = await generateCompositionRestorationCandidates(
        composition.id,
        restorationGenerationInput(),
      );
      setRestorationCandidates(next);
      setRestorationCandidateIds(defaultRestorationCandidateIds(next));
      setNotice(
        `已生成肤色候选 · Outer ${next.outer.pixelCount} px · Base 缺口 ${next.base.missingPixelCount} px`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRestorationError(message);
      setNotice(`还原候选生成失败：${message}`);
    } finally {
      setRestorationBusy(false);
    }
  };

  const beginRestorationRecommendation = async () => {
    if (
      !composition ||
      !compositionDraft ||
      !restorationCandidates ||
      !restorationRecommendationProvider ||
      !restorationRecommendationProviders.includes(
        restorationRecommendationProvider,
      ) ||
      !aiModel.trim() ||
      !restorationRecommendationUserIntent.trim() ||
      restorationRecommendationRunning
    ) {
      return;
    }
    setRestorationRecommendationBusy(true);
    setRestorationRecommendationError(null);
    setNotice("正在创建受限 AI 修补候选推荐任务");
    const contextId = restorationRecommendationContextRef.current;
    try {
      const job = await startAiRestorationRecommendation(composition.id, {
        provider: restorationRecommendationProvider,
        model: aiModel.trim(),
        reasoningEffort: aiReasoningEffort,
        userIntent: restorationRecommendationUserIntent.trim(),
        compositionVersion: restorationCandidates.version,
        candidateSetHash: restorationCandidates.candidateSetHash,
        ...restorationGenerationInput(),
      });
      if (job.kind !== "restoration_recommendation") {
        throw new Error("API 返回的 Job 不是修补候选推荐任务");
      }
      if (contextId !== restorationRecommendationContextRef.current) return;
      await synchronizeRestorationRecommendationJob(job.id, contextId);
      setNotice("AI 推荐任务已创建 · 候选选择与还原计划保持不变");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRestorationRecommendationError(message);
      setNotice(`AI 修补候选推荐启动失败：${message}`);
    } finally {
      setRestorationRecommendationBusy(false);
    }
  };

  const cancelRestorationRecommendation = async () => {
    if (!restorationRecommendationJob || !restorationRecommendationRunning) return;
    setRestorationRecommendationBusy(true);
    setRestorationRecommendationError(null);
    try {
      await cancelAiJob(restorationRecommendationJob.id);
      await synchronizeRestorationRecommendationJob(restorationRecommendationJob.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRestorationRecommendationError(message);
      setNotice(`AI 推荐取消失败：${message}`);
    } finally {
      setRestorationRecommendationBusy(false);
    }
  };

  const loadRestorationRecommendation = () => {
    if (!restorationRecommendationJob) return;
    const result = loadRestorationRecommendationSelection(
      composition,
      restorationCandidates,
      restorationRecommendationJob,
    );
    if (!result.ok) {
      setRestorationRecommendationError(result.reason);
      return;
    }
    setRestorationCandidateIds(result.candidateIds);
    setRestorationRecommendationError(null);
    setNotice("AI 建议已载入本地候选选择 · 尚未应用还原计划");
  };

  const toggleRestorationCandidate = (candidateId: string) => {
    if (!restorationCandidates || candidateId === restorationCandidates.outer.candidateId) {
      return;
    }
    setRestorationCandidateIds((current) =>
      toggleRestorationCandidateId(restorationCandidates, current, candidateId),
    );
  };

  const applyRestorationPlan = async () => {
    if (
      !composition ||
      !compositionDraft ||
      !restorationCandidates ||
      restorationCoverage.missingPixelCount > 0
    ) {
      return;
    }
    setRestorationBusy(true);
    setRestorationError(null);
    setNotice("正在重新计算候选并应用清理计划");
    try {
      const detail = await setCompositionRestorationPlan(composition.id, {
        expectedVersion: restorationCandidates.version,
        candidateSetHash: restorationCandidates.candidateSetHash,
        candidateIds: restorationCandidateIds,
        ...restorationGenerationInput(),
      });
      setCompositionDetail(detail);
      setRestorationCandidates(null);
      setRestorationCandidateIds([]);
      setNotice(
        `清理计划已应用 · ${detail.report.restorationPixelCount ?? 0} px · 2D/3D 预览已刷新`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRestorationError(message);
      setNotice(`清理计划应用失败：${message}`);
    } finally {
      setRestorationBusy(false);
    }
  };

  const clearRestorationPlan = async () => {
    if (!composition || !compositionDraft || !composition.restorationPlan) return;
    setRestorationBusy(true);
    setRestorationError(null);
    setNotice("正在清除目标皮肤还原计划");
    try {
      const detail = await clearCompositionRestorationPlan(
        composition.id,
        composition.restorationPlan.version,
      );
      setCompositionDetail(detail);
      setRestorationCandidates(null);
      setRestorationCandidateIds([]);
      setNotice("目标皮肤还原计划已清除");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRestorationError(message);
      setNotice(`清除还原计划失败：${message}`);
    } finally {
      setRestorationBusy(false);
    }
  };

  const commitActiveComposition = async () => {
    if (
      !composition ||
      !compositionReport?.committable ||
      (compositionReport.restorationMissingPixelCount ?? 0) > 0 ||
      (compositionReport.restorationIssueCount ?? 0) > 0 ||
      !compositionDraft
    ) {
      return;
    }
    setCompositionBusy(true);
    setCompositionError(null);
    setNotice("正在校验混搭结果并创建不可变 Revision");
    try {
      const result = await commitCompositionProject(
        composition.id,
        `混搭提交：${composition.name}`,
      );
      await refreshHistory(result.project.id, result.revision.id);
      setNotice(
        `混搭已提交 · ${result.branch.name} #${result.revision.sequence} · ${result.report.appliedPixelCount} px`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCompositionError(message);
      setNotice(`混搭提交失败：${message}`);
    } finally {
      setCompositionBusy(false);
    }
  };

  const downloadActiveSkin = () => {
    if (!activeSkin) {
      return;
    }

    const encoded = encodeSkinPng(activeSkin.image);
    const copy = new Uint8Array(encoded.byteLength);
    copy.set(encoded);
    const downloadUrl = URL.createObjectURL(
      new Blob([copy.buffer], { type: "image/png" }),
    );
    const link = document.createElement("a");
    link.href = downloadUrl;
    link.download = activeSkin.name;
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 0);
    setNotice(`已导出 ${activeSkin.name}，RGBA 像素保持不变`);
  };

  return (
    <main className="studio-shell">
      <header className="studio-header">
        <div>
          <p className="eyebrow">VERSIONED SKIN REPAIR + RESTORATION STUDIO / M10</p>
          <h1>
            MC<span>Skin</span>Split
          </h1>
          <p className="lede">
            Codex 辅助识别真实皮肤的语义部件，并对确定性还原候选给出受限建议；单组件修补、多图层混搭与目标残留还原均保留可追溯历史。
          </p>
        </div>
        <div className="baseline-stamp" aria-label="M10 受限 AI 换装建议与目标皮肤还原工作室">
          <strong>M10</strong>
          <span>ADVISE + RESTORE</span>
        </div>
      </header>

      <section className="history-panel" aria-label="Revision 时间线">
        <div className="history-toolbar">
          <div className="panel-heading">
            <span>00</span>
            <div>
              <p>VERSION CONTROL</p>
              <h2>不可变 Revision 时间线</h2>
            </div>
          </div>

          <label className="history-select">
            <span>PROJECT</span>
            <select
              value={historyProject?.id ?? ""}
              disabled={historyBusy || historyProjects.length === 0}
              onChange={(event) => void chooseHistoryProject(event.target.value)}
            >
              {historyProjects.length === 0 && <option value="">暂无版本项目</option>}
              {historyProjects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>

          <label className="history-select">
            <span>BRANCH VIEW</span>
            <select
              value={branchFilter}
              disabled={historyBusy || historyBranches.length === 0}
              onChange={(event) => setBranchFilter(event.target.value)}
            >
              <option value="all">全部分支</option>
              {historyBranches.map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.name}
                </option>
              ))}
            </select>
          </label>

          <button
            className="history-import-button"
            type="button"
            disabled={!activeSkin || historyBusy}
            onClick={importActiveSkin}
          >
            当前皮肤 → IMPORT
          </button>
        </div>

        <div className="timeline-rail" data-empty={visibleRevisions.length === 0}>
          {visibleRevisions.length === 0 ? (
            <p>
              {historyBusy
                ? "正在读取 SQLite 时间线…"
                : "上传 PNG 会自动创建 Project 与首个 Import Revision。"}
            </p>
          ) : (
            visibleRevisions.map((revision) => (
              <button
                key={revision.id}
                className="revision-node"
                type="button"
                data-head={revision.isBranchHead}
                data-selected={revision.id === selectedRevisionId}
                disabled={historyBusy}
                onClick={() => void activateRevision(revision)}
              >
                <span className="revision-node-index">
                  {revision.branchName} / {String(revision.sequence).padStart(2, "0")}
                </span>
                <strong>
                  {operationLabels[revision.operationType] ?? revision.operationType.toUpperCase()}
                </strong>
                <small title={revision.summary}>{revision.summary}</small>
                <time dateTime={revision.createdAt}>
                  {formatRevisionTime(revision.createdAt)}
                </time>
              </button>
            ))
          )}
        </div>

        <div className="history-actions">
          <div className="history-facts">
            <span>
              PROJECT <strong>{historyProject?.name ?? "未连接"}</strong>
            </span>
            <span>
              REVISIONS <strong>{historyRevisions.length}</strong>
            </span>
            <span>
              SELECTED{" "}
              <strong>
                {selectedRevision
                  ? `${selectedRevision.branchName} #${selectedRevision.sequence}`
                  : "LOCAL SKIN"}
              </strong>
            </span>
          </div>

          <form className="branch-form" onSubmit={createBranchFromSelection}>
            <label>
              <span>NEW BRANCH</span>
              <input
                value={branchName}
                maxLength={80}
                disabled={!selectedRevision || historyBusy}
                onChange={(event) => setBranchName(event.target.value)}
              />
            </label>
            <button
              type="submit"
              disabled={!selectedRevision || !branchName.trim() || historyBusy}
            >
              从所选节点分支
            </button>
            <button
              className="revert-button"
              type="button"
              disabled={!selectedRevision || historyBusy}
              onClick={() => void revertToSelection()}
            >
              恢复为新 Revision
            </button>
          </form>
        </div>

        {historyError && <p className="history-error">{historyError}</p>}
      </section>

      <AnalyzedSkinCatalog
        items={analyzedSkins}
        busyGroupKey={busyCatalogGroupKey}
        loading={catalogLoading}
        error={catalogError}
        selectedRevisionId={selectedRevisionId}
        onActivate={(item) => void activateAnalyzedSkin(item)}
        onExportGroup={(item, group) => void exportAnalyzedGroup(item, group)}
      />

      <section
        className="ai-console"
        data-status={aiJob?.status ?? "idle"}
        aria-label="AI 语义识别任务"
      >
        <div className="ai-console-heading">
          <div className="panel-heading">
            <span>AI</span>
            <div>
              <p>CODEX SEMANTIC PROPOSAL</p>
              <h2>隔离识别与人工审核</h2>
            </div>
          </div>
          <p>
            AI 只提交 JSON 分类提案；源 PNG、候选区域和正式数据库由确定性代码控制。
          </p>
        </div>

        <div className="ai-console-grid">
          <form
            className="ai-config"
            onSubmit={(event) => {
              event.preventDefault();
              void beginAiAnalysis();
            }}
          >
            <label>
              <span>PROVIDER</span>
              <select
                value={aiProvider}
                disabled={aiBusy || aiJobRunning || aiProviders.length === 0}
                onChange={(event) => setAiProvider(event.target.value)}
              >
                {aiProviders.length === 0 && <option value="">不可用</option>}
                {aiProviders.map((provider) => (
                  <option key={provider} value={provider}>
                    {provider === "codex-exec" ? "本地 Codex CLI" : provider}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>MODEL</span>
              <input
                value={aiModel}
                maxLength={120}
                disabled={aiBusy || aiJobRunning}
                onChange={(event) => setAiModel(event.target.value)}
              />
            </label>
            <label>
              <span>REASONING</span>
              <select
                value={aiReasoningEffort}
                disabled={aiBusy || aiJobRunning}
                onChange={(event) =>
                  setAiReasoningEffort(
                    event.target.value as ApiAiAnalysisOptions["reasoningEffort"],
                  )
                }
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="xhigh">XHigh</option>
                <option value="max">Max</option>
              </select>
            </label>
            <dl className="ai-input-facts">
              <div>
                <dt>INPUT</dt>
                <dd>
                  {selectedRevision
                    ? `${selectedRevision.branchName} #${selectedRevision.sequence}`
                    : "请选择 Revision"}
                </dd>
              </div>
              <div>
                <dt>MODEL RULE</dt>
                <dd>{selectedRevision ? armLabels[resolvedArmType] : "—"}</dd>
              </div>
              <div>
                <dt>TAXONOMY</dt>
                <dd>{aiFocus.length} 类粗粒度识别</dd>
              </div>
            </dl>
            <p className="ai-privacy-note">
              本地 Codex CLI 在单次任务目录运行；图片可能由当前 Codex 配置的远端模型处理。
            </p>
            <div className="ai-controls">
              <button type="submit" disabled={!canStartAi || aiBusy}>
                识别所选 HEAD Revision
              </button>
              {aiJobRunning ? (
                <button
                  className="ai-secondary-button"
                  type="button"
                  disabled={aiBusy}
                  onClick={() => void cancelActiveAiJob()}
                >
                  取消任务
                </button>
              ) : (
                <button
                  className="ai-secondary-button"
                  type="button"
                  disabled={!aiJob || aiBusy || !aiProvider || !aiModel.trim()}
                  onClick={() => void retrySelectedAiJob()}
                >
                  {aiSourceRevision?.isBranchHead
                    ? "以当前配置重试"
                    : "重跑历史输入（仅提案）"}
                </button>
              )}
            </div>
          </form>

          <article className="ai-job-card">
            {aiJob ? (
              <>
                <div className="ai-job-status">
                  <span>{aiStatusLabels[aiJob.status]}</span>
                  <strong>{String(aiJobDetail?.runs.length ?? 0).padStart(2, "0")} RUNS</strong>
                </div>
                <div className="ai-job-meta">
                  <code>{shortIdentifier(aiJob.id)}</code>
                  <span>{aiJob.provider} / {aiJob.model}</span>
                  <span>reasoning / {aiJob.options.reasoningEffort}</span>
                  <span>{aiJob.skillName} {aiJob.skillVersion}</span>
                </div>

                <SemanticAiJobProgress detail={aiJobDetail} />

                {aiJob.proposalSummary && (
                  <p className="ai-proposal-summary">{aiJob.proposalSummary}</p>
                )}

                {aiJob.error && (
                  <p className="ai-job-error">
                    <strong>{aiJob.error.code}</strong>
                    {aiJob.error.message}
                  </p>
                )}

                {aiJob.reviewItems.length > 0 && (
                  <div className="ai-review-list">
                    <h3>{aiJob.reviewItems.length} 项需要人工审核</h3>
                    {aiJob.reviewItems.map((item, index) => (
                      <div key={`${item.type}-${index}`}>
                        <span>{Math.round(item.confidence * 100)}%</span>
                        <p>{item.question}</p>
                        <small>
                          {item.suggestedCategories
                            .map((category) => SEMANTIC_CATEGORY_LABELS[category])
                            .join(" / ") || "保留 unknown"}
                        </small>
                      </div>
                    ))}
                  </div>
                )}

                <div className="ai-run-strip">
                  {aiJobDetail?.runs.map((run) => (
                    <span key={run.id} data-status={run.status}>
                      RUN {run.attempt} · {run.status.toUpperCase()} · {run.assets.length} FILES
                    </span>
                  ))}
                </div>

                <SemanticAiEventLog
                  events={aiJobDetail?.events ?? []}
                  running={aiJobRunning}
                  logRef={aiEventLogRef}
                />
              </>
            ) : (
              <>
                <SemanticAiJobProgress detail={null} />
                <div className="ai-empty-state">
                  <strong>NO ANALYSIS JOB</strong>
                  <p>选择 Branch HEAD 后启动识别。上方大纲会显示每个确定性阶段，实时日志提供步骤明细。</p>
                </div>
              </>
            )}
            {aiError && <p className="ai-console-error">{aiError}</p>}
          </article>
        </div>
      </section>

      <section className="workbench" aria-label="皮肤预览工作台">
        <aside className="control-panel panel">
          <div className="panel-heading">
            <span>01</span>
            <div>
              <p>INPUT</p>
              <h2>载入与布局</h2>
            </div>
          </div>

          <label
            className="drop-zone"
            data-dragging={isDragging}
            onDragEnter={(event) => {
              event.preventDefault();
              setIsDragging(true);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
          >
            <input type="file" accept="image/png,.png" onChange={handleFileInput} />
            <span className="drop-icon" aria-hidden="true">+</span>
            <strong>{isLoadingSkin ? "正在解码像素…" : "选择或拖入 PNG"}</strong>
            <small>上传即创建 Import Revision · 64×64 · 最大 1 MiB</small>
          </label>

          <div className="fixture-picker" aria-label="真实与确定性测试皮肤">
            <span>REAL SKINS + LAB</span>
            <div>
              {SKIN_FIXTURES.map((fixture) => (
                <button
                  key={fixture.id}
                  type="button"
                  aria-label={`${fixture.label}：${fixture.name}`}
                  data-active={activeSkin?.fixtureId === fixture.id}
                  disabled={isLoadingSkin}
                  onClick={() => void activateFixture(fixture)}
                >
                  {fixture.label}
                </button>
              ))}
            </div>
          </div>

          <div className="model-selector">
            <span>MODEL RULE</span>
            <div className="segmented-control" aria-label="手臂模型规则">
              {(["auto", "wide", "slim"] as const).map((choice) => (
                <button
                  key={choice}
                  type="button"
                  aria-pressed={modelChoice === choice}
                  onClick={() => chooseModel(choice)}
                >
                  {choice === "auto" ? "自动" : choice === "wide" ? "Wide" : "Slim"}
                </button>
              ))}
            </div>
          </div>

          <dl className="file-facts">
            <div>
              <dt>纹理</dt>
              <dd title={skinName}>{skinName}</dd>
            </div>
            <div>
              <dt>像素</dt>
              <dd>{activeSkin ? "64×64 RGBA" : "解码中"}</dd>
            </div>
            <div>
              <dt>识别</dt>
              <dd>{armLabels[activeSkin?.assessment.armType ?? "slim"]}</dd>
            </div>
            <div>
              <dt>依据</dt>
              <dd title={activeSkin ? inferenceLabels[activeSkin.assessment.reason] : undefined}>
                {activeSkin ? inferenceLabels[activeSkin.assessment.reason] : "等待读取"}
              </dd>
            </div>
            <div>
              <dt>生效</dt>
              <dd>{armLabels[resolvedArmType]}</dd>
            </div>
            <div>
              <dt>UV</dt>
              <dd>72 面 · {layout.usedPixelCount} 像素</dd>
            </div>
          </dl>

          <button
            className="download-button"
            type="button"
            disabled={!activeSkin}
            onClick={downloadActiveSkin}
          >
            下载当前 PNG
          </button>
        </aside>

        <section className="atlas-panel panel">
          <div className="panel-heading-row">
            <div className="panel-heading">
              <span>02</span>
              <div>
                <p>PIXEL OUTPUT</p>
                <h2>{pixelView === "atlas" ? "16× UV Atlas" : "72 面 Contact Sheet"}</h2>
              </div>
            </div>
            <div className="view-switch" aria-label="像素输出视图">
              <button
                type="button"
                aria-pressed={pixelView === "atlas"}
                onClick={() => setPixelView("atlas")}
              >
                ATLAS
              </button>
              <button
                type="button"
                aria-pressed={pixelView === "faces"}
                onClick={() => setPixelView("faces")}
              >
                FACES
              </button>
            </div>
          </div>

          <div className="atlas-stage" data-view={pixelView}>
            {pixelView === "atlas" && <div className="atlas-grid" aria-hidden="true" />}
            {activeSkin ? (
              <AtlasCanvas
                armType={resolvedArmType}
                image={activeSkin.image}
                skinName={activeSkin.name}
                view={pixelView}
              />
            ) : (
              <p className="pixel-loading">DECODE RGBA…</p>
            )}
          </div>
          <p className="panel-note">
            {pixelView === "atlas"
              ? "Canvas 实际缓冲区为 1024×1024，使用 16× 最近邻复制；未经过浏览器图片重采样。"
              : "按身体部位 → Base/Outer → front/back/left/right/top/bottom 的固定顺序生成。"}
          </p>
        </section>

        <section className="avatar-panel panel" data-state={previewState}>
          <div className="panel-heading">
            <span>03</span>
            <div>
              <p>AVATAR</p>
              <h2>{armLabels[resolvedArmType]}</h2>
            </div>
          </div>
          <p className="avatar-revision">
            {selectedRevision
              ? `REVISION / ${selectedRevision.branchName} #${selectedRevision.sequence}`
              : `LOCAL / ${skinName}`}
          </p>
          <SkinPreview
            armType={resolvedArmType}
            skinUrl={skinUrl}
            onStateChange={handlePreviewState}
          />
          <div className="viewer-status">
            <i aria-hidden="true" />
            {previewLabels[previewState]}
          </div>
        </section>
      </section>

      <section className="semantic-workspace" aria-label="人工语义编辑与部件库">
        <section className="semantic-panel semantic-editor-panel">
          <div className="panel-heading">
            <span>04</span>
            <div>
              <p>SEMANTIC BRUSH</p>
              <h2>64×64 像素草稿</h2>
            </div>
          </div>
          <div className="semantic-canvas-frame">
            {activeSkin && segmentation ? (
              <SemanticEditorCanvas
                activeComponentId={activeComponentId ?? undefined}
                armType={segmentation.source.armType}
                components={segmentation.components}
                disabled={!canEditSemantic || semanticBusy}
                image={activeSkin.image}
                selectedPixelIds={draftPixelIds}
                onSelectionChange={setDraftPixelIds}
              />
            ) : (
              <p>选择一个 Revision 后启用语义画笔</p>
            )}
          </div>
          <div className="semantic-draft-toolbar">
            <span>
              DRAFT <strong>{draftPixelIds.length}</strong> PX
            </span>
            <button
              type="button"
              disabled={draftPixelIds.length === 0 || semanticBusy}
              onClick={() => setDraftPixelIds([])}
            >
              清空草稿
            </button>
            <button
              type="button"
              disabled={!canEditSemantic || draftPixelIds.length === 0 || semanticBusy}
              onClick={unassignDraftPixels}
            >
              标记 unknown
            </button>
          </div>
          <p className="semantic-help">
            单击或拖动选择有效非透明 UV 像素；再次划过可擦除草稿。画笔过程不写快照，只有右侧确认操作才创建 Revision。
          </p>
        </section>

        <section className="semantic-panel component-panel">
          <div className="panel-heading semantic-heading-split">
            <span>05</span>
            <div>
              <p>COMPONENT TREE</p>
              <h2>组件与分类</h2>
            </div>
            <strong>{segmentation?.components.length ?? 0}</strong>
          </div>

          <div className="component-tree" aria-label="语义组件树">
            <div className="component-row unknown-row">
              <span aria-hidden="true">?</span>
              <div>
                <strong>unknown</strong>
                <small>{segmentation?.unknown.pixelCount ?? 0} px 待分类</small>
              </div>
            </div>
            {segmentation?.components.map((component) => (
              <div
                key={component.instanceId}
                className="component-row"
                data-active={component.instanceId === activeComponentId}
              >
                <input
                  type="checkbox"
                  aria-label={`合并选择 ${component.displayName}`}
                  checked={checkedComponentIds.includes(component.instanceId)}
                  disabled={semanticBusy}
                  onChange={(event) =>
                    setCheckedComponentIds((current) =>
                      event.target.checked
                        ? [...new Set([...current, component.instanceId])]
                        : current.filter((id) => id !== component.instanceId),
                    )
                  }
                />
                <button
                  type="button"
                  disabled={semanticBusy}
                  onClick={() => chooseComponent(component.instanceId)}
                >
                  <strong>{component.displayName}</strong>
                  <small>
                    {SEMANTIC_CATEGORY_LABELS[component.category]} · {component.spans.reduce(
                      (total, span) => total + span.x1 - span.x0 + 1,
                      0,
                    )} px
                    {component.reviewState === "needs_review" ? " · 需审核" : ""}
                  </small>
                </button>
              </div>
            ))}
          </div>

          <div className="semantic-form">
            <label>
              <span>INSTANCE ID</span>
              <input
                value={componentId}
                maxLength={100}
                disabled={semanticBusy}
                onChange={(event) => setComponentId(event.target.value)}
              />
            </label>
            <label>
              <span>显示名称</span>
              <input
                value={componentName}
                maxLength={80}
                disabled={semanticBusy}
                onChange={(event) => setComponentName(event.target.value)}
              />
            </label>
            <label>
              <span>分类</span>
              <select
                value={componentCategory}
                disabled={semanticBusy}
                onChange={(event) =>
                  setComponentCategory(event.target.value as SemanticCategory)
                }
              >
                {SEMANTIC_CATEGORIES.map((category) => (
                  <option key={category} value={category}>
                    {SEMANTIC_CATEGORY_LABELS[category]} / {category}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>SUBTYPE（可选）</span>
              <input
                value={componentSubtype}
                maxLength={80}
                disabled={semanticBusy}
                onChange={(event) => setComponentSubtype(event.target.value)}
              />
            </label>
          </div>

          <div className="semantic-actions">
            <button
              type="button"
              disabled={!canEditSemantic || draftPixelIds.length === 0 || semanticBusy}
              onClick={assignDraftPixels}
            >
              确认像素分类
            </button>
            <button
              type="button"
              disabled={!canEditSemantic || !activeComponent || draftPixelIds.length === 0 || semanticBusy}
              onClick={splitActiveComponent}
            >
              拆分为新组件
            </button>
            <button
              type="button"
              disabled={!canEditSemantic || !activeComponent || semanticBusy}
              onClick={reclassifyActiveComponent}
            >
              修改所选分类
            </button>
            <button
              type="button"
              disabled={!canEditSemantic || checkedComponentIds.length < 2 || semanticBusy}
              onClick={mergeCheckedComponents}
            >
              合并勾选组件
            </button>
          </div>
          <button
            className="export-part-button"
            type="button"
            disabled={!activeComponent || semanticBusy}
            onClick={() => void exportActiveComponent()}
          >
            所选组件 → 保存为 64×64 部件
          </button>
        </section>

        <section className="semantic-panel parts-panel">
          <div className="panel-heading semantic-heading-split">
            <span>06</span>
            <div>
              <p>PART LIBRARY</p>
              <h2>复用与冲突</h2>
            </div>
            <strong>{partLibrary.length}</strong>
          </div>

          <div className="part-library" data-empty={partLibrary.length === 0}>
            {partLibrary.length === 0 ? (
              <p>从组件树保存头发、衣服、手套或鞋后，部件会出现在这里。</p>
            ) : (
              partLibrary.map((part) => (
                <button
                  key={part.id}
                  className="part-card"
                  type="button"
                  data-active={part.id === selectedPartId}
                  disabled={semanticBusy}
                  onClick={() => {
                    setSelectedPartId(part.id);
                    setPartPreview(null);
                  }}
                >
                  <img src={partPreviewUrl(part.id)} alt="" />
                  <span>
                    <strong>{part.name}</strong>
                    <small>
                      {SEMANTIC_CATEGORY_LABELS[part.category]} · {part.manifest.compatibility.armTypes.join("/")}
                    </small>
                  </span>
                </button>
              ))
            )}
          </div>

          {selectedPart && (
            <div className="part-selection">
              <div>
                <strong>{selectedPart.name}</strong>
                <span>{selectedPart.manifest.placement.surfaces.length} surfaces</span>
              </div>
              <button
                type="button"
                disabled={!selectedRevision || semanticBusy}
                onClick={() => void previewSelectedPart()}
              >
                先分析冲突
              </button>
            </div>
          )}

          {partPreview && (
            <div className="conflict-report" aria-label="部件冲突报告">
              <p>
                <strong>{partPreview.report.hardConflictCount}</strong> 硬冲突
                <span>{partPreview.report.sameColorOverlapCount} 同色重叠</span>
              </p>
              <dl>
                <div>
                  <dt>写入</dt>
                  <dd>{partPreview.report.writePixelCount} px</dd>
                </div>
                <div>
                  <dt>模型</dt>
                  <dd>{partPreview.report.modelConflict ? "不兼容" : "兼容"}</dd>
                </div>
              </dl>
              <small>预览阶段没有创建 Revision。请选择明确的像素处理策略。</small>
              <div>
                <button
                  type="button"
                  disabled={!canEditSemantic || partPreview.report.modelConflict || semanticBusy}
                  onClick={() => void commitSelectedPart("use_part")}
                >
                  冲突处使用部件
                </button>
                <button
                  type="button"
                  disabled={
                    !canEditSemantic ||
                    partPreview.report.modelConflict ||
                    partPreview.report.writePixelCount <=
                      partPreview.report.hardConflictCount +
                        partPreview.report.sameColorOverlapCount ||
                    semanticBusy
                  }
                  onClick={() => void commitSelectedPart("keep_base")}
                >
                  冲突处保留基础
                </button>
              </div>
            </div>
          )}
        </section>
      </section>

      <ComponentRepairStudio
        parts={partLibrary}
        defaultArmType={resolvedArmType}
        onNotice={setNotice}
        onCommittedPart={async (part) => {
          await refreshReusableCatalog();
          setSelectedPartId(part.id);
          setCompositionPartId(part.id);
        }}
      />

      <section
        className="composition-studio"
        aria-label="多部件混搭与冲突处理"
        data-status={composition?.status ?? "idle"}
      >
        <header className="composition-heading">
          <div className="panel-heading">
              <span>08</span>
            <div>
              <p>PIXEL-SAFE COMPOSER</p>
              <h2>多皮肤部件混搭</h2>
            </div>
          </div>
          <p>
            <strong>{composition ? composition.name : "NO DRAFT"}</strong>
            <span>
              {composition
                ? `${armLabels[composition.armType]} · ${composition.status.toUpperCase()}`
                : "选择 Branch HEAD 后创建"}
            </span>
          </p>
        </header>

        <div className="composition-grid">
          <section className="composition-setup">
            <div className="composition-section-title">
              <span>PART LIBRARY</span>
              <h3>组件直接入场</h3>
            </div>
            <label className="composition-name-field">
              <span>混搭工程名称</span>
              <input
                value={compositionName}
                maxLength={120}
                disabled={compositionBusy}
                onChange={(event) => setCompositionName(event.target.value)}
              />
            </label>
            <button
              className="composition-create-button"
              type="button"
              disabled={!selectedRevision?.isBranchHead || compositionBusy}
              onClick={() => void createNewComposition()}
            >
              {compositionDraft ? "另建混搭草稿" : "创建混搭工程"}
            </button>

            <dl className="composition-base-facts">
              <div>
                <dt>BASE</dt>
                <dd>
                  {selectedRevision
                    ? `${selectedRevision.branchName} #${selectedRevision.sequence}`
                    : "未选择 Revision"}
                </dd>
              </div>
              <div>
                <dt>MODEL</dt>
                <dd>{composition ? armLabels[composition.armType] : "Alex / Slim 默认"}</dd>
              </div>
            </dl>

            <PartBundleShelf
              bundles={partBundles}
              selectedBundle={selectedBundle}
              targetArmType={compositionTargetArmType}
              draftReady={Boolean(compositionDraft)}
              busy={compositionBusy}
              allMembersLayered={selectedBundleAlreadyLayered}
              motion={bundleInspectorMotion}
              onSelect={setSelectedBundleId}
              onAdd={(bundle) => void addBundleToComposition(bundle)}
              onMotionChange={setBundleInspectorMotion}
            />

            <div className="composition-section-title atomic-parts-title">
              <span>ATOMIC PARTS</span>
              <h3>细组件逐个入场</h3>
              <small>保留原有 23 类语义组件与单件冲突处理。</small>
            </div>

            <div
              className="composition-part-library"
              data-empty={partLibrary.length === 0}
              aria-label="混搭组件库"
            >
              {partLibrary.length ? (
                partLibrary.map((part) => {
                  const layered = Boolean(
                    compositionDetail?.layers.some(
                      (layer) => layer.partId === part.id,
                    ),
                  );
                  const compatible =
                    !composition ||
                    part.manifest.compatibility.armTypes.includes(
                      composition.armType,
                    );
                  return (
                    <article
                      key={part.id}
                      className="composition-part-card"
                      data-active={part.id === compositionPartId}
                      data-compatible={compatible}
                    >
                      <button
                        className="composition-part-select"
                        type="button"
                        aria-pressed={part.id === compositionPartId}
                        onClick={() => setCompositionPartId(part.id)}
                      >
                        <img src={partPreviewUrl(part.id)} alt="" />
                        <span>
                          <strong>{part.name}</strong>
                          <small>
                            {SEMANTIC_CATEGORY_LABELS[part.category]} · {part.manifest.compatibility.armTypes.join("/")}
                          </small>
                        </span>
                      </button>
                      <button
                        className="composition-part-add"
                        type="button"
                        aria-label={`将 ${part.name} 加入混搭`}
                        title={
                          !compatible
                            ? `不兼容 ${armLabels[composition?.armType ?? "slim"]}`
                            : layered
                              ? "已在图层中"
                              : "加入混搭"
                        }
                        disabled={
                          !compositionDraft ||
                          compositionBusy ||
                          layered ||
                          !compatible
                        }
                        onClick={() => void addPartToComposition(part)}
                      >
                        {layered ? "✓" : "+"}
                      </button>
                    </article>
                  );
                })
              ) : (
                <p>保存语义组件后，它会直接出现在这里，不必回到上方点选。</p>
              )}
            </div>

            <div
              className="component-inspector"
              data-empty={!compositionPart}
            >
              {compositionPart ? (
                <>
                  <header>
                    <div>
                      <span>3D COMPONENT</span>
                      <strong>{compositionPart.name}</strong>
                    </div>
                    <small>拖拽旋转 · 滚轮缩放</small>
                  </header>
                  <div className="composition-3d-frame">
                    <SkinPreview
                      className="compact-skin-stage"
                      skinUrl={partMannequinUrl(
                        compositionPart.id,
                        inspectedPartArmType,
                      )}
                      armType={inspectedPartArmType}
                      motion={componentInspectorMotion}
                      ariaLabel={`${compositionPart.name} 白模三维预览`}
                    />
                    <div className="preview-chip-controls" aria-label="组件预览动作">
                      <button
                        type="button"
                        aria-pressed={componentInspectorMotion === "idle"}
                        onClick={() => setComponentInspectorMotion("idle")}
                      >
                        静止
                      </button>
                      <button
                        type="button"
                        aria-pressed={componentInspectorMotion === "walk"}
                        onClick={() => setComponentInspectorMotion("walk")}
                      >
                        走动
                      </button>
                    </div>
                  </div>
                  <button
                    className="component-inspector-add"
                    type="button"
                    disabled={
                      !compositionDraft ||
                      compositionBusy ||
                      compositionPartAlreadyLayered ||
                      !compositionPart.manifest.compatibility.armTypes.includes(
                        compositionTargetArmType,
                      )
                    }
                    onClick={() => void addPartToComposition(compositionPart)}
                  >
                    {compositionPartAlreadyLayered
                      ? "已在图层中"
                      : "将当前组件加入混搭"}
                  </button>
                </>
              ) : (
                <p>选择任意组件即可在白模上检查实际覆盖位置。</p>
              )}
            </div>
            {compositionError && (
              <p className="composition-error" role="alert">
                {compositionError}
              </p>
            )}
          </section>

          <section className="composition-layers-panel">
            <div className="composition-section-title">
              <span>LAYER STACK</span>
              <h3>覆盖优先级</h3>
            </div>
            <p className="composition-layer-guide">
              顶部图层优先写入；重新排序会清除已有冲突确认。
            </p>
            <div className="composition-layers" data-empty={!compositionDetail?.layers.length}>
              {compositionDetail?.layers.length ? (
                compositionDetail.layers.toReversed().map((layer) => (
                  <article key={layer.id} className="composition-layer">
                    <span>{layer.position === compositionDetail.layers.length - 1 ? "TOP" : `L${layer.position + 1}`}</span>
                    <img src={partPreviewUrl(layer.part.id)} alt="" />
                    <div>
                      <strong>{layer.part.name}</strong>
                      <small>{SEMANTIC_CATEGORY_LABELS[layer.part.category]}</small>
                    </div>
                    <div className="composition-layer-actions">
                      <button
                        type="button"
                        aria-label={`上移 ${layer.part.name}`}
                        title="上移，提高覆盖优先级"
                        disabled={
                          !compositionDraft ||
                          compositionBusy ||
                          layer.position === compositionDetail.layers.length - 1
                        }
                        onClick={() => void moveCompositionLayer(layer.id, 1)}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        aria-label={`下移 ${layer.part.name}`}
                        title="下移，降低覆盖优先级"
                        disabled={
                          !compositionDraft ||
                          compositionBusy ||
                          layer.position === 0
                        }
                        onClick={() => void moveCompositionLayer(layer.id, -1)}
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        aria-label={`移除 ${layer.part.name}`}
                        title="移除图层"
                        disabled={!compositionDraft || compositionBusy}
                        onClick={() => void deleteCompositionLayer(layer.id)}
                      >
                        ×
                      </button>
                    </div>
                  </article>
                ))
              ) : (
                <p>混搭工程创建后，从部件库逐个加入头发、衣服、手臂或腿部组件。</p>
              )}
              {composition && (
                <article className="composition-layer composition-base-layer">
                  <span>BASE</span>
                  <div aria-hidden="true">64</div>
                  <div>
                    <strong>基础 Revision</strong>
                    <small>固定底层，不可移除</small>
                  </div>
                </article>
              )}
            </div>
          </section>

          <section className="composition-preview-panel">
            <div className="composition-section-title">
              <span>LIVE OUTPUT</span>
              <h3>混搭结果 3D 预览</h3>
            </div>
            <div className="composition-preview-frame" data-ready={Boolean(composition)}>
              {composition ? (
                compositionPreviewMode === "3d" ? (
                  <SkinPreview
                    className="compact-skin-stage"
                    skinUrl={compositionPreviewUrl(
                      composition.id,
                      composition.updatedAt,
                    )}
                    armType={composition.armType}
                    motion={compositionPreviewMotion}
                    ariaLabel={`${composition.name} 混搭三维预览`}
                  />
                ) : (
                  <img
                    src={compositionPreviewUrl(composition.id, composition.updatedAt)}
                    alt={`${composition.name} 64×64 纹理预览`}
                  />
                )
              ) : (
                <p>PREVIEW<br />WAITING</p>
              )}
              {composition && (
                <div className="preview-chip-controls preview-chip-controls-wide">
                  <div aria-label="结果预览模式">
                    <button
                      type="button"
                      aria-pressed={compositionPreviewMode === "3d"}
                      onClick={() => setCompositionPreviewMode("3d")}
                    >
                      3D
                    </button>
                    <button
                      type="button"
                      aria-pressed={compositionPreviewMode === "texture"}
                      onClick={() => setCompositionPreviewMode("texture")}
                    >
                      纹理
                    </button>
                  </div>
                  {compositionPreviewMode === "3d" && (
                    <div aria-label="结果预览动作">
                      <button
                        type="button"
                        aria-pressed={compositionPreviewMotion === "idle"}
                        onClick={() => setCompositionPreviewMotion("idle")}
                      >
                        静止
                      </button>
                      <button
                        type="button"
                        aria-pressed={compositionPreviewMotion === "walk"}
                        onClick={() => setCompositionPreviewMotion("walk")}
                      >
                        走动
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
            <dl className="composition-metrics">
              <div>
                <dt>LAYERS</dt>
                <dd>{compositionReport?.layerCount ?? 0}</dd>
              </div>
              <div>
                <dt>WRITE</dt>
                <dd>{compositionReport?.writePixelCount ?? 0}<small> px</small></dd>
              </div>
              <div>
                <dt>HARD</dt>
                <dd>{compositionReport?.hardConflictCount ?? 0}</dd>
              </div>
              <div>
                <dt>OPEN</dt>
                <dd>{compositionReport?.unresolvedConflictCount ?? 0}</dd>
              </div>
              <div>
                <dt>RESTORE</dt>
                <dd>{compositionReport?.restorationPixelCount ?? 0}<small> px</small></dd>
              </div>
              <div data-alert={(compositionReport?.restorationMissingPixelCount ?? 0) > 0}>
                <dt>MISSING</dt>
                <dd>{compositionReport?.restorationMissingPixelCount ?? 0}</dd>
              </div>
            </dl>
            <div className="composition-output-actions">
              {composition && (
                <a
                  href={compositionPreviewUrl(composition.id, composition.updatedAt)}
                  download={`${composition.name}.png`}
                >
                  导出预览 PNG
                </a>
              )}
              <button
                type="button"
                disabled={
                  !compositionDraft ||
                  !compositionReport?.committable ||
                  (compositionReport.restorationMissingPixelCount ?? 0) > 0 ||
                  (compositionReport.restorationIssueCount ?? 0) > 0 ||
                  compositionBusy
                }
                onClick={() => void commitActiveComposition()}
              >
                {composition?.status === "committed"
                  ? "已创建 Revision"
                  : compositionReport?.committable
                    ? "创建 Compose Revision"
                    : "解决冲突后提交"}
              </button>
            </div>
            <p className="composition-output-note">
              预览按已应用的还原计划与顶部图层渲染；导出不等于提交，Revision 仍要求显式解决全部阻塞冲突。
            </p>
          </section>

          <CompositionRestorationPanel
            components={restorationComponents}
            mode={restorationMode}
            selectedFineIds={restorationFineIds}
            donorRevisionId={restorationDonorRevisionId}
            manualColor={restorationManualColor}
            includeManualColor={restorationIncludeManualColor}
            candidates={restorationCandidates}
            selectedCandidateIds={restorationCandidateIds}
            plan={composition?.restorationPlan ?? null}
            coveredPixelCount={restorationCoverage.coveredPixelCount}
            missingPixelCount={restorationCoverage.missingPixelCount}
            disabled={!compositionDraft}
            busy={compositionBusy || restorationBusy}
            error={restorationError}
            recommendationJobDetail={restorationRecommendationJobDetail}
            recommendationUserIntent={restorationRecommendationUserIntent}
            recommendationProviders={restorationRecommendationProviders}
            recommendationProvider={restorationRecommendationProvider}
            recommendationModel={aiModel}
            recommendationReasoningEffort={aiReasoningEffort}
            recommendationStaleReason={restorationRecommendationStale}
            recommendationBusy={restorationRecommendationBusy}
            recommendationError={restorationRecommendationError}
            onModeChange={changeRestorationMode}
            onToggleFine={toggleRestorationFineComponent}
            onDonorRevisionIdChange={(value) => {
              setRestorationDonorRevisionId(value);
              setRestorationCandidates(null);
              setRestorationCandidateIds([]);
              setRestorationError(null);
            }}
            onManualColorChange={(value) => {
              setRestorationManualColor(value);
              setRestorationCandidates(null);
              setRestorationCandidateIds([]);
              setRestorationError(null);
            }}
            onIncludeManualColorChange={(enabled) => {
              setRestorationIncludeManualColor(enabled);
              setRestorationCandidates(null);
              setRestorationCandidateIds([]);
              setRestorationError(null);
            }}
            onGenerate={() => void generateRestorationCandidates()}
            onToggleCandidate={toggleRestorationCandidate}
            onApply={() => void applyRestorationPlan()}
            onClear={() => void clearRestorationPlan()}
            onRecommendationUserIntentChange={setRestorationRecommendationUserIntent}
            onRecommendationProviderChange={setRestorationRecommendationProvider}
            onStartRecommendation={() => void beginRestorationRecommendation()}
            onCancelRecommendation={() => void cancelRestorationRecommendation()}
            onLoadRecommendation={loadRestorationRecommendation}
          />

          <section
            className="composition-conflicts-panel"
            data-ready={compositionReport?.committable ?? false}
          >
            <div className="composition-conflict-heading">
              <div className="composition-section-title">
                <span>CONFLICT MATRIX</span>
                <h3>逐像素裁决</h3>
              </div>
              <p>
                <strong>{compositionReport?.unresolvedConflictCount ?? 0}</strong>
                <span>UNRESOLVED</span>
              </p>
            </div>
            <div className="composition-resolution-actions">
              <button
                type="button"
                disabled={
                  !compositionDraft ||
                  !compositionReport?.hardConflictCount ||
                  compositionBusy
                }
                onClick={() => void resolveAllCompositionConflicts()}
              >
                确认顶部图层优先
              </button>
              <button
                type="button"
                disabled={
                  !compositionDraft ||
                  compositionBusy ||
                  (composition?.resolutionMode === "unresolved" &&
                    Object.keys(composition.conflictWinners).length === 0)
                }
                onClick={() => void clearCompositionResolutions()}
              >
                清除确认
              </button>
            </div>

            <div className="composition-conflict-list" data-empty={unresolvedCompositionConflicts.length === 0}>
              {unresolvedCompositionConflicts.length === 0 ? (
                <p>
                  {compositionReport?.committable
                    ? "全部阻塞冲突已解决，可以提交。"
                    : compositionReport?.layerCount
                      ? "没有待处理的像素冲突。"
                      : "添加图层后显示模型、语义边界和像素覆盖冲突。"}
                </p>
              ) : (
                unresolvedCompositionConflicts.slice(0, 8).map((conflict) => {
                  if (conflict.type === "hard_conflict") {
                    return (
                      <article key={conflict.id} className="composition-pixel-conflict" data-resolved={conflict.resolved}>
                        <header>
                          <strong>PX {conflict.x},{conflict.y}</strong>
                          <span>{conflict.resolved ? "RESOLVED" : "CHOOSE WINNER"}</span>
                        </header>
                        <div>
                          {conflict.writes.toReversed().map((write) => {
                            const layerName =
                              write.layerId === "base"
                                ? "基础皮肤"
                                : compositionLayerNames.get(write.layerId) ?? shortIdentifier(write.layerId);
                            return (
                              <button
                                key={write.layerId}
                                type="button"
                                aria-pressed={conflict.resolved && conflict.winnerLayerId === write.layerId}
                                disabled={!compositionDraft || compositionBusy}
                                onClick={() => void chooseCompositionConflictWinner(conflict.id, write.layerId)}
                              >
                                <span
                                  style={{
                                    backgroundColor: `rgba(${write.rgba[0]}, ${write.rgba[1]}, ${write.rgba[2]}, ${write.rgba[3] / 255})`,
                                  }}
                                  aria-hidden="true"
                                />
                                <strong>{layerName}</strong>
                                <small>{write.rgba.join("/")}</small>
                              </button>
                            );
                          })}
                        </div>
                      </article>
                    );
                  }

                  if (conflict.type === "model_conflict") {
                    return (
                      <article key={conflict.id} className="composition-structural-conflict">
                        <strong>MODEL / {compositionLayerNames.get(conflict.layerId) ?? shortIdentifier(conflict.layerId)}</strong>
                        <p>
                          目标为 {armLabels[conflict.targetArmType]}，部件仅支持 {conflict.supportedArmTypes.map((armType) => armLabels[armType]).join(" / ")}。
                        </p>
                      </article>
                    );
                  }

                  if (conflict.type === "unknown_conflict") {
                    return (
                      <article key={conflict.id} className="composition-structural-conflict">
                        <strong>SEMANTIC BOUNDS / {compositionLayerNames.get(conflict.layerId) ?? shortIdentifier(conflict.layerId)}</strong>
                        <p>{conflict.pixelIds.length} 个写入像素超出部件声明的 UV surface，必须修正部件。</p>
                      </article>
                    );
                  }

                  return null;
                })
              )}
            </div>
            {unresolvedCompositionConflicts.length > 8 && (
              <p className="composition-conflict-overflow">
                仅显示前 8 项；可确认统一图层顺序，或逐项处理后继续显示下一批。
              </p>
            )}
          </section>
        </div>
      </section>

      <footer className="status-bar" role="status" aria-live="polite">
        <span>STATUS</span>
        <p>{notice}</p>
        <code>immutable edits · pixel composition · {layout.id}</code>
      </footer>
    </main>
  );
}

function projectNameFromFile(fileName: string): string {
  const withoutExtension = fileName.replace(/\.png$/i, "").trim();
  return (withoutExtension || "Minecraft Skin").slice(0, 120);
}

function shortIdentifier(value: string): string {
  return value.length > 20 ? `${value.slice(0, 8)}…${value.slice(-8)}` : value;
}

function formatRevisionTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}
