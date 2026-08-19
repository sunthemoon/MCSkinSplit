# MCSkinSplit 当前实现证据审核

更新时间：2026-08-19

本审核用于核对外部《MCSkinSplit 初版审核与语义拆分修复实施方案》及其 Web Pro 摘要与当前仓库实现是否一致。外部材料明确说明编写时未成功读取仓库，因此其中的技术结论只能视为待验证假设，不能直接作为重构依据。

## 1. 基线

| 项目 | 审核结果 |
|---|---|
| 分支 | `main` |
| 审核基线 HEAD | `08b86149601d573517c7f43c1ad8cd735e54e01d` (`feat(ai): add player-first classification repair`) |
| 工作区 | 审核开始时无未提交修改；审核结论随后由 M16 实现 |
| 技术栈 | pnpm workspace；React/Vite Web、Fastify API、SQLite RevisionStore、TypeScript core/provider/worker packages |
| 开发命令 | `pnpm dev`，或分别运行 `pnpm dev:api` / `pnpm dev:web` |
| 总验证命令 | `pnpm verify`，依次执行 fixture 校验、typecheck、test、build |
| 本次验证 | M16 后 `pnpm verify` 通过；8 个包共 320 项测试通过；另完成 1 次真实模型/浏览器回归 |
| 已知非阻断提示 | Web 构建存在两个大于 500 kB 的 chunk 警告 |

测试分布：skin-core 71、skin-compositor 8、skin-analysis-pack 17、ai-provider 32、skin-revision 43、ai-worker 28、API 13、Web 108。

## 2. 总结判定

### 2.1 已被当前实现淘汰的判断

以下外部判断不再成立，不应据此重做领域模型或迁移历史数据：

- BodyPart、Surface 和 SemanticComponent 已经分离；正式识别结果不是身体部位或 UV 面。
- SemanticComponent 已能表达任意非透明、已使用 UV 像素的子集，也能跨 BodyPart、Layer、Face。
- 同一个 Surface 已能包含多个互不重叠的语义组件。
- CandidateRegion 不是固定的身体块或 Surface 单位，而是 Surface 内的四邻域颜色连通区域；均匀 Surface 仍可能只生成一个全 Surface Region。
- AI 已能引用 CandidateRegion，并用 `pixelOverrides.add/remove` 做可见像素边界修正。
- Unknown、人工复核、五类人工语义操作、不可变 Revision、分支、回退、部件写入 Mask、应用冲突检查均已存在。
- 可见语义拆分不会生成所选源 Revision 中不存在的像素；Composition restoration 和 Part repair 也已经与语义拆分分开。
- skinview3d Viewer 已按组件生命周期初始化、复用和释放；Blob URL 也有回收逻辑，其中 Part repair URL store 有直接单元测试，App 上传/Revision/下载 URL 仍缺直接回收测试。

### 2.2 部分成立的判断

- CandidateRegion 通常比 Surface 更细，但没有最大面积或强制边缘切分，同色区域仍可覆盖完整 Surface；也没有通用 UV 接缝、Base/Outer 投影、镜像或 3D 邻接图。
- 人工编辑已有像素选择、Unknown、合并、拆分、改分类和整组件移除，但缺少显隐、Solo、原图/结果/Diff、魔棒、框选、跨接缝选择、草稿 Undo/Redo 和关系编辑。
- 页面已有响应式工作流索引、玩家化 AI 主按钮和折叠技术详情，但默认仍是七个专家工作区纵向排列，不是面向普通玩家的四步主流程。
- Provenance 已记录 actor、AI Run 和 Composition restoration 证据，但 `containsGeneratedPixels` 仍是组件级布尔值，不能精确说明组件内每个像素的来源。
- Validator 仍会把新 AI 组件统一标成 non-generated；M16 已阻止已知
  generated/authored 来源提交新的 AI Revision，并保留不写 Revision 的只读分析。
- Part 已是完整 64×64 texture + write mask + manifest，而不是裁剪图；但没有 `generated-mask.png`，也不能在复用后完整传播逐像素 authored/generated 来源。
- Revision 由服务层、哈希和快照目录按 append-only 方式维护；M16 Migration
  013 已为核心 Revision/Asset/Part 历史增加数据库 no-update/no-delete trigger。

### 2.3 确实缺失的能力

