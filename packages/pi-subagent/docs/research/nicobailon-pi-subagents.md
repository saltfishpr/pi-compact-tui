# nicobailon/pi-subagents 调研

## 结论摘要

`nicobailon/pi-subagents` 已不是一个简单的“启动子进程并收集文本”扩展，而是一套建立在 Pi 子进程之上的代理编排平台：它同时覆盖角色定义、前后台执行、脚本化工作流、持久化会话、任务记录、调度、状态与事件协议、TUI 监控、运行中控制、验收证据和可选工作树隔离。项目自己的定位也是让父 Pi 会话把评审、侦察、实现、并行审计、工作流和后台任务交给专门的子 Pi 会话。[来源：README][readme-product]

对 `packages/pi-subagent` 最有价值的不是照搬全部功能，而是以下四个设计判断：

1. **先建立稳定的运行记录协议，再扩展 UI 和恢复能力。** 该项目的 FleetView、状态查询、结果通知、恢复和第三方集成都读取 `status.json`、`events.jsonl`、输出日志和结果文件，而不是解析终端文本。[来源：可观测性文档][observability-artifacts]
2. **Agent 定义、启动契约和运行实例应分层。** Markdown frontmatter 描述角色；启动阶段解析上下文、模型、工具、扩展和权限；运行阶段持久化解析后的有效契约及结果。这让覆盖、预检、审计和恢复成为可能。[来源：Agent 文档][agents-frontmatter]；[启动参数实现][pi-args]
3. **前台与后台应共享同一种 child result / lifecycle 语义。** 当前项目已经让两类 runner 共享有界 JSONL 子协议，并在状态中暴露模型、用量、工具次数、会话和 artifact 等统一字段。[来源：可观测性文档][observability-fields]
4. **安全边界必须独立于提示词。** 该项目已有工具 allowlist、递归深度、能力上限和非 Bash 权限门控，但子进程仍继承父进程环境，`bash` 明确不受原生权限门控，未配置工具列表时还会继承 Pi 的普通内置工具；这些事实说明“独立进程”不等于安全沙箱。[来源：启动实现][foreground-spawn]；[工具规则][agents-tools]；[权限文档][permissions]

建议 `packages/pi-subagent` 近期优先吸收“运行协议、显式 launch contract、可恢复 session、状态/控制分离、有限并发”五项，不宜在基础协议稳定前复制 missions、schedules、watchdog、Herdr、脚本 VM 等完整平台能力。

## 快照与研究范围

- 官方仓库：`https://github.com/nicobailon/pi-subagents.git`。
- 本地研究快照：`af09faac8d638c2341e9ebb4599ac9d816497fbb`，提交时间 `2026-08-06T07:06:51-07:00`，提交标题 `docs: split README into focused guides`。[来源：固定快照][snapshot]
- 该快照的 `package.json` 版本仍为 `0.41.0`，但 Git 描述为 `v0.41.0-8-gaf09faa`；因此本文覆盖 **v0.41.0 加其后 8 个尚未发布的提交**。[来源：package.json][package]；[Unreleased 记录][changelog-unreleased]
- 研究材料仅使用该快照中的 README、专项文档、CHANGELOG、源码、内置 Agent 定义和类型/Schema；没有用二手文章补足结论。
- 这是活跃且变化较快的实现。仅 v0.41.0 就把顶层 `tasks[]`、`chain[]`、`/chain`、`/parallel` 等旧入口硬切换为 `workflowScript`，并把普通顶层执行改成默认异步。[来源：v0.41.0 变更][changelog-041-changed]

## 产品定位与用户体验

### 定位

产品把父 Pi 当作编排者，把每个 subagent 当作“有独立任务的专注子 Pi 会话”。安装后用户无需先配置 Agent，可直接用自然语言要求父模型调用 `subagent` 工具；扩展不会自动在后台启动 reviewer。[来源：README][readme-how]

内置角色覆盖 `scout`、`researcher`、`planner`、`worker`、`reviewer`、`context-builder`、`oracle` 和 `delegate`。它们形成“侦察—研究—规划—实现—复核—决策校验”的产品语言，而不是只暴露一个通用子模型。[来源：README][readme-builtins]

推荐的人类工作流是 `clarify → planner → worker → fresh reviewers → worker`；包内还提供并行评审、评审循环、并行研究、上下文构建和清理等 prompt shortcuts。这里的“工作流”主要是父 Agent 的指导模式，实际多代理执行统一落到 `workflowScript`。[来源：工作流文档][workflow-pattern]

### 交互面

- 自然语言是主入口；单 Agent 可用 `/run <agent> ...`，管理和诊断另有 `/subagents-*` 命令。[来源：README][readme-first]；[工作流文档][workflow-direct]
- 普通顶层调用默认异步；`async: false` 可要求前台结果，单 Agent 的 `clarify: true` 可在 TUI 里预览和编辑任务、模型、thinking、skills、输出和读入文件。[来源：工作流文档][workflow-clarify]
- 前台执行在对话里流式展示；后台执行立即归还控制权，并通过 FleetView、Fleet inspector、`status` 和 `subagent_wait` 继续观察。[来源：README][readme-running]；[可观测性文档][observability-ui]
- inline 结果有 `rich` 和稳定单行 `summary` 两种模式；切换为 `summary` 不影响 FleetView 的实时详情。[来源：配置文档][config-inline]

