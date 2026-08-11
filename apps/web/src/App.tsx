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
  readonly source: "fixture" | "upload";
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

  useEffect(() => {
    void activateFixture(DEFAULT_FIXTURE);

    return () => {
      requestIdRef.current += 1;
      releaseObjectUrl();
    };
  }, [activateFixture, releaseObjectUrl]);

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

  const resolvedArmType =
    modelChoice === "auto"
      ? (activeSkin?.assessment.armType ?? "slim")
      : modelChoice;
  const layout = useMemo(() => getSkinLayout(resolvedArmType), [resolvedArmType]);
  const skinUrl = activeSkin?.url ?? DEFAULT_FIXTURE.url;
  const skinName = activeSkin?.name ?? DEFAULT_FIXTURE.name;

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
          <p className="eyebrow">LOSSLESS UV WORKBENCH / M1</p>
          <h1>
            MC<span>Skin</span>Split
          </h1>
          <p className="lede">
            将 64×64 像素确定性映射为 72 个身体表面，并保持每个 RGBA 字节可逆。
          </p>
        </div>
        <div className="baseline-stamp" aria-label="M1 固定像素核心">
          <strong>M1</strong>
          <span>PIXEL CORE</span>
        </div>
      </header>

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
            <small>完整 RGBA 解码 · 64×64 · 最大 1 MiB</small>
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
        <code>pngjs@7 · fixed UV · {layout.id}</code>
      </footer>
    </main>
  );
}