- 没有独立的隐藏内容 Completion Proposal、候选状态、接受/拒绝记录或 `completion_accept` Revision。
- 没有服装、头发、饰品通用的逐像素 `source_visible` / `manual_authored` / `generated_completion` 来源模型。
- 没有独立 generated mask，无法安全导出、过滤或复用已生成像素。
- 当前可见 Segmentation 每个 texel 只能有一个 owner；同一 Layer/texel 上不能同时保存“可见遮挡物”和“被遮挡组件”。这类补全必须成为独立的完成版组件/Part 资产，不能强行写成同一 `skin.png` 的第二层语义事实。
- 没有结构化、持久化的 Style Inventory。当前只有确定性 palette、候选摘要、渲染视图和模型描述。
- 没有可重复执行的真实浏览器 E2E；Web 自动化目前主要是 Node 环境纯函数、SSR 和 fake-viewer 测试。

### 2.4 本次审核发现并由 M16 修复的契约问题

这些问题比大规模重构更适合先修，以下条目记录的是修复前状态：

1. AI Schema/Prompt 曾把 `unknown` 列为可用组件分类，但 Validator 明确拒绝 `unknown` 组件；Unknown 实际应由独立 Mask/未分配桶承载。
2. 手工 Skill 指南曾把模糊区域描述为同时进入 unassigned 和 review，而 Skill 主规则与 Validator 要求每个 CandidateRegion 只能进入一个所有权桶。
3. Prompt 曾要求 pixel override “small”，但 Schema/Validator 没有像素数或 span 数上限。
4. Region 所有权曾只在应用 overrides 前校验；`pixelOverrides.add` 可从被声明为 unassigned/review 的 Region 取走像素，使 Region 桶状态与最终像素所有权不一致。
5. Analysis pack 会生成 left/right 视图，但 Provider 当前只附加 atlas、contact sheet、front、back 和 front+right 的组合图；自然色视图与 CandidateRegion ID 之间也没有可视化映射，模型容易看懂外观却选错精确 Region ID。

### 2.5 M16 实施结果

审核确认的前四项合同问题已在 M16 修复：新提案 Schema `1.1` 不再允许
`unknown` 组件；Prompt/Skill/Validator 统一采用唯一 Region 桶；override
限制为提案级 64 个唯一像素与 32 个 spans，并要求 add 必须由原所属组件
remove。历史 Schema `1.0` 保持只读。

M16 同时增加两项先决保护：会创建 Revision 的语义 Worker 拒绝已知
generated 或包含 `apply_part`/`compose`/`palette_change` 的有效内容祖先；
显式只读分析仍可用于比较，旧 Skill/Prompt Job 则必须新建分析而不能静默重试；
Migration 013 用 18 个 trigger 固化 Revision、Operation、Asset 和 Part/Bundle
历史，保留创建期一次性绑定与明确的生命周期字段更新。
旧 Skill v1-v3 Job 只在精确历史合同下补齐当时未存储的读取默认值，
当前写入与未知合同仍保持严格校验。

第 5 项视觉 grounding 保留为 M17，逐像素来源与隐藏内容补全仍分别受
M18/M19 约束，未在本里程碑提前实现。

## 3. 证据矩阵