这一 UX 的核心优点是“渐进披露”：新用户只需自然语言；高级用户才接触 Agent 文件、工作流脚本、artifact、状态与控制协议。

## Agent 定义、发现与配置

### 定义格式

Agent 是 Markdown 文件：YAML frontmatter 描述可执行契约，正文是 system prompt。frontmatter 可配置名称/别名、工具、扩展、模型和 fallback、thinking、提示词拼接方式、上下文/skills 继承、默认 fresh/fork、输出、预读文件、超时、turn budget、验收、递归深度、权限和持久记忆。[来源：Agent 文档][agents-frontmatter]；[字段说明][agents-fields]

`package` 可把本地名注册为 `{package}.{name}`；alias 只参与选择，持久状态始终使用 canonical name，冲突 alias 会报歧义错误。[来源：字段说明][agents-fields]

Agent 可被运行时管理动作 `list/get/create/update/delete/eject/disable/enable/reset` 读取或修改。内置/包 Agent 可以 eject 到用户或项目目录后再编辑，也可以只用 settings override 覆盖部分字段。[来源：管理动作][tool-management]；[覆盖机制][agents-overrides]

### 发现与优先级

文档声明优先级从低到高为 builtin → installed package → user → project，项目定义在运行时名称冲突时获胜；目录递归扫描，`.chain.md` 不被当作 Agent。[来源：Agent 发现文档][agents-discovery]

源码还显示了文档未完全展开的兼容路径：用户侧同时扫描 Pi agent 目录下的 `agents`、`~/.agents` 和 `PI_SUBAGENT_EXTRA_AGENT_DIRS`；项目侧同时读 legacy `.agents` 与当前项目配置目录中的 `agents`。[来源：发现实现][agents-discovery-code]

安装包可在 manifest 的 `pi-subagents.agents` 或 `pi.subagents.agents` 中发布 Agent 目录；package 层位于 builtin 之上、用户/项目之下。[来源：Agent 发现文档][agents-discovery]

### 配置层次

配置被拆成三层：

- 扩展级 `~/.pi/agent/extensions/subagent/config.json`：异步、FleetView、等待工具、并发、session/artifact、递归、missions、权限等运行设置。[来源：配置文档][config-root]
- 用户/项目 Pi settings：默认模型/thinking/extensions、Agent override、model scope、禁用 builtin 和 watchdog；项目设置优先于用户设置。[来源：配置文档][config-root]；[模型文档][models-precedence]
- Agent frontmatter 与单次调用参数：单次 model override → Agent frontmatter → settings 中的 Agent override → subagent 默认 → 父会话模型。[来源：模型文档][models-precedence]

### 提示词与记忆

自定义 Agent 默认是窄上下文：system prompt 默认为替换模式，不自动继承 Pi 基础 prompt、项目指令或 skills 目录；可以分别开启 `systemPromptMode: append`、`inheritProjectContext`、`inheritSkills`，也可以显式选择少量 skills。内置 Agent 默认继承项目指令。[来源：Agent 文档][agents-prompt]

可选的 per-agent memory 独立于 Pi 自身记忆：每次注入 resolved memory 目录中 `MEMORY.md` 的前 200 行；项目 memory 存在 `.pi/agent-memory/<path>`，用户 memory 存在 `~/.pi/agent/agent-memory/<path>`；只读 Agent 不会被提示写入，路径有 traversal/symlink escape 校验。[来源：Agent memory][agents-memory]

## 执行与并发模型

### 单 Agent

前台执行会构造 `pi --mode json -p` 子进程参数，按 Agent 契约加上 session、model、tools/extensions、context、skills 和 system prompt；随后用独立 OS 子进程运行 Pi，读取 stdout JSONL、收集 stderr、用量、工具调用和最终消息。[来源：前台执行实现][foreground-execution]；[启动参数实现][pi-args]

普通异步单/旧式多子运行多一层 detached Node runner：父扩展把启动配置写到临时文件，再以 `detached: true` 启动 `subagent-runner.ts`，由 runner 管理实际 child Pi 进程和持久化文件。[来源：异步启动实现][async-spawn]

### Scripted workflow

公开的多 Agent 表面只有 `workflowScript`。脚本通过 `runs.run(key, params)` 串行组合任务，通过 `runs.all([...])` 并行启动，使用稳定 key 去重/复用，并可用 `runs.status`、`runs.ref(s)`、`emit` 和受控 `console`。[来源：工具示例][tool-examples]；[工作流 API 实现][workflow-api]

