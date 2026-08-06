# 当前 `packages/pi-subagent` 实现与限制

## 结论摘要

当前实现已经形成一个“小而完整”的同步委派闭环：父代理通过单一 `agent` 工具选择静态角色；子代理在独立的内存会话中运行；角色可以限制模型、推理档位、内置工具、skill 和最大轮数；TUI 展示实时活动，最终结果、用量和错误摘要回填父会话。

它的核心取舍是**短任务、无状态、同进程、共享工作目录**。这种设计实现简单、启动成本低，适合探索和规划，但尚不能支撑长时间后台任务、跨轮跟进、崩溃恢复、严格权限隔离、显式编排和可观测性审计。下一阶段应先补“运行实体与生命周期”，再扩展角色配置；否则会在现有一次性函数调用模型上堆积难以兼容的字段。

## 调研范围与快照

- 仓库快照：`38618676581d849e2ff1b7defe03b8756d843ea2`，调研日期 2026-08-06。
- 当前包版本为 `0.4.4`，开发依赖 `@earendil-works/pi-coding-agent@^0.81.1`（[package.json](../../../../package.json)）。本地安装版本为 `0.81.1`。
- 证据以本仓库实现、随依赖安装的官方文档/类型声明和运行时代码为准。关于 Pi SDK 的行为，另参照上游 `v0.81.1` 的 [SDK 文档](https://github.com/earendil-works/pi/blob/v0.81.1/packages/coding-agent/docs/sdk.md)、[扩展文档](https://github.com/earendil-works/pi/blob/v0.81.1/packages/coding-agent/docs/extensions.md)和[安全说明](https://github.com/earendil-works/pi/blob/v0.81.1/packages/coding-agent/docs/security.md)。

## 产品模型与用户体验

用户只面对一个 `agent` 工具。模型参数包含角色名、仅供 UI 显示的短标题和完整任务提示；工具描述明确告知父代理，子代理看不到父会话，调用方必须把上下文写进 `prompt`（[index.ts](../../index.ts#L37)）。

内置角色只有两个：

- `explore`：只读代码探索，输出带路径和行号的事实（[explore.md](../../agents/explore.md)）。
- `planner`：只读制定实现计划，要求基于真实符号和文件输出步骤、文件与风险（[planner.md](../../agents/planner.md)）。

用户可用 Markdown frontmatter 增加全局或项目角色。配置入口、字段和覆盖顺序已面向用户写入 README：项目级定义只在项目受信任时加载，同名角色按“项目 > 全局 > 内置”覆盖（[README.zh.md](../../../../README.zh.md#L117)）。全局 `subagent.json` 只有 `enabled` 开关，文件不存在时默认创建并启用（[config.ts](../../config.ts#L6)）。

这套交互没有显式的“创建任务、查看任务、继续任务、等待任务、停止任务”命令。一次 tool call 就是一次完整运行；父代理必须等待该调用结束才能获得结果。

## 定义、发现与配置

角色定义由“文件名即名称、正文即系统提示、frontmatter 即运行策略”组成。当前 schema 支持：

| 字段 | 语义 | 当前约束 |
| --- | --- | --- |
| `description` | 告诉父模型何时使用 | 必填、非空 |
| `tools` | 内置工具白名单 | 可选、字符串数组 |
| `skills` | skill 名称白名单 | 可选、字符串数组 |
| `model` | `provider/model` | 可选，复用公共模型 schema |
| `effort` | 推理档位 | 可选，固定枚举 |
| `maxTurns` | 助手消息轮数上限 | 可选、正整数 |

schema 与加载逻辑见 [agents.ts](../../agents.ts#L9)。发现顺序是内置目录、`~/.pi/agent/agents`、受信任项目的 `.pi/agents`；使用 `Map.set` 实现后加载覆盖先加载。只扫描目录第一层、只接受 `.md`，不支持嵌套、命名空间、参数化角色或单个角色禁用。解析失败的文件被跳过，并在 UI 或 stderr 汇总告警（[agents.ts](../../agents.ts#L54)、[index.ts](../../index.ts#L10)）。

目录只在 `session_start` 时读取。配置或角色变更依赖 `/reload` 重建扩展，没有文件监听或目录版本标识。注册后的角色目录被闭包捕获，因此同一扩展实例内不会动态变化（[index.ts](../../index.ts#L134)）。

## 执行架构

一次运行的路径如下：

```text
父代理 agent tool call
  → 按名称取静态角色
  → 解析模型与推理档位
  → 建立受限 ResourceLoader
  → 创建内存 AgentSession
  → prompt(task)
  → 收集最后一条助手文本、用量与停止原因
  → 截断后写回父会话 tool result
```

`DefaultResourceLoader` 被显式设置为不加载 extension、prompt template、theme 和上下文文件，并用角色正文完全覆盖系统提示；只有列入角色 `skills` 的 skill 会保留（[runner.ts](../../runner.ts#L125)）。这带来真实的上下文隔离，也主动切断递归子代理和项目 `AGENTS.md`。父会话历史没有复制，输入只有 `prompt` 字符串。

子会话使用 `SessionManager.inMemory(cwd)`，并通过内存 settings 关闭 compaction（[runner.ts](../../runner.ts#L151)）。Pi SDK 将 `AgentSession` 定义为管理消息历史、模型、压缩与事件流的单会话对象；`SessionManager.inMemory()` 明确不做文件持久化（[SDK sessions](https://github.com/earendil-works/pi/blob/v0.81.1/packages/coding-agent/docs/sdk.md#sessions)）。

工具集合固定为 Pi 七个内置工具：`read`、`bash`、`edit`、`write`、`grep`、`find`、`ls`。角色省略 `tools` 时全部开放，显式请求不存在的工具会在启动前失败；配置 skill 时必须同时开放 `read`（[runner.ts](../../runner.ts#L66)、[runner.ts](../../runner.ts#L111)）。Pi SDK 本身支持 custom/extension tools，但当前 loader 禁用 extension，调用也没有传 `customTools`，所以角色无法使用 MCP、父会话扩展工具或领域专用工具（[SDK tools](https://github.com/earendil-works/pi/blob/v0.81.1/packages/coding-agent/docs/sdk.md#tools)）。

## 并发、共享状态与权限

`agent` 工具没有设置 `executionMode: "sequential"`。Pi agent-core `0.81.1` 默认并行执行同一助手消息中的多个非 sequential tool call，因此模型一次发出多个 `agent` 调用时可并行运行（[agent-core 运行时](https://github.com/earendil-works/pi/blob/v0.81.1/packages/agent/src/agent.ts)）。扩展用 `Map<toolCallId, RunningSubagent>` 同时跟踪它们（[index.ts](../../index.ts#L93)）。

并发没有队列、上限、优先级或资源预算。每个运行有独立消息上下文，但都使用相同 `cwd` 和本地内置工具。因而：

- 只读探索天然适合并行；
- 多个写角色可能同时修改相同文件，扩展没有工作树、分支或文件级冲突策略；
- 每个运行独立计费，父代理也没有总 token/成本/时间预算；
- `bash`、`edit`、`write` 是工具白名单，不是 OS 权限边界。

项目信任只决定是否读取 `.pi/agents`（[agents.ts](../../agents.ts#L88)），不是子进程沙箱。Pi 官方同样明确说明 project trust 只是输入加载保护，不限制模型启动后的工具行为；无人值守或不可信工作应运行在容器、VM 或策略沙箱中（[Security](https://github.com/earendil-works/pi/blob/v0.81.1/packages/coding-agent/docs/security.md)）。当前实现没有为子代理增加审批回调、命令策略、网络策略或凭据裁剪。

## 生命周期、取消与结果

父 tool call 的 `AbortSignal` 会映射到 `session.abort()`。达到 `maxTurns` 时，仅当第 N 条助手消息仍以 `toolUse` 停止才中止，保留该轮已有的最后文本；正常文本结束不会被误报超限（[runner.ts](../../runner.ts#L163)）。完成后记录 token、缓存 token、成本和助手轮数，并区分 `max_turns`、`aborted`、`error` 与无输出（[runner.ts](../../runner.ts#L191)）。订阅和 session 都在 `finally` 中释放。

这里仍有四个生命周期缺口：

1. `session_shutdown` 只清空父 UI 的 `running` Map，没有保存子 session 引用，也没有逐个 abort；正在执行的 tool call 是否会被外层运行时统一取消，完全依赖宿主生命周期（[index.ts](../../index.ts#L152)）。
2. 没有 timeout、心跳、重试、退避或 provider 限流协调。
3. 没有后台运行 ID；`#number` 只是展示编号，无法用于查询、继续或重新附着。
4. 子代理内部失败通过 `details.isError` 和文本返回，`execute()` 本身不抛错，因此父 agent-core 看到的是成功完成的工具调用，而不是原生 error tool result（[index.ts](../../index.ts#L108)、[runner.ts](../../runner.ts#L201)）。UI 能以错误样式展示，但模型侧只能从错误文本理解失败。

父会话会持久化 tool call、文本结果和 `SubagentResult.details`，所以实现能扫描当前 branch 的历史结果延续展示编号（[index.ts](../../index.ts#L24)）。子会话完整 transcript 不持久化；运行中只缓存助手消息用于 widget，结束后从 `running` Map 删除。它因此不能回答“子代理执行过哪些具体工具、某条命令返回什么、从中间状态继续”等问题。

最终输出使用 Pi 默认行数/字节限制做 head 截断，完整文本写入权限为 `0600` 的临时目录（[runner.ts](../../runner.ts#L75)）。这避免撑爆父上下文，但临时路径不是稳定 artifact：不能保证跨重启存在，也没有清理、索引或导出协议。

## TUI 与可观测性

运行 widget 能同时展示所有活动运行的编号、角色、标题，以及最近一条助手文本或 tool call 摘要；结束结果提供折叠/展开 Markdown、错误状态和模型/用量统计（[render.ts](../../render.ts#L93)、[render.ts](../../render.ts#L138)）。这已经优于只显示 spinner 的同步工具。

不过事件订阅只接收 `message_end` 且仅保留 assistant message（[runner.ts](../../runner.ts#L165)）。因此 widget：

- 不显示工具执行开始/结束、stdout、失败重试和等待原因；
- 长工具运行期间可能长时间停在上一次 tool call；
- 不计算耗时，也没有已运行/排队/取消中的状态机；
- TUI 之外没有结构化进度通道；传入的 `_onUpdate` 未使用（[index.ts](../../index.ts#L76)）。

## 已具备的优势

- **隔离默认值清晰**：不偷带父对话、项目上下文或扩展，调用描述也向父模型暴露这一事实。
- **角色即文件**：定义简单、可覆盖、可随项目版本控制，且项目定义受 trust 门控。
- **能力最小化**：工具和 skill 都是白名单；内置角色均只读。
- **模型策略实用**：角色可固定模型/effort，也可继承父会话，并复用公共 resolver 验证可用性。
- **失败与成本可见**：最大轮数、abort、provider error、无输出、token 与 cost 都进入结构化 details。
- **并行基础已存在**：宿主默认并行 tool call，加上多运行 widget，足以支持简单 fan-out。

## 主要限制与演进影响

| 限制 | 用户后果 | 架构影响 |
| --- | --- | --- |
| 运行等同一次同步 tool call | 不能后台继续工作或稍后取回 | 需要把 `run` 提升为有 ID 的领域实体 |
| 子 transcript 仅驻内存 | 不能恢复、审计、follow-up | 需要持久 session 与父子关联 |
| 只有字符串结果 | 无 artifact、结构化输出或引用协议 | 需要结果 envelope 与 artifact registry |
| 固定七个本地工具 | 无 MCP、扩展工具、领域工具 | 需要可审计的 capability resolver |
| 同 cwd、无沙箱/审批 | 写任务并发冲突，权限过宽 | 需要执行环境与权限策略，而非更多布尔字段 |
| 无并发与预算控制 | 易触发限流和成本放大 | 需要 scheduler/budget，而非依赖模型自律 |
| 关闭 compaction | 长任务最终撞上下文上限 | 持久化与 compaction 策略需协同设计 |
| 只取最后助手文本 | 中间证据和失败细节丢失 | 需要 event log 与可选 transcript 摘要 |
| 错误不进入原生 tool error | 父模型可能弱化失败语义 | 需要明确选择 throw、error result 或领域状态 |
| 无递归 | 编排能力有限 | 应先决定是否支持有深度/配额的 delegation tree |

## 建议的演进顺序

### P0：先定义稳定领域模型

引入 `SubagentRun`（稳定 ID、父 session/tool call、角色快照、状态、时间戳、预算、结果/错误、artifact）和明确状态机：`queued → running → succeeded|failed|cancelled|timed_out`。角色定义与运行实例分离，避免以后用文件名和展示编号承担身份语义。

### P1：补生命周期和可观测性

- 保存活动 session/abort handle，确保 shutdown 可等待或取消。
- 使用 tool `onUpdate` 输出结构化进度；TUI widget 只是同一事件模型的投影。
- 增加 wall-clock timeout、最大并发、全局/单次 token 与成本预算。
- 将内部错误映射为宿主可识别的 tool error，同时保留结构化 details。

### P2：持久化与后台任务

- 为运行保存 append-only event log 或持久 Pi session，并记录父子关联。
- 将 `spawn` 与 `wait/result` 分离，支持父代理继续工作、稍后汇合。
- 明确 restart 后的语义：恢复、标记 interrupted，还是可重试；不要只恢复 UI 编号。

### P3：能力与执行环境

- 把工具名称白名单升级为 capability policy：来源、参数约束、是否需批准、文件/网络边界。
- 对写代理提供隔离工作树或显式串行策略；对只读代理保留轻量共享 cwd。
- 允许显式选择扩展/MCP 工具，但默认不继承父代理全部能力。

### P4：高级编排

在具备预算、深度、持久化和取消传播后，再考虑 follow-up、handoff、递归委派、结果聚合与动态角色。否则递归只会放大现有的权限、成本和恢复缺口。

## 不建议直接做的事

- 不要先模仿竞品增加大量 frontmatter 字段；生命周期语义尚未稳定，配置会反向固化实现。
- 不要默认把父会话全文注入子代理；显式任务包是当前设计的重要隔离优势，可在其上增加受控附件/引用。
- 不要默认继承父会话全部 extension/MCP 工具；应显式解析和展示能力来源。
- 不要把临时输出文件当成 artifact 系统；它缺少稳定身份、生命周期与可移植性。
- 不要在共享工作目录中无上限并行写代理；至少先提供并发策略和冲突边界。

## 待验证问题

1. 目标产品更重视“低成本同步专家调用”，还是“可后台运行的代理任务”？这决定是否需要拆分 `spawn`/`wait`。
2. 写代理应共享工作树、使用独立 git worktree，还是由策略按角色选择？
3. 子 transcript 的隐私、保留期和父会话可见程度应如何定义？
4. MCP/extension tool 是按名称、来源还是 capability 授权？同名覆盖如何审计？
5. 父会话取消、session switch、`/reload` 和进程退出时，是级联取消还是允许 detach？
6. 结构化结果是否需要 schema；artifact 是否进入父上下文、只留引用，还是由父代理按需读取？