| 审核项 | 实际文件/符号 | 当前行为证据 | 结论 | 优化任务 |
|---|---|---|---|---|
| 皮肤上传入口 | `apps/web/src/App.tsx` `handleFileInput`、`apps/web/src/lib/revisionApi.ts`、`apps/api/src/app.ts` | 文件选择/拖入后先在浏览器解码，再创建 Project 与 Import Revision；API 再次从 PNG bytes 构建正式快照 | 已实现 | 玩家流程中保留一个明确入口；增加浏览器 E2E |
| PNG 解码与校验 | `packages/skin-core/src/png/codec.ts` `decodeSkinPng`；`apps/web/src/lib/skinFile.ts` | 校验 PNG 签名、完整解码、64×64、MIME 与 1 MiB 上限；64×32 明确拒绝 | 已实现 | 无领域重构；保留 fixture 回归 |
| UV 配置 | `packages/skin-core/src/layouts/layout.ts`、`layouts/schema.json`、`uv/surface-model.ts` | Slim/Wide 各 72 个非重叠 Surface；Atlas 与 canonical surface 可逆 | 已实现 | Candidate graph 复用 canonical 几何生成接缝边 |
| BodyPart/Surface 类型 | `packages/skin-core/src/types.ts` `BodyPart`、`SurfaceKey`、`SurfaceDefinition` | BodyPart/Layer/Face 只描述几何位置和方向 | 已分离 | 不做外部方案建议的领域重置 |
| CandidateRegion 生成 | `packages/skin-analysis-pack/src/candidate-regions.ts` `connectedRegions` | 每个 Surface 内按四邻域和 seed RGB 距离 ≤80 切分，保存 pixelIds/spans/bbox；没有面积上限，结果可能等于完整 Surface | 部分完成 | 新增独立证据图、边缘特征、ID overlay 与最大 Region 质量指标；不把 Region 持久化为语义资产 |
| SemanticComponent 类型 | `packages/skin-core/src/semantic/types.ts` `SemanticComponent` | 组件有 category、mask、spans、palette、relations、provenance，可跨多个 Surface | 已实现 | 补关系编辑与逐像素来源，不重建基础类型 |
| 组件像素遮罩 | `packages/skin-core/src/semantic/mask.ts`；`revision-store.ts` snapshot mask 文件 | 运行时权威 Mask 为 `Uint8Array(4096)`；JSON 用 canonical spans；快照保存 64×64 mask PNG | 已实现 | 可补集合运算 API，但无需另造不兼容 Mask 系统 |
| 风格前置分析 | candidate palette、analysis views、模型输出文字 | 没有独立 `StyleInventory` 类型、阶段或持久结果 | 缺失但非阻断 | 先在同一提案中试验轻量 appearance inventory，并用评测证明收益后再考虑额外模型调用 |
| AI Prompt/Skill | `.agents/skills/mc-skin-segmenter/SKILL.md`；`packages/ai-provider/src/codex-exec-provider.ts` `buildPrompt` | Tool-free/read-only，允许跨 Surface/BodyPart；M16 统一 Unknown、唯一所有权桶和有界 transfer | 已实现 | M17 再加入 graph/overlay 证据 |
| AI JSON Schema | `packages/ai-provider/src/analysis-proposal.schema.json` | Schema 1.1 严格组件/关系/region IDs/pixel overrides/unassigned/review 结构；Unknown 不属于组件枚举 | 已实现 | 保留 1.0 只读兼容；M17 随新证据另行升版 |
| Validator | `packages/ai-provider/src/validator.ts` `validateAnalysisProposal` | Validator v2 校验唯一 Region 桶、完整覆盖、有界 transfer、add/remove 来源和无重叠 | 已实现 | M17 增加跨 Surface evidence fixture 与质量指标 |
| Revision 写入 | `packages/skin-revision/src/revision-store.ts` `applyManualOperationUnlocked`、`commitAiSegmentationUnlocked`；`snapshot-storage.ts` | 新快照原子 rename、逐文件 SHA-256、SQLite 交叉校验；Migration 013 阻止核心历史 UPDATE/DELETE | 已实现 | 后续 Schema migration 必须事务重建 guards |
| 回退/分支 | `revision-store.ts` `revertRevisionUnlocked`、branch 创建逻辑 | Revert 复制历史状态但以当前 HEAD 为父创建新 Revision；Branch 从历史节点创建新分支首 Revision | 已实现 | 保持现契约，新增浏览器时间线 E2E |
| 遮挡补全 | M15 semantic follow-up；Composition restoration；Part repair | M15 只重新分类现有长发像素；Composition 只清旧 Outer/补 Base 肤色；Part repair 是用户创作式修补 | 通用能力缺失 | 在逐像素 provenance 后新增独立 Completion Proposal；不得复用现有三套模型冒充 |
| 生成像素来源 | `SemanticComponentProvenance`、restoration provenance、PartManifest 1.0/1.1 | 只有组件级 generated bool；Part 文件固定五项；repair derivation 固定 false | 不足 | 新增 PixelOriginDocument/generated mask，旧模糊历史保持只读兼容 |
| 人工编辑工具 | `SemanticEditorCanvas.tsx`、`App.tsx` 语义操作、`editor.ts` | 单像素/拖动选择、assign、unassign、merge、split、reclassify、整组件回 Unknown 均可用 | 核心已实现，效率工具缺失 | 明确新建组件模式；补显隐、Diff、魔棒、框选、接缝选择、Undo/Redo、关系编辑 |
| 部件导出与复用 | `packages/skin-core/src/semantic/parts.ts`、`part-storage.ts` | Part 保存 texture/write-mask/manifest/preview/source；单部件应用检查模型兼容及与 Base 的同/异色重叠，并由用户选择 `use_part`/`keep_base`；Composition 另行检查声明外 UV 与多层冲突 | 已实现 | Manifest 2.0 增 origin artifact、generated mask 与来源传播；旧 1.0/1.1 保持可读 |
| skinview3d 初始化 | `SkinPreview.tsx`、`mcSkinPreview.ts` | Mount 初始化一个 Viewer，换 Revision 只 loadSkin，unmount dispose；Blob URL 切换/卸载时 revoke | 已实现 | 补真实浏览器/WebGL/多 Viewer 回归；不重写 Viewer |
| 自动化测试 | workspace `*.test.ts`、fixtures、`pnpm verify` | 本次 320 项测试、typecheck、fixture check、build 全部通过；另有一次真实模型/浏览器 smoke | 单元/集成较强，可重复浏览器 E2E 与 completion GT 仍缺失 | 引入 Playwright/Vitest Browser；增加合成遮挡真值和视觉回归 |