脚本在独立 Node worker thread 的 `vm` context 中执行，只注入冻结的 `runs`、`emit`、`console`；字符串代码生成和 WebAssembly 被关闭，脚本输入/输出必须是无循环的 JSON 值。工作流有总超时和 abort controller，结束时会终止 worker 并中止未等待的 child launch。[来源：工作流 VM][workflow-vm]；[工作流生命周期][workflow-lifecycle]

`runs.run` 的失败会抛错并让顺序工作流 fail-fast；`runs.all` 使用 `Promise.all` 同时发起，并把每个 child 设为 `collectFailure`，因此会等待所有 sibling 并按输入顺序返回成功/失败结果。[来源：工作流 API 实现][workflow-api]；[v0.41 修复说明][changelog-runs-all]

### 并发边界

旧式 parallel 配置默认 `maxTasks=8`、`concurrency=4`，但文档明确说新编排使用 `workflowScript`/`runs.all`；脚本实现会拒绝 child 级 `concurrency`，`runs.all` 直接对所有 calls 做 `Promise.all`。[来源：并发配置][config-parallel]；[工作流 API 实现][workflow-api]

因此，**从当前公开实现推断，`workflowScript` 的 `runs.all` 没有自己的并发池上限**。全局 `maxSubagentSpawnsPerSession` 可以限制整个会话的累计启动数，但默认不设上限，且它控制的是总 spawn 数而不是同时运行数。[来源：spawn budget 配置][config-spawn-budget]。这是 `packages/pi-subagent` 不宜照搬的部分：应让并发上限成为调度器的强约束，而不是依赖脚本作者自律。

普通 model-facing 工具仍保留“一次前台 subagent call/turn”的 guard；扩展到扩展的 correlated delegation 才允许并行请求。这个 guard 控制顶层工具重入，不等同于控制一个 `workflowScript` 内部的 child 并发数。[来源：executor 注释][executor-guard]

## 上下文、工具、模型与权限隔离

### 上下文

- `context: fresh` 创建新上下文；`context: fork` 从父 session 当前 leaf 创建真实 branched session，不是把摘要拼到 prompt。父 session 未持久化、leaf 不存在或无法创建分支时会 fail-fast，不会静默退回 fresh。[来源：fork 语义][tool-fork]；[session 文档][observability-session]
- fork 会过滤父侧 subagent 编排指令、slash/status/control 消息和历史 `subagent` tool call/result，同时保留普通对话和无关工具结果；默认 child 不注册 `subagent` 工具。[来源：工作流安全边界][workflow-safety]
- Anthropic transcript 中的 signed thinking blocks 会从 fork child 移除；若 child/fallback 解析为 Anthropic，还会强制 thinking off。因此需要 Anthropic thinking 的 child 应用 fresh。[来源：fork 语义][tool-fork]

### 工具与扩展

显式 `tools` 是严格 allowlist；空列表生成 `--no-tools`；省略则不传 `--tools`，child 得到 Pi 普通内置工具。`extensions` 省略表示允许普通扩展发现，空值表示禁用 ambient extensions，显式列表则只加载列出的普通扩展，再加运行时必需扩展与 `subagentOnlyExtensions`。[来源：工具规则][agents-tools]；[启动参数实现][pi-args]

child 只有在 resolved builtin tools 明确包含 `subagent` 时才得到 child-safe fanout 能力；默认最大深度为 2，即 main → child → grandchild，Agent 只能收紧继承的上限，不能放宽。[来源：递归文档][workflow-recursion]；[递归实现][recursion-code]

MCP direct tools 需要 Agent frontmatter 明确列出 `mcp:` selector，并依赖 `pi-mcp-adapter`；全局 directTools 不会自动授权给 child。启动前会检查显式工具是否真的注册，缺失时 fail-closed。[来源：Agent 工具文档][agents-mcp]

### 模型

内置 Agent 默认继承父会话模型，支持 per-role 默认、单次 override、thinking suffix、模糊模型匹配、按序 fallback 和 provider/model scope。[来源：模型文档][models-precedence]；[模型匹配][models-fuzzy]

fallback 只针对 quota、认证、超时、模型不可用等 provider/model 失败，不会把普通任务失败交给下一个模型。[来源：字段说明][agents-fields]

`modelScope` 的强制性并不一致：调用方显式指定的模型若越界会中止；来自 Agent frontmatter、全局 default 或父 session 的模型只警告。若目标是严格合规边界，这一设计不足以作为硬策略。[来源：model scope][models-scope]

### 权限与安全边界

原生 child 权限是 opt-in，只拦截非 Bash 工具；规则为 `allow/ask/deny`，Agent 规则覆盖全局规则，未配置和未知工具默认 allow。`ask` 由 child watchdog 模型判决，不转发到父 UI；watchdog 不可用、超时或响应无效时 fail-closed 为 deny。[来源：权限文档][permissions]

`bash` 明确完全不在这套权限系统范围内，外部 CLI Agent 也无法被拦截。项目建议另装 `pi-guard`，但 headless child 无法把 `ask` 提示转发给父 UI，只能配置明确 allow/deny。[来源：Bash 边界][permissions-bash]

