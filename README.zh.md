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

| 功能            | 用途                                                                                         |
| --------------- | -------------------------------------------------------------------------------------------- |
| 紧凑编辑器      | 在输入框边框中显示当前工作状态、模型和推理级别，减少额外界面占用。                           |
| 多行页脚        | 集中显示项目路径、Git 分支、会话、token、费用、上下文和其他扩展状态。                        |
| 用量状态        | 使用 OpenAI Codex 或 DeepSeek 时，在页脚查看限流额度或账户余额。                             |
| 输入历史        | 使用 `shift+↑` / `shift+↓` 找回之前提交的输入；记录会跨会话保留。                            |
| 快速新会话      | 使用 `/clear` 立即开始新会话，效果与 `/new` 相同。                                           |
| Git 自动信任    | 根据 `origin` 远程地址中的域名或用户名，自动信任符合规则的项目。                             |
| Ark Coding Plan | 注册 `ark-coding-plan` provider，可直接在 Pi 中选择火山方舟 Coding Plan 模型。               |
| 子代理          | 注册 `agent` 工具，将聚焦任务委派给在隔离上下文中运行的专用子代理，并在 TUI 中实时展示进度。 |
| 空闲回顾        | 会话进入空闲状态时自动生成会话摘要，并通过 TUI widget 展示；亦可通过 `/recap` 手动触发。     |
| 会话小贴士      | 每次会话开始时，在 TUI 顶部展示一条使用小贴士。 |

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

插件内置了只读的 `planner` 子代理，无需配置。需要基于当前代码制定方案时，直接告诉 Pi：

```text
使用 planner 子代理检查当前项目，并为添加用户认证制定实现计划。
```

Pi 会自动委派任务，并在运行期间通过 TUI 实时展示进度。

#### 添加自定义子代理

在以下任一位置创建 markdown 文件：

- `~/.pi/agent/agents/` — 在所有项目中可用
- `.pi/agents/` — 仅在当前已信任项目中可用

文件名就是子代理名称。例如，创建 `~/.pi/agent/agents/reviewer.md`：

```markdown
---
description: 审查代码改动的正确性和可维护性，不修改文件。
tools:
  - read
  - bash
effort: high
---

审查指定改动，找出明确的缺陷、风险和可维护性问题。
引用相关文件，并说明每个问题应如何修复。
```

创建或修改子代理后执行 `/reload`，然后即可让 Pi“使用 reviewer 子代理”。

#### 配置项

| 字段          | 必填 | 用途                                                                        |
| ------------- | ---- | --------------------------------------------------------------------------- |
| `description` | 是   | 告诉 Pi 这个子代理适合处理什么任务。                                        |
| `tools`       | 否   | 限制可用工具；省略时允许使用所有内置编码工具。                              |
| `model`       | 否   | 使用 `provider/id` 格式指定模型；省略时使用当前模型。                       |
| `effort`      | 否   | 设置推理档位：`off`、`minimal`、`low`、`medium`、`high`、`xhigh` 或 `max`。 |
| `skills`      | 否   | 为子代理加载指定的 Pi skill；使用时需在 `tools` 中包含 `read`。             |
| `maxTurns`    | 否   | 限制子代理最多执行多少轮。                                                  |

Markdown 正文用于描述子代理的职责、约束和预期输出。项目级定义仅在项目受信任时加载。同名时，项目级定义覆盖全局定义，全局定义覆盖插件内置定义。

### 空闲回顾

默认情况下，会话空闲 5 分钟后会使用当前模型自动生成一次 recap。使用 `/recap` 可立即触发。

如需自定义，创建 `.pi/extensions/pi-recap.json`（项目级）或 `~/.pi/agent/extensions/pi-recap.json`（全局）：

```json
{
  "model": "openai/gpt-4o-mini",
  "thinkingLevel": "off",
  "idle": "3m"
}
```

- `model` — 指定生成 recap 的模型，格式为 `provider/model`。不填则使用当前模型。
- `thinkingLevel` — `off` / `minimal` / `low` / `medium` / `high` / `xhigh`。
- `idle` — 触发前的空闲时长，如 `"3m"` 或 `180000`，下限 5s。

### 会话小贴士

默认使用英文。如需切换为中文（或其他 rpiv 生态支持的语言），安装共享的语言扩展后运行 `/languages` 选择：

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
