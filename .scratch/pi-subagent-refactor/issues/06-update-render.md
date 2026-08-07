Type: task
Status: needs-triage
Blocked by: 02, 04

## Question

更新 `render.ts`，实现 v0/v1 details 分派渲染，并适配新的领域类型。

### 变更

1. **Widget 渲染（`updateSubagentWidget`）**：
   - 输入从 `ReadonlyMap<string, RunningSubagent>` 改为 `SubagentRun[]`（来自 `manager.getRunningRuns()`）。
   - 不再从 `message` 数组解析 `DisplayItem`，改为直接读取 `run.lastActivity`。
   - `formatDisplayItem` 直接处理 `SubagentActivity` 联合类型。

2. **结果渲染（`renderSubagentResult`）**：
   - 检测 `details.version`：
     - 缺省（v0）：走现有逻辑，`details` 视为 `SubagentResult`。
     - `version: 1`：走新逻辑，`details` 视为 `SubagentDetailsV1`。
   - v1 渲染逻辑：
     - `heading`：从 `identity.number`、`identity.agent`、`identity.title` 构建。
     - 错误处理：从 `outcome` 的 discriminated union 中提取错误信息。
     - 输出：`outcome.kind === "success"` 时显示 `outcome.text`。
     - 遥测：从 `telemetry` 读取 usage 和 model。
   - v0 渲染逻辑：保持现有代码不变。

3. **类型导入更新**：
   - `RunningSubagent` → 不再需要（被 `SubagentRun` 替代）。
   - `SubagentResult` → 保留，用于 v0 兼容。
   - 新增 import `SubagentRun` 从 `manager.ts`。
   - 新增 import `SubagentDetailsV1` 从 `details.ts`。

### 要求

- v0 和 v1 渲染结果在视觉上完全一致（不改变 TUI 展示）。
- `renderSubagentCall` 保持不变（返回空 Container）。
- `AgentRenderContext` 类型保持不变。
- 所有现有颜色/样式逻辑不变。

### 文件

- 修改：`packages/pi-subagent/render.ts`