child Pi 进程的 `env` 是 `{...process.env, ...sharedEnv, ...depthEnv}`，默认 cwd 也是父运行目录；因此它继承父进程可见的环境变量和文件权限。可选 worktree 只隔离 Git 工作目录，不隔离凭证、网络、进程或系统权限。[来源：前台 spawn][foreground-spawn]；[worktree 文档][workflow-worktree]

内置角色也不都是最小权限：例如 `scout` 有 `bash` 和 `write`，`oracle` 有 `bash`，`reviewer` 有 `bash/edit/write`。[来源：scout 定义][builtin-scout]；[oracle 定义][builtin-oracle]；[reviewer 定义][builtin-reviewer]。因此其安全边界仍主要依赖任务提示、工具 allowlist 和宿主环境，而非真正的 sandbox。

## 状态、持久化与恢复

### Session 与运行记录

Session 始终启用；目录优先级为单次 `sessionDir` → extension `defaultSessionDir` → 从父 session 推导的目录。fork child 直接用 branched `.jsonl` 作为 `--session`。[来源：session 配置][config-session]；[session 文档][observability-session]

异步运行会写 `status.json`、`events.jsonl`、`output-<n>.log` 和 Markdown log；最终结果另写到 results 目录。状态字段包含 run/session id、mode/state、时间、cwd、session/output、workflow graph、steps/results、token/cost、model attempts、tool/turn count 和 nested children。[来源：artifact 文档][observability-artifacts]；[字段定义][observability-fields]

生命周期协议对 child stdout 单行限制为 16 MiB，stderr 只保留最后 128 KiB；它处理 split UTF-8、未终止 JSON、Pi retry 和新旧 terminal watermark。消费者被明确要求读取 JSON 文件并忽略未知字段/事件，以保留前向兼容。[来源：child protocol][observability-protocol]

另有 `run-history.jsonl`，它将 task 文本替换为 `[redacted]`，只保留 SHA-256 task hash，并尝试将目录/文件权限设为 `0700/0600`；读取超过 1200 条时保留最近 1000 条。[来源：history 实现][run-history]

### Mission 与 schedule

普通 task 默认创建 project-local mission，记录 goal、run id、lifecycle、decision、artifact 和 delivery receipt；自动持久化失败不会阻止执行，显式 `missionId`/`mission` 则严格失败。重启或 compaction 后可先从 mission 找回 run，再执行 `status/steer/resume/stop`。[来源：mission 文档][missions]

schedule 也是 project-local durable record，支持一次性和固定间隔，运行永远 async + fresh，不自动建 mission；它不是内置 daemon，需要外部调用 `schedule.run-due`。当前只支持 `overlap=skip`，尚无 calendar/cron、queue/replace 和 schedule TUI。[来源：schedule 文档][schedules]

### 恢复

`resume` 不是恢复原 OS 进程，而是从已持久化 child session file 启动新 child；可恢复 paused、completed、failed run，stopped run 不可恢复。恢复时对 canonical session file 获取跨进程独占 lease，只有能证明 owner 已死才回收 stale lease。[来源：resume 文档][tool-resume]

进程终止证明与执行成功分开：只有 live parent 观察到精确 detached runner close、所有 child writer close 且 session lease 空闲，`process-terminal` 才为 `observed`；否则是 `unknown`，不能从 PID 消失或 result 文件存在推断退出。[来源：终止证明][observability-terminal]

## UI 与结果聚合

前台视图显示当前工具、近期输出、tokens、cost、duration、activity freshness 和 chain graph；折叠态紧凑，展开态显示每步完整输出。[来源：前台 UI][observability-foreground]

FleetView 常驻 editor 上/下方，汇总 active children；Fleet inspector 能查看结构化 Markdown/tool transcript、选择 child、刷新、steer、stop，并可打开 Herdr pane。无 TUI 时退化为文本 status/显式控制命令。[来源：Fleet UI][observability-ui]

工作流结果同时保存：

- 脚本最终 `return` 值；
- `emit` 的里程碑；
- console 与 trace；
- 每个 child 的 output、structured output、success 和 artifact path；
- 汇总 token 与 cost。

成功与失败都会写结果文件；失败会保留 `WorkflowScriptError.partial` 中已经完成的 child、trace 和 emits。[来源：workflow 持久化实现][workflow-persist]

`outputMode: file-only` 可只返回大文件的路径与大小/行数摘要；失败或保存失败仍回退为 inline output 方便诊断。[来源：output mode][tool-output]

后台完成通知只归属于发起 session；成功 sibling 可短暂批处理为安静的分组通知，failed/paused 立即可见。[来源：完成通知][observability-notify]

## 错误、取消与运行边界

### 控制语义

