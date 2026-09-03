[English](./README.md) ｜ 中文

# pi-compact-tui

一组面向日常使用的 [Pi](https://pi.dev/) 扩展：精简 TUI、补充状态信息，并提供命令审计、输入历史、会话回顾、subagent、联网搜索等能力。

![演示](./assets/demo.gif)

## 安装

```bash
pi install npm:pi-compact-tui
# 或
pi install git:github.com/saltfishpr/pi-compact-tui
```

所有插件的配置文件统一放在 `~/.pi/agent/extensions/` 目录下，首次使用时会自动生成默认配置，无需手动创建。

## 插件

### Bash 命令审计（`pi-bash-audit`）

拦截 Pi 执行的 bash 命令，分两级防护：

1. **规则匹配**：内置一份"只读命令白名单"（如 `ls`、`cat`、`git status` 等），命中的直接放行；也可以用规则强制放行、强制确认或交给模型审计。
2. **模型审计**：规则未放行的命令交给指定模型判断风险，高风险命令弹出确认框，由你决定是否执行。

**配置**：运行 `/audit` 选择审计模型和推理档位即可启用，也可以直接编辑 `~/.pi/agent/extensions/bash-audit.json`：

```json
{
  "enable": true,
  "model": "anthropic/claude-sonnet-4-5",
  "thinkingLevel": "off",
  "rules": [
    { "command": "pnpm", "args": ["install"], "action": "allow" },
    { "command": "rm", "args": ["-rf"], "action": "prompt" }
  ]
}
```

字段说明：

- `model`：审计模型，格式 `<provider>/<model-id>`；不填则使用当前会话模型。
- `thinkingLevel`：`off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`。
- `rules`：每条规则包含：
  - `command`：命令名（如 `pnpm`）；
  - `args`：需要匹配的参数（如 `["install"]`）；
  - `except`：例外参数组合，命中后不应用本规则；
  - `action`：`allow`（直接放行）/ `prompt`（人工确认）/ `auto`（交给模型审计）。

### 清屏新会话（`pi-clear-command`）

提供 `/clear` 命令，等价于 `/new`，开启一个全新会话。

### 精简编辑器（`pi-compact-editor`）

替换默认输入框，在输入框边框上展示状态：左侧显示工作状态（Thinking / Streaming / Running xxx），右侧显示当前模型与推理档位。

### 可配置状态栏（`pi-compact-footer`）

替换默认底部状态栏，支持多行、左右对齐，可自由排列要展示的元素：目录、Git 分支、会话名、token 用量（输入/输出/缓存读/缓存写）、缓存命中率、费用、上下文占用、模型、推理档位，以及其他扩展注册的状态。

**配置**：编辑 `~/.pi/agent/extensions/footer.json`：

```json
{
  "separator": " ",
  "lines": [
    {
      "left": ["pwd", "branch", "sessionName"],
      "right": ["cacheHitRate", "cost", "context"]
    },
    { "left": ["extensionStatuses"] }
  ]
}
```

- `lines`：每行一个对象，`left` 与 `right` 是元素名数组，分别靠左、靠右排列。
- 可用元素名：`pwd`、`branch`、`sessionName`、`inputTokens`、`outputTokens`、`cacheReadTokens`、`cacheWriteTokens`、`cacheHitRate`、`cost`、`context`、`provider`、`model`、`thinkingLevel`、`extensionStatuses`，以及 `status:<key>`（引用其他扩展注册的状态，如 `status:codex-stats`）。

### 输入历史（`pi-history`）

按 `Shift+↑` / `Shift+↓` 在输入框中翻阅历史输入，跨会话持久保存（保留最近 100 条）。

### 会话回顾（`pi-recap`）

会话空闲时在输入框上方自动生成一句简短的回顾（当前在做什么、下一步是什么），开始新输入或恢复工作后自动清除；也可以随时运行 `/recap` 手动生成。

**配置**：编辑 `~/.pi/agent/extensions/recap.json`：

```json
{
  "model": "anthropic/claude-sonnet-4-5",
  "thinkingLevel": "off",
  "idle": "30s"
}
```

- `model` / `thinkingLevel`：生成回顾用的模型与推理档位，不填则使用当前会话模型。
- `idle`：空闲多久后触发回顾，支持数字（毫秒）或 `"30s"`、`"1m"` 等时长字符串，最小 5 秒。

> 注意：本插件已内置 recap 功能，如果你单独安装过 `saltfishpr/pi-recap`，请卸载它以避免冲突。

### Subagent（`pi-subagent`）

为 Pi 提供 `agent` 工具，可把独立子任务（如探索代码库、制定计划）委托给子代理，在隔离上下文中运行。内置 `explore`（探索）和 `planner`（规划）两个子代理，你也可以添加自己的。

**添加子代理**：在 `~/.pi/agents/`（全局）或 `.pi/agents/`（项目）下放置 Markdown 文件，文件名即子代理名：

```markdown
---
description: 审查代码变更，输出问题清单
model: anthropic/claude-sonnet-4-5
effort: low
maxTurns: 30
---

这里写子代理的系统提示词……
```

- `description`（必填）：告诉主模型何时使用该子代理。
- `model` / `effort` / `maxTurns`：可选，不填时继承当前会话模型；`maxTurns` 默认 50。

**配置**：编辑 `~/.pi/agent/extensions/subagent.json`，可关闭功能、限制并发数，或按子代理名覆盖其 `model` / `effort` / `maxTurns`：

```json
{
  "enabled": true,
  "maxConcurrent": 4,
  "agents": {
    "explore": { "effort": "low" }
  }
}
```

### 使用提示（`pi-tips`）

每次新开会话时在顶部展示一条随机使用技巧（如快捷键、常用命令），支持多语言。

### Git 自动信任（`pi-trust-git`）

根据项目 Git `origin` 远程地址自动信任项目，跳过 Pi 的手动确认。

**配置**：编辑 `~/.pi/agent/extensions/trust.json`，命中任一名单即自动信任：

```json
{
  "domains": ["github.com"],
  "usernames": ["saltfishpr"]
}
```

- `domains`：信任的远程域名（如 `github.com`、`gitlab.com`）。
- `usernames`：信任的远程路径首段（如 `github.com/saltfishpr/xxx` 中的 `saltfishpr`）。

### 用量状态（`pi-usage-stats`）

在状态栏展示当前模型的 provider 用量：

- **openai-codex**：订阅限流窗口（5h / 7d 剩余额度）。
- **deepseek**：账户余额。
- **zai-coding-cn**（智谱）：账户余额。

**配置**：编辑 `~/.pi/agent/extensions/provider-stats.json`，按需关闭某个 provider 或指定余额币种：

```json
{
  "providers": {
    "deepseek": { "enabled": true, "currency": "CNY" }
  }
}
```

未配置的 provider 默认启用。

### 联网搜索（`pi-web-search`）

TODO

## License

MIT