## 4. 强制判定问题

1. **当前 component 是什么？** 语义物品实例；BodyPart 和 Surface 是几何坐标，CandidateRegion 是暂态分析单位，Part 是可复用导出资产。
2. **一个组件能否表达任意 64×64 像素遮罩？** 能表达任意非透明、已使用 UV 像素的子集。权威 Mask 是 4096 字节二值数组，spans/PNG 是可审计表示；当前语义验证拒绝拥有透明或未使用 UV 像素。
3. **一个组件能否跨多个 BodyPart？** 能。
4. **一个 Surface 能否包含多个组件？** 能，只要 Mask 不重叠。
5. **AI 的最小选择单位是什么？** 正常选择单位是 Surface 内颜色连通 CandidateRegion；由于组件可以只用 `pixelOverrides.add` 获得像素，当前最小可表达单位实际是一个源 Revision 可见像素。
6. **AI 能否返回少量像素 add/remove？** 能。Schema/Validator v2 将整个提案限制为 64 个唯一 override 像素和 32 个 spans，并要求 add 来自显式组件间转移。
7. **低置信度如何处理？** Region 可进入 unassigned 或 review；低置信度组件进入 `needs_review`。每个 Region 恰好进入一个所有权桶。
8. **可见拆分会生成源 Revision 不存在的像素吗？** 不会。候选和 overrides 都限制在所选源 Revision 的非透明有效 UV 像素；会创建 Revision 的重分析还会拒绝已知 generated/authored 内容祖先，避免把来源洗成 non-generated。
9. **补全像素是否有独立 generated mask？** 没有。现有 generated 信息最多是组件级布尔值。
10. **拒绝补全会改变正式拆分吗？** 当前没有通用 hidden-content completion。Composition plan 的清除/不应用不会修改源 Revision；未来 Completion 必须保持同样的候选先行边界。
11. **画笔、合并、拆分、改分类是否可用？** 可用；关系编辑、显隐、Diff、魔棒、框选、接缝选择与草稿 Undo/Redo 不可用。
12. **每个确认操作是否创建新 Revision？** 五种正式语义操作都会创建新 Revision；画布选择草稿本身不写 Revision。
13. **回退是否创建新 Revision？** 是，不移动或修改旧节点。
14. **部件应用是否检测像素冲突？** 是。单部件应用报告模型不兼容及与 Base 的同/异色重叠，再由用户整体选择 `use_part` 或 `keep_base`；Composition 还会检查 manifest 声明外 UV、多层同像素写入，并阻止未解决的 blocking conflict 提交。
15. **技术说明是否置于主流程之前？** AI Provider 和日志已折叠，但全局默认仍展示七个专家工作区及较多 Revision/Branch/Instance/Library/Composition 概念，因此只能判定为部分改善。

## 5. 不采用的外部实施步骤