- `interrupt` 是可恢复暂停；`stop` 是更强的顶层 async 终止，stopped 不可 resume，且 foreground/nested 不能作为 stop 目标。[来源：stop 文档][tool-stop]
- `steer` 等待 child Pi 确认接收消息，但确认只代表输入被接受，不代表模型会遵从；只有顶层 single run 可在 ack 超时后进入受限的 pause/revival 恢复，multi-child 与 nested 不会自动替换。[来源：steer 文档][tool-steer]
- 工作流 timeout/abort 会终止脚本 worker，并向仍未完成的 child launch 发 abort；返回 partial trace/children，而不是丢掉已完成结果。[来源：工作流生命周期][workflow-lifecycle]

### 自动重试与 fallback

child 启动重试非常保守：只有非零退出、无模型消息、无工具调用、无用量、无 mutation、无协议/生命周期信号且 2 秒内失败，才以 250/750/1500ms 做同模型有限重试；任何真实工作迹象都会阻止重放。[来源：启动重试实现][startup-retry]

模型 fallback 与启动重试都不会掩盖普通任务失败；这避免 writer 已经产生副作用后被另一模型自动重跑。[来源：字段说明][agents-fields]；[启动重试实现][startup-retry]

### Budget 与验收

支持 wall-clock timeout、turn budget、tool-call budget 和 reported token/cost budget，但文档明确警告不要给 writer 使用硬 turn/tool/usage cap：这些指标不能证明一个修改片段能安全交付，而且 timeout 也不是 mutation-safe boundary。writer 更适合窄任务 + 足够宽的 outer timeout，并在截止前要求 checkpoint。[来源：budget 警告][tool-budget]

验收策略将 child 自述与 runtime 证据分开：可要求结构化 `acceptance-report`、changed files、commands、no-staged-files 和 runtime verification command；显式 gate 失败会让 run 失败，推断 gate 只提供可观测性。独立 review 是与 evidence level 正交的 gate。[来源：验收文档][tool-acceptance]

## 实现架构

```text
父 Pi Extension
  ├─ subagent / subagent_wait / slash / RPC / supervisor channel
  ├─ Agent discovery + settings + launch-contract resolution
  ├─ Foreground executor
  │    └─ child Pi process (--mode json -p)
  ├─ Async launcher
  │    └─ detached Node runner
  │         └─ one or more child Pi processes
  ├─ workflowScript worker thread + vm
  │    └─ host runs.run / runs.all → ordinary executor
  └─ file control plane
       ├─ session JSONL
       ├─ status.json / events.jsonl / output logs / result JSON
       ├─ mission / schedule / worktree manifests
       └─ steering / supervisor / nested-run sidecars
```

扩展入口集中注册 tool、wait tool、slash commands、watchdog、RPC、Fleet UI 和事件 handler；session start 时恢复 active jobs、wait subscriptions 和结果 watcher，headless `agent_end` 会 drain outstanding work。[来源：extension 入口][extension-entry]

前台与后台执行代码是分开的 runner，但复用 AgentConfig、Pi 参数构建、工具解析、fallback、预算、acceptance、child protocol 和 shared result types。工作流自身不是第三种 child runtime，而是一个受限 JS 协调器，通过 ordinary executor 启动 child。[来源：extension imports][extension-imports]；[workflow host launch][workflow-host-launch]

跨进程协调以文件和 session-scoped id 为主；`pi.events` 只在单进程内有效，不能直接传给 child。因此 status、steering、supervisor、nested tree 和 result delivery 都需要 sidecar/目录协议。[来源：事件边界][observability-events]

## 优势

1. **角色、执行、状态和控制形成闭环。** 用户既能自然语言委派，也能查状态、看 transcript、steer、pause、resume、stop，不会把后台任务变成“黑盒 Promise”。[来源：状态/控制动作][tool-status]
2. **持久化模型具体。** session、lifecycle artifacts、missions、schedules、worktree manifests、lease 和 process-terminal proof 分别承担不同恢复/审计职责，没有把“有结果文件”误当作“进程确定退出”。[来源：可观测性文档][observability-terminal]；[mission 文档][missions]
3. **launch contract 细粒度。** 模型、thinking、fallback、上下文、skills、工具、扩展、MCP、输出和权限都可单 Agent 覆盖，并能在启动前 fail-closed 检查显式工具缺失。[来源：Agent 字段][agents-fields]；[Agent 工具文档][agents-tools]
4. **副作用场景有明确策略。** 可选 per-child worktree、writer budget 警告、验收 evidence 和 reviewer gate，均承认 writer 不能只用“子 Agent 返回成功”判断完成。[来源：worktree 文档][workflow-worktree]；[验收文档][tool-acceptance]
5. **可观测协议考虑前向兼容和资源边界。** 生命周期有版本、消费者忽略未知字段、stdout/stderr 有边界，超大冗余事件会被投影而不是无限透传。[来源：artifact 文档][observability-artifacts]；[child protocol][observability-protocol]

## 限制与风险

