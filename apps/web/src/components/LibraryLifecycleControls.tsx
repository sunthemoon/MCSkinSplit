import { useEffect, useState } from "react";
import type { ApiLibraryStatus } from "../lib/revisionApi";

interface LibraryLifecycleControlsProps {
  readonly assetId: string;
  readonly name: string;
  readonly status: ApiLibraryStatus;
  readonly busy: boolean;
  readonly retiredReason?: string | null;
  readonly onRetire: (reason?: string) => void | Promise<void>;
  readonly onRestore: () => void | Promise<void>;
}

export function LibraryLifecycleControls({
  assetId,
  name,
  status,
  busy,
  retiredReason,
  onRetire,
  onRestore,
}: LibraryLifecycleControlsProps) {
  const [armed, setArmed] = useState(false);
  const [reason, setReason] = useState("");

  useEffect(() => {
    setArmed(false);
    setReason("");
  }, [assetId, status]);

  if (status === "retired") {
    return (
      <div className="library-lifecycle" data-status="retired">
        <p>已退役{retiredReason ? ` · ${retiredReason}` : ""}</p>
        <button type="button" disabled={busy} onClick={() => void onRestore()}>
          恢复使用
        </button>
      </div>
    );
  }

  if (!armed) {
    return (
      <div className="library-lifecycle" data-status="active">
        <button type="button" disabled={busy} onClick={() => setArmed(true)}>
          退役此项…
        </button>
      </div>
    );
  }

  return (
    <div className="library-lifecycle library-retire-confirm" data-status="confirm">
      <p>退役后默认列表会隐藏“{name}”，历史 Revision 和引用仍保留。</p>
      <label>
        <span>退役原因（可选）</span>
        <input
          value={reason}
          maxLength={240}
          placeholder="例如：眼睛误识别为头发"
          onChange={(event) => setReason(event.target.value)}
        />
      </label>
      <div>
        <button type="button" disabled={busy} onClick={() => void onRetire(reason)}>
          确认退役
        </button>
        <button type="button" disabled={busy} onClick={() => setArmed(false)}>
          取消
        </button>
      </div>
    </div>
  );
}
