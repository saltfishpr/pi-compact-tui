Type: task
Status: needs-triage
Blocked by: 01

## Question

实现 `Executor` 接口并重构 `runner.ts`。当前 `runSubagent()` 函数承担了 session 创建、工具校验、skill 校验、输出截断、结果组装等所有职责。重构为 `Executor` 接口，当前实现作为 default executor。

### Executor 接口

```typescript
export interface Executor {
  execute(input: ExecuteInput, callbacks: { onActivity: (activity: SubagentActivity) => void }): Promise<ExecuteOutcome>;
}
```

### DefaultExecutor 实现

`DefaultExecutor` 类实现 `Executor` 接口，内部逻辑从当前 `runSubagent()` 迁移：

1. **工具校验**：从 `getSupportedToolNames()` 验证 `availableTools`。
2. **Skill 校验**：验证 `skills` 不为空时要求 `read` 工具，验证 skill 可用性。
3. **Session 创建**：`createAgentSession` 用 `SessionManager.inMemory`。
4. **消息订阅**：`session.subscribe` 监听 `message_end`，将每条 assistant message 转换为 `SubagentActivity` 并通过 `onActivity` 回调推送。
5. **maxTurns**：达到 `maxTurns` 时 `session.abort()`。
6. **输出截断**：`truncateOutput()` 逻辑保持不变。
7. **结果组装**：最终组装 `ExecuteOutcome` 返回。

### 要求

- 所有 `pi-ai` 和 `pi-coding-agent` 的 import 隔离在 `DefaultExecutor` 中，不泄露到接口。
- `ExecuteInput` 和 `ExecuteOutcome` 由 ticket 01 定义，此 ticket 仅实现。
- 保留 `UsageStats` 和 `TruncationResult` 类型定义，留在 `executor.ts` 中。
- 不改动 `runner.ts` 外部行为，只是内部重组。
- `onActivity` 转换逻辑：从 `Message` 中提取最后一条 `text` 或 `toolCall` 内容，转换为 `SubagentActivity`。

### 文件

- 修改：`packages/pi-subagent/runner.ts` → 重命名为 `executor.ts`（或保留原名但内容替换，由实现决定）
- 注意：`render.ts` 当前 import `RunningSubagent` 和 `SubagentResult` 从 `runner.ts`。这些类型不再从 `runner.ts` 导出，需要更新 import 路径。