1. **产品面过宽，维护成本很高。** 一个扩展同时拥有 Agent 管理、执行、VM 工作流、后台 runner、TUI、RPC、missions、schedules、worktree、watchdog、权限、Herdr 和 intercom。v0.41.0 的硬切换也表明公共表面仍在快速重构。[来源：package exports][package]；[v0.41.0 变更][changelog-041-changed]
2. **并发模型不够一致。** legacy parallel 有 `maxTasks/concurrency`，`workflowScript` 的 `runs.all` 却直接 `Promise.all`，累计 spawn cap 又默认无限；高 fanout 容易触发资源竞争，项目已经专门为并发 Pi 启动 race 加了重试。[来源：并发配置][config-parallel]；[工作流 API][workflow-api]；[启动重试][startup-retry]
3. **不是安全沙箱。** child 继承父 env 和宿主文件权限；未显式 tools 时继承普通 Pi 工具；未知非 Bash 工具默认 allow；Bash 完全绕过原生权限门控。[来源：前台 spawn][foreground-spawn]；[Agent 工具文档][agents-tools]；[权限文档][permissions]
4. **默认能力仍偏宽。** 多个“只读语义”内置角色拥有 Bash，`scout` 还能 write；这把最小权限责任推回 Agent 作者和宿主策略。[来源：builtin 定义][builtin-scout]；[builtin-oracle]
5. **model scope 不是统一硬边界。** inherited/default/frontmatter 模型越界只警告，不能满足严格预算或合规场景。[来源：model scope][models-scope]
6. **恢复的定义复杂且有限。** resume 是从 session 开新进程，不是续接原进程；stopped 不可恢复；没有 persisted `.jsonl` 就无法 revive；process terminal 在 observer 丢失时只能报告 unknown。[来源：resume 文档][tool-resume]；[终止证明][observability-terminal]
7. **部分声明字段不生效。** `interactive` 虽可写入 frontmatter，但“parsed for compatibility, not currently enforced”。[来源：字段说明][agents-fields]
8. **外部 CLI runner 能力明显降级。** 只支持 async、日志、timeout、stop；不支持 foreground/clarify、steer/resume/pause、Pi models/tools/extensions、skills、structured output、nested subagents 或 fallback，也无法套用原生权限。[来源：external CLI][tool-external-cli]；[权限文档][permissions-bash]
9. **敏感数据面大。** session/artifact/transcript 可能包含代码、路径、环境变量和凭据；`share: true` 会通过 `gh` 上传 secret Gist，虽默认关闭但必须在产品上明确提示。[来源：session share][tool-share]
10. **工作流脚本是“trusted inline JS”，不是面向不可信输入的策略语言。** VM 限制了可见对象和动态代码，但仍允许任意循环/控制流，主要依赖总 timeout；稳定性与可审计性弱于声明式 DAG。[来源：v0.41 新增说明][changelog-workflow]；[工作流 VM][workflow-vm]

## 对 packages/pi-subagent 可借鉴的设计

### 建议近期采用

1. **统一 `RunRecord` / `ChildRecord`。** 至少包含 run id、parent/child index、agent、task 摘要、state、started/updated/ended、session file、output/transcript、model、usage、exit/signal/error。先让 foreground/background 共用这套结构，再做 UI。[参考：状态字段][observability-fields]
2. **事件日志 + 当前快照双写。** `events.jsonl` 用于审计与增量观察，`status.json` 用于快速读取；写入应原子化，schema 带版本，读者忽略未知字段。[参考：artifact 文档][observability-artifacts]
3. **把 Agent 定义与执行参数显式合并为 resolved launch contract。** 记录 field provenance，尤其是 model、context、tools、extensions、cwd、session、timeout；恢复必须绑定原契约，不能重新按当前设置解析后静默漂移。[参考：模型优先级][models-precedence]；[前台 execution digest][foreground-execution]
4. **fresh/fork 做一等类型且不静默降级。** fork 失败就报错，并过滤父侧 orchestration history。[参考：fork 语义][tool-fork]；[工作流安全边界][workflow-safety]
5. **强制有界并发。** 提供全局和单次 concurrency，排队而不是一次 `Promise.all` 全部 spawn；同时保留累计 spawn budget 和 recursion depth 两个不同维度。[反例：workflow API][workflow-api]；[参考：spawn budget][config-spawn-budget]
6. **区分 interrupt / stop / resume / steer。** 这些动作应有明确状态机，resume 应明确为“基于持久 session 启动后续进程”。[参考：状态控制][tool-status]；[resume 文档][tool-resume]
7. **结果保留 partial success。** 并行 sibling 失败不应抹去已成功输出；工作流失败也应返回已经完成的 children 和 artifacts。[参考：runs.all][changelog-runs-all]；[workflow 持久化][workflow-persist]
8. **先做 transcript/status 的文本 fallback，再加 TUI inspector。** 这样 headless、测试和其他 UI 扩展都可以复用同一协议。[参考：Fleet fallback][observability-ui]
9. **writer 与 reader 使用不同默认策略。** reader 可用 turn/tool hard cap；writer 只用 scope、足够宽的 timeout、checkpoint 和验收证据。[参考：budget 警告][tool-budget]
10. **最小工具集默认拒绝。** 自定义 Agent 不应因省略 `tools` 就获得 ambient 工具；Bash 应作为高风险能力单独声明和审计，而不是普通 allowlist 项。[反例：Agent 工具规则][agents-tools]；[Bash 边界][permissions-bash]