1. **不执行“先分离 BodyPart/Surface 与 SemanticComponent”的大迁移。** 当前模型已经分离，强行迁移会增加历史兼容风险。
2. **不重写 Mask 基础。** 现有 binary mask + canonical spans + PNG snapshot 已精确且有测试；只在其上补集合运算或 origin 文档。
3. **不默认把一次识别拆成四次模型调用。** M13 通过单次 tool-free 调用解决了超时和工具循环问题。多轮会直接增加延迟、费用和失败面，必须先用离线评测证明收益。
4. **不把 Composition restoration 当成衣服/头发补全。** 它的语义固定为旧目标清理、Outer clear 和 Base skin fill。
5. **不把 Part repair 当成 AI 隐藏内容恢复。** 它是用户创作式、不可变的部件修补历史。
6. **不宣称补全恢复了作者原始隐藏图案。** 源 PNG 没有的像素只能是有证据的候选或推测。
7. **不把同一 Layer/texel 的隐藏像素强塞进可见 Segmentation。** 接受候选后优先形成完成版组件/Part；只有目标 texel 没有覆盖当前可见 owner 时，才可写入新的完整皮肤 Revision。

## 6. 修正后的实施顺序

### M16：先修现有契约与建立量化基线（已完成）

目标：消除无需架构重写即可确认的矛盾，并让后续优化可测。

- 从 AI component category Schema/Prompt 中移除 `unknown`；Unknown 只由 unassigned/review/unknown mask 表达。
- 修正 Skill 手工指南，要求每个 CandidateRegion 恰好进入 component、unassigned 或一个 review item。
- 在 Schema/Validator 中共同限制 pixel overrides，例如最多 64 个像素、32 个 spans，并把数字纳入版本合同。
- 要求 `pixelOverrides.add` 只能接收从某个 component-owned Region 显式 remove 的像素，并且每个 add 只有一个转移来源；允许 remove 后不再 add，使边界像素回到 Unknown。unassigned/review Region 不允许再通过 override 暗中进入组件。
- 以上变化使用新的 proposal Schema、Validator、Prompt 和 Skill 版本，历史 Run 继续按其记录版本读取；旧合同的 retry 必须使用原版本或明确要求新建分析 Job，禁止原地改变 `1.0` 提案含义。
- 在逐像素 origin 上线前，阻止已知 `containsGeneratedPixels`/authored 来源的
  Revision 通过 clean semantic reanalysis 提交新 Revision；显式只读分析仍可用。
  至少覆盖 Composition 手工填充和已知修补/生成部件的回归。
- 增加跨 Surface 组件、同 Surface 多组件、override 边界、低置信度、错误所有权和 provenance reanalysis 回归。
- Validator 报告持续记录 visible coverage、unknown/review，并新增 override 唯一
  像素数与 span 数。需要 Ground Truth 的组件边界误差和跨部位召回/误报转入
  M17/M21 评测，不用无真值数字冒充准确率。
- 回归使用测试代码生成的合成长发/露肩服装状态；本机
  `750fa4166940b473` 只作为非分发 smoke 样本，未确认许可前不提交源 PNG。
- 为核心 Revision/Asset/Operation 内容表增加“完成写入后不可更新/删除”的 migration 与直接 SQL 篡改测试；`skin_asset.revision_id` 目前需要在同一创建事务中由 `NULL` 绑定一次 Revision，trigger 必须保留这一受限 bootstrap 转换，Branch HEAD、目录状态等明确可变字段也保持可更新。后续快照 Schema migration 必须在同一事务内显式重建这些 trigger，不能用永久禁写规则阻断合法升级。

验收：Schema、Prompt、Skill、Validator 不再互相矛盾；新合同完成版本升级，
历史 Schema `1.0` 保持只读；known-generated Revision 不会通过重分析提交而洗掉来源；
直接 SQL 修改核心历史被数据库拒绝。最终 `pnpm verify` 证据同步记录在
[`implementation-status.md`](../implementation-status.md)。

### M17：Candidate Evidence Graph 与视觉 grounding

目标：提高跨 Surface 长发、裙摆、外套和饰品的精确 Region 归属，不改变语义组件模型。

