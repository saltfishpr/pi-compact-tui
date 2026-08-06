# tintinweb/pi-subagents 调研报告

> 调研日期：2026-08-06  
> 目的：为 `packages/pi-subagent` 的产品与实现演进提供决策依据。

## 1. 快照与范围

- 上游仓库：`https://github.com/tintinweb/pi-subagents.git`。
- 本地源码：`/private/tmp/tintinweb-pi-subagents`。
- 调研 HEAD：[`2966cd5a33c0640de9698b56a39c11f83207a835`](https://github.com/tintinweb/pi-subagents/tree/2966cd5a33c0640de9698b56a39c11f83207a835)，提交时间 2026-07-31，提交说明为 `feat(agents): add fallbackSubagent for fail-closed dispatch (#183)`。
- `package.json` 版本仍为 `0.14.3`，HEAD 比 `v0.14.3` 多 3 个提交：前台结果语义修复、嵌套 subagent、`fallbackSubagent`。因此本文把嵌套 delegation 和可配置失败关闭标为“master 未发布能力”，不能直接视为 npm 稳定版合同。[来源：版本与依赖](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/package.json#L2-L31)，[来源：Unreleased 发布说明](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/CHANGELOG.md#L8-L16)，[来源：v0.14.3 发布说明](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/CHANGELOG.md#L18-L25)
- 资料范围只使用该仓库的一手资料：README、CHANGELOG、源码、类型、测试与 manifest；所有 GitHub 链接都固定到上述 commit。

## 2. 结论摘要

`tintinweb/pi-subagents` 不是一个“小型 spawn 工具”，而是一套完整的 subagent 产品层：它把独立 `AgentSession`、前后台执行、并发队列、结果通知、会话查看与 steering、自定义 agent、模型/工具/extension 选择、转录、调度、内存、worktree、事件总线和跨 extension RPC 组合成同一扩展。它追求 Claude Code 风格的交互，但大量能力已超过简单的 Claude Code 仿制。[来源：产品定位与功能清单](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/README.md#L1-L34)

对 `packages/pi-subagent` 最值得借鉴的不是功能数量，而是以下边界：

1. 将“agent 定义”“调用时策略”“运行记录”分成三个模型，并明确 frontmatter 与调用参数的优先级。[来源：调用配置归并](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/invocation-config.ts#L3-L35)
2. 每个 subagent 使用独立 `AgentSession`，但由一个 root manager 统一拥有生命周期、并发、取消和结果消费。[来源：会话创建](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/agent-runner.ts#L830-L900)，[来源：manager 状态模型](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/agent-manager.ts#L124-L160)
3. 区分人类 UI 数据与父 agent 可解析的数据：同一次后台完成既渲染主题化卡片，也向 LLM 发送结构化 `<task-notification>`。[来源：通知格式](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/index.ts#L149-L178)，[来源：通知发送](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/index.ts#L318-L369)
4. 把“上下文隔离”“工具隔离”“extension 隔离”“工作区隔离”“磁盘留痕”作为不同维度，不能用一个 `isolated` 布尔值笼统表达。[来源：AgentConfig 维度](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/types.ts#L23-L72)，[来源：转录设置边界](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/settings.ts#L87-L104)

其最大风险也来自功能面过宽：运行时全局状态多、生命周期耦合重；“read-only”默认 agent 仍拥有 `bash`；extension 过滤不是安全沙箱；worktree 是冲突隔离而不是权限隔离；所谓 session resume 实际依赖进程内 `AgentRecord`，并未从持久化 session 自动重建 manager 记录。[来源：默认只读 agent 工具](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/default-agents.ts#L9-L40)，[来源：extension 过滤边界](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/agent-runner.ts#L597-L625)，[来源：resume 查找条件](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/agent-manager.ts#L496-L526)

## 3. 产品定位与用户体验

### 3.1 核心交互

父 agent 通过 `Agent` 工具发起任务，必填 `prompt`、短 `description`、`subagent_type`；可选模型、thinking、turn limit、后台执行、resume、`isolated`、父上下文继承、worktree 和 schedule。前台调用阻塞并内联返回最终结果；后台调用立即返回 agent ID，完成后主动触发后续 turn，而不是要求父 agent 轮询。[来源：工具 schema](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/index.ts#L898-L962)，[来源：后台返回合同](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/index.ts#L1233-L1315)，[来源：前台返回合同](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/index.ts#L1318-L1428)

父 agent 另有两个工具：`get_subagent_result` 支持非阻塞检查、可取消的等待和完整对话输出；`steer_subagent` 将一条用户消息注入正在运行的 session，并返回当前 token、工具次数、上下文占用和 compaction 状态。[来源：结果工具](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/index.ts#L1432-L1515)，[来源：steer 工具](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/index.ts#L1517-L1568)

### 3.2 人类管理界面

- `Agent` 调用自身提供流式 spinner、turn/tool/token/activity 状态和折叠/展开结果。[来源：工具渲染](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/index.ts#L964-L1050)
- above-editor widget 可选 `all`、`background`、`off`；默认只显示后台任务，避免和前台工具结果重复。[来源：widget 模式](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/types.ts#L75-L84)，[来源：过滤实现](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/ui/agent-widget.ts#L231-L259)
- FleetView 在编辑器下方列出 `main` 与可打开的 agent；空输入框时用方向键进入，`Enter` 打开实时对话。它只展示已经拥有 session 的任务，完成项保留 4 秒；最多直接展示 5 个 agent 行。[来源：FleetView 行为与常量](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/ui/fleet-list.ts#L1-L28)，[来源：列表筛选](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/ui/fleet-list.ts#L178-L200)，[来源：键盘导航](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/ui/fleet-list.ts#L209-L259)
- ConversationViewer 实时订阅 session，支持滚动、内联撰写 steering 消息和两次按 `x` 确认停止，降低误杀风险。[来源：viewer 订阅与输入](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/ui/conversation-viewer.ts#L23-L94)
- `/agents` 是 agent 类型、运行实例、scheduled jobs 与 settings 的统一入口；还支持创建、自定义、eject 默认 agent 等管理动作。[来源：菜单入口](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/index.ts#L1605-L1663)

### 3.3 产品设计评价

优点是可观察性完整，用户能看到“正在做什么、花了多少、上下文是否快满、能否干预”，而不只看到一个 opaque promise。缺点是同时存在工具结果、widget、FleetView、viewer、完成通知和 `/agents` 菜单六个 surface，状态一致性和键盘冲突成本显著增加。FleetView 已需要窥探 TUI 私有 `focusedComponent` 来避免截获对话框按键，这说明 UI 集成已触及上游非公开边界。[来源：FleetView focus 判断](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/ui/fleet-list.ts#L220-L272)

## 4. Agent 定义、发现与配置

### 4.1 定义与发现

自定义 agent 是带 YAML frontmatter 的 Markdown 文件，文件名就是类型名，正文是 system prompt。发现优先级为：

1. `<cwd>/.pi/agents/*.md`
2. `<cwd>/.agents/agents/*.md`
3. `$PI_CODING_AGENT_DIR/agents/*.md`

加载顺序从低到高覆盖，因此 `.pi/agents` 最终胜出；同名自定义 agent 可覆盖内建 agent。文件按 spawn 前重新加载，无需重启，但工具 schema 中的类型列表是在注册时生成，可能直到下一会话才更新。[来源：发现实现](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/custom-agents.ts#L11-L33)，[来源：spawn 前 reload](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/index.ts#L1054-L1060)，[来源：schema 类型描述](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/index.ts#L909-L918)

### 4.2 内建 agent

内建类型为 `general-purpose`、`Explore`、`Plan`。`general-purpose` 继承父 system prompt，拥有全部内建工具；Explore 和 Plan 使用独立 prompt，工具集合为 `read, bash, grep, find, ls`，其中 Explore 默认尝试 Haiku，模型不可用时回退父模型。[来源：默认 agent 配置](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/default-agents.ts#L9-L40)，[来源：Plan 配置](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/default-agents.ts#L73-L125)

### 4.3 配置维度与优先级

frontmatter 覆盖工具、extension、skills、memory、模型、thinking、max turns、session 持久化、转录、nested allowlist、prompt mode、上下文继承、后台默认值、extension 隔离、worktree 和 enabled 状态。[来源：frontmatter 映射](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/custom-agents.ts#L56-L86)

调用配置采用 `agentConfig.field ?? params.field ?? default`。这意味着自定义 agent 明确写在 frontmatter 的 `model`、thinking、max turns、inherit context、background、isolated、worktree 会锁定策略，调用参数只填补空缺；内建 agent 刻意不写调用策略字段，允许调用方选择。[来源：优先级实现](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/invocation-config.ts#L13-L35)，[来源：默认配置注释](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/default-agents.ts#L11-L26)

配置注册表支持大小写不敏感查找，但 master 对“大小写歧义的两个 agent”不再猜测。新的 `fallbackSubagent` 可指定 fallback agent，或设为 `none` 失败关闭；未配置仍沿用 `general-purpose` fallback。需要注意：这是 HEAD 的 Unreleased 能力。[来源：严格解析与 fallback](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/agent-types.ts#L123-L150)，[来源：dispatch 策略](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/agent-types.ts#L153-L218)

### 4.4 持久设置

运行设置采用 global + project 双层 JSON：`<agentDir>/subagents.json` 提供全局默认，`<cwd>/.pi/subagents.json` 覆盖。字段会逐项校验，损坏文件警告后忽略，菜单只写 project 文件。[来源：设置路径与合并](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/settings.ts#L226-L268)，[来源：字段校验](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/settings.ts#L144-L223)

## 5. 执行与并发模型

### 5.1 单个 agent

每次新调用创建一个独立 `AgentSession`，配置自己的 cwd、session manager、settings manager、model、tools、custom tools 和 resource loader；随后 bind extensions、订阅事件并调用 `session.prompt()`。因此隔离单位是真实 session，不是父 session 中的一段临时 prompt。[来源：session 构造](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/agent-runner.ts#L830-L900)，[来源：执行循环](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/agent-runner.ts#L902-L973)

`AgentManager` 保存所有 `AgentRecord`。新 agent 获得 UUID、独立 `AbortController`、usage accumulator、compaction count、session、promise、状态和可选 worktree/transcript 元数据。[来源：AgentRecord 类型](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/types.ts#L86-L148)，[来源：record 创建](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/agent-manager.ts#L166-L224)

### 5.2 并发与排队

- 默认只允许 4 个顶层后台 agent 同时运行；超出的进入 FIFO 队列，完成后 drain。前台 agent 不占后台池、直接运行。[来源：并发常量与池判断](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/agent-manager.ts#L25-L61)，[来源：队列分支](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/agent-manager.ts#L208-L224)，[来源：drain](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/agent-manager.ts#L437-L453)
- 同一父 turn 内的多个后台调用通过 100ms debounce 识别为一批。`smart`/`group` 模式把完成通知合并；首个完成后最多等 30 秒，超时先发 partial batch，straggler 后续按 15 秒重组。[来源：batch 识别](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/index.ts#L654-L686)，[来源：group join](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/group-join.ts#L23-L117)
- scheduled agent 使用 `bypassQueue: true`，不会被 `maxConcurrent` 延后；这也意味着计划任务可以突破手动任务的总并发上限。[来源：scheduler 设计](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/schedule.ts#L1-L15)，[来源：spawn 参数](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/schedule.ts#L240-L259)
- master 的 nested child 也不占顶层池，避免父 agent 持有 slot 又等待 child 导致死锁；深度有限但宽度不受 `maxConcurrent` 约束，因此 fan-out 仍可能无界。[来源：nested 池语义](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/agent-manager.ts#L50-L60)

### 5.3 Nested delegation（master 未发布）

只有 agent frontmatter 明确设置 `allowed_subagents`，且未启用 `isolated`、未到深度上限时，runner 才注入 ownership-scoped 的 `Agent`、`get_subagent_result`、`steer_subagent`。默认最大深度为 2，主 session 计 0。[来源：注入条件](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/agent-runner.ts#L748-L770)，[来源：深度设置](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/nested-tools.ts#L38-L49)

子 agent 类型严格按 allowlist 解析，不应用 top-level fallback；result/resume/steer 都检查 `parentAgentId` 所有权。父 agent 结束时 manager 会停止它拥有的 child，防止不可见任务继续烧 token。[来源：allowlist 与所有权](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/nested-tools.ts#L142-L215)，[来源：父结束清理](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/agent-manager.ts#L425-L435)

## 6. 上下文、工具、模型与权限隔离

### 6.1 上下文

`prompt_mode: append` 复制父 system prompt，再附加 subagent bridge、`active_agent` 标签、环境和 agent 指令；`replace` 则用独立身份与自定义 prompt。`append` 把父 prompt 放在字节前缀位置，明确以 KV cache 复用为优化目标。[来源：prompt builder](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/prompts.ts#L15-L27)，[来源：append/replace 实现](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/prompts.ts#L58-L99)

`inherit_context` 不是复制原始 session 对象，而是把当前 branch 的 user/assistant 文本与 compaction summary 序列化后前置到任务 prompt；tool results 被跳过以减小体积。[来源：上下文抽取](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/context.ts#L15-L57)，[来源：注入位置](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/agent-runner.ts#L949-L965)

runner 主动设置 `noContextFiles: true` 和空 `appendSystemPromptOverride`，阻止上游再次注入 AGENTS.md/CLAUDE.md/APPEND_SYSTEM.md。要继承项目规则必须选 append，或者显式继承父对话。[来源：resource loader 配置](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/agent-runner.ts#L597-L665)

### 6.2 工具与 extension

内建工具是从 pi 的 tool factories 动态获取名称，不硬编码。自定义 agent 的 `tools:` 可选内建工具、`ext:<extension>` 或 `ext:<extension>/<tool>`，`disallowed_tools` 最后执行 deny。[来源：内建工具发现](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/agent-types.ts#L12-L22)，[来源：tools 解析](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/custom-agents.ts#L139-L155)

extension 工具可能在 `session_start` 或 `before_agent_start` 异步注册，因此非 isolated session 不使用冻结的 allowlist，而用 `excludeTools` 加 live active-set narrowing；这是兼容 MCP 等延迟工具的关键复杂度。[来源：动态工具作用域设计](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/agent-runner.ts#L773-L827)，[来源：v0.14.3 修复说明](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/CHANGELOG.md#L18-L24)

`isolated: true` 强制 extensions 与 skills 为 false，并只保留内建工具；但它不隔离模型 provider/runtime，也不限制内建 `bash` 或文件工具访问进程可达的文件系统。[来源：isolated 归并](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/agent-runner.ts#L540-L545)，[来源：session 模型 runtime 与工具配置](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/agent-runner.ts#L830-L860)

重要安全边界：`extensionsOverride` 是 loader 结果过滤，不是沙箱。源码明确指出，被排除 extension 的 factory 仍会执行一次，只是不绑定 handler、不注册工具。因此不可信 extension 不能靠 `exclude_extensions` 安全化；真正不加载需要 `extensions: false` / `isolated`。[来源：过滤边界](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/agent-runner.ts#L597-L650)

另一个风险是 Explore/Plan 虽被产品称为 read-only，却拥有 `bash`。写保护依靠 system prompt 禁止变更，而不是命令级 allowlist 或 OS sandbox；恶意/失控模型仍可用 shell 写文件。[来源：只读工具集合](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/default-agents.ts#L9-L40)，[来源：prompt 禁止规则](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/default-agents.ts#L41-L68)

### 6.3 模型

调用参数或 frontmatter 可以给精确 `provider/modelId` 或 fuzzy 名。resolver 只在已配置认证的 available models 中匹配，支持点/横线归一、日期尾缀省略和跨 provider fallback；失败时列出可用模型。[来源：model resolver](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/model-resolver.ts#L17-L99)

`scopeModels` 默认关闭。开启时，调用参数显式选择的越界模型 hard error；frontmatter 或父模型越界只 warning 并继续。更关键的是实现仅支持精确 `provider/modelId`，pi 支持的 glob、裸 ID、thinking 后缀会被静默忽略；若解析后集合为空，scope 检查成为 no-op。[来源：scope 策略](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/model-scope.ts#L12-L69)，[来源：格式限制](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/enabled-models.ts#L12-L22)，[来源：空集合行为](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/enabled-models.ts#L101-L136)

### 6.4 工作目录与 worktree

worktree mode 在临时目录创建 detached worktree；若 agent 有变更，就 `git add -A`、使用 `--no-verify` 自动提交，再建立 `pi-agent-<id>` 分支并移除 worktree；无变更直接清理。创建失败会由 manager 报错，不会静默降级到原工作区。[来源：worktree 创建](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/worktree.ts#L40-L80)，[来源：清理与自动提交](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/worktree.ts#L83-L163)，[来源：严格失败](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/agent-manager.ts#L238-L258)

它解决的是并行修改冲突和结果交付，不是安全隔离：子进程、网络、仓库外文件访问仍由原工具权限决定；自动 `add -A` 和 `--no-verify` 还会把 agent 留下的所有 worktree 改动提交进分支。

## 7. 状态、持久化与恢复

### 7.1 进程内状态与 resume

`AgentRecord` 和 `AgentSession` 由 `AgentManager` 保存在内存 Map。完成记录 10 分钟后被清理并 dispose；session start/switch 会清理已完成且已消费的记录；shutdown 会停止所有 agent 并 dispose manager。[来源：自动清理](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/agent-manager.ts#L596-L624)，[来源：shutdown 生命周期](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/index.ts#L572-L596)

`resume` 通过 agent ID 在 manager 中找现存 record，并直接对其中的 `session` 再次 `prompt()`。`persist_session: true` 只把 child session 改用磁盘 `SessionManager.create`；代码没有读取已写入 session 并重建 `AgentRecord` 的路径。因此这里的“resume completed sessions”应理解为“当前扩展实例仍持有该 record 时继续”，不是跨进程/任意 root resume 的可靠恢复合同。这是从构造与查找路径得出的实现结论。[来源：resume 实现](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/agent-manager.ts#L496-L544)，[来源：session manager 选择](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/agent-runner.ts#L830-L835)，[来源：Agent 工具 resume 分支](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/index.ts#L1209-L1230)

完成时扩展会 `appendEntry("subagents:record", ...)`，但只用于跨 extension 历史重建；本实现没有读取这些 entry 来恢复 manager。[来源：完成记录写入](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/index.ts#L400-L420)

### 7.2 转录、内存与调度

- 默认每个 agent 把完整对话写到 OS temp 下的 JSONL `.output`；根目录强制 `0700`，可按项目或 agent 关闭。compaction 前 flush，成功 compaction 后重新锚定索引。[来源：路径与权限](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/output-file.ts#L27-L68)，[来源：流式写入](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/output-file.ts#L71-L123)
- memory 有 user/project/local 三个 scope，读取 `MEMORY.md` 前 200 行；有 write/edit 的 agent 获得读写 memory，没有写工具的 agent 只读且不会创建目录。路径和文件拒绝符号链接，但递归 `mkdirSync` 后没有逐级重新验证新建路径的每个祖先，不能等同于通用安全存储层。[来源：memory 路径与读取](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/memory.ts#L20-L117)，[来源：读写/只读 prompt](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/memory.ts#L119-L179)
- schedule 存在 `<cwd>/.pi/subagent-schedules/<sessionId>.json`，用 PID lock、重新读取、临时文件 rename 实现并发写；root `/resume` 可按相同 session ID 重新加载，`/new` 使用新文件。[来源：schedule store](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/schedule-store.ts#L1-L55)，[来源：原子 mutation](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/schedule-store.ts#L57-L103)

usage 不是调用 `getSessionStats().tokens.total`，而是在每次 assistant `message_end` 累加 input/output/cacheWrite，避免 compaction 重置并排除累计前缀导致的 cacheRead 重复计算；compaction count 也单独保存在 record。[来源：usage record 语义](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/types.ts#L115-L122)，[来源：事件累计](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/agent-runner.ts#L936-L946)

## 8. UI 与结果聚合

后台完成被转换为两种表现：LLM 收到包含 task id、tool-use id、output file、status、summary、result preview、token/tool/context/compaction/duration 的 XML；人类看到相同 details 的主题化紧凑卡片。result preview 被截断，完整内容需 `get_subagent_result` 或展开查看。[来源：XML 字段](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/index.ts#L154-L178)，[来源：renderer](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/index.ts#L232-L279)

完成通知先延迟 200ms，给 `get_subagent_result` 成功消费结果并取消冗余 nudge 的机会。group join 则把同批任务合成一次 follow-up turn，减少多个 agent 相继完成造成的父 agent 反复唤醒。[来源：通知 hold](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/index.ts#L293-L337)，[来源：group 通知](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/index.ts#L341-L369)

这种“消费状态 + 通知防重 + group timeout”模型值得借鉴，因为结果交付是 subagent 产品的核心，而不是 UI 附属功能。代价是需要非常清楚地区分：agent 已完成、父 agent 已知晓、结果已被读取、通知已发送，这四种状态并不相同。

## 9. 错误、取消与边界行为

- foreground `Agent` 接收父工具调用的 AbortSignal，父调用被 Esc 中断时 manager 停止 child；background 不转发父调用 signal，设计上允许它脱离发起该工具调用继续运行。[来源：signal wiring](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/agent-manager.ts#L266-L290)，[来源：前台传 signal](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/index.ts#L1376-L1395)
- 取消 `get_subagent_result(wait: true)` 只取消等待，不停止后台 agent，也不消费结果；正常完成通知仍会到达。[来源：等待语义](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/index.ts#L1455-L1474)
- queued agent 停止时从队列移除；running agent 触发自己的 controller。`abortAll` 在 shutdown 同时处理两类。[来源：单项停止](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/agent-manager.ts#L577-L594)，[来源：全量停止](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/agent-manager.ts#L633-L655)
- max turns 是软硬两级：到 soft limit 时 steer 一条“立即收尾”，再给默认 5 个 grace turns；仍未结束才 hard abort。结果区分 `steered`（已收尾）与 `aborted`。[来源：turn limit](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/agent-runner.ts#L902-L920)
- provider 重试耗尽可能以正常 promise resolve、最终 assistant message `stopReason: error` 的形式出现，因此 runner 显式检查最后一条 assistant message；无文本的 length stop 也算 error，带文本的 length stop 保留为有用的截断结果。[来源：最终 turn 错误分类](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/agent-runner.ts#L470-L497)
- worktree 创建失败会在 spawn 前失败，不产生 orphan record；queued agent dequeue 时还会重新校验 cwd，处理 TOCTOU。[来源：启动前校验](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/agent-manager.ts#L227-L258)，[来源：dequeue 错误](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/agent-manager.ts#L437-L452)

已知边界：scheduled fires 绕过并发池；headless 模式不等待计划任务；resume 依赖内存 record；extension filter 不阻止 factory 执行；nested 宽度无限；isolated 不是 OS sandbox。这些都需要在产品文档中作为合同明确，而不能只作为实现注释存在。[来源：schedule/headless 边界](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/README.md#L89-L93)，[来源：nested 宽度边界](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/agent-manager.ts#L50-L60)

## 10. 实现架构

主要模块职责如下：

| 模块 | 职责 |
|---|---|
| `index.ts` | 扩展入口、工具/命令注册、UI、通知、事件、settings wiring |
| `agent-types.ts` / `custom-agents.ts` | agent registry、类型解析、定义发现与 frontmatter 解析 |
| `invocation-config.ts` | frontmatter 与调用参数归并 |
| `agent-runner.ts` | resource loader、system prompt、model/tool/extension scope、session 执行、turn/usage/compaction |
| `agent-manager.ts` | record 所有权、队列、生命周期、取消、resume、worktree 清理 |
| `nested-tools.ts` | master 未发布的 ownership-scoped delegation |
| `group-join.ts` | 批量结果通知与 straggler timeout |
| `output-file.ts` / `memory.ts` / `schedule*.ts` | 三套不同的持久化用途 |
| `ui/*` | widget、FleetView、conversation viewer |

上游自己的架构清单也把入口、runner、manager、registry、memory、transcript、worktree、prompt/context 和 UI 分开。[来源：README 架构](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/README.md#L643-L666)

架构上最重要的取舍是“单 root manager + 多独立 AgentSession”。为避免 child session 再加载本扩展、创建第二套 manager，入口检测 child session context 后直接返回；nested orchestration 改由 root manager 注入 scoped custom tools。[来源：child activation guard](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/index.ts#L226-L230)，[来源：nested customTools](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/agent-runner.ts#L748-L770)

扩展还通过 `Symbol.for("pi-subagents:manager")` 和 `pi.events` RPC 对外暴露 manager 能力，并清除外部传入的 parent/depth/config root 元数据，避免调用方伪造 nested ownership。[来源：全局 registry 与清洗](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/index.ts#L466-L509)，[来源：RPC 生命周期](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/index.ts#L511-L570)

## 11. 优势

1. **完整的任务生命周期合同**：created、started、completed/failed、steered、compacted、scheduled、settings 变化都有事件，易于和其他 extension 集成。[来源：事件发射](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/index.ts#L375-L464)
2. **前后台语义明确**：前台内联依赖结果，后台返回 ID 并主动通知；等待取消不误杀任务。[来源：Agent 工具描述](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/index.ts#L821-L849)
3. **可观察性强**：实时活动、token、context%、compaction、turn limit、模型和 invocation tags 一致呈现在多个 surface。[来源：invocation tags](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/ui/agent-widget.ts#L100-L175)
4. **配置分层清楚**：agent 文件定义角色能力，`subagents.json` 定义项目运行策略，调用参数定义单次意图。[来源：frontmatter 配置](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/custom-agents.ts#L56-L86)，[来源：运行设置](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/settings.ts#L11-L119)，[来源：调用归并](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/invocation-config.ts#L13-L35)
5. **结果聚合成熟**：notification hold、防重消费、smart group 与 partial/straggler 处理兼顾 agent 唤醒次数和结果及时性。[来源：通知 hold](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/index.ts#L293-L337)，[来源：group join](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/group-join.ts#L23-L117)
6. **针对上游现实问题做了大量兼容**：异步 extension tools、provider error resolve、compaction 后 usage/transcript、旧/新 model runtime 都有专门处理。[来源：v0.14.3 修复](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/CHANGELOG.md#L18-L25)，[来源：model runtime 兼容](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/CHANGELOG.md#L27-L34)

## 12. 限制与风险

1. **功能与状态面过宽**：工具、菜单、两类 widget、viewer、RPC、scheduler、memory、transcript、worktree、nested 都共享 manager 与模块级 settings，回归矩阵很大。[来源：入口集成面](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/index.ts#L226-L290)，[来源：README 架构](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/README.md#L643-L666)
2. **权限语义不够硬**：read-only 仍有 bash；worktree 和 isolated 容易被用户误解为安全 sandbox；extension exclude 仍运行 factory。[来源：默认工具](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/default-agents.ts#L9-L40)，[来源：extension filter 边界](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/agent-runner.ts#L597-L650)
3. **并发上限不是总预算**：foreground、nested、scheduled 都可绕过顶层后台池；只限制 depth 不限制 width，也没有全局 token/cost budget。[来源：池 slot 判断](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/agent-manager.ts#L50-L60)，[来源：scheduler bypass](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/schedule.ts#L215-L259)
4. **恢复能力容易被高估**：磁盘 session、JSONL transcript、root custom entry、schedule store 是四套不同持久化，只有 schedule 明确实现 root resume 恢复；agent resume 本身依赖 manager record。[来源：session manager 选择](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/agent-runner.ts#L830-L835)，[来源：resume 查找](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/agent-manager.ts#L496-L526)，[来源：schedule store](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/schedule-store.ts#L1-L55)
5. **fallback 默认仍偏危险**：master 虽支持 fail-closed，但默认继续把未知/disabled/ambiguous 类型替换为 `general-purpose`；在后台/计划任务中可能先运行了不同权限 agent，调用者才看到 note。[来源：默认 fallback](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/agent-types.ts#L174-L218)
6. **模型 scope 不是完整策略执行器**：默认关闭、用户/父配置可越界继续、仅支持精确项、空集合 no-op。[来源：scope 策略](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/model-scope.ts#L12-L69)，[来源：解析限制](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/enabled-models.ts#L12-L22)
7. **自动 Git 副作用较重**：worktree 完成时 `add -A`、`--no-verify`、自动 commit/branch；若未来集成进较保守的产品，应改为显式结果交付策略。[来源：worktree 自动提交](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/worktree.ts#L97-L158)
8. **内部 API 依赖**：FleetView 使用 TUI 私有 focus 字段，model runtime 兼容路径也通过 facade 内部字段获取 runtime；上游升级风险高。[来源：TUI private focus](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/ui/fleet-list.ts#L262-L272)，[来源：model runtime bridge](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/agent-runner.ts#L837-L850)

## 13. 对 `packages/pi-subagent` 的可借鉴设计

建议优先级从高到低：

1. **先稳定领域模型**：至少拆出 `AgentDefinition`、`InvocationPolicy`、`AgentRun`、`ResultDelivery`，避免配置与运行状态混在一个对象中。tintinweb 的 `AgentConfig` / `AgentInvocation` / `AgentRecord` 已验证这个分层有价值。[来源：类型分层](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/types.ts#L23-L73)，[来源：Invocation 类型](https://github.com/tintinweb/pi-subagents/blob/2966cd5a33c0640de9698b56a39c11f83207a835/src/types.ts#L150-L159)
2. **建立单一生命周期 owner**：一个 manager 统一取消、queue、record retention 和 child ownership；不要让每个 UI surface 持有自己的任务真相。
3. **定义明确的结果消费状态机**：至少区分 running、terminal、delivered、consumed；后台完成用主动 follow-up，不要求 LLM 轮询。
4. **把限制建模为多个正交字段**：context mode、tool policy、extension policy、workspace mode、persistence policy、model policy 分开，并在 UI 中展示实际 resolved invocation。
5. **软 turn limit + grace + hard abort**：比直接截断更容易得到可用的 partial result，但状态必须明确标为 wrapped/partial。
6. **usage 采用 lifetime accumulator**：不能依赖会被 compaction 替换的 message 数组派生累计总量。
7. **custom agent 发现采用项目优先、全局 fallback，并支持每次 spawn reload**；同时把“schema 中的可选类型是否实时变化”作为显式决策，不要出现 UI/registry 实时而工具 schema 滞后的半动态状态。
8. **若支持 nested，默认关闭、严格 allowlist、ownership-scoped、父结束级联取消**；另外必须增加横向并发/总 token 预算，弥补 tintinweb 只限深度的缺口。
9. **为 agent 结果同时提供 machine-readable payload 与 human renderer**，避免父模型从彩色 UI 文本中猜状态。
10. **对未知 agent 类型默认 fail-closed**。若提供 fallback，应由用户显式开启，并在 spawn 前完成解析。

## 14. 不宜直接照搬

1. **不要一次性照搬六套 UI surface**。先选一个 live status surface + 一个 inspect/steer surface，验证实际使用频率后再扩展。
2. **不要把 `bash` 放进“read-only”能力集**，除非有命令审计/沙箱；prompt 禁止不是权限边界。
3. **不要把 `isolated` 设计成布尔值**。名称会让用户误以为包含网络、文件、process、secret、provider 全隔离。
4. **不要让 scheduled/nested/foreground 默认绕过所有总并发预算**。应有全局运行数、每父 fan-out、token/cost 三类上限。
5. **不要把 session 持久化等同于可恢复任务**。真正跨进程 resume 必须持久化并重建 run index、owner、resolved definition、cwd/model/tool policy 和结果消费状态。
6. **不要默认 fallback 到全工具 general-purpose**。这会把拼写错误放大为权限升级。
7. **不要默认自动 commit `-A --no-verify`**。更安全的方案是保留 worktree/patch，交由父 agent 或用户确认合并。
8. **不要把 extension 过滤宣传为安全隔离**，除非 loader 能保证被排除 factory 根本不执行。
9. **不要直接依赖上游私有字段**；若能力必须依赖 private API，应有版本 gate、feature detection 和降级路径。

## 15. 待验证问题

以下问题仅凭本仓库实现无法确认，建议在 `packages/pi-subagent` 设计前用 pi 当前安装版本做最小原型或集成测试：

1. `AgentSession` 的 extension hooks、tool active set 和 `beforeToolCall` 在当前 `@earendil-works/pi-*` fork 中是否与 tintinweb 针对的版本完全一致？
2. root session `/resume` 后，是否能通过 session entries 或 session 文件稳定重建 subagent run index，而无需保留进程内 manager？
3. pi 的 interrupt/background 机制是否已有可复用的 job abstraction，可替代本项目自建 queue、record、follow-up 防重？
4. 当前 TUI 是否提供公开的 focus/overlay/navigation API，避免 FleetView 对私有 `focusedComponent` 的依赖？
5. extension loader 能否提供“factory 不执行”的真正 allowlist，还是只能在加载后过滤？
6. model scope 是否已有官方 resolver 可直接调用，避免自行实现不完整的 exact-only 子集？
7. worktree 结果最合适的合同是 patch、branch、保留目录还是自动 commit；用户是否接受 `--no-verify`？
8. 后台完成触发的新 parent turn 在 print/headless 模式、session switch 和 shutdown 竞态下的可靠性如何？
9. transcript 中是否可能包含 secrets/tool outputs；临时目录 `0700`、重启清理和 opt-out 是否满足目标用户的合规预期？
10. nested delegation 是否真的需要首版支持；若需要，合理的默认 max depth、fan-out、总 token 与总 wall-clock budget 是什么？

## 16. 建议决策

对 `packages/pi-subagent`，建议采用“窄核心、硬边界、可扩展 surface”的路线：首阶段只实现独立 session、定义发现、前台/后台、统一 manager、取消、结果主动交付与单一 inspect UI；第二阶段再加入 steering、可靠跨进程恢复和 worktree；nested、scheduler、memory、RPC、FleetView 应分别以真实需求证明后再进入核心。

如果只选 tintinweb 的一个设计作为基线，应选择其“root manager 拥有多个独立 AgentSession + 结构化结果交付”架构；如果只避开一个问题，应避免把权限控制建立在 prompt 和命名（`read-only`、`isolated`）上。
