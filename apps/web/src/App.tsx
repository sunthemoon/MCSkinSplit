import {
  SEMANTIC_CATEGORIES,
  SEMANTIC_CATEGORY_LABELS,
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
import { SkinPreview, type PreviewState } from "./components/SkinPreview";
import { SemanticEditorCanvas } from "./components/SemanticEditorCanvas";
import {
  decodeMinecraftSkinBytes,
  decodeMinecraftSkinFile,
} from "./lib/skinFile";
import {
  branchRevision,
  applySemanticOperation,
  cancelAiJob,
  commitRevisionPart,
  createProject,
  exportRevisionPart,
  getProject,
  importProjectSkin,
  listAiJobs,
  listAiProviders,
  listBranches,
  listParts,
  listProjects,
  listRevisions,
  loadAiJobDetail,
  loadRevisionSegmentation,
  loadRevisionSkin,
  partPreviewUrl,
  previewRevisionPart,
  retryAiJob,
  revertRevision,
  startAiAnalysis,
  type ApiAiJobDetail,
  type ApiAiJobStatus,
  type ApiAiAnalysisOptions,
  type ApiBranch,
  type ApiProject,
  type ApiPart,
  type ApiPartPreview,
  type ApiRevision,
  type ApiSegmentation,
} from "./lib/revisionApi";

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
  const [selectedPartId, setSelectedPartId] = useState<string | null>(null);
  const [partPreview, setPartPreview] = useState<ApiPartPreview | null>(null);
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
  const handledAiJobsRef = useRef(new Set<string>());

  const releaseObjectUrl = useCallback(() => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
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
    [refreshHistory],
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
              defaultModel: "codex-config-default",
              defaultReasoningEffort: "medium" as const,
            }
          : catalog;
        setAiProviders(normalized.providers);
        setAiModel(normalized.defaultModel);
        setAiReasoningEffort(normalized.defaultReasoningEffort);
        setAiProvider((current) =>
          normalized.providers.includes(current)
            ? current
            : (normalized.providers[0] ?? ""),
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
    void listAiJobs(selectedRevisionId)
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
    let cancelled = false;

    void (async () => {
      await activateFixture(DEFAULT_FIXTURE);
      try {
        const [projects, parts] = await Promise.all([listProjects(), listParts()]);
        if (cancelled) {
          return;
        }
        setHistoryProjects(projects);
        setPartLibrary(parts);
        setSelectedPartId((current) => current ?? parts[0]?.id ?? null);
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
          setHistoryError(
            `Revision API 未连接：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    })();

    return () => {
      cancelled = true;
      requestIdRef.current += 1;
      releaseObjectUrl();
    };
  }, [activateFixture, refreshHistory, releaseObjectUrl]);

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
      const parts = await listParts();
      setPartLibrary(parts);
      setSelectedPartId(part.id);
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
          <p className="eyebrow">AI-ASSISTED SEMANTIC STUDIO / M5</p>
          <h1>
            MC<span>Skin</span>Split
          </h1>
          <p className="lede">
            Codex 读取隔离分析包并提出语义分类；Schema 与像素校验通过后才创建不可变 Revision，低置信度区域保留给人工修正。
          </p>
        </div>
        <div className="baseline-stamp" aria-label="M5 AI 辅助语义工作室">
          <strong>M5</strong>
          <span>AI REVIEW</span>
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

          <article className="ai-job-card" aria-live="polite">
            {aiJob ? (
              <>
                <div className="ai-job-status">
                  <span>{aiStatusLabels[aiJob.status]}</span>
                  <strong>{String(aiJobDetail?.runs.length ?? 0).padStart(2, "0")} RUNS</strong>
                </div>
                <div className="ai-progress" aria-label={aiStatusLabels[aiJob.status]}>
                  <i style={{ width: `${aiProgressPercent(aiJob.status)}%` }} />
                </div>
                <div className="ai-job-meta">
                  <code>{shortIdentifier(aiJob.id)}</code>
                  <span>{aiJob.provider} / {aiJob.model}</span>
                  <span>reasoning / {aiJob.options.reasoningEffort}</span>
                  <span>{aiJob.skillName} {aiJob.skillVersion}</span>
                </div>

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

                <ol className="ai-event-log">
                  {aiJobDetail?.events.slice(-6).toReversed().map((event) => (
                    <li key={event.id}>
                      <time dateTime={event.createdAt}>{formatRevisionTime(event.createdAt)}</time>
                      <span>{event.message}</span>
                    </li>
                  ))}
                </ol>
              </>
            ) : (
              <div className="ai-empty-state">
                <strong>NO ANALYSIS JOB</strong>
                <p>选择 Branch HEAD 后启动识别。生成的组件会直接进入下方人工语义编辑器。</p>
              </div>
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

      <footer className="status-bar" role="status" aria-live="polite">
        <span>STATUS</span>
        <p>{notice}</p>
        <code>immutable edits · 64×64 parts · {layout.id}</code>
      </footer>
    </main>
  );
}

function projectNameFromFile(fileName: string): string {
  const withoutExtension = fileName.replace(/\.png$/i, "").trim();
  return (withoutExtension || "Minecraft Skin").slice(0, 120);
}

function aiProgressPercent(status: ApiAiJobStatus): number {
  switch (status) {
    case "queued":
      return 8;
    case "preparing":
      return 24;
    case "running":
      return 58;
    case "validating":
      return 82;
    case "succeeded":
      return 100;
    case "failed":
    case "cancelled":
      return 100;
  }
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
