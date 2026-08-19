# INC-001 Worker 并发回归在全仓验证中超时

## 1. 基本信息

| 项 | 内容 |
| --- | --- |
| 状态 | 已转需求 |
| 发现日期 | 2026-08-19 |
| 发现时所在需求 | M16 真实运行与历史 Job 兼容验证 |
| 是否阻塞当前需求 | 是；阻塞 `pnpm verify` 全仓验证 |
| 发现方式 | 命令行回归 |
| 影响模块 | `apps/ai-worker/tests/ai-job-manager.test.ts` |

## 2. 范围判定

- 当前需求范围：验证 M16 语义分析合同、历史 Job 可读性与真实 Web/API 效果。
- 该问题是既有 restoration recommendation 并发测试的负载敏感超时，不改变 M16 业务行为。
- 阻塞验收点：全部 workspace 测试必须可稳定完成。
- 当前处理决定：用户已授权优化可改进项；将此项作为独立测试稳定性修复，不修改业务实现。

## 3. 复现入口与步骤

- 环境：Windows PowerShell，Node 24.18.1，pnpm 10.13.1。
- 入口：仓库根目录 `pnpm verify`。
- 测试：`AiJobManager > does not queue a restoration recommendation committed during start regeneration`。

步骤：

1. 运行 `pnpm verify`，使各 workspace 包按根命令并发执行测试。
2. 等待 `apps/ai-worker` 执行 restoration recommendation 并发提交回归。
3. 观察 Vitest 终态与清理时的未处理异常。

## 4. 实际结果与预期结果

### 实际结果

- 用例在默认 5000 ms 超时后失败，实际用时约 5974 ms。
- 测试清理关闭 SQLite 后，尚未完成的异步操作继续读取，产生 `The database connection is not open` 连带异常。
- 同一 Worker 包单独运行时通过，表明这是全仓并行负载下的时限敏感，不是业务断言失败。

### 预期结果

用例依据显式 Promise 信号验证并发边界，在合理的全仓负载波动内完成；超时不应先于已编码的确定性信号。

### 证据

| 证据 | 路径/摘要 |
| --- | --- |
| 命令 | 仓库根目录 `pnpm verify` |
| Vitest | 用例位于 `apps/ai-worker/tests/ai-job-manager.test.ts:1118` |
| 错误 | `Test timed out in 5000ms`，随后是 `The database connection is not open` |
| 对照 | Worker 独立 typecheck/28 tests/build 通过 |

## 5. 初步影响范围

- 只影响测试时限与失败后清理顺序。
- 未观察到 API、SQLite 生产数据或 restoration recommendation 业务行为错误。

## 6. 后续处理建议

- 建议优先级：P2。
- 处理方式：仅为该昂贵并发用例设置明确的合理超时，保留 Promise 信号和业务断言；修复后重跑 Worker 及全仓验证。
