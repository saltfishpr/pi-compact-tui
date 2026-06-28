# pi-compact-tui

[Pi](https://pi.dev/) 扩展包，用紧凑、无干扰的替代方案替换默认的编辑器和页脚。

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

用单行状态栏替换默认页脚，展示你关心的信息。

- **左侧** — 当前工作目录（`~` 代表 home）、git 分支和会话名称。
- **右侧** — 会话费用（美元）、上下文窗口使用情况（百分比和 token 数量）以及自动压缩指示器 `(auto)`。
- **对齐** — 左右内容会间隔开，并根据终端宽度智能截断以适配。

### Clear Command

注册 `/clear` 斜杠命令，作为开启新会话的快捷方式。

- `/clear` — `/new` 的别名：立即启动一个新会话，等同于 `ctx.newSession()`。

### Provider Proxy

根据当前使用的模型 provider 自动设置 `HTTP_PROXY` / `HTTPS_PROXY`，适用于不同 provider 需要不同代理配置的场景（例如通过 VPN 访问 OpenAI，同时使用本地 Ollama）。

- **按 provider 代理** — 在 JSON 配置文件中将 provider 名称映射到代理 URL。
- **通配回退** — 使用 `"*"` 作为未匹配 provider 的默认代理。
- **自动生效** — 会话启动和模型切换时自动设置代理，会话关闭时清除。

配置文件（项目级优先于全局）：

```jsonc
// ~/.pi/agent/extensions/proxy.json  （全局）
// .pi/extensions/proxy.json          （项目）
{
  "proxies": {
    "*": "http://127.0.0.1:7890",
    "openai": "http://127.0.0.1:7890",
  }
}
```

### Commit Prompt

内置的提示词模板（`/commit`），用于自动化 git 提交。它会收集当前 git 状态、diff、分支和最近的提交历史，然后指示 agent 一步完成暂存和提交。

## License

MIT
