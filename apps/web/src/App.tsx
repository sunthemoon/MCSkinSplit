import {
  type ChangeEvent,
  type DragEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { SkinPreview, type PreviewState } from "./components/SkinPreview";
import { validateMinecraftSkinFile } from "./lib/pngHeader";

const DEFAULT_SKIN_URL = "/skins/wide-basic.png";

interface ActiveSkin {
  name: string;
  source: "fixture" | "upload";
  url: string;
}

const previewLabels: Record<PreviewState, string> = {
  loading: "正在载入纹理",
  ready: "3D 预览已就绪",
  error: "3D 预览载入失败",
};

export function App() {
  const [activeSkin, setActiveSkin] = useState<ActiveSkin>({
    name: "wide-basic.png",
    source: "fixture",
    url: DEFAULT_SKIN_URL,
  });
  const [previewState, setPreviewState] = useState<PreviewState>("loading");
  const [notice, setNotice] = useState("可上传一张标准 64×64 Minecraft PNG 皮肤");
  const [isDragging, setIsDragging] = useState(false);
  const objectUrlRef = useRef<string | null>(null);

  useEffect(
    () => () => {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
      }
    },
    [],
  );

  const selectFile = useCallback(async (file: File) => {
    try {
      await validateMinecraftSkinFile(file);
      const nextUrl = URL.createObjectURL(file);

      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
      }

      objectUrlRef.current = nextUrl;
      setActiveSkin({ name: file.name, source: "upload", url: nextUrl });
      setNotice("PNG 签名与 64×64 IHDR 校验通过");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }, []);

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

  const resetFixture = () => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }

    setActiveSkin({
      name: "wide-basic.png",
      source: "fixture",
      url: DEFAULT_SKIN_URL,
    });
    setNotice("已恢复确定性 wide 基线皮肤");
  };

  return (
    <main className="studio-shell">
      <header className="studio-header">
        <div>
          <p className="eyebrow">LOSSLESS UV WORKBENCH / M0</p>
          <h1>
            MC<span>Skin</span>Split
          </h1>
          <p className="lede">
            固定坐标、不可变历史与 AI 辅助语义拆分的 Minecraft 皮肤工作台。
          </p>
        </div>
        <div className="baseline-stamp" aria-label="M0 基线已建立">
          <strong>M0</strong>
          <span>BASELINE</span>
        </div>
      </header>

      <section className="workbench" aria-label="皮肤预览工作台">
        <aside className="control-panel panel">
          <div className="panel-heading">
            <span>01</span>
            <div>
              <p>INPUT</p>
              <h2>载入皮肤</h2>
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
            <strong>选择或拖入 PNG</strong>
            <small>仅接收 64×64 · 最大 1 MiB</small>
          </label>

          <dl className="file-facts">
            <div>
              <dt>纹理</dt>
              <dd title={activeSkin.name}>{activeSkin.name}</dd>
            </div>
            <div>
              <dt>来源</dt>
              <dd>{activeSkin.source === "fixture" ? "内置 fixture" : "本地上传"}</dd>
            </div>
            <div>
              <dt>模型</dt>
              <dd>Classic / Slim 自动预览</dd>
            </div>
          </dl>

          <button className="quiet-button" type="button" onClick={resetFixture}>
            恢复基线皮肤
          </button>
        </aside>

        <section className="atlas-panel panel">
          <div className="panel-heading">
            <span>02</span>
            <div>
              <p>ATLAS</p>
              <h2>原始 UV 像素</h2>
            </div>
          </div>
          <div className="atlas-stage">
            <div className="atlas-grid" aria-hidden="true" />
            <img src={activeSkin.url} alt={`${activeSkin.name} 的 64×64 UV Atlas`} />
          </div>
          <p className="panel-note">
            M0 保持原图，不执行缩放写入；M1 将接入确定性 RGBA 与 UV 往返核心。
          </p>
        </section>

        <section className="avatar-panel panel" data-state={previewState}>
          <div className="panel-heading">
            <span>03</span>
            <div>
              <p>AVATAR</p>
              <h2>三维预览</h2>
            </div>
          </div>
          <SkinPreview skinUrl={activeSkin.url} onStateChange={handlePreviewState} />
          <div className="viewer-status">
            <i aria-hidden="true" />
            {previewLabels[previewState]}
          </div>
        </section>
      </section>

      <footer className="status-bar" role="status" aria-live="polite">
        <span>STATUS</span>
        <p>{notice}</p>
        <code>skinview3d@3.4.2 · animation API</code>
      </footer>
    </main>
  );
}
