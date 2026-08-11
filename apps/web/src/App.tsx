import {
  encodeSkinPng,
  getSkinLayout,
  type ArmType,
  type ArmTypeAssessment,
  type RgbaImage,
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
import {
  decodeMinecraftSkinBytes,
  decodeMinecraftSkinFile,
} from "./lib/skinFile";
import {
  branchRevision,
  createProject,
  getProject,
  importProjectSkin,
  listBranches,
  listProjects,
  listRevisions,
  loadRevisionSegmentation,
  loadRevisionSkin,
  revertRevision,
  type ApiBranch,
  type ApiProject,
  type ApiRevision,
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
  const objectUrlRef = useRef<string | null>(null);
  const requestIdRef = useRef(0);

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

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      await activateFixture(DEFAULT_FIXTURE);
      try {
        const projects = await listProjects();
        if (cancelled) {
          return;
        }
        setHistoryProjects(projects);
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
  const visibleRevisions = historyRevisions
    .filter(
      (revision) => branchFilter === "all" || revision.branchId === branchFilter,
    )
    .toReversed();

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
          <p className="eyebrow">IMMUTABLE SKIN STUDIO / M2</p>
          <h1>
            MC<span>Skin</span>Split
          </h1>
          <p className="lede">
            将 64×64 像素确定性映射为 72 个身体表面；每次确认都写入可校验、可分支的完整快照。
          </p>
        </div>
        <div className="baseline-stamp" aria-label="M2 不可变版本历史">
          <strong>M2</strong>
          <span>HISTORY</span>
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

      <footer className="status-bar" role="status" aria-live="polite">
        <span>STATUS</span>
        <p>{notice}</p>
        <code>SQLite · SHA-256 · fixed UV · {layout.id}</code>
      </footer>
    </main>
  );
}

function projectNameFromFile(fileName: string): string {
  const withoutExtension = fileName.replace(/\.png$/i, "").trim();
  return (withoutExtension || "Minecraft Skin").slice(0, 120);
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
