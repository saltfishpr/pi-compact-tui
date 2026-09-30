# Compact footer 性能测试

## 运行

测试入口：`packages/pi-compact-footer/footer.bench.ts`。

在 Pi 会话中，直接使用当前会话文件：

```bash
pnpm bench:footer
```

在普通终端中指定文件：

```bash
PI_SESSION_FILE=/path/to/session.jsonl pnpm bench:footer
```

测试要求会话选择的模型存在于已安装 Pi 的模型目录中。`PI_PROVIDER` 和 `PI_MODEL` 优先于文件内的选择模型，可用于明确指定当前模型。

每次运行输出输入快照的 SHA-256、字节数、entry 数、当前分支长度，以及 Node.js、CPU、模型和布局信息。Vitest 表格中的耗时单位为 **ms/op**。

### 固定输入并比较前后版本

活动会话会持续追加 entries；比较代码版本时，先在仓库外保存固定快照：

```bash
cp "$PI_SESSION_FILE" /tmp/pi-footer-session.jsonl

PI_SESSION_FILE=/tmp/pi-footer-session.jsonl \
  pnpm bench:footer --outputJson /tmp/pi-footer-before.json

# 修改实现后，使用同一快照、模型、footer 配置和机器重跑。
PI_SESSION_FILE=/tmp/pi-footer-session.jsonl \
  pnpm bench:footer --compare /tmp/pi-footer-before.json \
  --outputJson /tmp/pi-footer-after.json
```

Session file 包含会话正文，不要把快照提交到仓库。完成比较后删除临时快照。

## 测量范围

- **完整 render / warm cache**：compact 和已安装官方 footer，分别测试 80、120、200 列。
- **首次 render**：新建 compact footer 实例后 render，计时包含 constructor，但不包含会话文件读取、JSON 解析或 SDK 初始化。
- **缓存失效**：在两个 leaf 之间交替切换后 render；计时包含 O(1) 的 `SessionManager.branch()`。两个 leaf 由内存中新增的两个非 context custom entries 提供，不会随迭代增长历史。
- **辅助操作**：分别测量 `SessionManager.getEntries()`、真实的 `AgentSession.getContextUsage()`、`SettingsManager.getSettings()`。

使用真实 `SessionManager`、`AgentSession` 和 extension context；context projection 没有替换成常量或 mock。运行前校验非空输出、终端宽度限制，以及缓存命中前后输出一致。

## 隔离与边界

- 原 session file 只读取一次；后续恢复和分支操作全部发生在内存中，不修改原文件。
- 使用空的临时 auth/model storage 和无扩展、工具、skills、prompt 的 ResourceLoader，不读取用户凭证、不发起模型请求。临时 SDK 目录在测试结束后删除。
- compact 使用用户当前 `footer.json` 配置；两种 footer 使用固定 dark theme、模拟 Git 分支 `benchmark` 和空 extension statuses。
- Settings 使用固定的 `{ compaction: { enabled: true }, cacheWarming: "off" }`，不代表用户完整 settings 的复制开销；无真实订阅认证。
- 官方和 compact 布局不同，比较的是同一会话输入下两套真实实现的整体耗时，不是严格同布局对比。
- 不包含终端写入、TUI diff、Git watcher、扩展状态更新、streaming 输入或网络耗时。
- 这是性能基线，不设置跨机器通用的 pass/fail 耗时阈值；优先比较同一机器、同一快照、同一配置下的多次结果。

## 当前会话基线

同一固定快照连续运行两次，环境为 Apple M4 Pro、macOS arm64、Node.js v22.22.0、Pi 0.99.1；模型为 `openai-codex/gpt-6.1-sol`。

- 快照：955,750 bytes，225 entries，当前分支 166 entries。
- SHA-256：`da5350c7bc81578fd955d7ba0d2f94eb2dfa4290d7f7f88a36d9744166d011a2`。
- 基准运行额外添加 2 个内存 custom entries。
- 配置含 2 行，extension statuses 为空；空行可能不输出。

以下为每次操作的平均耗时，转换为 **µs/op**：

| 场景 | 第一次 | 第二次 |
| --- | ---: | ---: |
| Compact warm render，80 列 | 37.4 | 38.2 |
| 官方 warm render，80 列 | 15.1 | 15.8 |
| Compact warm render，120 列 | 26.0 | 26.7 |
| 官方 warm render，120 列 | 15.7 | 15.4 |
| Compact warm render，200 列 | 26.0 | 26.9 |
| 官方 warm render，200 列 | 15.2 | 15.9 |
| Compact 新实例 + 首次 render，120 列 | 31.1 | 32.4 |
| Compact 切换 leaf + render，120 列 | 30.8 | 31.4 |
| 官方切换 leaf + render，120 列 | 39.9 | 40.3 |
| entries 浅快照 | 1.4 | 1.4 |
| context usage / projection | 19.1 | 18.5 |
| 固定 settings 小配置的复制 | 0.7 | 0.7 |

在这个快照下，120 列 compact warm render 耗时约为官方的 **1.66–1.74 倍**，但绝对耗时只有约 26–27 µs。真实 context usage 路径的独立测量约为 19 µs，值得优先调查缓存收益；entries 快照和这个固定 settings 的复制开销较小。

独立基准受到 JIT、GC 和执行顺序影响，不能把它们的平均值直接相加或相减来严格归因。当前快照也不能证明超长会话、真实 streaming 或终端刷新没有性能问题。
