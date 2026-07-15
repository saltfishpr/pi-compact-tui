# AGENTS.md

This file provides guidance to AI agents when working with code in this repository.

## 项目概述

这是一个 pi extension package，通过 pnpm workspace monorepo 组织，内含多个 extension。

## 项目结构

```
pi-compact-tui/
├── packages/
│   ├── pi-compact-editor/index.ts   # 自定义编辑器（CustomEditor 子类）
│   ├── pi-compact-footer/index.ts   # 自定义底部状态栏（setFooter）
│   ├── pi-clear-command/index.ts    # /clear 命令（registerCommand）
│   └── pi-provider-proxy/           # 按 provider 自动设置代理
├── package.json                     # pi package 清单 + workspace 配置
└── pnpm-workspace.yaml
```

每个 extension 是一个独立的 TypeScript 文件，导出默认函数，接收 `ExtensionAPI`。

### 关键技术栈

- **语言**: TypeScript（通过 jiti 运行时加载，无需编译）
- **包管理**: pnpm workspace
- **peer dependencies**（运行时由 pi 提供，不要打包）:
  - `@earendil-works/pi-coding-agent` — ExtensionAPI, ExtensionContext, CustomEditor 等
  - `@earendil-works/pi-ai` — StringEnum 等 AI 工具
  - `@earendil-works/pi-tui` — Loader, truncateToWidth, visibleWidth 等 TUI 工具
- **dev dependencies**（仅用于类型检查）: 上面对应的 `@earendil-works/pi-*` + `typescript`

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

在 `package.json` 的 `pi.extensions` 数组中追加路径：

```json
{
  "pi": {
    "extensions": [
      "./packages/pi-compact-editor/index.ts",
      "./packages/pi-compact-footer/index.ts",
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
- `@earendil-works/pi-coding-agent` — extensions.md（事件、ExtensionAPI、ExtensionContext）
- `@earendil-works/pi-tui` — tui.md（组件 API、自定义组件模式）
- `@earendil-works/pi-ai` — StringEnum 等 AI 工具类型
