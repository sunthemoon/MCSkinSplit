import {
  SEMANTIC_CATEGORIES,
  SEMANTIC_CATEGORY_LABELS,
  categoryBelongsToAggregate,
  encodeSkinPng,
  getSkinLayout,
  type ArmType,
  type ArmTypeAssessment,
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
import { HiddenContentCompletionWorkspace } from "./components/HiddenContentCompletionWorkspace";
import { LibraryLifecycleControls } from "./components/LibraryLifecycleControls";
import { LibraryToolbar } from "./components/LibraryToolbar";
import { PartBundleShelf } from "./components/PartBundleShelf";
import {
  PlayerResultWorkspace,
  type PlayerCompletionResultSnapshot,
  type PlayerResultSelection,
} from "./components/PlayerResultWorkspace";
import {
  PLAYER_WORKFLOW_HASHES,
  PlayerWorkflowNav,
  resolvePlayerWorkflowStepFromHash,
  type PlayerWorkflowStep,
} from "./components/PlayerWorkflowNav";
import {
  PixelOriginSummaryPanel,
  partOriginDetailLabel,
  partOriginStatusLabel,
} from "./components/PixelOriginSummaryPanel";
import { SemanticAiEventLog } from "./components/SemanticAiEventLog";
import { SemanticAiJobProgress } from "./components/SemanticAiJobProgress";
import { SemanticFollowupReview } from "./components/SemanticFollowupReview";
import {
  WORKFLOW_SECTIONS,
  WorkflowSectionNav,
  resolveWorkflowSectionIdFromHash,
} from "./components/WorkflowSectionNav";
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
  shouldDeferGenericAiHydration,
  type PendingCatalogAiHydration,
} from "./lib/catalogAiHydration";
import {
  addCompositionPart,
  applySemanticFollowup,
  applyCompositionBundle,
  archiveAnalyzedSkin,
  branchRevision,
  applySemanticOperation,
  cancelAiJob,
  commitComposition as commitCompositionProject,
  clearCompositionRestorationPlan,
  commitRevisionPart,
  compositionPreviewUrl,
  createComposition,
  createProject,
  dismissSemanticFollowup,
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
  loadRevisionOrigin,
  loadRevisionSkin,
  partMannequinUrl,
  partPreviewUrl,
  previewRevisionPart,
  publishCompletionResult,
  restorePart,
  restorePartBundle,
  restoreAnalyzedSkin,
  retirePart,
  retirePartBundle,
  revisePartBundle,
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
  type ApiManualSemanticOperation,
  type ApiBranch,
  type ApiAnalyzedSkin,
  type ApiAnalyzedSkinGroup,
  type ApiCompletionProposalDetail,
  type ApiCompositionDetail,
  type ApiCompositionRestorationCandidates,
  type ApiProject,
  type ApiPart,
  type ApiPartBundle,
  type ApiPartPreview,
  type ApiRevision,
  type ApiRevisionOrigin,
  type ApiSegmentation,
} from "./lib/revisionApi";
import {
  BUNDLE_KIND_LABELS,
  DEFAULT_LIBRARY_FILTERS,
  buildLibraryProjectOptions,
  filterLibraryAssets,
  librarySourceLabel,
  type LibraryFilters,
} from "./lib/libraryCatalog";
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
import {
  completionResultAppliesToRevision,
  findCompletionCatalogContext,
  isCompletionWorkspaceEnabled,
  type CompletionCatalogContext,
} from "./lib/completionWorkspace";
import {
  applySelectionPixels,
  compareSemanticRevisionSnapshots,
  commitSemanticSelection,
  createSemanticSelectionHistory,
  mirroredSelectionPixelIds,
  redoSemanticSelection,
  seamExpansionPixelIds,
  semanticRevisionDiffLabel,
  semanticRevisionDiffPixelIds,
  semanticSelectionSpans,
  undoSemanticSelection,
  type SemanticCanvasViewMode,
  type SemanticRevisionDiff,
  type SemanticRevisionSnapshot,
  type SemanticSelectionTool,
} from "./lib/semanticSelectionTools";

type ModelChoice = "auto" | ArmType;

interface SemanticRelationDraft {
  readonly attachedTo: string | null;
  readonly pairedWith: readonly string[];
  readonly sameOutfitGroup: string;
  readonly conflictsWith: readonly string[];
}

function emptySemanticRelationDraft(): SemanticRelationDraft {
  return {
    attachedTo: null,
    pairedWith: [],
    sameOutfitGroup: "",
    conflictsWith: [],
  };
}

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
const COMPLETION_WORKSPACE_ENABLED = isCompletionWorkspaceEnabled(
  import.meta.env.VITE_ENABLE_COMPLETION_WORKSPACE,
);

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
  completion_accept: "COMPLETION",
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

function initialStudioMode(): "player" | "advanced" {
  if (typeof window === "undefined") return "player";
  return resolveWorkflowSectionIdFromHash(window.location.hash)
    ? "advanced"
    : "player";
}

function initialPlayerWorkflowStep(): PlayerWorkflowStep {
  if (typeof window === "undefined") return "import";
  if (
    COMPLETION_WORKSPACE_ENABLED &&
    window.location.hash === "#workspace-completion"
  ) {
    return "review";
  }
  return resolvePlayerWorkflowStepFromHash(window.location.hash) ?? "import";
}

function pushWorkspaceHash(hash: string): void {
  if (typeof window === "undefined" || window.location.hash === hash) return;
  const nextUrl = new URL(window.location.href);
  nextUrl.hash = hash.slice(1);
  window.history.pushState(window.history.state, "", nextUrl);
}

function scheduleWorkspaceFocus(
  findTarget: () => HTMLElement | null,
): void {
  if (typeof window === "undefined") return;
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      const target = findTarget();
      if (!target) return;
      target.focus({ preventScroll: true });
      target.scrollIntoView({
        behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
        block: "start",
      });
    });
  });
}

