# pi-subagent domain

`agent` 工具的领域词汇：把一次"父代理委派子代理执行任务"的过程抽成一等实体。

## Language

**SubagentSpec**:
磁盘上一份 agents/`*.md` 文件加载后的结果，含 frontmatter（运行策略：model、tools、skills、maxTurns 等）与 body（system prompt 正文）。静态、可版本化、可跨会话共享的声明单元；一个 SubagentSpec 可以被多次委派运行。
_Avoid_: AgentDefinition、LoadedAgent

**SubagentRun**:
一次委派的运行时实体，代表"父代理调用 `agent` 工具"到"拿到结果"的整个过程。有稳定 `runId` 与状态机，是 in-memory 的进行时观察句柄，不承载持久化。
_Avoid_: RunningSubagent、AgentInvocation、Task

**SubagentManager**:
`SubagentRun` 的单一事实来源，作用域限当前 session（in-memory）。独占 number 分配（构造时扫 session branch 恢复）与状态迁移。
_Avoid_: SubagentPool、Registry、Supervisor

**SubagentActivity**:
Run 的最近一次可展示活动（一条 text 或 toolCall），供 Widget 实时反映 subagent 正在做什么。领域层实体，与 render 层的 `DisplayItem` 相区分。
_Avoid_: Message、Event、DisplayItem

**AgentToolResultDetails**:
`agent` 工具 `toolResult.details` 的载荷，写入 session log 供跨 session 回放渲染。生命周期与 Run 分离；版本演进由 `version` 字段承担：当前 shape 视作 v0（缺省 `version`），renderer 按 `details.version` 分派。

**Executor**:
接受一次运行的输入、跑 pi-ai session、把领域活动流回调给 Manager、结束时返回 `ExecuteOutcome`。是 pi-ai `Message` → 领域 `SubagentActivity` 的翻译层；SubagentManager 通过它注入 fake 完成单测。隔离 pi 依赖。
_Avoid_: Runner、SessionRunner、Worker
