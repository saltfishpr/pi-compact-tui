Type: task
Status: needs-triage
Blocked by: 02, 03, 04

## Question

重构 `index.ts`，将 `execute()` 中的逻辑委托给 `SubagentManager`。

### 当前流程（76-127 行）

```
execute(toolCallId, params, signal, _onUpdate, ctx):
  1. 查找 agent (agents.find)
  2. 分配 agentNumber (nextAgentNumber++)
  3. 解析模型 (resolveModel)
  4. 注册 running 状态 (running.set)
  5. 更新 Widget (updateSubagentWidget)
  6. 设置 onMessage 回调
  7. 调用 runSubagent()
  8. 组装返回结果
  9. finally 清理 + 更新 Widget
```

### 目标流程

```
execute(toolCallId, params, signal, _onUpdate, ctx):
  1. 查找 SubagentSpec (agents.find)
  2. 解析模型 (resolveModel)
  3. 调用 manager.run(toolCallId, spec, title, task, model, thinkingLevel, signal, ctx.cwd)
  4. 从 run.outcome 构建 SubagentDetailsV1
  5. 返回 { content: [{ type: "text", text: ... }], details: v1 }
```

### 要求

- `manager.run()` 内部处理状态管理、Activity 更新、Widget 刷新。
- `index.ts` 不再持有 `running` Map，不直接调用 `updateSubagentWidget`。
- Widget 刷新由 `SubagentManager` 负责：在 `createRun`、`updateActivity`、`completeRun` 时调用 `updateSubagentWidget`。
- 为此，`SubagentManager` 构造函数需要接收 `ctx: ExtensionContext` 引用。
- `getNextAgentNumber()` 逻辑移入 `SubagentManager` 构造函数。
- `reportDiagnostics` 函数和 `registerAgentTool` 保持不变（但 `registerAgentTool` 接收 `SubagentManager` 而非 `Map`）。
- 工具注册时 `parameters` 中 `name` 的 `StringEnum` 从 `SubagentSpec[]` 的值生成。
- 向后兼容：`toolResult.details` 写入 `SubagentDetailsV1`（version: 1），render 层处理 v0 兼容。

### 文件

- 修改：`packages/pi-subagent/index.ts`