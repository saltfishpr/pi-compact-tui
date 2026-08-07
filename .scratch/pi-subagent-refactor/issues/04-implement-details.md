Type: task
Status: needs-triage
Blocked by: 01

## Question

定义 `AgentToolResultDetails` v1 结构。

### SubagentDetailsV1（`details.ts`）

按照前面确认的设计：

```typescript
export interface SubagentDetailsV1 {
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

### 要求

- 只定义类型，不包含 normalize 逻辑。向前兼容由 render 层分派处理（见 ticket 06）：缺省 version 视为 v0，走旧 `SubagentResult` 渲染路径；`version: 1` 走 `SubagentDetailsV1` 渲染路径。
- 类型定义完整，所有字段有 JSDoc 注释。
- 不改动 `SubagentResult` 的现有定义（保留在 `executor.ts` 中，供 `DefaultExecutor` 内部使用）。
- `SubagentDetailsV1` 的 `usage` 类型复用 `UsageStats`（从 `executor.ts` import）。

### 文件

- 新文件：`packages/pi-subagent/details.ts`