- 保留现有 CandidateRegion 精确分区，新增独立、版本化 `CandidateEvidenceGraphDocument`。
- 生成确定性边：同 Surface 接触/距离、canonical UV seam、Base/Outer 同 texel 投影、左右镜像；只有存在可验证坐标映射时才加入 3D 邻接。
- 为节点增加边缘、细长度、面积、颜色族等宿主计算特征，避免让模型从 bbox 自行猜测。
- 生成自然色视图与 CandidateRegion 伪彩/编号视图的同机位对照；将 left/right 或组合 contact sheet 真正附加给 Provider。
- Prompt 引用 Region ID 和宿主生成的图边；保留有预算、由 Host 校验的 span overrides 作为边界修正，但不允许模型发明图边或引用候选可见集合以外的像素。
- 先在同一次 JSON 提案中试验轻量 `appearanceInventory`；只有 A/B 评测证明准确率收益大于延迟/失败成本时，才拆成额外模型 pass。

验收：Region 仍精确覆盖全部源可见 UV 且无重叠；无 Atlas 折行伪邻接；Slim/Wide seam/mirror 测试通过；合成长发案例能把 torso 发束与露肩衣服分开；普通整面同色衣服不误判为长发。

### M18：逐像素来源与 Part 2.0 基础

目标：在生成任何隐藏内容前，先能准确回答完整皮肤与可复用组件资产中的每个当前像素来自哪里。

- 新增版本化 `PixelOriginDocument`，以 canonical spans 记录新 Revision 的固有来源 `source_visible`、`manual_authored`、`generated_completion` 及 source Revision/candidate/actor 证据。
- 新 Revision 强制 origin entries 无重叠，并覆盖所有当前非透明、有效 UV 像素；component provenance 只保留摘要。
- 旧快照不反向猜测精确来源。首次从任意旧快照派生新 Revision 时，能由不可变导入/操作证据证明的像素写入对应精确来源，所有无法证明来源的像素写入可继续传播的 `legacy_mixed` 兼容状态；若转换不能覆盖全部当前非透明有效 UV 像素，则拒绝派生，而不是把它们默认为 source-visible。
- Origin 文档的 canonical 内容必须进入 `resultHash`，同时纳入逐文件 checksum、storage verifier、Revision diff 和 API DTO。
- 复制不是新的固有来源类别；`origin.json` 另存 `derivation: copied` 及 copied-from Revision/component/pixel 血缘，同时保留被复制像素原本的 source/manual/generated 来源。
- Part 2.0 同时保存完整逐像素 `origin.json` 和由其派生的 `generated-mask.png`；实现必须扩展 `PART_FILE_NAMES`、`part_file_asset.file_role`、数据库引用、storage read/write/verify 和 checksum 合同，而不是只升级 manifest 元数据。只保存 generated mask 或摘要不足以完成来源往返，且 generated mask 必须是 write mask 子集。
- Part 导出、应用、Bundle、Composition 和 repair 全程传播来源与复制血缘；旧 Manifest 1.0/1.1 保持可读。

验收：来源在 Revision→Part→新 Revision 往返后不丢失；仅源像素导出与含已接受生成像素导出结果可预测；篡改 origin/generated mask 会被存储校验拒绝。

### M19：独立隐藏内容 Completion Proposal 核心

目标：为被长发/饰品遮挡的衣服以及被饰品遮挡的头发提供可审计候选，而不是自动改正式结果。

- 新建独立 proposal/candidate/decision 存储与 job kind，不复用 semantic follow-up、Composition restoration 或 PartEdit 表。
- Proposal 绑定源 Revision/hash、目标组件、遮挡组件、允许生成范围、证据 hash，以及 `skin_texel` 或 `latent_component` 目标表示。跨 Base/Outer 且没有覆盖可见 owner 的 texel 才能选择 `skin_texel`；同 Layer 遮挡必须使用独立 `latent_component` texture/mask。
- 先生成确定性候选：真实 Base/Outer underlay、镜像、同 Surface 连续、对面/邻域参考、图案延续；无法支持时允许不生成。
- AI 只对 host 生成的候选排序/解释；若未来允许模型生成像素，输出也必须先转成受限候选并做尺寸、UV、Mask、颜色和 stale 校验。
- Reject 只写审计决定，源 Revision hash 不变。Accept 总是创建不可变 Completion Result；只有不覆盖当前可见 owner 的 `skin_texel` 候选才创建 `completion_accept` 皮肤 Revision，同 Layer 隐藏候选则创建完成版组件/Part 变体并保持源 `skin.png` 不变。手工改候选记录为 `manual_authored`。

