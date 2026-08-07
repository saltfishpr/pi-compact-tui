## Destination

将 `pi-subagent` 重写为以 `SubagentManager` 为核心的架构，`execute()` 退化为 thin adapter。领域实体（`SubagentSpec`、`SubagentRun`、`SubagentActivity`、`AgentToolResultDetails`）各自独立，`Executor` 接口隔离 pi-ai 依赖。向前兼容通过 `details.version` 字段在 render 层分派。文件结构：`agents.ts` + `manager.ts` + `executor.ts` + `render.ts` + `index.ts`。

核心设计决策（已通过 grilling 确认）：

- **SubagentManager**：全职责，持有 Executor 引用，`execute()` 委托给 `manager.run()`。拥有 number 分配（构造时扫 session branch 恢复）和 runId 分配（randomUUID）。
- **Executor 接口**：`execute(input, { onActivity }): Promise<ExecuteOutcome>`，异步方法 + 回调流，pi-ai Message → SubagentActivity 翻译层。
- **SubagentActivity**：联合类型 `{ type: 'text', text: string } | { type: 'toolCall', name, args }`，Manager 只保留最新一条。
- **SubagentRun**：状态机 `"pending" | "running" | "completed" | "aborted" | "failed"`，独立 runId（randomUUID），toolCallId 作为关联字段。
- **SubagentSpec**：`LoadedAgent` → `SubagentSpec`，`AgentCatalog` 不变。
- **AgentToolResultDetails v1**：`identity` + `outcome`（discriminated union）+ `telemetry`，缺省 version 视为 v0。
- **向前兼容**：render 层分派，v0 走旧路径，v1 走新路径。

## Notes

- 领域语言：见 `packages/pi-subagent/CONTEXT.md`
- 依赖 API：见 `node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts`
- 无需新增单元测试

## Tickets

```
01 (unblocked) ──┬── 02 (blocked by 01)
                 ├── 03 (blocked by 01)
                 └── 04 (blocked by 01)
                         │
02 ──────────────────────┬── 05 (blocked by 02, 03, 04)
03 ──────────────────────┤
04 ───────────┬── 06 (blocked by 02, 04)
              │
05 ───────────┬── 07 (blocked by 05, 06)
06 ───────────┘
```

| # | Title | Status | Blocked by |
|---|-------|--------|------------|
| 01 | [define-types-and-spec](./issues/01-define-types-and-spec.md) | needs-triage | — |
| 02 | [implement-manager](./issues/02-implement-manager.md) | needs-triage | 01 |
| 03 | [implement-executor](./issues/03-implement-executor.md) | needs-triage | 01 |
| 04 | [implement-details](./issues/04-implement-details.md) | needs-triage | 01 |
| 05 | [refactor-index](./issues/05-refactor-index.md) | needs-triage | 02, 03, 04 |
| 06 | [update-render](./issues/06-update-render.md) | needs-triage | 02, 04 |
| 07 | [verify-and-cleanup](./issues/07-verify-and-cleanup.md) | needs-triage | 05, 06 |

## Decisions so far

<!-- 实现阶段逐 ticket 记录 -->

## Not yet specified

<!-- 无 -->

## Out of scope

- 队列/并发/后台运行能力（后续扩展，不在本次重构范围）
- 新增单元测试