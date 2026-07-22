# pi-compact-tui

一组面向日常使用的 [Pi](https://pi.dev/) 扩展：精简 TUI、补充常用状态，并提供输入历史、新会话快捷命令和额外模型 provider。

## 安装

### npm

```bash
pi install npm:pi-compact-tui
```

### Git

```bash
pi install git:github.com/saltfishpr/pi-compact-tui
```

## 你会得到什么

| 功能         | 用途                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------ |
| 紧凑编辑器   | 在输入框边框中显示当前工作状态、模型和推理级别，减少额外界面占用。                                     |
| 多行页脚     | 集中显示项目路径、Git 分支、会话、token、费用、上下文和其他扩展状态。                                  |
| 用量状态     | 使用 OpenAI Codex 或 DeepSeek 时，在页脚查看限流额度或账户余额。                                       |
| 输入历史     | 使用 `shift+↑` / `shift+↓` 找回之前提交的输入；记录会跨会话保留。                                      |
| 快速新会话   | 使用 `/clear` 立即开始新会话，效果与 `/new` 相同。                                                     |
| Git 自动信任 | 根据 `origin` 远程地址中的域名或用户名，自动信任符合规则的项目。                                       |
| 子代理       | 注册 `agent` 工具，将聚焦任务委派给在隔离上下文中运行的专用子代理，并在 TUI 中实时展示进度。           |
| 空闲回顾     | 会话进入空闲状态时自动生成会话摘要，并通过 TUI widget 展示；亦可通过 `/recap` 手动触发。               |
| Bash 审计    | 由指定模型评估待执行的 bash 命令：低风险仅提示，中风险以警告展示，高风险或审计失败会要求确认后再执行。 |
| 会话小贴士   | 每次会话开始时，在 TUI 顶部展示一条使用小贴士。                                                        |

## 插件说明

除非对应章节另有说明，安装后即可使用所有内置插件。全局配置文件统一位于 `~/.pi/agent/extensions/`。

### 紧凑编辑器（`pi-compact-editor`）

**使用方法：** 在 TUI 模式下，输入框边框会显示当前模型和推理级别；Agent 工作时还会显示思考、输出和正在运行的工具等状态。

**配置：** 无。

### 紧凑页脚（`pi-compact-footer`）

**使用方法：** 在 TUI 模式下，页脚按配置展示会话、模型、token、费用、上下文、Git 和其他插件状态。

**配置：** 插件会生成 `~/.pi/agent/extensions/footer.json`。编辑后重启 Pi 会话：

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

- `separator` — 各可见元素之间的分隔文本。
- `lines` — 页脚行；每行可包含 `left` 和 `right` 元素数组。
- 内置元素：`pwd`、`branch`、`sessionName`、`inputTokens`、`outputTokens`、`cacheReadTokens`、`cacheWriteTokens`、`cacheHitRate`、`cost`、`context`、`provider`、`model`、`thinkingLevel` 和 `extensionStatuses`。
- 使用 `status:<key>` 可单独放置插件状态，例如 `status:codex-stats` 或 `status:deepseek-stats`。

### Codex 用量状态（`pi-codex-stats`）

**使用方法：** 选择 `openai-codex` 模型后，插件会展示各限流窗口的剩余百分比，并在使用过程中自动刷新。

**配置：** 在 Pi 中配置 OpenAI Codex 凭据，无需插件专用配置文件。紧凑页脚需包含 `extensionStatuses` 或 `status:codex-stats` 才会显示该状态。

### DeepSeek 用量状态（`pi-deepseek-stats`）

**使用方法：** 选择 `deepseek` 模型后，页脚会显示今日用量、当前会话用量和账户余额。

**配置：** 先在 Pi 中配置 DeepSeek API Key。通过生成的 `~/.pi/agent/extensions/deepseek-stats.json` 选择显示币种：

```json
{
  "currency": "CNY"
}
```

支持 `CNY` 和 `USD`。紧凑页脚需包含 `extensionStatuses` 或 `status:deepseek-stats` 才会显示该状态。

### 输入历史（`pi-history`）

**使用方法：** 按 `shift+↑` 找回之前提交的输入，按 `shift+↓` 向后移动或恢复当前草稿。历史记录会跨会话保留。

**配置：** 无。插件会自动管理 `~/.pi/agent/extensions/history.jsonl`。

### 清空命令（`pi-clear-command`）

**使用方法：** 执行 `/clear` 开始一个全新会话，效果与 `/new` 相同。

**配置：** 无。

### Git 自动信任（`pi-trust-git`）

**使用方法：** Pi 检查项目是否可信时，插件会读取 `origin` 远程地址；若域名或首段用户名命中白名单，则自动信任项目，否则继续执行 Pi 默认信任流程。

**配置：** 编辑自动生成的 `~/.pi/agent/extensions/trust.json`：

```json
{
  "domains": ["private-gitlab.com"],
  "usernames": ["saltfishpr", "my-team"]
}
```

匹配不区分大小写，任一列表命中即可。

### 子代理（`pi-subagent`）

**使用方法：** 让 Pi 将聚焦任务委派给 `explore` 以查找代码事实，或委派给 `planner` 以制定实现方案。任务会在隔离上下文中运行，并在 TUI 中实时展示进度。

```text
使用 planner 子代理检查当前项目，并为添加用户认证制定实现计划。
```

**配置：** 自动生成的 `~/.pi/agent/extensions/subagent.json` 默认启用 `agent` 工具；将 `enabled` 设为 `false` 可关闭。

```json
{
  "enabled": true
}
```

如需添加自定义子代理，在 `~/.pi/agent/agents/` 中创建所有项目可用的 Markdown 文件，或在 `.pi/agents/` 中创建仅供当前已信任项目使用的文件。文件名即子代理名称；修改后执行 `/reload`。

```markdown
---
description: 审查代码改动的正确性和可维护性，不修改文件。
tools:
  - read
  - bash
effort: high
---

审查指定改动，引用相关文件并报告明确问题。
```

| 字段          | 必填 | 用途                                                                        |
| ------------- | ---- | --------------------------------------------------------------------------- |
| `description` | 是   | 告诉 Pi 这个子代理适合处理什么任务。                                        |
| `tools`       | 否   | 限制可用工具；省略时允许使用所有内置编码工具。                              |
| `model`       | 否   | 使用 `provider/model` 格式指定模型；省略时使用当前模型。                    |
| `effort`      | 否   | 设置推理档位：`off`、`minimal`、`low`、`medium`、`high`、`xhigh` 或 `max`。 |
| `skills`      | 否   | 为子代理加载指定 Pi skill；使用时需在 `tools` 中包含 `read`。               |
| `maxTurns`    | 否   | 限制子代理最多执行多少轮。                                                  |

项目级定义仅在项目受信任时加载。同名定义的优先级为：项目级、全局、内置。

### 空闲回顾（`pi-recap`）

**使用方法：** Agent 完成工作后，如果会话保持空闲 5 分钟，插件会生成简短摘要。执行 `/recap` 可立即触发。

**配置：** 当前项目使用 `.pi/extensions/recap.json`，全局使用 `~/.pi/agent/extensions/recap.json`；项目配置优先。

```json
{
  "model": "openai/gpt-4o-mini",
  "thinkingLevel": "off",
  "idle": "3m"
}
```

- `model` — 可选，使用 `provider/model` 格式指定专用模型；默认使用当前模型。
- `thinkingLevel` — 可选，可设为 `off`、`minimal`、`low`、`medium`、`high`、`xhigh` 或 `max`。
- `idle` — 可选，可使用 `"3m"` 或 `180000` 等时长，最短 5 秒。

### Bash 审计（`pi-bash-audit`）

**使用方法：** 默认关闭。启用后，只读命令会直接执行；其他 `bash` 工具调用会被判定为 `low`、`medium` 或 `high` 风险。低、中风险仅展示通知，高风险和审计失败会要求确认。

**配置：** 创建 `~/.pi/agent/extensions/bash-audit.json`：

```json
{
  "model": "openai/gpt-4o-mini",
  "thinkingLevel": "off"
}
```

- `model` — 启用审计所必需，格式为 `provider/model`。
- `thinkingLevel` — 可选，可设为 `off`、`minimal`、`low`、`medium`、`high`、`xhigh` 或 `max`。

### 会话小贴士（`pi-tips`）

**使用方法：** 每次会话开始时，在对话记录顶部展示一条随机使用提示。

**配置：** 默认使用英文。若要选择中文或其他 rpiv 扩展提供的语言，安装共享语言扩展后执行 `/languages`：

```bash
pi install npm:@juicesharp/rpiv-i18n
```

## 更新与卸载

### npm

```bash
pi update npm:pi-compact-tui
pi remove npm:pi-compact-tui
```

### Git

```bash
pi update --extensions
pi remove git:github.com/saltfishpr/pi-compact-tui
```

## License

MIT
