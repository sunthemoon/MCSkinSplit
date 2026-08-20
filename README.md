# MCSkinSplit

> 把一张难以复用的 Minecraft 皮肤，变成看得懂、改得准、可回退的头发、服装与饰品组件。

[中文说明](#中文说明) · [English](#english)

## 中文说明

### 把喜欢的造型从整张皮肤里拆出来

MCSkinSplit 是一套面向 Minecraft 皮肤创作者、像素美术和资源整理者的本地语义拆分与复用工作台。它不会把皮肤粗略切成头、身体和四肢图片，而是把跨 UV 面、跨身体部位和跨 Base/Outer 图层的像素组织成“长发”“上衣”“手套”“鞋子”“头饰”等真正可以再次使用的组件。

普通玩家只需完成四步：**导入皮肤 → 智能识别 → 检查修正 → 保存导出**。历史版本、组件修补、多皮肤混搭和资产管理仍可从高级工作室进入。完整产品定位、第一版边界与待验证问题见 [PRODUCT.md](PRODUCT.md)。

> **当前状态：** 可见组件拆分、人工修正、版本历史、逐像素来源、Part、Bundle、修补和混搭已经可用；隐藏内容候选仍是默认关闭的实验能力，尚未通过完整发布门。

- **适合：** 想从现成皮肤中单独保存、修改或复用长发、衣服和饰品的创作者。
- **解决：** 同一物品跨多个 UV 面和内外层，靠肉眼逐像素复制容易漏选、错层或改坏原图。
- **得到：** 可检查的语义组件、不会覆盖旧结果的版本，以及可继续修补或组合的 Part 和 Bundle。

![MCSkinSplit 玩家四步工作台、皮肤 Atlas 与 3D 预览](docs/assets/readme/studio-overview.jpg)

### 当前可以做什么

- **从皮肤得到语义组件：** 无损读取 64×64 RGBA PNG，区分 Slim/Alex 与 Wide/Classic，并用精确像素范围表示头发、服装、肤色、五官和饰品。
- **在 2D/3D 中检查修正：** Atlas 与角色预览联动，支持显隐、Solo、画笔、矩形、同色选择、整面选择、Unknown、合并、拆分、重分类、关系编辑和草稿撤销/重做。
- **保留每一次确认：** 导入、识别、人工修正、部件应用、修补和混搭都会创建新 Revision；旧结果不被覆盖，逐像素来源区分源图、人工创作和已接受的生成内容。
- **保存并再次使用：** 单个组件可保存为带纹理、遮罩、来源和预览的 Part；完整头发、服装或饰品大类可保存为 Bundle，应用和组合前会先显示冲突。
- **按需启用 AI：** AI 只帮助完成初始分类或排列本地程序生成的候选；像素边界、身份、Hash、来源和最终写入仍由本地确定性程序（Host）校验并等待用户确认。

### 怎么使用

![MCSkinSplit 用户流程：导入、智能识别、检查修正、保存导出](docs/assets/readme/user-workflow.svg)

图表由 Kroki 从可维护的 [Mermaid 源码](docs/assets/readme/user-workflow.mmd)生成。

1. 导入一张 64×64 PNG，并确认 Slim 或 Wide 手臂布局。
2. 启动可选智能识别，或直接使用人工拆分工具。
3. 选择组件，在 2D/3D 中检查像素归属；草稿只有在确认后才创建新版本。
4. 选择明确的结果，下载完整皮肤 PNG，或保存单个 Part、完整分类 Bundle。

### 真实界面

| 组件检查与逐像素修正 | 拆分后的可复用组件 |
| --- | --- |
| ![三栏语义组件编辑器](docs/assets/readme/semantic-components.jpg) | ![独立组件资产的 3D 展示](docs/assets/readme/reusable-part.jpg) |

左侧界面展示组件树、像素选择和分类确认；右侧展示从皮肤中导出的独立 Part，以及它在对应 Slim/Wide 模型上的真实外观。图片来自本仓库运行中的实际界面，不是概念稿。

### 怎么运作

![MCSkinSplit 系统流程：确定性 Host、可选 AI、严格校验、用户确认和不可变版本](docs/assets/readme/system-workflow.svg)

图表由 Kroki 从可维护的 [Mermaid 源码](docs/assets/readme/system-workflow.mmd)生成。

关键原则是：**模型没有直接写入皮肤或版本历史的权限**。本地 Host 负责 PNG 解码、UV 映射、候选区域、像素边界和来源证据；可选 AI 只能返回受 Schema 约束的分类或候选排序。结果通过严格校验并由用户确认后，系统才会创建带 Branch、快照 Hash 和逐像素 Origin 的不可变 Revision。

### 快速开始

前置条件：

- Node.js 24
- pnpm 10.13.1
- 支持 WebGL 的浏览器
- 可选 AI 功能需要已经安装并完成认证的 Codex CLI

```bash
pnpm install
pnpm dev
```

打开 `http://127.0.0.1:5173`。该命令会同时启动 Fastify API（`127.0.0.1:3001`）和 Vite。运行时数据库、Revision 快照、部件和审计资料默认保存在 `data/`；启动 API 前设置 `MC_SKIN_DATA_DIR` 可以改用其他数据目录。

隐藏内容 Completion 是实验功能，默认不会进入玩家流程。只在明确测试时设置 `VITE_ENABLE_COMPLETION_WORKSPACE=true`；它生成的是需要人工审核的推测候选，不会宣称恢复了原作者没有画出的真实像素。

项目无需环境变量即可启动。常用可选配置：

| 变量 | 用途 | 默认行为 |
| --- | --- | --- |
| `MC_SKIN_DATA_DIR` | 指定 SQLite、Revision、Part、Bundle 和 AI 审计资料的持久化目录 | 仓库根目录下的 `data/` |
| `VITE_ENABLE_COMPLETION_WORKSPACE` | 显式开启隐藏内容候选实验区 | 未设置时关闭 |

AI Provider、模型与推理参数见 [AI 分析合同](docs/ai-analysis.md)；不使用 AI 时无需配置。

### 常用命令

| 命令 | 用途 |
| --- | --- |
| `pnpm dev` | 同时启动本地 API 与 Web 工作台 |
| `pnpm build` | 构建全部 workspace 包 |
| `pnpm verify` | 检查 fixture、类型、单元/集成测试与全部构建 |
| `pnpm browser:install` | 安装确定性浏览器测试所需的 Chromium |
| `pnpm verify:browser` | 使用隔离数据目录和 replay provider 运行浏览器回归 |

完整仓库验证：

```bash
pnpm verify
```

浏览器回归不依赖外部模型：

```bash
pnpm browser:install
pnpm verify:browser
```

### 当前边界

- AI 完全可选；PNG/UV、人工拆分、版本、预览、Part、Bundle、修补和混搭都可以在没有模型调用时工作。
- Completion 生成的是推测内容，始终需要显式接受；评测与发布门未全部通过前保持 feature flag 默认关闭。
- 同层隐藏内容可以形成未发布的 latent Part，但不能伪装成来源皮肤中的单层 PNG。
- 仓库没有承诺云部署、多人实时协作、在线素材市场或自动发布资产。

### 技术栈

| 技术 | 在项目中的作用 |
| --- | --- |
| TypeScript + pnpm workspace | 统一 Web、API、Worker 与领域包的类型和构建 |
| React + Vite | 浏览器中的玩家四步工作台与高级工作室 |
| Fastify | 本地 Project、Revision、Part、Bundle、AI Job 与 Completion API |
| SQLite + better-sqlite3 | 保存本地项目元数据、不可变历史和资产索引 |
| skinview3d | Slim/Wide Minecraft 角色与组件的 3D 预览 |
| Vitest + Playwright | 单元/集成测试与确定性 Chromium 工作流回归 |

### 运行与部署边界

当前仓库只验证了本地开发运行。`pnpm build` 会构建全部包，但仓库没有 Dockerfile、Compose、托管平台配置或完整的生产服务编排，因此不能把 `pnpm dev` 当作生产部署方案。

若后续部署为长期服务，至少需要持久化 `data/`（或 `MC_SKIN_DATA_DIR` 指定的目录）、为 API/Web 提供正式进程管理与反向代理，并单独评估 Codex CLI 认证和模型调用权限；这些步骤目前没有被仓库声明为已支持。

### 文档导航

- [产品说明与第一版范围](PRODUCT.md)
- [架构与数据流](docs/architecture.md)
- [UV 布局合同](docs/uv-layout.md)
- [版本历史与存储](docs/revision-history.md)
- [语义编辑与组件](docs/semantic-editing-and-parts.md)
- [AI 分析合同](docs/ai-analysis.md)
- [组件修补](docs/component-repair-workflow.md)
- [多组件混搭](docs/composition-workflow.md)
- [隐藏内容候选](docs/hidden-content-completion.md)
- [实现状态与验证证据](docs/implementation-status.md)

### 仓库结构

```text
apps/api/                     Fastify Project / Revision API
apps/ai-worker/               持久化 AI Job、Run 与审计资料
apps/web/                     Vite + React 浏览器工作台
packages/ai-provider/         可替换 Provider 合同与 Codex CLI 适配器
packages/skin-analysis-pack/  确定性分析工作区、证据与离线评测
packages/skin-compositor/     多组件混搭与冲突报告
packages/skin-core/           PNG、布局、UV、语义与渲染核心
packages/skin-revision/       SQLite 元数据与不可变快照服务
docs/                         产品、架构、工作流和验证文档
tests/e2e/                    确定性浏览器回归
```

## English

### From a full skin to reusable semantic components

MCSkinSplit is a local semantic splitting and reuse studio for Minecraft skin creators, pixel artists, and asset curators. It turns a hard-to-reuse 64×64 PNG into understandable, editable, versioned components such as hair, clothing, gloves, shoes, and accessories.

The ordinary-player workflow is deliberately short: **Import → Smart analysis → Check & correct → Save & export**. Revision history, component repair, multi-skin composition, and asset management remain available in the Advanced Studio. See [PRODUCT.md](PRODUCT.md) for the product direction, first-release scope, and open validation questions.

> **Status:** visible-component splitting, manual correction, immutable history, per-pixel origin, Parts, Bundles, repair, and composition are available. Hidden-content Completion remains a disabled-by-default experiment until its release evidence is complete.

- **Best for:** creators who want to extract, correct, or reuse a specific look from an existing skin.
- **Solves:** the error-prone work of finding one semantic item across UV faces, body regions, and Base/Outer layers.
- **Produces:** inspectable semantic components, reversible Revisions, and reusable Part or Bundle assets.

The screenshots in the [real interface section](#真实界面) come from the running application and show the player workspace, pixel-accurate semantic editor, and an exported reusable Part; they are not concept art.

### What it does

- Splits lossless 64×64 RGBA skins into exact semantic components while keeping Slim/Alex and Wide/Classic layouts explicit.
- Links the pixel Atlas, component ownership, and a 3D avatar for hide, Solo, selection, Unknown, merge, split, reclassification, relation editing, and local undo/redo.
- Stores every confirmed change as a new immutable Revision with per-pixel origin evidence instead of overwriting the source.
- Exports reusable Parts and complete-category Bundles, then shows compatibility and pixel conflicts before repair or composition.
- Uses AI only as an optional classifier or ranker; the local host remains authoritative for candidate identities, pixels, validation, hashes, persistence, and user confirmation.

### User workflow

![MCSkinSplit workflow: import, smart analysis, check and correct, save and export](docs/assets/readme/user-workflow.svg)

[Mermaid source](docs/assets/readme/user-workflow.mmd), rendered through Kroki.

### How it works

![MCSkinSplit system flow: deterministic host, optional AI, strict validation, user confirmation, immutable revision](docs/assets/readme/system-workflow.svg)

[Mermaid source](docs/assets/readme/system-workflow.mmd), rendered through Kroki.

The model never receives direct write authority. The deterministic host decodes the PNG, maps UV surfaces, builds candidate evidence, validates every returned identity and pixel boundary, and waits for explicit user confirmation before creating an immutable Revision.

### Quick start

Requirements: Node.js 24, pnpm 10.13.1, and a WebGL-capable browser. Optional AI workflows additionally require an installed and authenticated Codex CLI.

```bash
pnpm install
pnpm dev
```

Open `http://127.0.0.1:5173`; the Fastify API listens on `127.0.0.1:3001`. Runtime data is stored under `data/` by default. Set `MC_SKIN_DATA_DIR` before starting the API to use a different data directory.

No environment variable is required for the deterministic workflow. `VITE_ENABLE_COMPLETION_WORKSPACE=true` explicitly enables the experimental Completion UI; AI provider settings are documented in [AI analysis](docs/ai-analysis.md).

### Verification

```bash
pnpm verify

# Deterministic Chromium E2E with isolated data and a replay provider
pnpm browser:install
pnpm verify:browser
```

### Current boundaries

- AI is optional; deterministic editing, history, previews, Parts, Bundles, repair, and composition work without a model call.
- Hidden-content Completion is inference, not factual recovery. It stays behind `VITE_ENABLE_COMPLETION_WORKSPACE=true` until its release evidence is complete and always requires an explicit decision.
- A same-layer latent completion may become an unpublished Part, but it cannot be represented honestly as pixels from the original single-layer skin PNG.
- Cloud deployment, real-time collaboration, an online marketplace, and automatic asset publication are not claimed by this repository.

### Technology and deployment

The workspace uses TypeScript and pnpm, React with Vite for the Web studio, Fastify for the local API, SQLite through better-sqlite3 for versioned metadata, skinview3d for avatar previews, and Vitest plus Playwright for automated verification.

Only local development has been verified. `pnpm build` builds the workspace, but the repository does not include Docker, Compose, hosted-platform configuration, or complete production process orchestration. A future long-running deployment must persist `data/` (or `MC_SKIN_DATA_DIR`) and supply its own process management, reverse proxy, and optional Codex CLI authentication policy.

For detailed contracts and evidence, start with [architecture](docs/architecture.md), [AI analysis](docs/ai-analysis.md), [hidden-content completion](docs/hidden-content-completion.md), and [implementation status](docs/implementation-status.md).