### 可在后续阶段采用

- per-agent model/fallback/thinking override 与 model scope；但 scope 必须对所有来源同样硬执行。[参考：models][models-precedence]；[当前 scope 边界][models-scope]
- per-agent memory，但先限制注入大小、明确写权限并阻止 traversal/symlink escape。[参考：memory][agents-memory]
- managed Git worktree，前提是先有 ownership journal、patch/handoff manifest 和保守清理策略。[参考：worktree 生命周期][workflow-worktree]
- mission-like durable task wrapper，适合跨 compaction/restart 找回“为什么做”和“下一步”；不应与基础 run 状态混成一个对象。[参考：mission 名词模型][missions]
- capability ceiling 应只能单调收紧，不能由 child 放宽；当前项目的 Agent `maxSubagentDepth` 只能收紧是可复用范式。[参考：递归实现][recursion-code]

## 不宜照搬

1. **不要在首版暴露 inline JavaScript 编排。** 先用声明式 `single`、`parallel`、`sequence`/DAG；它更容易 schema 校验、计算 spawn/concurrency、恢复和展示。等稳定后再决定是否需要 trusted script escape hatch。
2. **不要同时建设 missions、schedule、watchdog、Herdr 和 external CLI。** 它们依赖成熟的 run protocol；提前复制只会让状态机和持久化格式过早膨胀。
3. **不要采用 `tools` 省略即 ambient access。** 安全默认值应是显式、最小、可审计的 role capability。
4. **不要把模型策略中的“越界只告警”称为 enforcement。** 严格场景必须在 resolved model 上统一拒绝。
5. **不要用 child model 代替人类权限确认。** watchdog arbiter 可以做自动策略判断，但不能等价于父 UI 的用户授权。
6. **不要把 PID、结果文件或 `endedAt` 当作终止证明。** 若不实现精确 proof，宁可明确展示 `unknown`。

## 待验证问题

以下问题在当前文档/源码中无法仅靠静态阅读得出可靠结论，建议在决定演进路线前做针对性实验：

1. **`workflowScript` 默认后台运行的进程级耐久性。** coordinator 在父扩展进程内用 worker thread 执行，而普通 async child 另有 detached runner；需要验证整个父 Pi 进程退出后，workflow coordinator、在跑 children、状态与恢复分别如何表现。[来源：async workflow 路径][workflow-persist]；[detached runner][async-spawn]
2. **高 fanout 的实际资源曲线。** 分别测 4/8/16/32 个 `runs.all` child 的启动 race、FD、内存、API 限流、状态文件竞争和取消延迟。[依据：`Promise.all` 实现][workflow-api]
3. **父环境敏感变量继承范围。** 盘点 Pi/provider/extension 凭证是否通过 env、文件或 keychain 被 child 继承，以及 worktree 是否会暴露 `.env`/未跟踪文件。[依据：spawn env][foreground-spawn]
4. **Agent management 的权限策略。** `create/update/delete/eject/reset` 会修改用户/项目 Agent 或 settings；需验证 model-facing 调用时哪些动作需要人类确认、哪些只受宿主 tool approval 控制。[依据：管理动作][tool-management]
5. **恢复契约漂移。** Agent 文件、settings、模型 registry 或 extension 安装在 run 后发生变化时，resume 使用原 resolved contract 还是重新解析；哪些差异会拒绝、警告或静默改变。[依据：resume 语义][tool-resume]
6. **worktree 的冲突与清理。** 验证 dirty repo、child crash、父进程 crash、patch capture 失败、同文件并行修改和 synthetic setup path 下的保留策略。[依据：worktree 文档][workflow-worktree]
7. **权限 fail-closed 是否覆盖 extension/MCP 工具。** 原生权限声明只针对 Pi child 非 Bash tool，需要验证动态扩展工具名、MCP direct tool 和 alias 在 arbiter 前后的 resolved name 是否一致。[依据：权限文档][permissions]；[MCP 文档][agents-mcp]
8. **artifact 清理与 mission/schedule 引用完整性。** 状态、session、mission、result、worktree handoff 的保留期不同，需验证清理后 UI、resume 和 stale pointer 的退化方式。[依据：artifact 清理][observability-artifacts]；[missions][missions]

## 来源索引

以下均为官方仓库固定提交 `af09faac8d638c2341e9ebb4599ac9d816497fbb` 的 permalink。

