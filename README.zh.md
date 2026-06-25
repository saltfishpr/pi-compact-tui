# pi-compact-tui

[Pi](https://pi.dev/) 扩展包，用紧凑、无干扰的替代方案替换默认的编辑器和页脚。

## Install

从 git 安装：

```bash
pi install git:github.com/saltfishpr/pi-compact-tui
```

## Features

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

## License

MIT