export function App() {
  const [studioMode, setStudioMode] = useState<"player" | "advanced">(() =>
    initialStudioMode(),
  );
  const [playerWorkflowStep, setPlayerWorkflowStep] =
    useState<PlayerWorkflowStep>(() => initialPlayerWorkflowStep());
  const [playerCompletionResult, setPlayerCompletionResult] =
    useState<PlayerCompletionResultSnapshot | null>(null);
  const [playerResultSelection, setPlayerResultSelection] =
    useState<PlayerResultSelection>("current");
  const [completionPublishBusy, setCompletionPublishBusy] = useState(false);
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
  const [revisionOrigin, setRevisionOrigin] = useState<ApiRevisionOrigin | null>(null);
  const [draftSelectionHistory, setDraftSelectionHistory] = useState(
    createSemanticSelectionHistory,
  );
  const draftPixelIds = draftSelectionHistory.present;
  const [semanticSelectionTool, setSemanticSelectionTool] =
    useState<SemanticSelectionTool>("brush");
  const [semanticCanvasViewMode, setSemanticCanvasViewMode] =
    useState<SemanticCanvasViewMode>("texture");
  const [semanticRevisionDiff, setSemanticRevisionDiff] =
    useState<SemanticRevisionDiff | null>(null);
  const [semanticRevisionDiffStatus, setSemanticRevisionDiffStatus] =
    useState<"none" | "loading" | "ready" | "unavailable">("none");
  const [semanticMiddleView, setSemanticMiddleView] = useState<"2d" | "3d">("2d");
  const [hiddenSemanticComponentIds, setHiddenSemanticComponentIds] =
    useState<readonly string[]>([]);
  const [soloSemanticComponentId, setSoloSemanticComponentId] =
    useState<string | null>(null);
  const [semanticSelectionPreview, setSemanticSelectionPreview] = useState<{
    readonly kind: "mirror" | "seam";
    readonly pixelIds: readonly number[];
  } | null>(null);
  const [activeComponentId, setActiveComponentId] = useState<string | null>(null);
  const [componentTargetMode, setComponentTargetMode] =
    useState<"selected" | "new">("new");
  const [checkedComponentIds, setCheckedComponentIds] = useState<readonly string[]>([]);
  const [componentId, setComponentId] = useState("hair.main");
  const [componentName, setComponentName] = useState("主头发");
  const [componentCategory, setComponentCategory] =
    useState<SemanticCategory>("hair");
  const [componentSubtype, setComponentSubtype] = useState("");
  const [semanticRelationDraft, setSemanticRelationDraft] =
    useState<SemanticRelationDraft>(emptySemanticRelationDraft);
  const [semanticBusy, setSemanticBusy] = useState(false);
  const [partLibrary, setPartLibrary] = useState<readonly ApiPart[]>([]);
  const [partBundles, setPartBundles] = useState<readonly ApiPartBundle[]>([]);
  const [partLibraryFilters, setPartLibraryFilters] = useState<LibraryFilters>({
    ...DEFAULT_LIBRARY_FILTERS,
  });
  const [compositionPartFilters, setCompositionPartFilters] = useState<LibraryFilters>({
    ...DEFAULT_LIBRARY_FILTERS,
  });
  const [bundleLibraryFilters, setBundleLibraryFilters] = useState<LibraryFilters>({
    ...DEFAULT_LIBRARY_FILTERS,
  });
  const [libraryLifecycleBusy, setLibraryLifecycleBusy] = useState(false);
  const [removeComponentArmedId, setRemoveComponentArmedId] = useState<string | null>(null);
  const [selectedBundleId, setSelectedBundleId] = useState<string | null>(null);
  const [analyzedSkins, setAnalyzedSkins] =
    useState<readonly ApiAnalyzedSkin[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [busyCatalogGroupKey, setBusyCatalogGroupKey] = useState<string | null>(
    null,
  );
  const [busyCatalogRevisionIds, setBusyCatalogRevisionIds] =
    useState<ReadonlySet<string>>(() => new Set());
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
  const [aiSemanticBaseline, setAiSemanticBaseline] =
    useState<ApiAiAnalysisOptions["semanticBaseline"]>("empty");
  const [aiJobDetail, setAiJobDetail] = useState<ApiAiJobDetail | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const requestIdRef = useRef(0);
  const analyzedActivationRequestRef = useRef(0);
  const pendingCatalogAiHydrationRef =
    useRef<PendingCatalogAiHydration | null>(null);
  const aiJobDetailRequestRef = useRef(0);
  const aiJobDetailRef = useRef<ApiAiJobDetail | null>(null);
  const restorationRecommendationJobDetailRef = useRef<ApiAiJobDetail | null>(null);
  const restorationRecommendationContextRef = useRef(0);
  const handledAiJobsRef = useRef(new Set<string>());
  const aiEventLogRef = useRef<HTMLOListElement>(null);
  const partPreviewRequestRef = useRef(0);
  const libraryLifecycleBusyRef = useRef(false);
  const catalogLifecycleBusyRef = useRef(new Set<string>());
  const catalogRefreshRequestRef = useRef(0);
  const lastAdvancedSectionIdRef = useRef(
    typeof window === "undefined"
      ? WORKFLOW_SECTIONS[0]!.id
      : resolveWorkflowSectionIdFromHash(window.location.hash) ??
          WORKFLOW_SECTIONS[0]!.id,
  );

  const updateDraftSelection = useCallback((pixelIds: readonly number[]) => {
    setDraftSelectionHistory((current) =>
      commitSemanticSelection(current, pixelIds));
    setSemanticSelectionPreview(null);
  }, []);

  const clearDraftSelection = useCallback(() => {
    setDraftSelectionHistory(createSemanticSelectionHistory());
    setSemanticSelectionPreview(null);
  }, []);

  const focusPlayerStep = useCallback((step: PlayerWorkflowStep) => {
    scheduleWorkspaceFocus(() => {
      if (step === "save") {
        return document.querySelector<HTMLElement>(
          "[data-player-result-surface]",
        ) ?? document.getElementById("workspace-preview");
      }
      if (step === "review") {
        return document.getElementById("workspace-semantic");
      }
      return document.getElementById(
        step === "import" ? "workspace-preview" : "workspace-ai",
      );
    });
  }, []);

  const navigateToPlayerStep = useCallback((step: PlayerWorkflowStep) => {
    setStudioMode("player");
    setPlayerWorkflowStep(step);
    pushWorkspaceHash(PLAYER_WORKFLOW_HASHES[step]);
    focusPlayerStep(step);
  }, [focusPlayerStep]);

  const navigateToAdvancedStudio = useCallback(() => {
    const sectionId = lastAdvancedSectionIdRef.current;
    setStudioMode("advanced");
    pushWorkspaceHash(`#${sectionId}`);
    scheduleWorkspaceFocus(() => document.getElementById(sectionId));
  }, []);

  useEffect(() => {
    const followWorkspaceLocation = () => {
      const advancedSectionId = resolveWorkflowSectionIdFromHash(
        window.location.hash,
      );
      if (advancedSectionId) {
        lastAdvancedSectionIdRef.current = advancedSectionId;
        setStudioMode("advanced");
        scheduleWorkspaceFocus(() =>
          document.getElementById(advancedSectionId));
        return;
      }
      if (
        COMPLETION_WORKSPACE_ENABLED &&
        window.location.hash === "#workspace-completion"
      ) {
        setStudioMode("player");
        setPlayerWorkflowStep("review");
        scheduleWorkspaceFocus(() =>
          document.getElementById("workspace-completion"));
        return;
      }
      const playerStep = resolvePlayerWorkflowStepFromHash(
        window.location.hash,
      );
      if (playerStep) {
        setStudioMode("player");
        setPlayerWorkflowStep(playerStep);
        focusPlayerStep(playerStep);
      }
    };

    followWorkspaceLocation();
    window.addEventListener("hashchange", followWorkspaceLocation);
    window.addEventListener("popstate", followWorkspaceLocation);
    return () => {
      window.removeEventListener("hashchange", followWorkspaceLocation);
      window.removeEventListener("popstate", followWorkspaceLocation);
    };
  }, [focusPlayerStep]);

  const releaseObjectUrl = useCallback(() => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  }, []);

  const refreshAnalyzedCatalog = useCallback(async () => {
    const requestId = ++catalogRefreshRequestRef.current;
    const catalog = await listAnalyzedSkins({ status: "all" });
    if (requestId === catalogRefreshRequestRef.current) {
      setAnalyzedSkins(catalog);
    }
  }, []);

  const refreshReusableLibrary = useCallback(async () => {
    const [parts, bundles] = await Promise.all([
      listParts({ status: "all" }),
      listPartBundles({ status: "all" }),
    ]);
    setPartLibrary(parts);
    setPartBundles(bundles);
    const firstActivePart = parts.find((part) => part.libraryStatus === "active");
    const firstActiveBundle = bundles.find((bundle) => bundle.libraryStatus === "active");
    setSelectedPartId((current) => current ?? firstActivePart?.id ?? null);
    setCompositionPartId((current) => current ?? firstActivePart?.id ?? null);
    setSelectedBundleId((current) =>
      bundles.some((bundle) => bundle.id === current)
        ? current
        : (firstActiveBundle?.id ?? null),
    );
  }, []);

  const refreshReusableCatalog = useCallback(async () => {
    await Promise.all([refreshReusableLibrary(), refreshAnalyzedCatalog()]);
  }, [refreshAnalyzedCatalog, refreshReusableLibrary]);

  const activateFixture = useCallback(
    async (fixture: SkinFixture) => {
      pendingCatalogAiHydrationRef.current = null;
      analyzedActivationRequestRef.current += 1;
      aiJobDetailRequestRef.current += 1;
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
        setSemanticRevisionDiff(null);
        setSemanticRevisionDiffStatus("none");
        setRevisionOrigin(null);
        clearDraftSelection();
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
    [clearDraftSelection, releaseObjectUrl],
  );

  const activateRevision = useCallback(
    async (
      revision: ApiRevision,
      options: {
        preserveAiDetailRequest?: boolean;
        preserveAnalyzedActivation?: boolean;
      } = {},
    ) => {
      if (!options.preserveAnalyzedActivation) {
        pendingCatalogAiHydrationRef.current = null;
        analyzedActivationRequestRef.current += 1;
      }
      if (!options.preserveAiDetailRequest) {
        aiJobDetailRequestRef.current += 1;
      }
      const requestId = ++requestIdRef.current;
      setIsLoadingSkin(true);
      setHistoryBusy(true);
      setHistoryError(null);
      setRevisionOrigin(null);
      setSemanticRevisionDiff(null);
      setSemanticRevisionDiffStatus(
        revision.parentRevisionId ? "loading" : "none",
      );
      setNotice(`正在校验并载入 ${revision.branchName} #${revision.sequence}`);

      try {
        const parentSnapshotPromise: Promise<SemanticRevisionSnapshot | null> =
          revision.parentRevisionId
            ? Promise.all([
                loadRevisionSkin(revision.parentRevisionId),
                loadRevisionSegmentation(revision.parentRevisionId),
              ])
                .then(([parentSkinBytes, parentSegmentation]) => ({
                  image: decodeMinecraftSkinBytes(parentSkinBytes).image,
                  armType: parentSegmentation.source.armType,
                  components: parentSegmentation.components,
                }))
                .catch(() => null)
            : Promise.resolve(null);
        const [skinBytes, segmentation, origin, parentSnapshot] = await Promise.all([
          loadRevisionSkin(revision.id),
          loadRevisionSegmentation(revision.id),
          loadRevisionOrigin(revision.id),
          parentSnapshotPromise,
        ]);
        const decoded = decodeMinecraftSkinBytes(skinBytes);
        if (requestId !== requestIdRef.current) {
          return false;
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
        if (parentSnapshot) {
          try {
            setSemanticRevisionDiff(compareSemanticRevisionSnapshots(
              parentSnapshot,
              {
                image: decoded.image,
                armType: segmentation.source.armType,
                components: segmentation.components,
              },
            ));
            setSemanticRevisionDiffStatus("ready");
          } catch {
            setSemanticRevisionDiff(null);
            setSemanticRevisionDiffStatus("unavailable");
          }
        } else {
          setSemanticRevisionDiff(null);
          setSemanticRevisionDiffStatus(
            revision.parentRevisionId ? "unavailable" : "none",
          );
        }
        setRevisionOrigin(origin);
        clearDraftSelection();
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
        return true;
      } catch (error) {
        if (requestId === requestIdRef.current) {
          const message = error instanceof Error ? error.message : String(error);
          setSemanticRevisionDiff(null);
          setSemanticRevisionDiffStatus("unavailable");
          setHistoryError(message);
          setNotice(`Revision 载入失败：${message}`);
        }
        return false;
      } finally {
        if (requestId === requestIdRef.current) {
          setIsLoadingSkin(false);
          setHistoryBusy(false);
        }
      }
    },
    [clearDraftSelection, releaseObjectUrl],
  );

  const refreshHistory = useCallback(
    async (
      projectId: string,
      preferredRevisionId?: string | null,
      shouldApply: () => boolean = () => true,
      preserveAiDetailRequest = false,
    ): Promise<boolean> => {
      pendingCatalogAiHydrationRef.current = null;
      const activationRequestId = ++analyzedActivationRequestRef.current;
      const canApply = () =>
        activationRequestId === analyzedActivationRequestRef.current &&
        shouldApply();
      const [project, branches, revisions, projects] = await Promise.all([
        getProject(projectId),
        listBranches(projectId),
        listRevisions(projectId),
        listProjects(),
      ]);
      if (!canApply()) return false;
      setHistoryProject(project);
      setHistoryBranches(branches);
      setHistoryRevisions(revisions);
      setHistoryProjects(projects);
      window.localStorage.setItem(HISTORY_PROJECT_KEY, project.id);

      const revisionId = preferredRevisionId ?? project.headRevisionId;
      const selected = revisions.find((revision) => revision.id === revisionId);
      if (selected) {
        if (!canApply()) return false;
        const activated = await activateRevision(selected, {
          preserveAiDetailRequest,
          preserveAnalyzedActivation: true,
        });
        if (!activated) return false;
        if (!canApply()) return false;
      } else {
        setSelectedRevisionId(null);
        setRevisionOrigin(null);
        setBranchFilter(project.defaultBranchId);
      }
      return true;
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
    async (
      jobId: string,
      followSuccessfulRevision: boolean,
      requestId: number,
    ): Promise<ApiAiJobDetail | null> => {
      const detail = await loadAiJobDetail(jobId);
      if (detail.job.kind !== "semantic_analysis") {
        throw new Error("API 返回的 Job 不是语义识别任务");
      }
      if (requestId !== aiJobDetailRequestRef.current) return null;
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
        const historyApplied = await refreshHistory(
          job.projectId,
          job.resultRevisionId,
          () => requestId === aiJobDetailRequestRef.current,
          true,
        );
        if (!historyApplied || requestId !== aiJobDetailRequestRef.current) {
          return null;
        }
        await refreshReusableCatalog();
        if (requestId !== aiJobDetailRequestRef.current) return null;
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
      aiJobDetailRequestRef.current += 1;
      aiJobDetailRef.current = null;
      setAiJobDetail(null);
      return;
    }
    const currentDetail = aiJobDetailRef.current;
    const current = currentDetail?.job;
    if (
      current?.inputRevisionId === selectedRevisionId ||
      current?.resultRevisionId === selectedRevisionId ||
      currentDetail?.semanticFollowup?.appliedRevisionId === selectedRevisionId
    ) {
      return;
    }
    if (
      shouldDeferGenericAiHydration(
        selectedRevisionId,
        pendingCatalogAiHydrationRef.current,
      )
    ) {
      return;
    }

    let cancelled = false;
    const requestId = ++aiJobDetailRequestRef.current;
    void listAiJobs({
      revisionId: selectedRevisionId,
      kind: "semantic_analysis",
    })
      .then(async (jobs) => {
        const latest = jobs.at(-1);
        if (!latest) {
          if (!cancelled && requestId === aiJobDetailRequestRef.current) {
            aiJobDetailRef.current = null;
            setAiJobDetail(null);
          }
          return;
        }
        const detail = await loadAiJobDetail(latest.id);
        if (!cancelled && requestId === aiJobDetailRequestRef.current) {
          aiJobDetailRef.current = detail;
          setAiJobDetail(detail);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled && requestId === aiJobDetailRequestRef.current) {
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
    const requestId = aiJobDetailRequestRef.current;
    const poll = () => {
      if (polling) {
        return;
      }
      polling = true;
      void synchronizeAiJob(job.id, true, requestId)
        .catch((error: unknown) => {
          if (!stopped && requestId === aiJobDetailRequestRef.current) {
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
      pendingCatalogAiHydrationRef.current = null;
      analyzedActivationRequestRef.current += 1;
      aiJobDetailRequestRef.current += 1;
      const requestId = ++requestIdRef.current;
      setIsLoadingSkin(true);
      setRevisionOrigin(null);
      setSemanticRevisionDiff(null);
      setSemanticRevisionDiffStatus("none");
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
  const activeSemanticDiffPixelIds = semanticRevisionDiff
    ? semanticRevisionDiffPixelIds(
        semanticRevisionDiff,
        semanticCanvasViewMode,
      )
    : [];
  const completionCatalogContext = useMemo(
    () => findCompletionCatalogContext(analyzedSkins, selectedRevisionId),
    [analyzedSkins, selectedRevisionId],
  );
  const activePlayerCompletionResult =
    playerCompletionResult !== null &&
    historyProject !== null &&
    playerCompletionResult.detail.proposal.projectId === historyProject.id &&
    completionResultAppliesToRevision(
      playerCompletionResult.detail,
      playerCompletionResult.catalogContext,
      selectedRevisionId,
    )
      ? playerCompletionResult
      : null;
  const activeComponent = segmentation?.components.find(
    (component) => component.instanceId === activeComponentId,
  );
  const libraryProjectOptions = useMemo(
    () => buildLibraryProjectOptions([...partLibrary, ...partBundles]),
    [partBundles, partLibrary],
  );
  const filteredPartLibrary = useMemo(
    () => filterLibraryAssets(partLibrary, partLibraryFilters),
    [partLibrary, partLibraryFilters],
  );
  const filteredCompositionParts = useMemo(
    () => filterLibraryAssets(partLibrary, compositionPartFilters),
    [compositionPartFilters, partLibrary],
  );
  const filteredPartBundles = useMemo(
    () => filterLibraryAssets(partBundles, bundleLibraryFilters),
    [bundleLibraryFilters, partBundles],
  );
  const activePartLibrary = useMemo(
    () => partLibrary.filter((part) => part.libraryStatus === "active"),
    [partLibrary],
  );
  useEffect(() => {
    setSelectedPartId((current) =>
      filteredPartLibrary.some((part) => part.id === current)
        ? current
        : (filteredPartLibrary[0]?.id ?? null),
    );
  }, [filteredPartLibrary]);
  useEffect(() => {
    partPreviewRequestRef.current += 1;
    setPartPreview(null);
  }, [selectedRevisionId, selectedPartId]);
  useEffect(() => {
    setRemoveComponentArmedId(null);
  }, [selectedRevisionId, activeComponentId]);
  useEffect(() => {
    const componentIds = new Set(
      segmentation?.components.map((component) => component.instanceId) ?? [],
    );
    setHiddenSemanticComponentIds((current) =>
      current.filter((componentId) => componentIds.has(componentId)));
    setSoloSemanticComponentId((current) =>
      current && componentIds.has(current) ? current : null);
    setSemanticSelectionPreview(null);
  }, [segmentation?.revisionId]);
  useEffect(() => {
    if (!activeComponent || componentTargetMode !== "selected") return;
    setSemanticRelationDraft({
      attachedTo: activeComponent.relations.attachedTo,
      pairedWith: activeComponent.relations.pairedWith,
      sameOutfitGroup: activeComponent.relations.sameOutfitGroup ?? "",
      conflictsWith: activeComponent.relations.conflictsWith ?? [],
    });
  }, [activeComponent, componentTargetMode]);
  useEffect(() => {
    setCompositionPartId((current) =>
      filteredCompositionParts.some((part) => part.id === current)
        ? current
        : (filteredCompositionParts[0]?.id ?? null),
    );
  }, [filteredCompositionParts]);
  useEffect(() => {
    setSelectedBundleId((current) =>
      filteredPartBundles.some((bundle) => bundle.id === current)
        ? current
        : (filteredPartBundles[0]?.id ?? null),
    );
  }, [filteredPartBundles]);
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
    selectedRevision &&
      aiProvider &&
      aiModel.trim() &&
      !aiJobRunning &&
      !historyBusy &&
      !isLoadingSkin,
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
    const aiDetailRequestId = ++aiJobDetailRequestRef.current;
    setAiBusy(true);
    setAiError(null);
    try {
      let analysisRevision = selectedRevision;
      let branchedProjectId: string | null = null;
      if (!analysisRevision.isBranchHead) {
        const branch = await branchRevision(
          analysisRevision.id,
          `reanalyze-${analysisRevision.sequence}-${Date.now().toString(36)}`,
        );
        if (aiDetailRequestId !== aiJobDetailRequestRef.current) return;
        analysisRevision = branch.revision;
        branchedProjectId = branch.project.id;
      }
      const job = await startAiAnalysis(analysisRevision.id, {
        mode: "full",
        provider: aiProvider,
        model: aiModel.trim(),
        reasoningEffort: aiReasoningEffort,
        taxonomyLevel: "coarse",
        focus: aiFocus,
        createRevisionOnSuccess: true,
        semanticBaseline: aiSemanticBaseline,
      });
      if (aiDetailRequestId !== aiJobDetailRequestRef.current) return;
      handledAiJobsRef.current.delete(job.id);
      const synchronized = await synchronizeAiJob(
        job.id,
        true,
        aiDetailRequestId,
      );
      if (!synchronized) return;
      if (branchedProjectId && !synchronized.job.resultRevisionId) {
        const historyApplied = await refreshHistory(
          branchedProjectId,
          analysisRevision.id,
          () => aiDetailRequestId === aiJobDetailRequestRef.current,
          true,
        );
        if (!historyApplied) return;
      }
      if (
        aiDetailRequestId === aiJobDetailRequestRef.current &&
        !terminalAiStatuses.has(synchronized.job.status)
      ) {
        setNotice("智能分析已开始；原皮肤版本保持不变");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (aiDetailRequestId === aiJobDetailRequestRef.current) {
        setAiError(message);
        setNotice(`AI 分析启动失败：${message}`);
      }
    } finally {
      setAiBusy(false);
    }
  };

  const applySelectedSemanticFollowup = async (suggestionId: string) => {
    if (!aiJob || aiJobRunning) return;
    setAiBusy(true);
    setAiError(null);
    const aiDetailRequestId = ++aiJobDetailRequestRef.current;
    let detail: ApiAiJobDetail;
    try {
      detail = await applySemanticFollowup(aiJob.id, suggestionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (aiDetailRequestId === aiJobDetailRequestRef.current) {
        setAiError(message);
        setNotice(`分类修复版生成失败：${message}`);
      }
      setAiBusy(false);
      return;
    }

    if (aiDetailRequestId !== aiJobDetailRequestRef.current) {
      setAiBusy(false);
      return;
    }
    aiJobDetailRef.current = detail;
    setAiJobDetail(detail);
    const refreshErrors: string[] = [];
    try {
      await refreshReusableCatalog();
    } catch (error) {
      refreshErrors.push(
        `分析目录刷新失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const repairedRevisionId =
      detail.semanticFollowup?.appliedRevisionId ?? detail.job.resultRevisionId;
    if (
      repairedRevisionId &&
      aiDetailRequestId === aiJobDetailRequestRef.current
    ) {
      try {
        const historyApplied = await refreshHistory(
          detail.job.projectId,
          repairedRevisionId,
          () => aiDetailRequestId === aiJobDetailRequestRef.current,
          true,
        );
        if (
          !historyApplied &&
          aiDetailRequestId === aiJobDetailRequestRef.current
        ) {
          refreshErrors.push("Revision 未能重新载入");
        }
      } catch (error) {
        refreshErrors.push(
          `Revision 刷新失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (aiDetailRequestId === aiJobDetailRequestRef.current) {
      if (refreshErrors.length > 0) {
        const message = refreshErrors.join("；");
        setAiError(`分类修复版已生成，但${message}`);
        setNotice("分类修复版已生成；页面数据刷新未完成，可稍后重新载入");
      } else {
        setNotice("推荐分类修复版已生成；原识别仍保留在分析目录中");
      }
    }
    setAiBusy(false);
  };

  const dismissSelectedSemanticFollowup = async () => {
    if (!aiJob || aiJobRunning) return;
    setAiBusy(true);
    setAiError(null);
    const aiDetailRequestId = ++aiJobDetailRequestRef.current;
    let detail: ApiAiJobDetail;
    try {
      detail = await dismissSemanticFollowup(aiJob.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (aiDetailRequestId === aiJobDetailRequestRef.current) {
        setAiError(message);
        setNotice(`保留原识别失败：${message}`);
      }
      setAiBusy(false);
      return;
    }

    if (aiDetailRequestId !== aiJobDetailRequestRef.current) {
      setAiBusy(false);
      return;
    }
    aiJobDetailRef.current = detail;
    setAiJobDetail(detail);
    try {
      await refreshReusableCatalog();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (aiDetailRequestId === aiJobDetailRequestRef.current) {
        setAiError(`已保留原识别，但分析目录刷新失败：${message}`);
        setNotice("已保留原识别；分析目录刷新未完成");
      }
      setAiBusy(false);
      return;
    }
    if (aiDetailRequestId === aiJobDetailRequestRef.current) {
      setNotice("已保留原识别；分类修复建议未写入皮肤");
    }
    setAiBusy(false);
  };

  const cancelActiveAiJob = async () => {
    if (!aiJob || !aiJobRunning) {
      return;
    }
    setAiBusy(true);
    setAiError(null);
    const aiDetailRequestId = ++aiJobDetailRequestRef.current;
    try {
      await cancelAiJob(aiJob.id);
      await synchronizeAiJob(aiJob.id, true, aiDetailRequestId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (aiDetailRequestId === aiJobDetailRequestRef.current) {
        setAiError(message);
        setNotice(`AI Job 取消失败：${message}`);
      }
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
    const aiDetailRequestId = ++aiJobDetailRequestRef.current;
    try {
      const createRevisionOnSuccess = Boolean(aiSourceRevision?.isBranchHead);
      const retry = await retryAiJob(aiJob.id, {
        provider: aiProvider,
        model: aiModel.trim(),
        reasoningEffort: aiReasoningEffort,
        createRevisionOnSuccess,
        semanticBaseline: aiSemanticBaseline,
      });
      handledAiJobsRef.current.delete(retry.id);
      const synchronized = await synchronizeAiJob(
        retry.id,
        true,
        aiDetailRequestId,
      );
      if (!synchronized) return;
      setNotice(
        createRevisionOnSuccess
          ? "AI 重试已创建；验证成功后生成新 Revision"
          : "AI 重试已创建；历史输入只生成可审计提案，不修改 Branch",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (aiDetailRequestId === aiJobDetailRequestRef.current) {
        setAiError(message);
        setNotice(`AI Job 重试失败：${message}`);
      }
    } finally {
      setAiBusy(false);
    }
  };

  const semanticTarget = (forceHostGenerated = false) => {
    const instanceId = componentId.trim();
    const displayName = componentName.trim();
    if (!displayName) {
      throw new Error("组件名称不能为空");
    }
    if (studioMode === "advanced" && !instanceId) {
      throw new Error("高级工作室中的组件 ID 不能为空");
    }
    return {
      ...(studioMode === "advanced"
        ? { instanceId }
        : !forceHostGenerated &&
            componentTargetMode === "selected" &&
            activeComponent
          ? { instanceId: activeComponent.instanceId }
          : {}),
      displayName,
      category: componentCategory,
      ...(componentSubtype.trim()
        ? { subtype: componentSubtype.trim() }
        : {}),
    } as const;
  };

  const commitSemanticOperation = async (
    operation: ApiManualSemanticOperation,
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
      clearDraftSelection();
      setCheckedComponentIds([]);
      await refreshHistory(result.project.id, result.revision.id);
      if (result.generatedComponentId) {
        setActiveComponentId(result.generatedComponentId);
        setComponentId(result.generatedComponentId);
        setComponentTargetMode("selected");
      }
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
    if (!segmentation) {
      setNotice("当前版本的语义布局尚未载入");
      return;
    }
    try {
      void commitSemanticOperation(
        {
          type: "assign_pixels",
          target: semanticTarget(),
          spans: semanticSelectionSpans(draftPixelIds, segmentation.source.armType),
        },
        `分类 ${draftPixelIds.length} 个像素`,
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const unassignDraftPixels = () => {
    if (draftPixelIds.length === 0) {
      setNotice("先选择要退回未分类的已分类像素");
      return;
    }
    if (!segmentation) {
      setNotice("当前版本的语义布局尚未载入");
      return;
    }
    void commitSemanticOperation(
      {
        type: "unassign_pixels",
        spans: semanticSelectionSpans(draftPixelIds, segmentation.source.armType),
      },
      `标记 ${draftPixelIds.length} 个像素为未分类`,
    );
  };

  const splitActiveComponent = () => {
    if (!activeComponent || draftPixelIds.length === 0) {
      setNotice("拆分需要先选中来源组件，并在 Atlas 选择其部分像素");
      return;
    }
    if (!segmentation) {
      setNotice("当前版本的语义布局尚未载入");
      return;
    }
    try {
      void commitSemanticOperation(
        {
          type: "split_component",
          sourceComponentId: activeComponent.instanceId,
          target: semanticTarget(true),
          spans: semanticSelectionSpans(draftPixelIds, segmentation.source.armType),
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
          target: semanticTarget(true),
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

  const removeActiveComponentRecognition = () => {
    if (!activeComponent) {
      setNotice("先选择要移除识别的组件");
      return;
    }
    if (removeComponentArmedId !== activeComponent.instanceId) {
      setRemoveComponentArmedId(activeComponent.instanceId);
      setNotice(
        `再次确认后，${activeComponent.displayName} 的全部像素将退回未分类；旧版本不会被改写`,
      );
      return;
    }
    setRemoveComponentArmedId(null);
    void commitSemanticOperation(
      {
        type: "unassign_pixels",
        spans: activeComponent.spans,
      },
      `移除 ${activeComponent.displayName} 的组件识别`,
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
    setComponentTargetMode("selected");
    setSemanticRelationDraft({
      attachedTo: component.relations.attachedTo,
      pairedWith: component.relations.pairedWith,
      sameOutfitGroup: component.relations.sameOutfitGroup ?? "",
      conflictsWith: component.relations.conflictsWith ?? [],
    });
    setRemoveComponentArmedId(null);
  };

  const beginNewComponent = () => {
    setComponentTargetMode("new");
    setActiveComponentId(null);
    setSoloSemanticComponentId(null);
    setComponentId("");
    setComponentName("新组件");
    setComponentSubtype("");
    setSemanticRelationDraft(emptySemanticRelationDraft());
    setNotice("新组件模式：圈选像素并确认分类，组件编号由系统生成");
  };

  const previewSemanticExpansion = (kind: "mirror" | "seam") => {
    if (!activeSkin || !segmentation || draftPixelIds.length === 0) {
      setNotice("先在 2D 画布圈选至少 1 个像素，再预览扩展范围");
      return;
    }
    const candidates = kind === "mirror"
      ? mirroredSelectionPixelIds(
          activeSkin.image,
          segmentation.source.armType,
          draftPixelIds,
        )
      : seamExpansionPixelIds(
          activeSkin.image,
          segmentation.source.armType,
          draftPixelIds,
        );
    const selected = new Set(draftPixelIds);
    const additions = candidates.filter((pixelId) => !selected.has(pixelId));
    setSemanticSelectionPreview({ kind, pixelIds: additions });
    setNotice(
      additions.length > 0
        ? `橙色预览包含 ${additions.length} 个${kind === "mirror" ? "镜像" : "跨 UV 接缝"}像素；确认前不会修改草稿`
        : `当前选择没有可加入的${kind === "mirror" ? "可见镜像" : "可见接缝邻接"}像素`,
    );
  };

  const confirmSemanticExpansion = () => {
    if (!semanticSelectionPreview) return;
    updateDraftSelection(applySelectionPixels(
      draftPixelIds,
      semanticSelectionPreview.pixelIds,
      "add",
    ));
    setNotice(`已把 ${semanticSelectionPreview.pixelIds.length} 个预览像素加入本地草稿`);
  };

  const saveActiveComponentRelations = () => {
    if (!activeComponent) {
      setNotice("先选择要编辑关系的组件");
      return;
    }
    void commitSemanticOperation(
      {
        type: "set_component_relations",
        componentId: activeComponent.instanceId,
        relations: {
          attachedTo: semanticRelationDraft.attachedTo,
          pairedWith: semanticRelationDraft.pairedWith,
          sameOutfitGroup: semanticRelationDraft.sameOutfitGroup.trim() || null,
          conflictsWith: semanticRelationDraft.conflictsWith,
        },
      },
      `更新 ${activeComponent.displayName} 的组件关系`,
    );
  };

  const changePartLibraryStatus = async (
    part: ApiPart,
    action: "retire" | "restore",
    reason?: string,
  ) => {
    if (libraryLifecycleBusyRef.current) return;
    libraryLifecycleBusyRef.current = true;
    setLibraryLifecycleBusy(true);
    setHistoryError(null);
    try {
      const updated = action === "retire"
        ? await retirePart(part.id, reason)
        : await restorePart(part.id);
      await refreshReusableCatalog();
      if (updated.libraryStatus === "retired") {
        setPartLibraryFilters((filters) =>
          filters.status === "active" ? { ...filters, status: "retired" } : filters,
        );
      }
      setSelectedPartId(updated.id);
      setNotice(action === "retire" ? `已退役组件 ${updated.name}` : `已恢复组件 ${updated.name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setHistoryError(message);
      setNotice(`组件库状态修改失败：${message}`);
    } finally {
      libraryLifecycleBusyRef.current = false;
      setLibraryLifecycleBusy(false);
    }
  };

  const changeBundleLibraryStatus = async (
    bundle: ApiPartBundle,
    action: "retire" | "restore",
    reason?: string,
  ) => {
    if (libraryLifecycleBusyRef.current) return;
    libraryLifecycleBusyRef.current = true;
    setLibraryLifecycleBusy(true);
    setCompositionError(null);
    try {
      const updated = action === "retire"
        ? await retirePartBundle(bundle.id, reason)
        : await restorePartBundle(bundle.id);
      await refreshReusableCatalog();
      if (updated.libraryStatus === "retired") {
        setBundleLibraryFilters((filters) =>
          filters.status === "active" ? { ...filters, status: "retired" } : filters,
        );
      }
      setSelectedBundleId(updated.id);
      setNotice(action === "retire" ? `已退役完整大类 ${updated.name}` : `已恢复完整大类 ${updated.name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCompositionError(message);
      setNotice(`完整大类状态修改失败：${message}`);
    } finally {
      libraryLifecycleBusyRef.current = false;
      setLibraryLifecycleBusy(false);
    }
  };

  const replaceBundleMember = async (
    bundle: ApiPartBundle,
    memberPartId: string,
    replacementPartId: string,
    reason?: string,
  ) => {
    if (libraryLifecycleBusyRef.current) return;
    libraryLifecycleBusyRef.current = true;
    setLibraryLifecycleBusy(true);
    setCompositionError(null);
    try {
      const result = await revisePartBundle(bundle.id, {
        name: bundle.name,
        replacements: [{ memberPartId, replacementPartId }],
        ...(reason?.trim() ? { reason: reason.trim() } : {}),
      });
      await refreshReusableCatalog();
      setSelectedBundleId(result.bundle.id);
      setNotice(`已生成 ${result.bundle.name} 新版本；旧完整大类已退役`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCompositionError(message);
      setNotice(`完整大类成员替换失败：${message}`);
    } finally {
      libraryLifecycleBusyRef.current = false;
      setLibraryLifecycleBusy(false);
    }
  };

  const activateAnalyzedSkin = async (
    item: ApiAnalyzedSkin,
    revisionId = item.revision.id,
  ) => {
    const activationRequestId = ++analyzedActivationRequestRef.current;
    const aiDetailRequestId = ++aiJobDetailRequestRef.current;
    const pendingHydration: PendingCatalogAiHydration = {
      activationRequestId,
      aiDetailRequestId,
      revisionId,
    };
    pendingCatalogAiHydrationRef.current = pendingHydration;
    let aiDetailHydrationAttached = false;
    aiJobDetailRef.current = null;
    setAiJobDetail(null);
    setHistoryBusy(true);
    setHistoryError(null);
    setAiError(null);
    try {
      const aiDetailPromise = loadAiJobDetail(
        item.semanticFollowup?.jobId ?? item.aiJob.id,
      ).then(
        (detail) => ({ detail, error: null }),
        (error: unknown) => ({ detail: null, error }),
      );
      const [project, branches, revisions, projects] =
        await Promise.all([
          getProject(item.project.id),
          listBranches(item.project.id),
          listRevisions(item.project.id),
          listProjects(),
        ]);
      if (activationRequestId !== analyzedActivationRequestRef.current) return;
      setHistoryProject(project);
      setHistoryBranches(branches);
      setHistoryRevisions(revisions);
      setHistoryProjects(projects);
      window.localStorage.setItem(HISTORY_PROJECT_KEY, project.id);
      const revision = revisions.find(
        (candidate) => candidate.id === revisionId,
      );
      if (!revision) {
        throw new Error("目录中的 Revision 已不存在");
      }
      const activated = await activateRevision(revision, {
        preserveAiDetailRequest: true,
        preserveAnalyzedActivation: true,
      });
      if (
        !activated ||
        activationRequestId !== analyzedActivationRequestRef.current
      ) return;
      aiDetailHydrationAttached = true;
      void aiDetailPromise.then((aiDetailResult) => {
        try {
          if (
            activationRequestId !== analyzedActivationRequestRef.current ||
            aiDetailRequestId !== aiJobDetailRequestRef.current
          ) return;
          if (aiDetailResult.detail) {
            aiJobDetailRef.current = aiDetailResult.detail;
            setAiJobDetail(aiDetailResult.detail);
            return;
          }
          aiJobDetailRef.current = null;
          setAiJobDetail(null);
          setAiError(
            `Revision 可正常载入，但 AI 运行记录读取失败：${
              aiDetailResult.error instanceof Error
                ? aiDetailResult.error.message
                : String(aiDetailResult.error)
            }`,
          );
        } finally {
          if (pendingCatalogAiHydrationRef.current === pendingHydration) {
            pendingCatalogAiHydrationRef.current = null;
          }
        }
      });
    } catch (error) {
      if (activationRequestId === analyzedActivationRequestRef.current) {
        const message = error instanceof Error ? error.message : String(error);
        setHistoryError(message);
        setNotice(`已分析皮肤载入失败：${message}`);
      }
    } finally {
      if (
        !aiDetailHydrationAttached &&
        pendingCatalogAiHydrationRef.current === pendingHydration
      ) {
        pendingCatalogAiHydrationRef.current = null;
      }
      if (activationRequestId === analyzedActivationRequestRef.current) {
        setHistoryBusy(false);
      }
    }
  };

  const changeAnalyzedSkinCatalogStatus = async (
    item: ApiAnalyzedSkin,
    action: "archive" | "restore",
    reason?: string,
  ): Promise<boolean> => {
    const revisionId = item.revision.id;
    if (catalogLifecycleBusyRef.current.has(revisionId)) return false;
    catalogLifecycleBusyRef.current.add(revisionId);
    catalogRefreshRequestRef.current += 1;
    setBusyCatalogRevisionIds(new Set(catalogLifecycleBusyRef.current));
    setCatalogError(null);
    try {
      const updated = action === "archive"
        ? await archiveAnalyzedSkin(revisionId, reason)
        : await restoreAnalyzedSkin(revisionId);
      catalogRefreshRequestRef.current += 1;
      setAnalyzedSkins((current) =>
        current.map((candidate) =>
          candidate.revision.id === revisionId ? updated : candidate,
        ),
      );
      setNotice(
        action === "archive"
          ? `已归档分析结果 ${item.project.name} · ${item.revision.branchName} #${item.revision.sequence}`
          : `已恢复分析结果 ${item.project.name} · ${item.revision.branchName} #${item.revision.sequence}`,
      );
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const actionLabel = action === "archive" ? "归档" : "恢复";
      setCatalogError(`分析结果${actionLabel}失败：${message}`);
      setNotice(`分析目录${actionLabel}失败：${message}`);
      return false;
    } finally {
      catalogLifecycleBusyRef.current.delete(revisionId);
      setBusyCatalogRevisionIds(new Set(catalogLifecycleBusyRef.current));
    }
  };

  const exportAnalyzedGroup = async (
    item: ApiAnalyzedSkin,
    group: ApiAnalyzedSkinGroup,
    revisionId = item.revision.id,
  ) => {
    const busyKey = `${revisionId}:${group.key}`;
    setBusyCatalogGroupKey(busyKey);
    setCatalogError(null);
    setNotice(`正在将 ${group.displayName} 的 ${group.componentCount} 个组件整组入库`);
    try {
      const bundle = await exportRevisionBundle(revisionId, {
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

  const exportCurrentHeadGroup = async (kind: ApiAnalyzedSkinGroup["kind"]) => {
    if (!selectedRevision?.isBranchHead || !segmentation || !historyProject) {
      setNotice("完整大类重新入库只允许基于当前 Branch HEAD");
      return;
    }
    const componentIds = segmentation.components
      .filter((component) => categoryBelongsToAggregate(component.category, kind))
      .map((component) => component.instanceId);
    if (componentIds.length === 0) {
      setNotice(`当前 HEAD 没有可组成${BUNDLE_KIND_LABELS[kind]}的已确认组件`);
      return;
    }
    const busyKey = `${selectedRevision.id}:current-head:${kind}`;
    setBusyCatalogGroupKey(busyKey);
    setCatalogError(null);
    try {
      const bundle = await exportRevisionBundle(selectedRevision.id, {
        name: `${historyProject.name} · ${BUNDLE_KIND_LABELS[kind]} · ${selectedRevision.branchName} #${selectedRevision.sequence}`,
        kind,
        componentIds,
      });
      await refreshReusableCatalog();
      setSelectedBundleId(bundle.id);
      setNotice(`已从修正后的当前 HEAD 重新入库 ${bundle.name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCatalogError(message);
      setNotice(`当前 HEAD 完整大类入库失败：${message}`);
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
      setNotice(
        `已保存部件 ${part.name} · texture + write mask + 逐像素来源记录`,
      );
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
    const revisionId = selectedRevision.id;
    const partId = selectedPart.id;
    const requestId = ++partPreviewRequestRef.current;
    setSemanticBusy(true);
    setHistoryError(null);
    try {
      const preview = await previewRevisionPart(
        revisionId,
        partId,
      );
      if (requestId !== partPreviewRequestRef.current) return;
      setPartPreview(preview);
      setNotice(
        `冲突预览：${preview.report.hardConflictCount} 个硬冲突，尚未创建 Revision`,
      );
    } catch (error) {
      if (requestId !== partPreviewRequestRef.current) return;
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
    if (
      !selectedRevision ||
      !selectedPart ||
      !partPreview ||
      partPreview.revisionId !== selectedRevision.id ||
      partPreview.part.id !== selectedPart.id
    ) {
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
      part.libraryStatus === "retired" ||
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
    if (
      bundle.libraryStatus === "retired" ||
      !composition ||
      !compositionDraft ||
      selectedBundleAlreadyLayered
    ) {
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

  const openCompletionRevision = async (
    revisionId: string,
    destination: "source" | "result",
  ) => {
    if (!historyProject) return;
    if (destination === "result" && playerCompletionResult) {
      const acceptedRevisionId =
        playerCompletionResult.detail.result?.revision?.id ?? null;
      const sourceChoice = playerCompletionResult.catalogContext.choices.find(
        (choice) => choice.revisionId === revisionId,
      );
      if (revisionId === acceptedRevisionId) {
        setPlayerResultSelection("completed");
      } else if (sourceChoice) {
        setPlayerResultSelection(sourceChoice.kind);
      }
    }
    setHistoryBusy(true);
    setHistoryError(null);
    try {
      const opened = await refreshHistory(historyProject.id, revisionId);
      if (!opened) return;
      navigateToPlayerStep(destination === "source" ? "review" : "save");
      setNotice(
        destination === "source"
          ? "已切换隐藏内容检查使用的分析版本"
          : "已载入明确选择的结果版本",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setHistoryError(message);
      setNotice(`结果版本载入失败：${message}`);
    } finally {
      setHistoryBusy(false);
    }
  };

  const handleCompletionDecision = async (
    detail: ApiCompletionProposalDetail,
    catalogContext: CompletionCatalogContext,
    navigateToResult: boolean,
  ) => {
    setPlayerCompletionResult({ detail, catalogContext });
    setPlayerResultSelection(catalogContext.sourceKind);
    if (navigateToResult) {
      navigateToPlayerStep("save");
    }
  };

  const publishLatentCompletionPart = async () => {
    const result = activePlayerCompletionResult?.detail.result;
    if (
      !result ||
      result.representation !== "latent_component" ||
      !result.latentPart
    ) {
      setNotice("当前选择没有可发布的完成版组件");
      return;
    }
    setCompletionPublishBusy(true);
    try {
      const outcome = await publishCompletionResult(result);
      setPlayerCompletionResult((current) => {
        if (current?.detail.result?.id !== outcome.result.id) return current;
        return {
          ...current,
          detail: { ...current.detail, result: outcome.result },
        };
      });
      try {
        await refreshReusableCatalog();
        setSelectedPartId(outcome.result.latentPart?.id ?? null);
        setNotice(
          outcome.changed
            ? "完成版组件已发布到部件库"
            : "完成版组件之前已经发布；部件库已刷新",
        );
      } catch (refreshError) {
        setNotice(
          `组件已发布，但部件库刷新失败：${refreshError instanceof Error ? refreshError.message : String(refreshError)}`,
        );
      }
    } catch (error) {
      setNotice(
        `完成版组件发布失败：${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setCompletionPublishBusy(false);
    }
  };

  const selectPlayerResult = async (
    selection: PlayerResultSelection,
    revisionId?: string,
  ) => {
    setPlayerResultSelection(selection);
    if (revisionId) {
      await openCompletionRevision(revisionId, "result");
    } else {
      navigateToPlayerStep("save");
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
    <main
      className="studio-shell"
      data-studio-mode={studioMode}
      data-player-step={playerWorkflowStep}
    >
      <header className="studio-header">
        <div>
          <p className="eyebrow">PLAYER-FIRST VERSIONED SKIN STUDIO / M20</p>
          <h1>
            MC<span>Skin</span>Split
          </h1>
          <p className="lede">
            {studioMode === "player"
              ? "导入一张皮肤，智能识别可见部件，检查需要修正的地方，再选择要保存或导出的结果。每一步都由用户确认。"
              : "Codex 辅助识别真实皮肤的语义部件，并对确定性还原候选给出受限建议；单组件修补、多图层混搭与目标残留还原均保留可追溯历史。"}
          </p>
        </div>
        <div className="baseline-stamp" aria-label="M20 玩家优先的皮肤拆分工作室">
          <strong>M20</strong>
          <span>REVIEW + CHOOSE</span>
        </div>
      </header>

      <PlayerWorkflowNav
        mode={studioMode}
        step={playerWorkflowStep}
        onSelectStep={navigateToPlayerStep}
        onChangeMode={(mode) => {
          if (mode === "advanced") {
            navigateToAdvancedStudio();
          } else {
            const currentAdvancedSection = resolveWorkflowSectionIdFromHash(
              window.location.hash,
            );
            if (currentAdvancedSection) {
              lastAdvancedSectionIdRef.current = currentAdvancedSection;
            }
            navigateToPlayerStep(playerWorkflowStep);
          }
        }}
      />

      {studioMode === "advanced" && <WorkflowSectionNav />}

      <div className="studio-content">

        <section
          id="workspace-history"
          className="history-panel"
          aria-label="Revision 时间线"
          data-workflow-section
          tabIndex={-1}
        >
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
        busyRevisionIds={busyCatalogRevisionIds}
        loading={catalogLoading}
        error={catalogError}
        selectedRevisionId={selectedRevisionId}
        onActivate={(item) => void activateAnalyzedSkin(item)}
        onActivateRevision={(item, revisionId) => void activateAnalyzedSkin(item, revisionId)}
        onExportGroup={(item, group) => void exportAnalyzedGroup(item, group)}
        onExportVariantGroup={(item, revisionId, group) => void exportAnalyzedGroup(item, group, revisionId)}
        onArchive={(item, reason) =>
          changeAnalyzedSkinCatalogStatus(item, "archive", reason)}
        onRestore={(item) =>
          changeAnalyzedSkinCatalogStatus(item, "restore")}
      />

      <section className="current-head-bundle-export" aria-label="当前 HEAD 完整大类重新入库">
        <div>
          <span>CORRECTED HEAD</span>
          <h2>当前 HEAD 完整大类重新入库</h2>
          <p>
            先在下方修正误识别，再从最新 Branch HEAD 导出新 Bundle；旧 Bundle 不会被覆盖，可单独退役。
          </p>
        </div>
        <dl>
          <div><dt>PROJECT</dt><dd>{historyProject?.name ?? "未选择工程"}</dd></div>
          <div><dt>HEAD</dt><dd>{selectedRevision ? `${selectedRevision.branchName} #${selectedRevision.sequence}` : "未选择 Revision"}</dd></div>
        </dl>
        <div className="current-head-bundle-actions">
          {(["hair", "clothing", "accessory"] as const).map((kind) => {
            const busyKey = `${selectedRevision?.id}:current-head:${kind}`;
            const count = segmentation?.components.filter((component) =>
              categoryBelongsToAggregate(component.category, kind)).length ?? 0;
            return (
              <button
                key={kind}
                type="button"
                disabled={!selectedRevision?.isBranchHead || count === 0 || busyCatalogGroupKey !== null}
                onClick={() => void exportCurrentHeadGroup(kind)}
              >
                {busyCatalogGroupKey === busyKey ? "正在入库…" : `${BUNDLE_KIND_LABELS[kind]} · ${count} 组件`}
              </button>
            );
          })}
        </div>
      </section>

      <section
        id="workspace-ai"
        className="ai-console"
        data-status={aiJob?.status ?? "idle"}
        aria-label="AI 语义识别任务"
        data-workflow-section
        tabIndex={-1}
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
            <div className="ai-player-intro">
              <span>ONE CLICK</span>
              <strong>识别部件，并检查跨部位错分</strong>
              <p>
                默认从干净语义开始，不沿用旧分类。发现安全的分类调整时再让用户确认；被遮挡的隐藏衣服或头发仍可能需要后续补全。
              </p>
            </div>
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
                <dt>ANALYSIS</dt>
                <dd>{aiSemanticBaseline === "empty" ? "干净重新识别" : "参考现有分类"}</dd>
              </div>
            </dl>
            <p className="ai-privacy-note">
              皮肤图片可能由当前 Codex 配置的远端模型处理；正式像素仍由本地确定性代码校验。
            </p>
            <div className="ai-controls">
              <button type="submit" disabled={!canStartAi || aiBusy}>
                {aiBusy ? "正在启动…" : "智能分析皮肤"}
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
              ) : <span />}
            </div>
            <details className="ai-advanced-config">
              <summary>高级设置与重试</summary>
              <div>
                <label>
                  <span>识别方式</span>
                  <select
                    value={aiSemanticBaseline}
                    disabled={aiBusy || aiJobRunning}
                    onChange={(event) => setAiSemanticBaseline(event.target.value as ApiAiAnalysisOptions["semanticBaseline"])}
                  >
                    <option value="empty">干净重新识别（推荐）</option>
                    <option value="current">参考现有分类</option>
                  </select>
                </label>
                <label>
                  <span>Provider</span>
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
                  <span>Model</span>
                  <input value={aiModel} maxLength={120} disabled={aiBusy || aiJobRunning} onChange={(event) => setAiModel(event.target.value)} />
                </label>
                <label>
                  <span>Reasoning</span>
                  <select
                    value={aiReasoningEffort}
                    disabled={aiBusy || aiJobRunning}
                    onChange={(event) => setAiReasoningEffort(event.target.value as ApiAiAnalysisOptions["reasoningEffort"])}
                  >
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                    <option value="xhigh">XHigh</option>
                    <option value="max">Max</option>
                  </select>
                </label>
              </div>
              <button
                className="ai-secondary-button ai-advanced-retry"
                type="button"
                disabled={!aiJob || aiBusy || aiJobRunning || !aiProvider || !aiModel.trim()}
                onClick={() => void retrySelectedAiJob()}
              >
                使用高级设置重试
              </button>
            </details>
          </form>

          <article className="ai-job-card">
            {aiJob ? (
              <>
                <div className="ai-job-status">
                  <span>{aiStatusLabels[aiJob.status]}</span>
                  <strong>
                    {aiJobRunning ? "页面关闭后仍会继续" : "运行记录已保存"}
                  </strong>
                </div>
                <SemanticAiJobProgress detail={aiJobDetail} />

                <SemanticFollowupReview
                  followup={aiJobDetail?.semanticFollowup ?? null}
                  busy={aiBusy}
                  onApply={(suggestionId) => void applySelectedSemanticFollowup(suggestionId)}
                  onDismiss={() => void dismissSelectedSemanticFollowup()}
                />

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

                <details className="ai-technical-details">
                  <summary>高级信息 · 运行记录与技术日志</summary>
                  <div className="ai-job-meta">
                    <code>{shortIdentifier(aiJob.id)}</code>
                    <span>{aiJob.provider} / {aiJob.model}</span>
                    <span>reasoning / {aiJob.options.reasoningEffort}</span>
                    <span>{aiJob.skillName} {aiJob.skillVersion}</span>
                  </div>
                  <div className="ai-run-strip">
                    {aiJobDetail?.runs.map((run) => (
                      <span key={run.id} data-status={run.status}>
                        RUN {run.attempt} · {run.status.toUpperCase()} · {run.assets.length} FILES
                      </span>
                    ))}
                  </div>
                  <SemanticAiEventLog events={aiJobDetail?.events ?? []} running={aiJobRunning} logRef={aiEventLogRef} />
                </details>
              </>
            ) : (
              <>
                <SemanticAiJobProgress detail={null} />
                <div className="ai-empty-state">
                  <strong>NO ANALYSIS JOB</strong>
                  <p>选择任意版本后即可启动识别；历史版本会自动创建新分支。运行明细保留在高级信息中。</p>
                </div>
              </>
            )}
            {aiError && <p className="ai-console-error" role="alert">{aiError}</p>}
          </article>
        </div>
      </section>

      <section
        id="workspace-preview"
        className="workbench"
        aria-label="皮肤预览工作台"
        data-workflow-section
        tabIndex={-1}
      >
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
            <small>上传即创建导入版本 · 64×64 · 最大 1 MiB</small>
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
              ? `版本 / ${selectedRevision.branchName} #${selectedRevision.sequence}`
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

      <section
        id="workspace-semantic"
        className="semantic-workspace"
        aria-label={studioMode === "player" ? "检查并修正组件分类" : "人工语义编辑与部件库"}
        data-workflow-section
        tabIndex={-1}
      >
        <section
          className="semantic-panel semantic-editor-panel"
          data-testid="semantic-canvas-column"
        >
          <div className="panel-heading-row semantic-canvas-heading">
            <div className="panel-heading">
              <span>04</span>
              <div>
                <p>SELECT PIXELS</p>
                <h2>圈出要分类的像素</h2>
              </div>
            </div>
            <div className="view-switch" aria-label="语义检查二维或三维视图">
              <button
                type="button"
                aria-pressed={semanticMiddleView === "2d"}
                onClick={() => setSemanticMiddleView("2d")}
              >
                2D
              </button>
              <button
                type="button"
                aria-pressed={semanticMiddleView === "3d"}
                onClick={() => setSemanticMiddleView("3d")}
              >
                3D
              </button>
            </div>
          </div>
          <div
            className="semantic-selection-tools"
            role="toolbar"
            aria-label="像素选择工具"
            data-testid="semantic-selection-tools"
          >
            {([
              ["brush", "画笔"],
              ["rectangle", "矩形"],
              ["magic", "同色魔棒"],
              ["surface", "整面"],
            ] as const).map(([tool, label]) => (
              <button
                key={tool}
                type="button"
                aria-pressed={semanticSelectionTool === tool}
                disabled={!canEditSemantic || semanticBusy}
                onClick={() => {
                  setSemanticMiddleView("2d");
                  setSemanticSelectionTool(tool);
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="semantic-canvas-frame">
            {activeSkin && segmentation && semanticMiddleView === "2d" ? (
              <SemanticEditorCanvas
                activeComponentId={activeComponentId ?? undefined}
                armType={segmentation.source.armType}
                components={segmentation.components}
                disabled={!canEditSemantic || semanticBusy}
                diffPixelIds={activeSemanticDiffPixelIds}
                hiddenComponentIds={hiddenSemanticComponentIds}
                image={activeSkin.image}
                previewPixelIds={semanticSelectionPreview?.pixelIds ?? []}
                selectedPixelIds={draftPixelIds}
                selectionTool={semanticSelectionTool}
                soloComponentId={soloSemanticComponentId}
                viewMode={semanticCanvasViewMode}
                onSelectionChange={updateDraftSelection}
              />
            ) : activeSkin && segmentation ? (
              <div className="semantic-3d-preview" data-testid="semantic-3d-preview">
                <SkinPreview
                  armType={segmentation.source.armType}
                  skinUrl={skinUrl}
                  motion="idle"
                  ariaLabel="当前版本的三维分类检查预览"
                />
                <p>3D 用于检查整体位置；切回 2D 后圈选精确像素。</p>
              </div>
            ) : (
              <p>选择一个版本后启用语义画笔</p>
            )}
          </div>
          <div className="semantic-draft-toolbar">
            <span>
              DRAFT <strong>{draftPixelIds.length}</strong> PX
            </span>
            <button
              type="button"
              disabled={draftSelectionHistory.past.length === 0 || semanticBusy}
              onClick={() => {
                setDraftSelectionHistory(undoSemanticSelection);
                setSemanticSelectionPreview(null);
              }}
            >
              撤销
            </button>
            <button
              type="button"
              disabled={draftSelectionHistory.future.length === 0 || semanticBusy}
              onClick={() => {
                setDraftSelectionHistory(redoSemanticSelection);
                setSemanticSelectionPreview(null);
              }}
            >
              重做
            </button>
            <button
              type="button"
              disabled={draftPixelIds.length === 0 || semanticBusy}
              onClick={clearDraftSelection}
            >
              清空草稿
            </button>
            <button
              type="button"
              disabled={!canEditSemantic || draftPixelIds.length === 0 || semanticBusy}
              onClick={unassignDraftPixels}
            >
              标记为未分类
            </button>
          </div>
          <p className="semantic-help">
            点击、拖动或使用方向键与空格选择有效像素；再次选择可移除。草稿只保存在本页，右侧确认后才创建新版本。
          </p>
          <details className="semantic-selection-advanced">
            <summary>更多选区与语义对照</summary>
            <div className="semantic-expansion-tools">
              <button
                type="button"
                disabled={!activeSkin || draftPixelIds.length === 0 || semanticBusy}
                onClick={() => previewSemanticExpansion("mirror")}
              >
                预览镜像扩展
              </button>
              <button
                type="button"
                disabled={!activeSkin || draftPixelIds.length === 0 || semanticBusy}
                onClick={() => previewSemanticExpansion("seam")}
              >
                预览 UV 接缝扩展
              </button>
            </div>
            {semanticSelectionPreview && (
              <div className="semantic-expansion-confirm" role="status">
                <p>
                  橙色显示 {semanticSelectionPreview.pixelIds.length} 个待加入像素；当前草稿尚未改变。
                </p>
                <button
                  type="button"
                  disabled={semanticSelectionPreview.pixelIds.length === 0 || semanticBusy}
                  onClick={confirmSemanticExpansion}
                >
                  确认加入草稿
                </button>
                <button
                  type="button"
                  disabled={semanticBusy}
                  onClick={() => setSemanticSelectionPreview(null)}
                >
                  取消预览
                </button>
              </div>
            )}
            <div className="semantic-diff-modes" role="group" aria-label="纹理与语义对照模式">
              {([
                ["texture", "纹理 RGBA"],
                ["ownership", "像素归属"],
                ["category", "分类"],
              ] as const).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={semanticCanvasViewMode === mode}
                  onClick={() => {
                    setSemanticMiddleView("2d");
                    setSemanticCanvasViewMode(mode);
                  }}
                >
                  {label}
                  {semanticRevisionDiffStatus === "ready" && semanticRevisionDiff
                    ? ` · ${semanticRevisionDiffPixelIds(semanticRevisionDiff, mode).length}`
                    : ""}
                </button>
              ))}
            </div>
            <p className="semantic-texture-diff-note">
              {semanticRevisionDiffStatus === "loading"
                ? "正在读取父版本并计算真实变化像素…"
                : semanticRevisionDiffStatus === "ready" && semanticRevisionDiff
                  ? semanticRevisionDiffLabel(semanticRevisionDiff)
                  : semanticRevisionDiffStatus === "unavailable"
                    ? "父版本对照读取失败；当前没有显示推测性的差异。"
                    : selectedRevision
                      ? "这是首个版本，没有父版本可供逐像素对照。"
                      : "载入版本后显示真实的纹理与语义变化像素。"}
            </p>
          </details>
        </section>

        <section className="semantic-panel component-panel">
          <div
            className="semantic-component-column"
            data-testid="semantic-component-column"
          >
            <div className="panel-heading semantic-heading-split">
              <span>05</span>
              <div>
                <p>CHOOSE COMPONENT</p>
                <h2>选择一个组件</h2>
              </div>
              <strong>{segmentation?.components.length ?? 0}</strong>
            </div>

            <div className="component-tree" aria-label="语义组件树">
              <div className="component-row unknown-row">
                <span aria-hidden="true">?</span>
                <div>
                  <strong>{studioMode === "player" ? "未分类" : "unknown"}</strong>
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
                    className="component-merge-choice"
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
                    className="component-select-button"
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
                  <div className="component-overlay-actions">
                    <button
                      type="button"
                      aria-label={`${hiddenSemanticComponentIds.includes(component.instanceId) ? "显示" : "隐藏"} ${component.displayName} 的语义覆盖层`}
                      aria-pressed={!hiddenSemanticComponentIds.includes(component.instanceId)}
                      disabled={semanticBusy}
                      onClick={() => setHiddenSemanticComponentIds((current) =>
                        current.includes(component.instanceId)
                          ? current.filter((id) => id !== component.instanceId)
                          : [...current, component.instanceId])}
                    >
                      {hiddenSemanticComponentIds.includes(component.instanceId) ? "显示" : "隐藏"}
                    </button>
                    <button
                      type="button"
                      aria-label={`只看 ${component.displayName} 的语义覆盖层`}
                      aria-pressed={soloSemanticComponentId === component.instanceId}
                      disabled={semanticBusy}
                      onClick={() => {
                        setHiddenSemanticComponentIds((current) =>
                          current.filter((id) => id !== component.instanceId));
                        setSoloSemanticComponentId((current) =>
                          current === component.instanceId ? null : component.instanceId);
                      }}
                    >
                      Solo
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <PixelOriginSummaryPanel
              origin={revisionOrigin}
              activeComponentId={activeComponentId}
            />
          </div>

          <div
            className="semantic-classification-column"
            data-testid="semantic-classification-column"
          >
            <div className="panel-heading">
              <span>06</span>
              <div>
                <p>CONFIRM CATEGORY</p>
                <h2>分类并确认</h2>
              </div>
            </div>
            <div
              className="semantic-target-mode"
              role="group"
              aria-label="选择分类目标"
            >
              <button
                type="button"
                aria-pressed={componentTargetMode === "selected"}
                disabled={!activeComponent || semanticBusy}
                onClick={() => setComponentTargetMode("selected")}
              >
                所选组件
              </button>
              <button
                type="button"
                aria-pressed={componentTargetMode === "new"}
                disabled={semanticBusy}
                onClick={beginNewComponent}
              >
                + 新组件
              </button>
            </div>
            <p className="semantic-target-note">
              {componentTargetMode === "new"
                ? "确认后由系统生成组件编号。"
                : activeComponent
                  ? `像素将归入“${activeComponent.displayName}”。`
                  : "从左侧选择组件，或新建组件。"}
            </p>

          <div className="semantic-form">
            {studioMode === "advanced" && (
              <details className="semantic-raw-id">
                <summary>高级信息 · 原始组件 ID</summary>
                <label>
                  <span>INSTANCE ID</span>
                  <input
                    value={componentId}
                    maxLength={100}
                    disabled={semanticBusy}
                    onChange={(event) => setComponentId(event.target.value)}
                  />
                </label>
              </details>
            )}
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

          <div className="semantic-actions semantic-primary-action">
            <button
              type="button"
              disabled={!canEditSemantic || draftPixelIds.length === 0 || semanticBusy}
              onClick={assignDraftPixels}
            >
              确认像素分类
            </button>
          </div>

          <details
            className="semantic-component-advanced"
            open={studioMode === "advanced"}
          >
            <summary>更多组件操作</summary>
            <div className="semantic-actions">
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
                修改所选组件分类
              </button>
              <button
                type="button"
                disabled={!canEditSemantic || checkedComponentIds.length < 2 || semanticBusy}
                onClick={mergeCheckedComponents}
              >
                合并勾选组件
              </button>
              <button
                className="semantic-remove-component"
                type="button"
                disabled={!canEditSemantic || !activeComponent || semanticBusy}
                data-armed={removeComponentArmedId === activeComponent?.instanceId}
                onClick={removeActiveComponentRecognition}
              >
                {removeComponentArmedId === activeComponent?.instanceId
                  ? "确认全部退回未分类"
                  : "移除所选组件识别"}
              </button>
            </div>
            <p className="semantic-destructive-help">
              移除识别会创建新版本：所选组件的全部像素退回未分类，旧版本和已导出部件保持不变。
            </p>
            <button
              className="export-part-button"
              type="button"
              disabled={!activeComponent || semanticBusy}
              onClick={() => void exportActiveComponent()}
            >
              所选组件 → 保存为 64×64 部件
            </button>
          </details>

          <details
            className="semantic-relations-editor"
            data-testid="semantic-relations-editor"
          >
            <summary>组件关系（可选）</summary>
            <p>关系会在一次确认中创建一个新版本；不会改动纹理 RGBA。</p>
            <label>
              <span>附着到</span>
              <select
                value={semanticRelationDraft.attachedTo ?? ""}
                disabled={!activeComponent || semanticBusy}
                onChange={(event) => setSemanticRelationDraft((current) => ({
                  ...current,
                  attachedTo: event.target.value || null,
                }))}
              >
                <option value="">无</option>
                {segmentation?.components
                  .filter((component) => component.instanceId !== activeComponentId)
                  .map((component) => (
                    <option key={component.instanceId} value={component.instanceId}>
                      {component.displayName}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              <span>同套装分组（可选）</span>
              <input
                value={semanticRelationDraft.sameOutfitGroup}
                maxLength={100}
                disabled={!activeComponent || semanticBusy}
                onChange={(event) => setSemanticRelationDraft((current) => ({
                  ...current,
                  sameOutfitGroup: event.target.value,
                }))}
              />
            </label>
            <fieldset>
              <legend>成对组件</legend>
              {segmentation?.components
                .filter((component) => component.instanceId !== activeComponentId)
                .map((component) => (
                  <label key={component.instanceId}>
                    <input
                      type="checkbox"
                      checked={semanticRelationDraft.pairedWith.includes(component.instanceId)}
                      disabled={!activeComponent || semanticBusy}
                      onChange={(event) => setSemanticRelationDraft((current) => ({
                        ...current,
                        pairedWith: event.target.checked
                          ? [...new Set([...current.pairedWith, component.instanceId])]
                          : current.pairedWith.filter((id) => id !== component.instanceId),
                        conflictsWith: event.target.checked
                          ? current.conflictsWith.filter((id) => id !== component.instanceId)
                          : current.conflictsWith,
                      }))}
                    />
                    <span>{component.displayName}</span>
                  </label>
                ))}
            </fieldset>
            <fieldset>
              <legend>互斥组件</legend>
              {segmentation?.components
                .filter((component) => component.instanceId !== activeComponentId)
                .map((component) => (
                  <label key={component.instanceId}>
                    <input
                      type="checkbox"
                      checked={semanticRelationDraft.conflictsWith.includes(component.instanceId)}
                      disabled={!activeComponent || semanticBusy}
                      onChange={(event) => setSemanticRelationDraft((current) => ({
                        ...current,
                        conflictsWith: event.target.checked
                          ? [...new Set([...current.conflictsWith, component.instanceId])]
                          : current.conflictsWith.filter((id) => id !== component.instanceId),
                        pairedWith: event.target.checked
                          ? current.pairedWith.filter((id) => id !== component.instanceId)
                          : current.pairedWith,
                      }))}
                    />
                    <span>{component.displayName}</span>
                  </label>
                ))}
            </fieldset>
            <button
              type="button"
              disabled={!canEditSemantic || !activeComponent || semanticBusy}
              onClick={saveActiveComponentRelations}
            >
              确认组件关系
            </button>
          </details>
          </div>
        </section>

        <section className="semantic-panel parts-panel">
          <div className="panel-heading semantic-heading-split">
            <span>06</span>
            <div>
              <p>PART LIBRARY</p>
              <h2>复用与冲突</h2>
            </div>
            <strong>{filteredPartLibrary.length}</strong>
          </div>

          <LibraryToolbar
            filters={partLibraryFilters}
            projects={libraryProjectOptions}
            typeLabel="CATEGORY"
            typeOptions={SEMANTIC_CATEGORIES.map((category) => ({
              value: category,
              label: SEMANTIC_CATEGORY_LABELS[category],
            }))}
            onChange={setPartLibraryFilters}
          />

          <div className="part-library" data-empty={filteredPartLibrary.length === 0}>
            {filteredPartLibrary.length === 0 ? (
              <p>{partLibrary.length === 0 ? "从组件树保存头发、衣服、手套或鞋后，部件会出现在这里。" : "当前检索条件下没有组件。"}</p>
            ) : (
              filteredPartLibrary.map((part) => (
                <button
                  key={part.id}
                  className="part-card"
                  type="button"
                  data-active={part.id === selectedPartId}
                  data-library-status={part.libraryStatus}
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
                    <small className="library-source-chip">
                      {librarySourceLabel(part, libraryProjectOptions)}
                    </small>
                    <small className="part-origin-chip" data-origin-version={part.manifest.schemaVersion}>
                      {partOriginStatusLabel(part.manifest)}
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
                <span>{librarySourceLabel(selectedPart, libraryProjectOptions)}</span>
                <span>
                  {partOriginDetailLabel(selectedPart.manifest)}
                </span>
              </div>
              <button
                type="button"
                disabled={!selectedRevision || semanticBusy || selectedPart.libraryStatus === "retired"}
                onClick={() => void previewSelectedPart()}
              >
                先分析冲突
              </button>
            </div>
          )}

          {selectedPart && (
            <LibraryLifecycleControls
              assetId={selectedPart.id}
              name={selectedPart.name}
              status={selectedPart.libraryStatus}
              retiredReason={selectedPart.retiredReason}
              busy={libraryLifecycleBusy}
              onRetire={(reason) => changePartLibraryStatus(selectedPart, "retire", reason)}
              onRestore={() => changePartLibraryStatus(selectedPart, "restore")}
            />
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

      {COMPLETION_WORKSPACE_ENABLED && (
        <HiddenContentCompletionWorkspace
          key={selectedRevision?.id ?? "no-completion-source"}
          sourceRevision={selectedRevision ?? null}
          sourceSkinUrl={activeSkin?.source === "revision" ? skinUrl : null}
          segmentation={segmentation}
          catalogContext={completionCatalogContext}
          disabled={historyBusy || isLoadingSkin}
          onOpenRevision={openCompletionRevision}
          onDecision={handleCompletionDecision}
        />
      )}

      <PlayerResultWorkspace
        revision={selectedRevision ?? null}
        projectName={historyProject?.name ?? null}
        completion={activePlayerCompletionResult}
        selection={activePlayerCompletionResult ? playerResultSelection : "current"}
        components={segmentation?.components ?? []}
        activeComponentId={activeComponentId}
        busy={
          historyBusy ||
          semanticBusy ||
          completionPublishBusy ||
          busyCatalogGroupKey !== null
        }
        onSelectResult={(selection, revisionId) =>
          void selectPlayerResult(selection, revisionId)}
        onSelectComponent={chooseComponent}
        onDownloadPng={downloadActiveSkin}
        onSavePart={() => void exportActiveComponent()}
        onSaveBundle={(kind) => void exportCurrentHeadGroup(kind)}
        onPublishLatentPart={() => void publishLatentCompletionPart()}
      />

      <ComponentRepairStudio
        parts={activePartLibrary}
        projectOptions={libraryProjectOptions}
        defaultArmType={resolvedArmType}
        onNotice={setNotice}
        onCommittedPart={async (part) => {
          await refreshReusableCatalog();
          setSelectedPartId(part.id);
          setCompositionPartId(part.id);
        }}
      />

      <section
        id="workspace-composition"
        className="composition-studio"
        aria-label="多部件混搭与冲突处理"
        data-status={composition?.status ?? "idle"}
        data-workflow-section
        tabIndex={-1}
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
              bundles={filteredPartBundles}
              allParts={activePartLibrary}
              filters={bundleLibraryFilters}
              projectOptions={libraryProjectOptions}
              selectedBundle={selectedBundle}
              targetArmType={compositionTargetArmType}
              draftReady={Boolean(compositionDraft)}
              busy={compositionBusy}
              lifecycleBusy={libraryLifecycleBusy}
              allMembersLayered={selectedBundleAlreadyLayered}
              motion={bundleInspectorMotion}
              onSelect={setSelectedBundleId}
              onAdd={(bundle) => void addBundleToComposition(bundle)}
              onMotionChange={setBundleInspectorMotion}
              onFiltersChange={setBundleLibraryFilters}
              onRetire={(bundle, reason) => changeBundleLibraryStatus(bundle, "retire", reason)}
              onRestore={(bundle) => changeBundleLibraryStatus(bundle, "restore")}
              onReplaceMember={(bundle, memberPartId, replacementPartId, reason) =>
                replaceBundleMember(bundle, memberPartId, replacementPartId, reason)}
            />

            <div className="composition-section-title atomic-parts-title">
              <span>ATOMIC PARTS</span>
              <h3>细组件逐个入场</h3>
              <small>保留原有 23 类语义组件与单件冲突处理。</small>
            </div>

            <LibraryToolbar
              filters={compositionPartFilters}
              projects={libraryProjectOptions}
              typeLabel="CATEGORY"
              typeOptions={SEMANTIC_CATEGORIES.map((category) => ({
                value: category,
                label: SEMANTIC_CATEGORY_LABELS[category],
              }))}
              onChange={setCompositionPartFilters}
            />

            <div
              className="composition-part-library"
              data-empty={filteredCompositionParts.length === 0}
              aria-label="混搭组件库"
            >
              {filteredCompositionParts.length ? (
                filteredCompositionParts.map((part) => {
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
                          <small className="library-source-chip">
                            {librarySourceLabel(part, libraryProjectOptions)}
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
                <p>{partLibrary.length ? "当前检索条件下没有组件。" : "保存语义组件后，它会直接出现在这里，不必回到上方点选。"}</p>
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
                      compositionPart.libraryStatus === "retired" ||
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
      </div>
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
