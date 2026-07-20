# AGENTS.md

This file provides guidance to AI agents when working with code in this repository.

## 项目概述

这是一个 pi extension package，通过 pnpm workspace monorepo 组织，内含多个 extension，用于精简 TUI、补充状态信息，并提供输入历史、新会话快捷方式、Git 自动信任及额外模型 provider。

## 项目结构

```
pi-compact-tui/
├── packages/
│   ├── pi-clear-command/index.ts    # /clear 命令，等价于 /new 开启新会话
│   ├── pi-codex-stats/index.ts      # OpenAI Codex 用量（限流窗口）状态
│   ├── pi-compact-editor/index.ts   # 自定义编辑器（CustomEditor 子类），在输入框边框展示活动/模型/推理档位
│   ├── pi-compact-footer/           # 多行底部状态栏（index.ts + config.ts 布局配置）
│   ├── pi-deepseek-stats/           # DeepSeek 账户余额状态（index.ts + config.ts 货币配置）
│   ├── pi-history/index.ts          # 输入历史，shift+↑/↓ 检索，跨会话持久化
│   ├── pi-provider-ark/index.ts     # 注册 ark-coding-plan provider（火山方舟 Coding Plan）
│   └── pi-trust-git/index.ts        # 按 origin 远程的域名/用户名规则自动信任项目
├── package.json                     # pi package 清单 + workspace 配置
├── pnpm-workspace.yaml
├── README.md                        # 英文说明（含安装/配置）
└── README.zh.md                     # 中文说明
```

每个 extension 是一个独立的 TypeScript 文件，导出默认函数，接收 `ExtensionAPI`。带 `config.ts` 的 extension 会在 `~/.pi/agent/extensions/` 下读写自己的 JSON 配置。

### 关键技术栈

- **语言**: TypeScript（通过 jiti 运行时加载，无需编译）
- **包管理**: pnpm workspace
- **运行时依赖**（会打包）:
  - `zod` — 配置校验（如 pi-trust-git 的 trust.json）
  - `write-file-atomic` — 原子写文件（如 pi-history）
- **peer dependencies**（运行时由 pi 提供，不要打包）:
  - `@earendil-works/pi-coding-agent` — ExtensionAPI, ExtensionContext, CustomEditor, getAgentDir, readStoredCredential 等
  - `@earendil-works/pi-ai` — StringEnum 等 AI 工具
  - `@earendil-works/pi-tui` — Loader, truncateToWidth, visibleWidth 等 TUI 工具
- **dev dependencies**（仅用于类型检查）: 上面对应的 `@earendil-works/pi-*` + `typescript` + `@types/*`

## 配置文件约定

用户态配置统一位于 `~/.pi/agent/extensions/`：

- `footer.json` — 底部状态栏布局（行、左右位置、分隔符）
- `deepseek-stats.json` — DeepSeek 余额货币（`CNY` / `USD`）
- `trust.json` — Git 自动信任的域名/用户名白名单

## 如何新增 Extension

### 1. 创建 extension 文件

在 `packages/` 下新建目录和 `index.ts`：

```
packages/pi-my-extension/index.ts
```

### 2. Extension 基本骨架

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // 事件订阅、命令注册、工具注册等
}
```

### 3. 注册到 package.json

在 `package.json` 的 `pi.extensions` 数组中追加路径（数组保持字母序）：

```json
{
  "pi": {
    "extensions": [
      "./packages/pi-clear-command/index.ts",
      // ...
      "./packages/pi-my-extension/index.ts"
    ]
  }
}
```

### 4. 类型检查

```bash
pnpm typecheck
```

## 参考文档

Pi 类型声明及完整 API 文档位于:

- `node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
- `@earendil-works/pi-coding-agent`
  - `node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js`
- `@earendil-works/pi-tui`
  - `node_modules/@earendil-works/pi-tui`
- `@earendil-works/pi-ai`
  - `node_modules/@earendil-works/pi-ai`
