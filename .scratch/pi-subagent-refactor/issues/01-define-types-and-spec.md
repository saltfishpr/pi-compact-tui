Type: task
Status: needs-triage

## Question

定义本次重构涉及的所有领域类型，并完成 `LoadedAgent` → `SubagentSpec` 重命名。

### 需要定义的类型

1. **SubagentSpec**（`agents.ts`）：`LoadedAgent` 重命名，字段不变。`AgentCatalog` 中 `agents: LoadedAgent[]` 改为 `agents: SubagentSpec[]`。

2. **SubagentRun**（`manager.ts`）：状态机实体，字段含：
   - `runId: string`（randomUUID）
   - `toolCallId: string`（pi 的 toolCallId，关联字段）
   - `number: number`（展示编号）
   - `status: "pending" | "running" | "completed" | "aborted" | "failed"`
   - `spec: SubagentSpec`
   - `title: string`
   - `task: string`
   - `lastActivity?: SubagentActivity`（最新的活动，Widget 消费）
   - `outcome?: ExecuteOutcome`（结束时填充）

3. **SubagentActivity**（`activity.ts` 或 `manager.ts`）：联合类型
   ```typescript
   type SubagentActivity = 
     | { type: "text"; text: string } 
     | { type: "toolCall"; name: string; args: Record<string, unknown> };
   ```

4. **ExecuteInput / ExecuteOutcome**（`executor.ts`）：
   ```typescript
   interface ExecuteInput {
     runId: string;
     spec: SubagentSpec;
     task: string;
     signal?: AbortSignal;
     cwd: string;
     model: Model<any>;
     thinkingLevel: ModelThinkingLevel;
   }
   
   interface ExecuteOutcome {
     status: "completed" | "aborted" | "failed";
     stopReason?: "max_turns" | "aborted" | "error" | "tool_error";
     text?: string;
     errorMessage?: string;
     usage?: UsageStats;
     truncation?: TruncationResult;
     fullOutputPath?: string;
   }
   ```

5. **AgentToolResultDetails v1**（`details.ts`，按用户的定义）：
   ```typescript
   interface SubagentDetailsV1 {
     version: 1;
     identity: {
       number: number;
       agent: string;
       source: AgentSource;
       title: string;
       task: string;
     };
     outcome:
       | { kind: "success"; text: string }
       | { kind: "empty" }
       | { kind: "aborted"; text?: string }
       | { kind: "max_turns"; text?: string; turnLimit: number }
       | { kind: "error"; reason: "tool_error" | "runtime" | "unknown"; message: string };
     telemetry?: {
       model: string;
       usage: UsageStats;
     };
   }
   ```

6. **normalizeDetailsV0**（`details.ts`）：`SubagentResult`（v0）→ `SubagentDetailsV1` 转换函数。

### 要求

- 所有类型定义放在合适的文件中，export 清晰。
- `UsageStats` 和 `TruncationResult` 保留现有定义（来自 `runner.ts`），移到新文件或保留原位。
- 不改动任何运行时行为，只增加类型定义和重命名。
- 更新所有引用 `LoadedAgent` 的文件（`index.ts`、`runner.ts`、`render.ts`）。