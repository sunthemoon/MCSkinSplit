# 偶发问题记录

| 编号 | 状态 | 发现需求 | 标题 | 是否阻塞 | 证据 | 记录 |
|---|---|---|---|---|---|---|
| INC-001 | 已复现/待确认是否处理 | M1 固定像素核心 | 3D 预览尺寸监听触发 ResizeObserver loop 报告 | 否 | Vite 客户端日志 | 本文 INC-001 |

# INC-001 3D 预览尺寸监听触发 ResizeObserver loop 报告

## 1. 基本信息

| 项 | 内容 |
|---|---|
| 状态 | 已复现/待确认是否处理 |
| 发现日期 | 2026-08-11 |
| 发现时所在需求 | `docs/mc-skin-ai-assisted-segmentation-versioned-studio-plan.md` 的 M1 |
| 是否阻塞当前需求 | 否；Canvas、Wide/Slim、Contact Sheet 和 3D ready 验收均可完成 |
| 发现方式 | 本地页面验证 |
| 影响模块 | `apps/web/src/components/SkinPreview.tsx` 的尺寸监听候选范围 |

## 2. 范围判定

- 当前需求范围：固定 PNG RGBA、UV 双向映射、派生像素输出和 Canvas 预览。
- 该问题在 M0 已存在的 `SkinPreview` 尺寸监听中出现，不属于 M1 像素核心的验收点。
- 当前处理决定：只记录，不在 M1 中修改；页面功能与像素结果未受阻。

## 3. 复现入口与步骤

- 环境：Windows、本地 Vite 8 开发服务、应用内浏览器，2026-08-11。
- 页面：`http://127.0.0.1:5173/`。
- 测试数据：内置 `slim-basic.png`。

步骤：

1. 启动 `pnpm dev` 并打开 Studio。
2. 选择 Slim fixture。
3. 将模型规则手动覆盖为 Wide。
4. 切换到 FACES Contact Sheet 并执行页面截图。
5. 读取 Vite 开发服务输出。

## 4. 实际结果与预期结果

### 实际结果

页面仍正常、3D 状态为 ready，但 Vite 客户端向开发服务上报：

```text
[vite] (client) [Unhandled error] Error: ResizeObserver loop completed with undelivered notifications.
> ../../../../../@vite/client:535:50
```

同一操作序列在重新启动服务后再次出现。浏览器截图调用在第二次复现中超时，因此没有把截图作为错误证据；错误本身没有可见页面状态，服务日志是直接证据。

### 预期结果

响应式调整应更新 WebGL Canvas 的实际宽高，同时不产生全局 `ResizeObserver` 错误报告。

### 证据

| 证据 | 路径/摘要 |
|---|---|
| 日志 | 两次本地 Vite 服务均输出相同 `ResizeObserver loop completed with undelivered notifications` |
| 页面状态 | Slim → Wide 覆盖和 Contact Sheet 正常，3D 显示 ready |
| 截图 | 第二次截图调用超时；错误没有可见页面画面可供截图 |

## 5. 初步影响范围

- 页面：Studio 3D 预览区域。
- 候选代码：`SkinPreview` 中同步执行的 `ResizeObserver` 回调。
- 数据、API、数据库：无。
- 当前已见影响：开发环境错误日志；尚未观察到页面失效或数据错误。

## 6. 后续处理建议

- 建议优先级：P3。
- 建议处理方式：单独确认后，复测以 `requestAnimationFrame` 合并尺寸更新或使用 `ResizeObserverEntry` 尺寸，避免在观察回调内形成同步布局反馈。
- 修复前必须补充的证据：生产构建环境是否同样上报、连续窗口缩放时的触发频率、修复前后观察器调用计数。
