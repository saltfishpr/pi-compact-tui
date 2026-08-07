Type: task
Status: needs-triage
Blocked by: 01

## Question

实现 `SubagentManager` 类，作为 session 作用域内 `SubagentRun` 的单一事实来源。

### 职责

1. **生命周期管理**：`createRun(toolCallId, spec, title, task)` → `SubagentRun`，`destroyRun(runId)`。
2. **状态迁移**：`pending` → `running` → `completed/aborted/failed`，通过 `transition(runId, status)` 方法。
3. **Number 分配**：构造时扫 `ctx.sessionManager.getBranch()` 恢复 `maxNumber`，每次 `createRun` 自增。
4. **RunId 分配**：`randomUUID()`（或等价实现，无需引入额外依赖，用 `crypto.randomUUID()`）。
5. **Activity 更新**：`updateActivity(runId, activity: SubagentActivity)`，更新 run 的 `lastActivity`。
6. **Outcome 记录**：`completeRun(runId, outcome: ExecuteOutcome)`，设置 outcome 并 transition 到对应状态。
7. **查询**：`getRun(runId)`、`getRunningRuns()`（返回 `"pending" | "running"` 状态的 run 列表，供 Widget 消费）。
8. **持有 Executor**：构造函数注入 `Executor`，`run(toolCallId, spec, title, task, model, thinkingLevel, signal, cwd)` 方法执行完整流程（createRun → transition running → executor.execute → completeRun）。

### API 设计

```typescript
export class SubagentManager {
  constructor(executor: Executor, ctx: ExtensionContext);
  
  createRun(toolCallId: string, spec: SubagentSpec, title: string, task: string): SubagentRun;
  run(toolCallId: string, spec: SubagentSpec, title: string, task: string, model: Model, thinkingLevel: ModelThinkingLevel, signal?: AbortSignal, cwd?: string): Promise<SubagentRun>;
  getRun(runId: string): SubagentRun | undefined;
  getRunningRuns(): SubagentRun[];
  destroyRun(runId: string): void;
  destroyAll(): void;
}
```

### 约束

- 所有 run 存储在 `Map<string, SubagentRun>` 中（key 为 runId）。
- `run()` 方法内部调用 `executor.execute()`，通过 `onActivity` 回调更新 `lastActivity`。
- `run()` 的 `finally` 中确保 transition 到终态（completed/aborted/failed）。
- 不涉及 Widget 更新（render 层由外部调用 `getRunningRuns()` 拉取）。
- 不做并发控制（后续扩展加）。

### 合法性要求

- 状态迁移合法性检查：`pending → running`、`running → completed/aborted/failed` 是合法路径，其他拒绝。
- `createRun` 时 spec 必须非空，title/task 非空字符串。
- 如果 `run()` 期间 signal 触发 abort，`ExecuteOutcome` 的 status 应为 `"aborted"`。

### 文件

- 新文件：`packages/pi-subagent/manager.ts`