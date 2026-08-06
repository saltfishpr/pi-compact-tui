# Claude Code subagents 调研

## 结论摘要

Claude Code 把 subagent 定义为主会话内的“隔离执行单元”，核心价值不是多进程本身，而是四件事的组合：独立上下文、可复用角色定义、能力/权限收窄、只把最终报告带回主上下文。当前产品又在此基础上加入默认后台执行、并发和嵌套上限、独立 transcript、恢复、生命周期 hook、持久 memory、worktree 隔离以及可观察/可干预的 TUI。[官方 subagents 文档](https://code.claude.com/docs/en/sub-agents)（访问于 2026-08-06）

对 `packages/pi-subagent` 最值得借鉴的演进顺序是：

1. 先把一次性内存会话升级为具有稳定 `runId`、明确状态机和独立 transcript 的运行实体；
2. 再支持受控并发、后台运行、查看/取消、部分结果和可恢复 follow-up；
3. 同时建立父会话能力上界、agent allow/deny、权限请求转发和结构化生命周期事件；
4. 最后再考虑嵌套、worktree、持久 memory 和动态 MCP 等高复杂度能力。

不宜直接照搬 Claude Code 的部分包括：由模型通过自由文本描述决定自动路由、快速变化且依赖大量版本条件的配置面、依赖私有 CLI 内核的隐含行为，以及默认允许多层嵌套的大扇出。

## 研究快照与证据边界

- 调研日期：2026-08-06。
- Claude Code 公共仓库快照：commit [`5cf69b18c86d0224dc53815332bbd85574b97097`](https://github.com/anthropics/claude-code/tree/5cf69b18c86d0224dc53815332bbd85574b97097)，`CHANGELOG.md` 顶部版本为 2.1.223。[发布记录](https://github.com/anthropics/claude-code/blob/5cf69b18c86d0224dc53815332bbd85574b97097/CHANGELOG.md#L1-L23)
- Claude Agent SDK Python 快照：commit [`71142da6e118dd113d82fc3fd549e4a2ba465973`](https://github.com/anthropics/claude-agent-sdk-python/tree/71142da6e118dd113d82fc3fd549e4a2ba465973)，版本 0.2.131，内置 CLI 2.1.223。[SDK 发布记录](https://github.com/anthropics/claude-agent-sdk-python/blob/71142da6e118dd113d82fc3fd549e4a2ba465973/CHANGELOG.md#L1-L7)

### Claude Code 客户端源码是否公开

不能把 `anthropics/claude-code` 公共仓库当成 Claude Code 客户端源码。该快照根目录只有 README、CHANGELOG、许可证、示例、插件和仓库维护脚本；README 明确只说仓库包含可扩展 Claude Code 的插件，并把 bug 提交到该仓库，没有给出 CLI 实现入口。[README](https://github.com/anthropics/claude-code/blob/5cf69b18c86d0224dc53815332bbd85574b97097/README.md#L48-L54) 其许可证仅为 “All rights reserved” 和商业条款，而不是开源许可证。[LICENSE](https://github.com/anthropics/claude-code/blob/5cf69b18c86d0224dc53815332bbd85574b97097/LICENSE.md#L1)

因此，本报告对 Claude Code 客户端内部的数据结构、调度算法和进程模型不作源码级断言。客户端行为以官方文档和 CHANGELOG 为依据；可验证的实现映射来自 MIT 许可、公开源码的 Agent SDK Python。[SDK LICENSE](https://github.com/anthropics/claude-agent-sdk-python/blob/71142da6e118dd113d82fc3fd549e4a2ba465973/LICENSE#L1-L13)

## 产品定位与用户体验

Claude Code 把 subagent 定位为主会话中的短期委派者：在独立上下文完成聚焦子任务，主会话只接收总结。官方列出的价值是减少主上下文污染、限制工具、复用项目/用户级角色、用专门系统提示词塑造行为，以及把简单任务路由到更便宜的模型。它与 agent teams 的边界是：subagent 隶属于一个会话并向父级返回结果；需要独立会话之间直接通信时才使用 teams。[官方定位](https://code.claude.com/docs/en/sub-agents)（访问于 2026-08-06）

产品内置 Explore、Plan、general-purpose 等 agent。Explore/Plan 偏只读搜索，general-purpose 可处理包含修改的多步任务。用户既可以让 Claude 根据 `description` 自动委派，也可以自然语言点名、用 `@` mention 保证运行指定 agent，或用 `claude --agent <name>` 把整场主会话切换为该角色。[内置 agent 与调用方式](https://code.claude.com/docs/en/sub-agents#built-in-subagents)（访问于 2026-08-06）

当前 2.1.198 之后，`/agents` 不再提供创建向导，而是提示用户让 Claude 写文件或直接编辑 `.claude/agents/`；运行时委派在 transcript 中显示为带 agent 名称和任务摘要的工具调用行。这个取舍说明“定义即文本文件”比维护复杂 CRUD UI 更重要，但运行实例仍需要一等 UI。[创建体验](https://code.claude.com/docs/en/sub-agents#quickstart-create-your-first-subagent)（访问于 2026-08-06）

## 定义、发现与配置

### 定义格式与作用域

文件型 agent 使用 YAML frontmatter 加 Markdown body；body 是 agent 系统提示词。必须字段只有 `name` 和 `description`。当前可选字段包括 `tools`、`disallowedTools`、`model`、`permissionMode`、`maxTurns`、`skills`、`mcpServers`、`hooks`、`memory`、`effort`、`background`、`isolation`、`color` 等。[字段表](https://code.claude.com/docs/en/sub-agents#supported-frontmatter-fields)（访问于 2026-08-06）

发现范围和优先级从高到低为：组织 managed settings、当前进程 `--agents`、项目 `.claude/agents/`、用户 `~/.claude/agents/`、插件 `agents/`。项目发现会从 cwd 向仓库根逐层扫描，离 cwd 最近的同名定义优先；用户/项目目录递归扫描；插件子目录会进入其带冒号的 scoped name。[作用域与优先级](https://code.claude.com/docs/en/sub-agents#choose-the-subagent-scope)（访问于 2026-08-06）

运行中的客户端会 watch 已存在的用户/项目 agents 目录，文件修改通常数秒内生效；若 session 启动时目录尚不存在，首次创建目录后仍需重启。CLI `--agents` 和 SDK `agents` 则适合会话级、动态定义。[文件热加载](https://code.claude.com/docs/en/sub-agents#write-subagent-files)（访问于 2026-08-06）

### 路由

agent 的 `description` 同时承担目录展示和模型路由提示。Claude 会结合当前任务、对话上下文和 description 决定是否委派；`@` mention 才是确定性选择。插件 agent 使用 scoped name，正在运行的命名后台 agent 也会进入 mention 补全并显示状态。[调用与路由](https://code.claude.com/docs/en/sub-agents#invoke-subagents-explicitly)（访问于 2026-08-06）

对 pi 的含义：agent catalog 应把“展示元数据”和“路由策略”分开。description 可继续进入模型工具说明，但显式 `name` 调用必须确定性；未来若做自动路由，应增加机器可校验的适用条件或策略层，不要让 description 成为唯一控制面。

## 前台、后台、并发与嵌套

- 前台 subagent 阻塞父会话，权限请求同步转交用户。
- 自 2.1.198 起，subagent 默认后台运行；父 agent 确实需要结果再继续时可要求前台。用户也可指定前/后台，或用 `Ctrl+B` 把运行中的任务切到后台。
- 后台结果通过后续 completion notification 进入父会话；完成实例会暂留 `/tasks`，可打开详情。后台功能可整体禁用。[前后台行为](https://code.claude.com/docs/en/sub-agents#run-subagents-in-foreground-or-background)（访问于 2026-08-06）

并发和递归不是无限的。2.1.223 时默认每会话最多累计 spawn 200 个、同时运行 20 个；两者均可通过环境变量调整但不能关闭累计上限。默认允许自主嵌套到主会话下三层，达到深度后移除/拒绝 `Agent` 工具；可在 agent 工具配置里禁用继续委派。[会话上限](https://code.claude.com/docs/en/sub-agents#session-subagent-limit)、[并发上限](https://code.claude.com/docs/en/sub-agents#concurrent-subagent-limit)、[嵌套规则](https://code.claude.com/docs/en/sub-agents#let-subagents-spawn-their-own-subagents)（均访问于 2026-08-06）

这些限制来自真实故障压力而非纯产品设计：CHANGELOG 曾专门加入默认 20 并发上限、每会话 200 次上限、后台预算停止、嵌套深度调整等保护。[Claude Code CHANGELOG](https://github.com/anthropics/claude-code/blob/5cf69b18c86d0224dc53815332bbd85574b97097/CHANGELOG.md)

对 pi 的含义：在实现后台前就应定义 `queued/running/waiting_permission/completed/failed/cancelled` 状态、并发信号量、每会话 spawn budget 和嵌套 depth；不要先开放任意 `Promise.all` 再补限流。

## 上下文、工具、模型与权限隔离

### 上下文

普通 subagent 从全新上下文启动，不继承父会话历史、父级已经读过的文件或已调用 skill；父 agent 生成一条委派消息。它会收到自己的系统提示词、任务消息、通常会加载的 CLAUDE.md 层级、父会话启动时的 git status，以及显式预载 skill。Explore/Plan 特意跳过 CLAUDE.md 和 git status。fork 是例外：它复制父会话完整历史、系统提示词、工具和模型，但自己的工具输出仍只在 fork 内，最后仅返回结果。[启动上下文](https://code.claude.com/docs/en/sub-agents#what-loads-at-startup)、[fork 对比](https://code.claude.com/docs/en/sub-agents#how-forks-differ-from-named-subagents)（访问于 2026-08-06）

### 工具与 MCP

默认工具池先从父会话可用的内置工具和 MCP 工具继承，再应用全体 subagent 过滤器和后台过滤器；`tools` 是 allowlist，`disallowedTools` 是 denylist。AskUserQuestion、主会话终止、部分 plan/workflow/task 工具不会下放；后台 agent 的内置工具集合进一步收窄。fork 则继承父级完整工具池。[工具过滤](https://code.claude.com/docs/en/sub-agents#available-tools)（访问于 2026-08-06）

`mcpServers` 既可引用父会话已有连接，也可声明只在该 subagent 生命周期内连接的 inline server；后者避免 MCP 工具描述占用父上下文。组织级 MCP 限制仍覆盖 subagent。[MCP 隔离](https://code.claude.com/docs/en/sub-agents#scope-mcp-servers-to-a-subagent)（访问于 2026-08-06）

### 模型与推理

agent 可指定别名、完整模型 ID 或 `inherit`。解析还受环境变量、单次调用 override 和组织 `availableModels` 影响；不可用模型可能回落到允许的家族版本或父模型。自 2.1.198 起，subagent 继承父会话 extended thinking 开关，但 agent 可单独设置 effort；上下文窗口大小仍由实际 subagent 模型决定。[模型解析](https://code.claude.com/docs/en/sub-agents#choose-a-model)、[上下文差异](https://code.claude.com/docs/en/sub-agents#what-loads-at-startup)（访问于 2026-08-06）

### 权限与工作区

subagent 继承父会话权限上下文，并可声明 `default`、`acceptEdits`、`auto`、`dontAsk`、`bypassPermissions`、`plan` 等模式；但父级的高权限模式或组织政策可以优先。自 2.1.186 起，后台 agent 的权限请求会带 agent 身份显示在主会话，用户可以允许或拒绝单次调用，而无需停止整个 agent。[权限模式](https://code.claude.com/docs/en/sub-agents#permission-modes)、[后台权限交互](https://code.claude.com/docs/en/sub-agents#run-subagents-in-foreground-or-background)（访问于 2026-08-06）

`isolation: worktree` 为 agent 创建临时 git worktree；近期发布记录持续修复通过 cwd、`git -C`、`GIT_DIR` 等方式逃逸回主 checkout 的问题，说明工作树隔离必须在路径解析、shell 命令和 git 参数多个层次同时执法，不能只改变 cwd。[隔离修复记录](https://github.com/anthropics/claude-code/blob/5cf69b18c86d0224dc53815332bbd85574b97097/CHANGELOG.md#L25-L28)

对 pi 的含义：子 agent 的能力必须是 `parentCapabilities ∩ definitionCapabilities ∩ runtimePolicy`，绝不能因 agent frontmatter 扩权；MCP、skills、文件写入、shell 和嵌套 spawn 都应进入同一能力解析结果，并在启动前报告零工具或未知工具错误。

## 持久化、恢复与 memory

每个 subagent 有独立 JSONL transcript，路径为父 session 目录下 `subagents/agent-{agentId}.jsonl`。主会话 compaction 不改写这些文件；恢复父 session 后仍可继续对应 subagent；默认按 `cleanupPeriodDays`（30 天）清理。subagent 自身也支持自动 compaction。[transcript 生命周期](https://code.claude.com/docs/en/sub-agents#resume-subagents)（访问于 2026-08-06）

每次新调用默认产生新实例。可恢复实例拥有之前完整对话、工具调用、结果和 reasoning；Explore/Plan 是一次性 agent，不返回可恢复 ID。交互端由 Claude 用 `SendMessage` 携 agent ID/name 恢复；SDK 需要同时保留 parent session ID 和 Agent 工具结果中的 agent ID，再 resume 父 session 发起 follow-up。[恢复语义](https://code.claude.com/docs/en/sub-agents#resume-subagents)、[SDK 恢复流程](https://code.claude.com/docs/en/agent-sdk/subagents#resume-subagents)（访问于 2026-08-06）

`memory` 与 transcript 是不同机制：`user/project/local` memory 给同名 agent 一个跨会话目录，启动时注入 `MEMORY.md` 前 200 行或 25KB，并自动补充 Read/Write/Edit 以维护记忆；它不是精确重放一次 run，而是长期知识沉淀。[持久 memory](https://code.claude.com/docs/en/sub-agents#enable-persistent-memory)（访问于 2026-08-06）

对 pi 的含义：应先区分三个 ID/存储概念：agent definition name、run ID、parent session ID；优先实现 run transcript 和 follow-up resume，再考虑按 definition name 共享的 memory。当前 `SessionManager.inMemory()` 不足以支持可靠查看、恢复、崩溃恢复和审计。

## 生命周期与 hooks

Claude Code 有两层 hook：agent frontmatter 中的 hook 只在该定义运行时存在；settings/managed/plugin hook 在所有 subagent 内生效。工具级 `PreToolUse`、`PostToolUse` 等事件也会为 subagent 工具调用触发，并带 agent 身份。项目 agent 的 frontmatter hook 只有在工作区受信任后才执行。[agent-scoped hooks](https://code.claude.com/docs/en/sub-agents#define-hooks-for-subagents)（访问于 2026-08-06）

会话级 `SubagentStart` 提供 `agent_id` 和 `agent_type`，不能阻止启动但可注入 `additionalContext`；`SubagentStop` 还提供独立 transcript 路径和最后一条 assistant 文本，并可返回 block/reason 让 agent 继续工作。官方 SDK 类型也明确把并行 subagent 的工具 hook 通过 `agent_id`/`agent_type` 归因，因为事件会在同一控制通道交错。[hooks 官方参考](https://code.claude.com/docs/en/hooks#subagentstart)、[SDK 类型声明](https://github.com/anthropics/claude-agent-sdk-python/blob/71142da6e118dd113d82fc3fd549e4a2ba465973/src/claude_agent_sdk/types.py#L287-L309)

对 pi 的含义：不要把 hook 等同于 UI callback。应先定义内部结构化事件 `run_started/tool_started/tool_finished/permission_requested/compacted/run_finished/run_failed/run_cancelled`，每条均带 parent session、run、agent definition 和 tool call ID；外部 hook、TUI 和持久化都订阅同一事件流。

## UI、结果与可观察性

Claude Code 在主 transcript 中把委派显示为 Agent 工具调用；后台 run 出现在输入框下的 agent panel 和 `/tasks`，可打开某个实例 transcript、发送 follow-up、查看层级树和状态。嵌套树会显示 descendant 数量；fork/subagent 详情视图可用键盘选择、打开、停止或返回主输入。[运行 UI](https://code.claude.com/docs/en/sub-agents#observe-and-steer-running-forks)（访问于 2026-08-06）

最终报告在进入父模型前会进行 prompt-injection 形态扫描；扫描不会删改语义内容，但会转义伪造系统/对话边界，并向父级加入来源不可信提醒。这是“只回传 summary”仍然需要安全边界的重要证据。[结果扫描](https://code.claude.com/docs/en/sub-agents#subagent-output-scanning)（访问于 2026-08-06）

Agent SDK 中可通过 Agent/旧 Task `tool_use` 检测启动，内部消息带 `parent_tool_use_id`；当前仍存在新旧名称并存的兼容面。SDK 还公开 `list_subagents()` 和 `get_subagent_messages()`，可按父 session/agent ID 读取独立 transcript。[SDK 检测文档](https://code.claude.com/docs/en/agent-sdk/subagents#detect-subagent-invocation)、[SDK transcript 源码](https://github.com/anthropics/claude-agent-sdk-python/blob/71142da6e118dd113d82fc3fd549e4a2ba465973/src/claude_agent_sdk/_internal/sessions.py#L1281-L1334)

对 pi 的含义：现有“运行中 widget + 完成后折叠摘要”是合适起点，但下一步应加入稳定 run row、状态/耗时/模型/用量、打开独立 transcript、取消、等待权限、部分输出和失败原因；父上下文只接收精炼 final result，TUI 详情从 transcript/event store 读取，避免把所有过程消息塞回主 session。

## 错误、取消与限制

Claude Code 区分前后台 API 错误：前台若已有文本则返回部分输出并标注未完成，否则明确失败；后台标记 failed，同时保留最后输出，底层问题恢复后可 retry/resume。[API 错误语义](https://code.claude.com/docs/en/sub-agents#api-errors-in-subagents)（访问于 2026-08-06）

用户可停止选中的运行实例，也可整体停止后台 agent；SDK `ClaudeSDKClient.interrupt()` 提供会话级中断，`ResultMessage.terminal_reason` 区分 completed、max turns、流式中断和工具中断。[SDK interrupt 源码](https://github.com/anthropics/claude-agent-sdk-python/blob/71142da6e118dd113d82fc3fd549e4a2ba465973/src/claude_agent_sdk/client.py#L317-L321)、[SDK CHANGELOG](https://github.com/anthropics/claude-agent-sdk-python/blob/71142da6e118dd113d82fc3fd549e4a2ba465973/CHANGELOG.md#L45-L50)

主要限制和代价：

- 普通 subagent 不知道父会话细节，委派 prompt 缺上下文会直接降低质量；fork 虽解决上下文传递，但失去输入隔离并提高 token 成本。
- 并发 agent 各自消费模型调用；大量 detailed final report 仍会挤占父上下文。
- 后台权限、MCP 生命周期、嵌套、resume、compaction 和 worktree 清理之间存在大量竞态。官方 CHANGELOG 长期包含相关 race、泄漏、错误状态与路径逃逸修复，说明这是持续维护成本，而非一次性功能。[Claude Code CHANGELOG](https://github.com/anthropics/claude-code/blob/5cf69b18c86d0224dc53815332bbd85574b97097/CHANGELOG.md)
- 客户端核心非公开，无法从公共源码确认调度公平性、精确 transcript schema、崩溃恢复协议或 daemon 细节。

## Agent SDK 映射

Agent SDK 不是另一套 subagent 产品，而是把 Claude Code CLI 的 Agent 工具、控制协议和 session 存储能力暴露给应用。

| Claude Code 概念 | Python SDK 映射 | 证据 |
| --- | --- | --- |
| 动态 agent 定义 | `ClaudeAgentOptions.agents: dict[str, AgentDefinition]` | [`types.py`](https://github.com/anthropics/claude-agent-sdk-python/blob/71142da6e118dd113d82fc3fd549e4a2ba465973/src/claude_agent_sdk/types.py#L1980-L1988) |
| 定义字段 | `description`、`prompt`、tools/deny、model、skills、memory、MCP、maxTurns、background、effort、permissionMode | [`AgentDefinition`](https://github.com/anthropics/claude-agent-sdk-python/blob/71142da6e118dd113d82fc3fd549e4a2ba465973/src/claude_agent_sdk/types.py#L86-L105) |
| 启动协议 | connect 时把 dataclass 转换成字典并随 initialize control request 发送 | [`client.py`](https://github.com/anthropics/claude-agent-sdk-python/blob/71142da6e118dd113d82fc3fd549e4a2ba465973/src/claude_agent_sdk/client.py#L220-L240) |
| 文件型 agent | 通过 `setting_sources` 显式选择 filesystem settings；程序化同名定义优先 | [SDK 文档](https://code.claude.com/docs/en/agent-sdk/subagents#filesystem-based-definition-alternative) |
| 观察执行 | Agent/Task tool block + `parent_tool_use_id`；hook 输入含 agent identity | [SDK 文档](https://code.claude.com/docs/en/agent-sdk/subagents#detect-subagent-invocation)、[`types.py`](https://github.com/anthropics/claude-agent-sdk-python/blob/71142da6e118dd113d82fc3fd549e4a2ba465973/src/claude_agent_sdk/types.py#L293-L309) |
| 恢复 | 保留 parent session ID 和 Agent 结果里的 agent ID，resume parent session 后点名继续 | [SDK 文档](https://code.claude.com/docs/en/agent-sdk/subagents#resume-subagents) |
| transcript 读取 | `list_subagents()`、`get_subagent_messages()`；另有 SessionStore 版本 | [`sessions.py`](https://github.com/anthropics/claude-agent-sdk-python/blob/71142da6e118dd113d82fc3fd549e4a2ba465973/src/claude_agent_sdk/_internal/sessions.py#L1281-L1390) |
| 取消 | streaming client `interrupt()`，结果带 terminal reason | [`client.py`](https://github.com/anthropics/claude-agent-sdk-python/blob/71142da6e118dd113d82fc3fd549e4a2ba465973/src/claude_agent_sdk/client.py#L317-L321) |

SDK 还暴露 SessionStore adapter 和 subagent transcript helpers，说明可插拔持久层与 transcript 查询是产品化 agent runtime 的基础接口，而不是 UI 附属功能。[SDK CHANGELOG](https://github.com/anthropics/claude-agent-sdk-python/blob/71142da6e118dd113d82fc3fd549e4a2ba465973/CHANGELOG.md#L587-L597)

## 优势

1. **上下文边界清晰**：父会话保留决策链，搜索日志和工具噪音留在子上下文。
2. **定义可移植**：Markdown + frontmatter 易于版本控制，用户、项目、插件、组织和运行时定义形成完整分发层级。
3. **能力控制丰富**：工具/MCP/skill/model/权限/worktree 可按 agent 收窄。
4. **运行实体完整**：后台、并发、嵌套、transcript、resume、hook、状态 UI 和部分结果共同形成可操作的生命周期。
5. **交互和 SDK 同源**：CLI 产品与 SDK 共享 Agent 工具语义，利于自动化和第三方 UI。

## 风险

1. **复杂度扩散**：配置字段、scope、版本迁移和继承优先级已经非常庞大，用户很难预测最终有效能力。
2. **安全边界容易被误判**：改变 cwd 不等于 worktree 隔离；tools allowlist 不等于 shell 内部能力隔离；summary 也可能携带 prompt injection。
3. **模型调度不确定**：description 驱动的自动委派、模型回退和前后台选择包含模型判断，难以做强 SLA。
4. **竞态面大**：后台权限、进程/流关闭、取消、compaction、resume、MCP、transcript 写入和 worktree 清理相互耦合。
5. **成本与上下文扇出**：并发和嵌套会放大 token、费用和最终报告体积；仅有限流还不足以保证收益。
6. **证据不可完全复核**：核心 CLI 非开源，第三方只能验证文档、发布说明和 SDK 边界。

## `packages/pi-subagent` 可借鉴的决策

### P0：先建立可恢复运行内核

- 为每次调用生成稳定 `runId`，保存 parent session ID、definition name/version、task、resolved model/effort/tools、状态、时间、usage、终止原因和最终结果。
- 用独立 JSONL transcript 持久化过程消息；主会话 tool result 只保存 run reference、精炼结果和摘要元数据。
- 明确定义终态和部分结果：completed、max_turns、failed、cancelled 都可携带 `partialOutput`。
- 将 AbortSignal 取消结果从通用 error 中分离，并等待资源清理完成后再发布终态。

### P1：后台、并发和可观察性一起交付

- 增加显式 `mode: foreground | background`，不要一开始由模型隐式决定默认值。
- 加全局/每会话并发上限和 spawn budget；先默认禁止嵌套。
- TUI 用 run list 展示 queued/running/waiting/completed/failed/cancelled、耗时、模型和最后活动；支持打开 transcript、取消、清理、follow-up。
- 完成通知只触发父 agent 在后续 turn 消费真实结果；绝不根据“仍运行”状态让模型推测结论。

### P1：统一能力和权限解析

- effective capabilities 取父会话能力、agent 声明和运行时策略的交集。
- 增加 `disallowedTools` 或等价 deny 层、未知工具启动前失败、agent spawn allowlist。
- 后台权限请求进入 `waiting_permission`，携 run ID 回主 TUI；提供单次 allow/deny，拒绝不等于取消 run。
- 将 skills/MCP/文件系统/shell/worktree 都纳入同一解析与审计模型。

### P2：恢复与生命周期事件

- follow-up API 直接接收 `runId`，不让模型从自由文本解析 ID。
- 定义结构化 lifecycle event stream，并允许 TUI、存储和 hook 独立订阅。
- 恢复时使用创建 run 时冻结的 agent definition 快照，避免同名文件变更后语义漂移；同时在 UI 显示当前定义已变化。
- parent compaction 只保留 run 摘要和引用，subagent transcript 独立保存。

### P3：高级隔离和记忆

- worktree 必须等 pi runtime 能同时约束工具路径、shell cwd 和 git 重定向后再开放。
- memory 与 transcript 分层：transcript 用于精确恢复，memory 用于按定义共享的长期知识。
- 嵌套默认关闭；若开放，设置小深度、每 run 子节点上限、全会话预算，并在 TUI 中展示完整树。

## 不宜照搬

- **不要默认后台**：当前 pi 还没有完整权限转发、持久状态和恢复协议，先让用户/模型显式选择。
- **不要默认三层嵌套**：对小型 extension，收益不足以覆盖成本、错误传播和 UI 复杂度。
- **不要复制全部 frontmatter**：优先保留能在 pi runtime 中精确执法的字段；无法保证的 permission/MCP/worktree 字段宁可暂不接受。
- **不要把 description 当调度器**：保留确定性的 tool schema，自动路由只作为建议层。
- **不要依赖临时文件保存重要结果**：临时目录不具备 session 生命周期、清理策略和 crash durability。
- **不要把独立上下文误称为安全沙箱**：上下文、权限、文件系统和进程隔离必须分别建模。
- **不要照抄 Claude Code transcript schema**：其 CLI 核心与格式稳定性不可由公共源码保证；pi 应定义自己的版本化 schema。

## 待验证问题

1. pi extension API 是否允许后台 tool call 在父 turn 结束后继续持有 session/UI 生命周期，还是需要独立 task manager？
2. `SessionManager` 是否支持安全创建和附着独立持久 transcript，并在分支、resume、compaction 时保留引用？
3. pi 的权限请求是否能携 subagent run identity 转发到主 TUI，并在父 agent 正在生成时异步处理？
4. `createAgentSession` 的工具执行、MCP 连接和 abort 是否有“取消已确认、资源已释放”的完成信号？
5. 主 session tool result 在后台任务未完成时应采用何种协议，才能避免模型伪造结果或反复 spawn？
6. agent definition 热更新后，恢复旧 run 应冻结旧定义、迁移到新定义还是要求用户选择？
7. transcript 的保留期、敏感信息、删除级联、跨分支可见性和磁盘配额如何定义？
8. 并发模型调用是否受 provider rate limit、全局预算和 session cost budget 统一约束？
9. pi 的 read/edit/bash 工具能否真正绑定 worktree 根目录并阻止 git 参数/环境变量逃逸？
10. subagent final result 是否需要输出扫描、大小上限、结构化 schema 或父级二次摘要，以降低 prompt injection 和主上下文膨胀？

## 一手资料清单

- [Claude Code：Create custom subagents](https://code.claude.com/docs/en/sub-agents)，访问于 2026-08-06。
- [Claude Agent SDK：Subagents in the SDK](https://code.claude.com/docs/en/agent-sdk/subagents)，访问于 2026-08-06。
- [Claude Code hooks reference](https://code.claude.com/docs/en/hooks)，访问于 2026-08-06。
- [Claude Code 公共仓库固定快照](https://github.com/anthropics/claude-code/tree/5cf69b18c86d0224dc53815332bbd85574b97097)。
- [Claude Agent SDK Python 固定快照](https://github.com/anthropics/claude-agent-sdk-python/tree/71142da6e118dd113d82fc3fd549e4a2ba465973)。