验收：任何生成像素都在 generated mask 内；低置信度候选不能自动接受；Reject 不创建皮肤 Revision；latent accept 不改变源 skin hash，skin-texel accept 不覆盖现有 owner；重复决定幂等且 stale hash/version 被拒绝。

### M20：玩家优先工作区与高效人工校正

目标：在 Completion 核心合同稳定后，让普通玩家默认只看到“导入 → 智能识别 → 检查修正 → 保存/导出”。编辑效率工具可以与 M18/M19 并行开发，但最终信息架构在本阶段定版，避免 Completion 接入时重复改造。

- 将 History、Catalog、Part Repair、Composition 保留为“高级工作室/资产管理”，不删除现有能力。
- 检查页改成组件优先三栏：左侧组件树，中间 2D/3D，右侧分类与操作。
- 增加组件显隐/Solo、明确“新建组件”、框选、同色连通魔棒和 Surface-aware 选择。普通玩家输入显示名称/分类后，由 Host 生成 collision-safe Instance ID；原始 ID 仅在高级界面可见。对比模式分为 texture RGBA diff 与 semantic ownership/category-mask diff；纯分类 Revision 的 texture diff 应明确显示为无变化，而不是误导为未修正。
- 增加本地草稿 Undo/Redo；已提交历史继续使用 Revision/Revert。
- 镜像、跨接缝扩选都先预览再确认。
- 扩展 `ManualSemanticOperation` 支持关系编辑，并保持一次确认一个 Revision。
- 识别进度可在分类修复后增加“检查可安全补全区域”，Catalog 以“原识别 / 分类修复版 / 已接受补全版”展示；M21 评测通过前，Completion 入口只在高级实验功能或 feature flag 下可见，不进入默认玩家路径，也不自动发布 Part/Bundle。
- 提供源图、候选、结果的 2D/3D 对比，以及明显的 source/authored/generated 覆盖样式。
- 第四步提供独立的简化结果页，明确绑定用户选择的原识别、分类修复 Revision，或已接受的完成版组件/Part 变体。提供下载可表示的 PNG、保存所选组件为 Part、保存完整大类为 Bundle 三类动作；latent completion 只能导出为组件/Bundle，并明确不会伪装成同时包含遮挡物与隐藏像素的单层皮肤 PNG。完整 Catalog 管理仍留在高级工作室。
- 引入 Playwright 或 Vitest Browser。CI 使用隔离的 `MC_SKIN_DATA_DIR` 和确定性 replay/fake AI provider，覆盖上传、识别、逐像素修正、Unknown、合并/拆分、Completion accept/reject、Revision 切换、Hash 导航和 1600/1200/700/390px 布局；通过 URL API instrumentation 或 browser-component test 检查 Blob revoke，并分别实现可聚焦的键盘替代操作和触摸手势用例。真实 Provider/WebGL 作为单独 smoke，不作为确定性 CI 前置条件。

验收：玩家主路径无需理解 Branch、Instance ID、Provider 或 Composition；高级功能仍可达；Catalog/Part 清楚标识推测内容；键盘/触摸可完成核心操作；浏览器 E2E 可在 CI 重复运行。

### M21：Completion 评测与发布门

- 用“完整服装/头发真值 → 确定性遮挡 → 只向算法提供遮挡后皮肤”的方式建立合成 Ground Truth。
- 分别评测 conservative、mirror、pattern 和 AI-ranked candidates 的 precision/recall、generated-mask 越界率、颜色误差和用户接受率。
- Wide/Slim、Base/Outer、透明像素、跨接缝、对称/非对称、整面遮挡与无可靠证据都要有负例。
- 只有离线评测和真实浏览器 E2E 达标后，才解除 feature flag 并在默认玩家流程展示 Completion；否则保留高级实验功能。

## 7. 优先级结论

最先实施的不是外部方案原定的“领域模型重做”，而是：

1. M16 契约一致性与持久层防护；
2. M17 Region 证据图和视觉 grounding；
3. M18 逐像素 provenance 与 Part 2.0；
4. M19 独立 Completion 核心；
5. M20 玩家流程、编辑效率与 Completion UI；
6. M21 Completion 评测和发布门。

这条顺序复用现有稳定能力，并保证隐藏像素补全建立在可验证来源、独立候选和显式用户确认之上。
