# OpenAI Codex subagents 调研

## 结论摘要

Codex 的 subagent 产品核心不是“再调用一次模型”，而是把委派提升为**可观察、可继续、可关闭的 agent thread**：主线程保留需求与决策，子线程承载探索、测试、日志和实现噪音，最后把结果汇总回主线程。官方建议优先并行只读或写集互不重叠的任务，并明确提醒每个 subagent 都独立消耗模型与工具额度。[官方定位与适用场景](https://learn.chatgpt.com/docs/agent-configuration/subagents#why-subagent-workflows-help)

必须区分三层事实：

1. **已发布、已文档化的产品行为**：ChatGPT Work、Codex 桌面端、CLI 和 IDE 已有 subagent 工作流与线程 UI；当前 Codex 版本默认启用，通常由用户直接要求或 `AGENTS.md`/skill 指令触发。[官方可用性说明](https://learn.chatgpt.com/docs/agent-configuration/subagents#availability)
2. **稳定且默认开启的 V1 工具面**：官方配置参考把 `features.multi_agent` 标为 stable/on by default，并列出 `spawn_agent`、`send_input`、`resume_agent`、`wait_agent`、`close_agent`。[官方配置参考](https://learn.chatgpt.com/docs/config-file/config-reference#feature-flags)
3. **固定源码中的 MultiAgentV2**：源码也把 `multi_agent_v2` 标为 `Stage::Stable`，但 `default_enabled: false`；它引入 task path、`none/all/last N` 上下文 fork、mailbox、跨 agent 通信、自动驻留换出等设计。它没有进入当前公开配置参考，因此本报告只把它视为**值得研究的候选架构**，不能表述为所有 Codex 客户端都已公开可用。[V1/V2 feature flags](https://github.com/openai/codex/blob/57f42a81131ccf5933e7ec5dc659c381eeb5d72b/codex-rs/features/src/lib.rs#L1107-L1118)

对 `packages/pi-subagent` 的直接建议是：先补稳定 run ID、状态机、后台执行、独立 transcript、follow-up/interrupt、并发上限和结构化事件；再引入持久 agent graph 与按需恢复；最后才考虑递归委派和 task-path 通信。不要照搬 V2 的默认全历史 fork、完整 session-config 角色层或共享 cwd 下的并行写入。

## 研究快照与证据边界

- 调研日期：2026-08-06。
- 官方产品行为以 2026-08-06 获取的 [Codex Subagents 手册](https://learn.chatgpt.com/docs/agent-configuration/subagents)、[CLI slash commands](https://learn.chatgpt.com/docs/developer-commands#switch-agent-threads-with-agent)、[配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)和 [Hooks](https://learn.chatgpt.com/docs/hooks)为准。
- 开源实现固定在 OpenAI Codex commit [`57f42a81131ccf5933e7ec5dc659c381eeb5d72b`](https://github.com/openai/codex/tree/57f42a81131ccf5933e7ec5dc659c381eeb5d72b)，提交日期为 2026-08-06。
- 手册描述跨客户端的产品承诺；源码只证明该固定提交中存在某段实现。尤其是 `Stage::Stable` 是内部 feature maturity，不等于默认开启、已写入公开文档或已在所有客户端完成 rollout。
- 报告不使用二手文章，也不根据源码推断 ChatGPT 托管端的私有调度实现。

## 产品定位与各客户端 UX

官方把 subagent workflow 定义为：Codex 启动一个或多个专门 agent，在独立 agent thread 中并行工作，再由主线程收集结果。它主要解决主上下文中的 context pollution/context rot，并缩短可并行工作耗时；最合适的起点是探索、测试、triage、总结等 read-heavy 任务，多个 agent 同时写代码则会增加冲突和协调成本。[核心术语与建议](https://learn.chatgpt.com/docs/agent-configuration/subagents#core-terms)

| 客户端 | 已文档化体验 | 控制方式 |
| --- | --- | --- |
| ChatGPT Work | 符合资格的账户可在托管环境运行 subagents，聊天显示活动和结果；Web 侧有只读的 Active/Done 列表和详情 | 一般 intelligence 档位需明确要求委派；Ultra 可在并行能明显改善速度或质量时主动委派；Web sidebar 不直接 stop/steer 单个 agent，需在聊天中要求 |
| Codex 桌面端 | 主聊天显示每个 subagent thread，可打开检查过程与返回主聊天的 summary | 直接要求委派，或由项目/skill 指令授权；可在聊天中要求 steer、stop、close |
| Codex CLI | 主线程最终聚合结果，`/agent` 或 `/subagents` 打开 picker，切换到 agent thread 检查或继续工作 | 聊天中要求 spawn/steer/stop/close；非当前线程的 approval 也能弹出并带来源标签 |
| IDE extension | 支持时，composer 上方显示 background-agent panel，可看状态、stop all 或打开单个 thread | 直接要求委派，或由项目/skill 指令授权；也可用自然语言 steer/stop/close |

以上差异来自官方 [Availability](https://learn.chatgpt.com/docs/agent-configuration/subagents#availability)、[Managing subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents#managing-subagents) 与 [CLI `/agent`](https://learn.chatgpt.com/docs/developer-commands#switch-agent-threads-with-agent)。它们证明产品已具备多线程可见性，但不等于所有客户端暴露相同的底层工具或相同粒度的按钮。

## 触发与编排策略

当前公开规则刻意保守：

- ChatGPT 大多数 intelligence level 和本地 Codex 都以**显式委派**为主；本地 Codex 还可遵循 `AGENTS.md` 或 skill 中明确要求 delegation/parallel agent work 的指令。Ultra 的主动委派属于 ChatGPT Work 产品行为，不能外推为本地 Codex 的通用默认。[触发规则](https://learn.chatgpt.com/docs/agent-configuration/subagents#triggering-subagent-workflows)
- 好的委派 prompt 应说明如何拆分、是否等待所有 agent、以及需要返回什么格式；官方示例也是“一类检查一个 agent，全部完成后按类别汇总”。[编排示例](https://learn.chatgpt.com/docs/agent-configuration/subagents#orchestration-and-thread-controls)
- 固定源码中的 V1 tool description 更进一步约束：只有用户或适用的 `AGENTS.md`/skill 明确授权才可 spawn；“深入、彻底、研究”本身不构成授权，并要求只委派可与本地关键路径并行的具体 sidecar 任务。[V1 spawn guidance](https://github.com/openai/codex/blob/57f42a81131ccf5933e7ec5dc659c381eeb5d72b/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L682-L745)

这套策略的优点是避免模型为“看起来复杂”就无限 fan-out。对 pi 而言，应把是否允许委派作为显式 policy，而不是仅靠 role description 诱导模型自动路由。

## Custom agent 定义与配置层

Codex 内置 `default`、`worker`、`explorer`。用户可把每个 custom agent 定义为独立 TOML 文件：个人级 `~/.codex/agents/`，项目级 `.codex/agents/`。`name`、`description`、`developer_instructions` 必填；还可使用正常 `config.toml` 支持的配置键，如 `model`、`model_reasoning_effort`、`sandbox_mode`、`mcp_servers`、`skills.config`。同名自定义 agent 覆盖内置 agent。[官方 custom agents](https://learn.chatgpt.com/docs/agent-configuration/subagents#custom-agents)

它本质上是一个高优先级 **session config layer**，不是小型专用 manifest。源码会从各 config layer 相邻的 `agents/` 目录发现角色文件，按层合并；role layer 通过 session-flag precedence 重建配置，若 role 未显式指定，则尽量保留调用方当前 model、reasoning、provider 和 service tier。[发现与层合并](https://github.com/openai/codex/blob/57f42a81131ccf5933e7ec5dc659c381eeb5d72b/codex-rs/core/src/config/agent_roles.rs#L18-L111)、[role 配置应用](https://github.com/openai/codex/blob/57f42a81131ccf5933e7ec5dc659c381eeb5d72b/codex-rs/core/src/agent/role.rs#L31-L118)

模型/effort 的公开优先级是：custom agent 文件中的固定值最高；否则依次为 spawn 显式值、`[agents]` 默认值、父线程值。若显式切换模型但没有 effort，使用目标模型默认 effort。其他未设置项从父线程继承。[模型与配置继承](https://learn.chatgpt.com/docs/agent-configuration/subagents#custom-agents)

对 pi 的启示有两面：角色文件可复用、项目可版本控制、全局/项目覆盖都是优点；但“任意 session 配置都可进入 agent 文件”会放大配置优先级、安全审计和迁移成本。pi 更适合保留小而显式的 agent schema，再由一个 capability resolver 计算最终能力。

## 线程、树与身份

### 公开/V1 模型

公开产品把每个 subagent 表示为独立 agent thread。固定源码中，V1 `spawn_agent` 返回 `agent_id`（实际 thread ID）和可选 nickname；父子关系写入 `SessionSource::SubAgent(ThreadSpawn)`，同一根线程树共享一个 `AgentControl` 和 session ID，但每个 agent 有独立 thread。[V1 返回结构](https://github.com/openai/codex/blob/57f42a81131ccf5933e7ec5dc659c381eeb5d72b/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L391-L406)、[树级控制器](https://github.com/openai/codex/blob/57f42a81131ccf5933e7ec5dc659c381eeb5d72b/codex-rs/core/src/agent/control.rs#L90-L110)

### V2 task path

V2 在 thread ID 外增加稳定的逻辑路径：根为 `/root`，子任务名只能含小写字母、数字和下划线；当前 `/root/task1` spawn `task_3` 会得到 `/root/task1/task_3`。相对引用从当前 agent 解析，绝对路径可跨分支定位，重复路径被拒绝。[`AgentPath` 约束与解析](https://github.com/openai/codex/blob/57f42a81131ccf5933e7ec5dc659c381eeb5d72b/codex-rs/protocol/src/agent_path.rs#L17-L72)、[路径唯一性](https://github.com/openai/codex/blob/57f42a81131ccf5933e7ec5dc659c381eeb5d72b/codex-rs/core/src/agent/registry.rs#L245-L260)

task path 让模型更容易表达“父、子、兄弟”和跨分支通信，但不应替代不可变 run/thread ID：名称会承载用户语义，ID 才适合持久化、恢复和审计。pi 若采用该设计，应同时保留 `definitionName`、`runId`、`taskPath` 三种身份。

## 上下文 fork 与过滤

V1 只有布尔 `fork_context`：`false`/省略表示仅给初始任务；`true` 表示复制完整父 history。完整 fork 时 agent type 必须继承父级，不能同时选择另一 role。[V1 参数与限制](https://github.com/openai/codex/blob/57f42a81131ccf5933e7ec5dc659c381eeb5d72b/codex-rs/core/src/tools/handlers/multi_agents/spawn.rs#L94-L109)

V2 用 `fork_turns` 替代布尔值：

- `none`：不带周边历史；
- `all`：完整历史，也是省略参数时的默认值；
- 正整数字符串，如 `3`：只取最近三个 fork turn。

参数解析明确拒绝旧 `fork_context` 和 `0`。[V2 fork 参数](https://github.com/openai/codex/blob/57f42a81131ccf5933e7ec5dc659c381eeb5d72b/codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs#L191-L238)

“最近 N turn”不是简单按消息截断。边界包含真实 user message、`trigger_turn=true` 的 inter-agent communication，并应用 rollback 标记；截断后会丢掉 turn 前的启动上下文。[fork turn 边界](https://github.com/openai/codex/blob/57f42a81131ccf5933e7ec5dc659c381eeb5d72b/codex-rs/core/src/thread_rollout_truncation.rs#L62-L90)、[最近 N turn 截断](https://github.com/openai/codex/blob/57f42a81131ccf5933e7ec5dc659c381eeb5d72b/codex-rs/core/src/thread_rollout_truncation.rs#L256-L278)

fork 后还执行内容过滤：保留 system/developer/user 和 final-answer assistant 消息，丢弃 reasoning、shell/function/tool calls 及输出、inter-agent envelope；V2 还移除父级 multi-agent usage hint，必要时把父 developer instructions 替换为子 role instructions。只有 full-history fork 保留 reference context/world state，截断 fork 首轮需重建上下文。[基础过滤规则](https://github.com/openai/codex/blob/57f42a81131ccf5933e7ec5dc659c381eeb5d72b/codex-rs/core/src/agent/control/spawn.rs#L47-L80)、[V2 指令过滤与替换](https://github.com/openai/codex/blob/57f42a81131ccf5933e7ec5dc659c381eeb5d72b/codex-rs/core/src/agent/control/spawn.rs#L679-L826)

这个实现说明“fork history”必须定义消息白名单和指令 provenance，不能直接复制 transcript。对 pi，默认仍应保持当前的显式任务包/无父历史；后续可增加 `recent_turns`，但 `all` 不宜成为默认，因为它同时增加 token、隐私暴露和指令串扰。

## 模型、工具、MCP 与 skill

- **模型**：父模型/effort 默认继承，agent 文件、spawn 参数和 `[agents]` defaults 可分层覆盖；目标模型与 effort 会经过可用模型和支持档位校验。[源码中的 override 解析](https://github.com/openai/codex/blob/57f42a81131ccf5933e7ec5dc659c381eeb5d72b/codex-rs/core/src/tools/handlers/multi_agents_common.rs#L270-L325)
- **工具**：V2 tool description 告诉模型“子 agent 有与当前 agent 相同的工具，也能 spawn 自己的 subagents”，但实际 exposure 仍受 feature、模型支持、递归规则和 role config 影响。[V2 tool contract](https://github.com/openai/codex/blob/57f42a81131ccf5933e7ec5dc659c381eeb5d72b/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L749-L768)
- **MCP/skill**：因为 custom agent 是完整 config layer，agent 可配置自己的 `mcp_servers` 和 `skills.config`；省略时从父配置继承。官方示例用专属 docs MCP 构建研究 agent，也用 `skills.config` 禁用某个 skill。[官方 custom agent 示例](https://learn.chatgpt.com/docs/agent-configuration/subagents#example-custom-agents)
- **递归工具差异**：V1 的 collab 工具受 `agents.max_depth` 控制，固定源码默认深度为 1；V2 忽略该 V1 深度值，但只有模型声明支持 V2 时，非根 agent 才继续获得 collab tools。[工具暴露条件](https://github.com/openai/codex/blob/57f42a81131ccf5933e7ec5dc659c381eeb5d72b/codex-rs/core/src/tools/spec_plan.rs#L557-L572)

Codex 没把“tools allowlist”做成 custom agent 必填字段，而是通过完整配置、MCP/skill 设置、sandbox 和运行时 tool planner 共同决定能力。这很灵活，但最终 effective capabilities 不够直观。pi 当前静态工具/skill 白名单更容易审计；未来接入 MCP 时应维持显式 allowlist，并展示解析后的能力快照。

## Sandbox、approval 与共享 cwd

公开行为是：subagent 继承父线程当前 sandbox policy 和 composer 下选择的 permission mode。CLI 在查看其他线程时也能收到 inactive thread 的 approval，overlay 标明来源；无法弹出新 approval 的非交互流程会失败并把错误返回父工作流。父 turn 的实时 `/permissions`、`--yolo` 等 override 会在 spawn 时重新施加，即使 custom agent 文件写了不同默认值；同时，custom agent 可用 `sandbox_mode = "read-only"` 主动收窄能力。[官方 sandbox/approval 规则](https://learn.chatgpt.com/docs/agent-configuration/subagents#approvals-and-sandbox-controls)

源码对应地从父 turn 复制当前 cwd、approval policy 和 permission profile，而不是盲目使用启动时的旧 config。[运行时权限覆盖](https://github.com/openai/codex/blob/57f42a81131ccf5933e7ec5dc659c381eeb5d72b/codex-rs/core/src/tools/handlers/multi_agents_common.rs#L237-L268)

所有本地 agent 共享同一容器、文件系统和 cwd，修改立即互相可见；V2 默认 usage hint 直接把这一事实告诉模型。[共享工作目录提示](https://github.com/openai/codex/blob/57f42a81131ccf5933e7ec5dc659c381eeb5d72b/codex-rs/core/src/config/mod.rs#L260-L277) 这适合读任务和分离写集，不构成写隔离。pi 不应把角色的 `tools: [read]` 或共享 cwd 误当 OS sandbox；并行写至少需要文件 ownership、串行策略或独立 worktree。

## 并发、递归与资源控制

公开配置 `agents.max_concurrent_threads_per_session` 限制同时打开的 spawned-agent thread，不含主线程；固定 V1 源码默认上限为 6，默认递归深度为 1。完成的 V1 agent 在 close 前仍保持 open 并占用名额。[公开全局设置](https://learn.chatgpt.com/docs/agent-configuration/subagents#global-settings)、[V1 默认值](https://github.com/openai/codex/blob/57f42a81131ccf5933e7ec5dc659c381eeb5d72b/codex-rs/core/src/config/mod.rs#L212-L216)、[V1 close contract](https://github.com/openai/codex/blob/57f42a81131ccf5933e7ec5dc659c381eeb5d72b/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L318-L337)

V2 固定源码默认总并发 slot 为 4，**包含根 agent**，所以最多三个并发子 agent；V2 用 execution limiter 控制活跃 turn，并用 residency 容量控制加载中的子线程。其递归不是固定无限深，而是受模型的 `multi_agent_version` 元数据、同一根树共享的 slot 和 task-path 唯一性共同约束。[V2 配置默认值](https://github.com/openai/codex/blob/57f42a81131ccf5933e7ec5dc659c381eeb5d72b/codex-rs/core/src/config/mod.rs#L1270-L1322)、[V1/V2 名额换算](https://github.com/openai/codex/blob/57f42a81131ccf5933e7ec5dc659c381eeb5d72b/codex-rs/core/src/config/mod.rs#L1585-L1598)

pi 应把并发上限、累计 spawn budget、递归深度和 token/time budget 分开。只有并发信号量不能阻止 agent 反复串行 spawn 导致成本失控。

## 通信、等待、取消与恢复

### 稳定 V1 工具面

| 工具 | 语义 |
| --- | --- |
| `spawn_agent` | 创建 thread；可仅带任务，也可 full-history fork；返回 thread ID/nickname |
| `send_input` | 向既有 thread 发送文本或结构化 input；`interrupt=true` 时先中断当前 turn |
| `wait_agent` | 等待指定 agent 达终态，返回按 ID 索引的 status/final message；timeout 返回空状态 |
| `close_agent` | 显式关闭目标及其 live descendants；completed agent 不 close 会继续占 slot |
| `resume_agent` | 从已持久化 rollout 重新打开 closed agent，以便继续 `send_input`/`wait_agent` |

V1 schema 与语义见固定源码的 [`send_input`](https://github.com/openai/codex/blob/57f42a81131ccf5933e7ec5dc659c381eeb5d72b/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L148-L183)、[`wait_agent`](https://github.com/openai/codex/blob/57f42a81131ccf5933e7ec5dc659c381eeb5d72b/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L269-L283)、[`close_agent`](https://github.com/openai/codex/blob/57f42a81131ccf5933e7ec5dc659c381eeb5d72b/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L318-L337) 和 [`resume_agent`](https://github.com/openai/codex/blob/57f42a81131ccf5933e7ec5dc659c381eeb5d72b/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L247-L267)。`close_agent` 在实现中先把持久 edge 标为 closed，再 shutdown 目标与 live descendants。[V1 close 实现](https://github.com/openai/codex/blob/57f42a81131ccf5933e7ec5dc659c381eeb5d72b/codex-rs/core/src/agent/control/legacy.rs#L32-L101)

### 源码中的 V2 工具面

| 工具 | 与 V1 的关键变化 |
| --- | --- |
| `spawn_agent(task_name, message, fork_turns, …)` | 强制 task name；默认 full fork；返回 canonical task path |
| `send_message(target, message)` | 只入 mailbox，不启动新 turn |
| `followup_task(target, message)` | idle 时启动新 turn；运行中在 sampling 边界或当前 tool 后交付；不能 target root |
| `wait_agent(timeout_ms)` | 等待当前 agent mailbox 的任意更新或用户 steer；只返回“有更新/超时”的 summary，不直接返回内容 |
| `interrupt_agent(target)` | 中断当前 turn，但 agent 保持可通信和可 follow-up，不等同 close |
| `list_agents(path_prefix?)` | 列出当前根线程树中的 live agent，可按 task-path 前缀过滤 |

工具集合由 V2 registry 明确注册，V1/V2 不是增量叠加，而是二选一的协议面。[V1/V2 注册分支](https://github.com/openai/codex/blob/57f42a81131ccf5933e7ec5dc659c381eeb5d72b/codex-rs/core/src/tools/spec_plan.rs#L1095-L1181) `send_message` 与 `followup_task` 共用提交路径，差别仅是 `trigger_turn`；发送前会按需 reload 被换出的 V2 thread。[V2 消息路径](https://github.com/openai/codex/blob/57f42a81131ccf5933e7ec5dc659c381eeb5d72b/codex-rs/core/src/tools/handlers/multi_agents_v2/message_tool.rs#L51-L131) V2 `wait_agent` 是 mailbox/activity wait，不承载真实内容，因此结果交付依赖独立的输入队列和 completion notification。[V2 wait](https://github.com/openai/codex/blob/57f42a81131ccf5933e7ec5dc659c381eeb5d72b/codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs#L36-L149)

V2 去掉显式 close/resume，改成 interrupt + 自动换出/按需加载。这让模型工具更少，但运行时复杂度更高。对 pi 的第一版后台 API，显式 `cancel`/`resume` 比自动 LRU 更容易解释；mailbox 可以借鉴，但必须保证 completion notification 至少一次交付并可从持久 store 重放。

## 持久化、agent graph 与 LRU residency

每个非 ephemeral thread 都有独立 rollout。另有 SQLite-backed `AgentGraphStore` 保存有向 parent/child edge 与 open/closed 状态，支持列 direct children 和 BFS descendants；每个 child 最多一个 parent。[AgentGraphStore 接口](https://github.com/openai/codex/blob/57f42a81131ccf5933e7ec5dc659c381eeb5d72b/codex-rs/agent-graph-store/src/store.rs#L13-L59)、[SQLite 实现](https://github.com/openai/codex/blob/57f42a81131ccf5933e7ec5dc659c381eeb5d72b/codex-rs/agent-graph-store/src/local.rs#L10-L109)

恢复策略随协议不同：

- V1 resume 会从 rollout 打开目标，并沿持久 graph 递归重开 open descendants；源码对 V2 提前返回，不走该 eager subtree 恢复路径。[恢复分支](https://github.com/openai/codex/blob/57f42a81131ccf5933e7ec5dc659c381eeb5d72b/codex-rs/core/src/agent/control/spawn.rs#L849-L889)
- V2 恢复根线程时只恢复 open descendants 的 `AgentPath`/role/nickname 元数据，不立即启动 runtime；之后 message/follow-up 根据 thread ID 从 rollout lazy reload。[V2 metadata 恢复](https://github.com/openai/codex/blob/57f42a81131ccf5933e7ec5dc659c381eeb5d72b/codex-rs/core/src/agent/control/spawn.rs#L126-L196)、[V2 按需 reload](https://github.com/openai/codex/blob/57f42a81131ccf5933e7ec5dc659c381eeb5d72b/codex-rs/core/src/agent/control/spawn.rs#L250-L379)
- V2 residency 使用 LRU 队列；容量满时只换出 completed、errored、interrupted，且没有 active turn 和 pending mailbox 的线程。换出前 materialize rollout 并 shutdown，随后从 thread manager 移除；被保护的当前目标不会被淘汰。[V2 LRU residency](https://github.com/openai/codex/blob/57f42a81131ccf5933e7ec5dc659c381eeb5d72b/codex-rs/core/src/agent/control/residency.rs#L48-L150)、[可换出条件](https://github.com/openai/codex/blob/57f42a81131ccf5933e7ec5dc659c381eeb5d72b/codex-rs/core/src/agent/control/residency.rs#L217-L232)

这套设计把“身份存在”“runtime resident”“turn running”分成三个状态，能在有限内存下保留大量可继续 agent。pi 应先建立这三个概念和可靠 transcript，再实现 LRU；否则 UI 会把 unloaded 误报为 lost，消息也可能发往不存在的内存 session。

## Hooks 与可观测性

公开 Hooks 已覆盖 `SubagentStart` 和 `SubagentStop`：

- `SubagentStart` 提供 `turn_id`、`agent_id`、`agent_type`、`permission_mode`；stdout/additionalContext 可给子 agent 注入 developer context，但 `continue:false` 不能阻止启动。
- `SubagentStop` 还提供 subagent transcript path、最后一条 assistant message 和 continuation guard；hook 可返回 block/reason 要求子 agent 再执行一轮，`continue:false` 优先阻止继续。
- `SessionEnd` 只用于主线程，不对 subagent 触发。

见官方 [SubagentStart](https://learn.chatgpt.com/docs/hooks#subagentstart)、[SubagentStop](https://learn.chatgpt.com/docs/hooks#subagentstop) 与 [SessionEnd](https://learn.chatgpt.com/docs/hooks#sessionend)。固定源码也明确只让 thread-spawn subagent 走 start/stop hook，并把 parent session ID、agent identity、权限模式、transcript 路径写入 schema。[hook dispatch](https://github.com/openai/codex/blob/57f42a81131ccf5933e7ec5dc659c381eeb5d72b/codex-rs/core/src/hook_runtime.rs#L104-L150)、[stop dispatch](https://github.com/openai/codex/blob/57f42a81131ccf5933e7ec5dc659c381eeb5d72b/codex-rs/core/src/hook_runtime.rs#L300-L367)

运行事件不是只为 TUI 临时渲染：V1 产生 `CollabAgentToolCall` 的 in-progress/completed item；V2 产生 started/interacted/interrupted 的 `SubAgentActivityItem`，并记录 `codex.multi_agent.spawn` 计数器及 role/version tag。[V2 activity event](https://github.com/openai/codex/blob/57f42a81131ccf5933e7ec5dc659c381eeb5d72b/codex-rs/core/src/tools/handlers/multi_agents_v2.rs#L47-L55)、[spawn telemetry](https://github.com/openai/codex/blob/57f42a81131ccf5933e7ec5dc659c381eeb5d72b/codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs#L155-L171)

pi 应让持久 event log、TUI、hook 和父会话 completion notification 共用同一事件模型，事件至少包含 parent session、run/thread ID、task path、definition、tool call、状态、时间、usage 和终止原因。

## V1 与 V2 差异总表

| 维度 | V1：已公开稳定、默认开启 | V2：固定源码 Stable、默认关闭 |
| --- | --- | --- |
| feature | `features.multi_agent` | `features.multi_agent_v2`，公开配置参考未列出 |
| 身份 | thread UUID + nickname | thread UUID + 唯一 canonical task path + nickname |
| spawn 上下文 | `fork_context: boolean`，默认不 fork | `fork_turns: none/all/N`，默认 all |
| role 与 full fork | full fork 必须继承 parent agent type | full fork仍可显式选择 role；usage hint 对 full fork 的 model/effort override 更保守 |
| 通信 | `send_input`，可选 interrupt | `send_message`（只排队）与 `followup_task`（触发 turn）分离 |
| 等待 | 等指定 ID 的终态，直接返回 status/final | 等当前 mailbox 活动，只返回 wake/timeout summary |
| 生命周期 | 显式 close、resume；completed 在 close 前占 slot | interrupt，不 close；终态可 LRU unload，消息时 lazy reload |
| 枚举 | 无统一 tree listing 工具 | `list_agents(path_prefix)` |
| 递归 | 默认 max depth 1 | 忽略 V1 depth；受模型 V2 能力和共享并发限制 |
| 默认容量（固定源码） | 6 个 spawned threads，不含 root | 4 个总 slot，含 root |
| tool namespace | Responses API namespace `multi_agent_v1` | 默认 `collaboration` namespace，可配置；工具实现为 V2 分支 |
| 恢复 | 显式 resume/eager open descendants | metadata restore + lazy runtime residency |

差异的最关键证据是同一固定提交中 V1 on/V2 off 的 [feature flags](https://github.com/openai/codex/blob/57f42a81131ccf5933e7ec5dc659c381eeb5d72b/codex-rs/features/src/lib.rs#L1107-L1118)、协议选择逻辑的 [V2 override/V1 fallback](https://github.com/openai/codex/blob/57f42a81131ccf5933e7ec5dc659c381eeb5d72b/codex-rs/core/src/config/mod.rs#L1556-L1583)，以及工具注册中的 [互斥分支](https://github.com/openai/codex/blob/57f42a81131ccf5933e7ec5dc659c381eeb5d72b/codex-rs/core/src/tools/spec_plan.rs#L1095-L1181)。

## 优势

1. **主上下文保持干净**：过程日志留在子 thread，主线程接收 summary，适合大型调研和并行检查。
2. **线程是一等实体**：可查看、切换、继续、等待、关闭/中断，而不是一次同步函数调用。
3. **定义与运行分离**：custom agent 是可复用配置，运行实例拥有独立 thread ID、rollout、状态和 parent edge。
4. **权限继承有明确上界**：父 turn 的实时 sandbox/approval 决策重新施加，agent role 可进一步收窄。
5. **恢复架构完整**：rollout 保存对话，agent graph 保存拓扑；V2 又把 metadata 与 resident runtime 分离。
6. **多端共享语义**：桌面端、CLI、IDE 都围绕 agent thread 展示，不把 orchestration 绑死在单一 UI。
7. **可观测性可扩展**：turn item、telemetry、hooks、transcript 和 approval source 都有 agent identity。

## 限制与风险

1. **成本放大**：每个 agent 独立做模型与工具工作；并发提速不等于 token/费用下降，官方也明确提示消耗更高。[官方成本提醒](https://learn.chatgpt.com/docs/agent-configuration/subagents#availability)
2. **共享工作区冲突**：同 cwd 让结果即时可见，也让并行写、测试和 git 操作互相干扰；没有事务或自动 merge 边界。
3. **配置过重**：custom agent 复用完整 config layer，模型、MCP、skill、sandbox、provider 和动态工具的最终优先级难以向用户解释；官方也承认格式较重且可能演进。[官方 schema 说明](https://learn.chatgpt.com/docs/agent-configuration/subagents#custom-agent-file-schema)
4. **fork 两难**：`none` 容易缺上下文，`all` 容易泄露无关历史并增加 token，`last N` 只按 turn 边界截断，不保证保留语义依赖。
5. **递归与 fan-out 风险**：V2 允许有能力的子 agent 再 spawn；并发限制约束同时运行量，却不直接约束累计调用、总 token 或任务树宽度。
6. **approval 在非交互环境会失败**：后台任务如果需要新权限而客户端不能呈现 prompt，只能失败并向父级传播；自动化需要预先设计足够保守的权限 profile。
7. **V2 状态面复杂**：known、resident、running、interrupted、completed、unloaded 不同；LRU reload、mailbox 和 completion notification 之间存在竞态与一致性成本。
8. **公开产品与源码存在 rollout 边界**：公开手册只承诺稳定 V1 产品行为；V2 的 `Stage::Stable`/默认关闭组合说明内部成熟度标签不能用作公开可用性判断。

## `packages/pi-subagent` 可借鉴的决策

### P0：把一次调用升级为可恢复 run

- 建立不可变 `runId`，记录 parent session/tool call、definition 名与版本、task、resolved model/effort/capabilities、cwd、状态、时间、usage、终止原因和最终结果。
- 状态至少区分 `queued`、`running`、`waiting_permission`、`completed`、`failed`、`cancelled`、`interrupted`；不要用“是否还在 Map 中”代替领域状态。
- 每个 run 保存独立 transcript/event log；父 tool result 只存精炼结果和 run reference。

### P1：拆分 spawn、通信、wait、cancel

- 提供后台 `spawn`，父 agent 可继续做非重叠工作；completion 以持久 notification 入父 mailbox。
- 区分“不启动 turn 的 message”和“启动/继续 turn 的 follow-up”，避免一个 `send` 布尔参数同时承担排队、中断和恢复。
- 第一阶段保留显式 `cancel/close/resume`，比自动 LRU 更可预测；完成后仍可查看 transcript，但是否占并发 slot 应由 scheduler 而不是对象是否存在决定。
- `wait` 应返回结构化 wake reason，并让真实 message/result 通过 mailbox 消费；必须支持去重与重放。

### P1：统一能力与权限解析

- 计算 `effectiveCapabilities = parentUpperBound ∩ roleAllowlist ∩ runtimePolicy`，保存快照并展示；role 绝不能通过 MCP、skill 或 model config 扩大父级权限。
- 继续保留当前 pi 的显式 tool/skill allowlist，不采用“任意 session config 都是 agent schema”的开放面。
- 当前共享 cwd 的只读 agent 可继续轻量运行；写 agent 默认串行或明确声明互斥 write set，之后再评估 worktree。

### P2：agent graph 与上下文策略

- 持久化 `parentRunId → childRunId` edge 和 open/closed 状态，支持 tree view、级联取消和恢复。
- 同时保留 definition name、run ID、可选 task path；task path 只作可读定位，不作数据库主键。
- 上下文策略先支持 `none` 与 `recent_turns:N`；默认 `none` + 显式任务包。fork 时白名单化 user/developer/final assistant，过滤 reasoning、tool calls/output 和父级 orchestration hint。
- 在递归开放前增加 per-session 并发、累计 spawn、depth、token、time 五类独立预算。

### P2：结构化事件与 UI

- 用统一事件流驱动运行 widget、详情页、持久化和 hook：`run_started`、`tool_started`、`permission_requested`、`tool_finished`、`message_received`、`run_interrupted`、`run_finished`。
- TUI 提供 run list/tree、耗时、模型、最后活动、等待原因、打开 transcript、follow-up、cancel；主上下文不回灌原始日志。
- approval UI 必须带 run/agent identity；非交互时明确 fail-closed，而不是静默扩大权限。

## 不宜照搬

- **不要把 V2 当已发布标准**：它在固定源码中 stable 但默认关闭，公开参考仍只列 V1。
- **不要默认 `fork_turns=all`**：pi 当前显式任务 prompt 的隔离价值应保留。
- **不要把角色变成完整 session config layer**：会把 provider、MCP、skill、sandbox 和工具优先级耦合成难以审计的配置系统。
- **不要在共享 cwd 默认并行写**：模型提示“write set 不重叠”是协作建议，不是隔离保证。
- **不要先做递归再补预算**：树形 fan-out 会同时放大权限、成本、取消传播和恢复问题。
- **不要让 LRU 早于持久 transcript/graph**：没有可靠持久层时，unload 等于丢失。
- **不要只凭自然语言 description 自动路由**：显式授权与确定性 role 选择应优先，自动委派只能在 policy 允许后作为优化。

## 待验证问题

1. Pi SDK 当前是否支持持久 `AgentSession` 的 detach/re-attach，还是需要 `pi-subagent` 自建 transcript 与 replay？
2. 父 session reload、branch、shutdown 和进程崩溃时，后台 run 应继续、级联取消，还是标记 interrupted 后等待显式 resume？
3. Extension tool 的 `AbortSignal`、approval 和 tool events 能否携带稳定 child run identity，并在 inactive run 上交互？
4. MCP/extension tools 能否按来源而非仅按名称做 allowlist，连接是否可以限定到单个 run 生命周期？
5. 写 agent 的首选隔离是 scheduler 串行、声明 write set，还是独立 git worktree；Windows/非 git 项目如何降级？
6. mailbox notification 的至少一次交付、去重、顺序和 compaction 后重放由谁保证？
7. token/cost 数据是否能在运行中获取，以支持树级 budget，而不是只在终态统计？
8. 目标 UX 是继续保持一个高层 `agent` 工具，由扩展内部编排，还是公开 `spawn/send/wait/cancel/list`；后者会显著增加模型工具选择负担。
