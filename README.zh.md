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

| 功能            | 用途                                                                           |
| --------------- | ------------------------------------------------------------------------------ |
| 紧凑编辑器      | 在输入框边框中显示当前工作状态、模型和推理级别，减少额外界面占用。             |
| 多行页脚        | 集中显示项目路径、Git 分支、会话、token、费用、上下文和其他扩展状态。          |
| 用量状态        | 使用 OpenAI Codex 或 DeepSeek 时，在页脚查看限流额度或账户余额。               |
| 输入历史        | 使用 `shift+↑` / `shift+↓` 找回之前提交的输入；记录会跨会话保留。              |
| 快速新会话      | 使用 `/clear` 立即开始新会话，效果与 `/new` 相同。                             |
| Git 自动信任    | 根据 `origin` 远程地址中的域名或用户名，自动信任符合规则的项目。               |
| Ark Coding Plan | 注册 `ark-coding-plan` provider，可直接在 Pi 中选择火山方舟 Coding Plan 模型。 |
| 子代理          | 注册 `agent` 工具，将聚焦任务委派给在隔离上下文中运行的专用子代理，并在 TUI 中实时展示进度。 |

## 按需配置

配置文件位于 `~/.pi/agent/extensions/`。

### 页脚布局

首次运行会生成 `footer.json`。你可以调整显示行、左右位置和分隔符；修改后需重启 Pi 会话。

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

### DeepSeek 用量

使用 DeepSeek 前，请先在 Pi 中配置对应 API Key。`deepseek-stats.json` 可选择余额币种：

```json
{
  "currency": "CNY"
}
```

支持 `CNY` 和 `USD`。

### Ark Coding Plan

设置 API Key 后，通过 `/model` 选择 `ark-coding-plan` provider 下的模型：

```bash
export ARK_API_KEY="your-api-key"
```

### Git 自动信任

创建 `trust.json`，配置允许的 Git 域名或用户名：

```json
{
  "domains": ["private-gitlab.com"],
  "usernames": ["saltfishpr", "my-team"]
}
```

匹配不区分大小写，任一列表命中即可；仅检查 `origin` 远程地址。未命中时，Pi 会继续执行默认的项目信任流程。

### 子代理

子代理以 markdown 文件定义，从三处发现，优先级由低到高（同名时后者覆盖前者）：

- 内置：随本扩展一起提供
- 全局：`~/.pi/agent/agents/`
- 项目：`.pi/agents/`（受仓库控制；每次运行前需确认）

每个文件由 YAML frontmatter 加 markdown 正文组成，正文作为子代理的 system prompt：

```markdown
---
description: 根据上下文和需求生成具体的实现方案。只读，绝不修改代码。
tools:
  - read
  - grep
  - find
  - ls
model: anthropic/claude-opus-4-5
effort: high
skills:
  - some-skill
maxTurns: 100
---

You are a planning specialist...
```

| 字段          | 必填 | 说明                                                                     |
| ------------- | ---- | ------------------------------------------------------------------------ |
| `description` | 是   | 说明何时使用该子代理，会展示给调用方。                                    |
| `tools`       | 否   | 工具白名单。默认为 `read`、`bash`、`edit`、`write`。                      |
| `model`       | 否   | `provider/id` 形式的模型覆盖。默认沿用调用方模型。                        |
| `effort`      | 否   | 推理级别：`minimal`、`low`、`medium`、`high`、`xhigh`、`max`。默认取 Pi 默认值。 |
| `skills`      | 否   | 预加载到子代理 system prompt 的 skill 名称。需 `read` 工具才能加载。      |
| `maxTurns`    | 否   | 限制 assistant 轮数，达到上限后子代理停止。                               |

子代理在全新上下文中运行，看不到主对话，因此需把它所需的一切都写进任务 prompt。

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
