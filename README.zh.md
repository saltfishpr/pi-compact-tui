# pi-compact-tui

一组面向日常使用的 [Pi](https://pi.dev/) 扩展：精简 TUI、补充常用状态，并提供输入历史、新会话快捷命令和额外模型 provider。

## 安装

```bash
pi install git:github.com/saltfishpr/pi-compact-tui
```

## 你会得到什么

| 功能            | 用途                                                                           |
| --------------- | ------------------------------------------------------------------------------ |
| 紧凑编辑器      | 在输入框边框中显示当前工作状态、模型和推理级别，减少额外界面占用。             |
| 多行页脚        | 集中显示项目路径、Git 分支、会话、token、费用、上下文和其他扩展状态。          |
| 用量状态        | 使用 OpenAI Codex 或 DeepSeek 时，在页脚查看限流额度或账户余额。               |
| 输入历史        | 使用 `Shift+↑` / `Shift+↓` 找回之前提交的输入；记录会跨会话保留。              |
| 快速新会话      | 使用 `/clear` 立即开始新会话，效果与 `/new` 相同。                             |
| Git 自动信任    | 根据 `origin` 远程地址中的域名或用户名，自动信任符合规则的项目。               |
| Ark Coding Plan | 注册 `ark-coding-plan` provider，可直接在 Pi 中选择火山方舟 Coding Plan 模型。 |

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

## 更新与卸载

```bash
pi update --extensions
pi remove git:github.com/saltfishpr/pi-compact-tui
```

## License

MIT
