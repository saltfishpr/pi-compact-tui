# pi-compact-tui

[Pi](https://pi.dev/) 扩展包，提供紧凑的 TUI 组件和专注的工作流工具。

## Install

从 git 安装：

```bash
pi install git:github.com/saltfishpr/pi-compact-tui
```

## 扩展

### Compact Editor

用简洁的编辑器替换默认编辑器。顶部边框显示工作状态指示器（旋转加载动画）和当前模型，提供平静、专注的体验，去除不必要的界面元素。

- **工作状态指示器** — agent 在思考、流式输出或运行工具时会有动画效果。状态文本实时更新：`Thinking` → `Streaming` → `Running <tool>` → `Running N tools`。
- **模型标签** — 当前使用的模型显示在顶部边框的右侧。
- **边框自适应** — 左右标签会自动截断以适应终端宽度，确保在任何窗口大小下都保持干净的单行边框。

### Compact Footer

用可配置的多行状态栏替换默认页脚。每行有独立的左/右元素组，两侧会被拉开并根据终端宽度智能截断。

#### 元素

| Key                 | 说明                                                                                                      |
| ------------------- | --------------------------------------------------------------------------------------------------------- |
| `pwd`               | 精简的当前工作目录（`~/repos/github.com/user/project` 显示为 `~/r/g/u/project`）。                         |
| `branch`            | Git 分支，以括号包裹。                                                                                    |
| `sessionName`       | 当前会话名，前缀为 `•`。                                                                                  |
| `inputTokens`       | 累计输入 token（`↑`）。                                                                                   |
| `outputTokens`      | 累计输出 token（`↓`）。                                                                                   |
| `cacheReadTokens`   | 累计缓存读取 token（`R`）。                                                                               |
| `cacheWriteTokens`  | 累计缓存写入 token（`W`）。                                                                               |
| `cacheHitRate`      | 最近一次的缓存命中率（`CH<pct>%`）。                                                                      |
| `cost`              | 会话费用（美元）；使用 OAuth 订阅时追加 `(sub)`。                                                         |
| `context`           | 上下文窗口使用 `pct%/window`，开启自动压缩时追加 `(auto)`。超过 70% / 90% 时会显示为 warning / error 色。 |
| `provider`          | 当前 provider，仅当可用 provider 多于一个时显示。                                                         |
| `model`             | 当前模型 id。                                                                                             |
| `thinkingLevel`     | 支持推理的模型的推理级别（`• off` / `• <level>`）。                                                       |
| `extensionStatuses` | 其他扩展上报的聚合状态文本，不包含已明确指定位置的 key。                                                   |
| `status:<key>`       | 指定扩展 key 的状态文本，显示在当前配置位置；例如 `status:codex-stats`。                                    |

#### 配置

配置从全局路径 `~/.pi/agent/extensions/footer.json` 加载。文件不存在时，插件会自动创建并写入默认布局。

Schema：

```jsonc
{
  // 同一侧元素之间的分隔符
  "separator": " ",
  // 有序页脚行列表；每行独立配置左右两组
  "lines": [
    {
      "left": ["pwd", "branch", "sessionName"],
      "right": ["status:codex-stats", "cacheHitRate", "cost", "context"],
    },
    { "left": ["extensionStatuses"] },
  ],
}
```

在 `left` 或 `right` 中使用 `status:<key>`，即可将对应 status 值放到指定位置。只要明确指定了某个 key，即使该位置当前没有值，它也不会再出现在 `extensionStatuses` 中。

数组语义为整体覆盖（不做深度合并）。没有任何可见内容的行会被跳过，因此可以放心列出可选元素。

默认布局：

```jsonc
{
  "separator": " ",
  "lines": [
    { "left": ["pwd", "branch", "sessionName"], "right": ["cacheHitRate", "cost", "context"] },
    { "left": ["extensionStatuses"] },
  ],
}
```

### Codex Stats

当使用 `openai-codex` 模型时，在页脚状态栏中显示 OpenAI Codex 限流用量。插件使用 Pi 现有的 OAuth 凭据调用 Codex Usage API。

- **限流窗口** — 以剩余百分比显示各个窗口，例如 `5h 77% left 7d 59% left`。
- **用量颜色** — 剩余用量低于 30% 时显示警告色，低于 10% 时显示错误色。
- **刷新生命周期** — 在 `session_start`、`model_select` 和 `agent_settled` 时刷新，确保重试、上下文压缩和排队的 follow-up 完成后再获取用量。
- **认证** — 需要已通过 Pi 登录 `openai-codex` provider；存在 `ChatGPT-Account-ID` 时会一并转发。
- **清理** — 切换到非 Codex 模型或会话关闭时清除状态。

### DeepSeek Stats

当使用 `deepseek` provider 时，通过 DeepSeek Balance API 在页脚状态栏显示账户用量：`今日 ¥0.12 • 本次 ¥0.03 • 余额 ¥9.85`。

- **今日使用** — 昨日最后一次观测余额与当前余额的差额。
- **本次会话使用** — 当前 Pi 会话首次获取的余额与当前余额的差额。
- **余额记录** — 状态持久化到 `~/.pi/agent/extensions/deepseek-stats-state.json`；首次运行时以当前余额为基线。
- **刷新生命周期** — 在 `session_start`、`model_select` 和 `agent_settled` 时刷新。
- **认证** — 使用 Pi 为 `deepseek` provider 配置的 API Key（通常为 `DEEPSEEK_API_KEY`）。

显示币种配置位于 `~/.pi/agent/extensions/deepseek-stats.json`，文件不存在时会自动创建：

```json
{
  "currency": "CNY"
}
```

`currency` 支持 `CNY` 和 `USD`，用于选择 API 返回的对应币种余额，不进行汇率换算。充值造成的负差额按 0 展示。

### Clear Command

注册 `/clear` 斜杠命令，作为开启新会话的快捷方式。

- `/clear` — `/new` 的别名：立即启动一个新会话，等同于 `ctx.newSession()`。

### Git Trust

当项目的 `origin` Git 远程地址匹配允许的域名或用户名时，自动信任该项目。没有规则匹配时，Pi 会继续执行正常的项目信任流程。

配置从 `~/.pi/agent/extensions/trust.json` 加载（自定义 Pi agent 目录时使用对应路径）：

```json
{
  "domains": ["github.com", "git.example.com"],
  "usernames": ["saltfishpr", "my-team"]
}
```

- 域名和用户名匹配不区分大小写。
- 任一允许列表匹配即可授予信任。
- 支持 HTTPS、SSH URL 和 SCP 风格的远程地址。
- 仅检查 `origin` 远程地址。

### Commit Prompt

内置的提示词模板（`/commit`），用于自动化 git 提交。它会收集当前 git 状态、diff、分支和最近的提交历史，然后指示 agent 一步完成暂存和提交。

## License

MIT