[readme-product]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/README.md#L5-L8
[readme-first]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/README.md#L19-L40
[readme-how]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/README.md#L41-L51
[readme-builtins]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/README.md#L53-L68
[readme-running]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/README.md#L90-L96
[package]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/package.json#L1-L100
[changelog-unreleased]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/CHANGELOG.md#L1-L13
[changelog-041-changed]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/CHANGELOG.md#L39-L49
[changelog-runs-all]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/CHANGELOG.md#L61-L64
[changelog-workflow]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/CHANGELOG.md#L24-L33
[agents-frontmatter]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/docs/agents.md#L1-L13
[agents-discovery]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/docs/agents.md#L15-L35
[agents-overrides]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/docs/agents.md#L58-L93
[agents-prompt]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/docs/agents.md#L95-L108
[agents-fields]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/docs/agents.md#L110-L188
[agents-memory]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/docs/agents.md#L190-L213
[agents-tools]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/docs/agents.md#L215-L260
[agents-mcp]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/docs/agents.md#L225-L260
[agents-discovery-code]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/src/agents/agents.ts#L1685-L1782
[models-precedence]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/docs/models.md#L1-L53
[models-fuzzy]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/docs/models.md#L122-L142
[models-scope]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/docs/models.md#L144-L162
[config-root]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/docs/configuration.md#L1-L5
[config-inline]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/docs/configuration.md#L31-L45
[config-spawn-budget]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/docs/configuration.md#L99-L109
[config-parallel]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/docs/configuration.md#L119-L130
[config-session]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/docs/configuration.md#L132-L146
[workflow-pattern]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/docs/workflows.md#L1-L36
[workflow-safety]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/docs/workflows.md#L13-L20
[workflow-direct]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/docs/workflows.md#L55-L60
[workflow-clarify]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/docs/workflows.md#L61-L79
[workflow-worktree]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/docs/workflows.md#L81-L97
[workflow-recursion]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/docs/workflows.md#L127-L145
[tool-examples]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/docs/tool-reference.md#L1-L25
[tool-fork]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/docs/tool-reference.md#L71-L77
[tool-output]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/docs/tool-reference.md#L79-L83
[tool-budget]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/docs/tool-reference.md#L53-L69
[tool-management]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/docs/tool-reference.md#L85-L152
[tool-status]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/docs/tool-reference.md#L154-L184
[tool-resume]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/docs/tool-reference.md#L186-L193
[tool-stop]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/docs/tool-reference.md#L195-L204
[tool-steer]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/docs/tool-reference.md#L206-L212
[tool-acceptance]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/docs/tool-reference.md#L218-L273
[tool-external-cli]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/docs/tool-reference.md#L275-L290
[tool-share]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/docs/tool-reference.md#L292-L300
[observability-foreground]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/docs/observability.md#L5-L13
[observability-ui]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/docs/observability.md#L15-L58
[observability-artifacts]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/docs/observability.md#L60-L81
[observability-fields]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/docs/observability.md#L83-L95
[observability-terminal]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/docs/observability.md#L97-L107
[observability-protocol]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/docs/observability.md#L109-L117
[observability-session]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/docs/observability.md#L138-L140
[observability-notify]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/docs/observability.md#L142-L146
[observability-events]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/docs/observability.md#L148-L164
[missions]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/docs/missions.md#L1-L49
[schedules]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/docs/missions.md#L51-L87
[permissions]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/docs/watchdog.md#L124-L166
[permissions-bash]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/docs/watchdog.md#L168-L176
[extension-imports]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/src/extension/index.ts#L15-L75
[extension-entry]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/src/extension/index.ts#L533-L585
[pi-args]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/src/runs/shared/pi-args.ts#L262-L430
[foreground-execution]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/src/runs/foreground/execution.ts#L293-L402
[foreground-spawn]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/src/runs/foreground/execution.ts#L458-L469
[async-spawn]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/src/runs/background/async-execution.ts#L413-L479
[workflow-api]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/src/workflows/scripted-workflow.ts#L35-L78
[workflow-vm]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/src/workflows/scripted-workflow.ts#L80-L133
[workflow-lifecycle]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/src/workflows/scripted-workflow.ts#L262-L301
[workflow-host-launch]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/src/workflows/scripted-workflow.ts#L333-L413
[workflow-persist]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/src/runs/foreground/subagent-executor.ts#L4037-L4176
[executor-guard]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/src/runs/foreground/subagent-executor.ts#L3991-L4010
[recursion-code]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/src/shared/types.ts#L1910-L1949
[startup-retry]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/src/runs/shared/subagent-startup-retry.ts#L4-L82
[run-history]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/src/runs/shared/run-history.ts#L16-L180
[builtin-scout]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/agents/scout.md#L1-L12
[builtin-oracle]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/agents/oracle.md#L1-L12
[builtin-reviewer]: https://github.com/nicobailon/pi-subagents/blob/af09faac8d638c2341e9ebb4599ac9d816497fbb/agents/reviewer.md#L1-L13
[snapshot]: https://github.com/nicobailon/pi-subagents/commit/af09faac8d638c2341e9ebb4599ac9d816497fbb
