Type: task
Status: needs-triage
Blocked by: 05, 06

## Question

验证向前兼容性并进行最终清理。

### 验证项

1. **类型检查通过**：`pnpm typecheck` 无错误。
2. **v0 details 兼容**：确认 render 层对缺省 version 的 `SubagentResult` 能正确渲染。
3. **v1 details 正确**：`SubagentDetailsV1` 的所有 outcome variant 都有对应的渲染分支。
4. **导入清理**：移除所有不再使用的 import（`RunningSubagent` 引用等）。
5. **文件删除**：如果 `runner.ts` 的内容已完全迁移到 `executor.ts`，删除 `runner.ts`。如果保留（因为 `render.ts` 仍需 v0 类型），则保留但标注 deprecated。

### 清理项

- 检查 `index.ts` 中是否还有直接的 Widget 操作（应该已移到 Manager）。
- 检查 `agents.ts` 中 `LoadedAgent` 引用是否已全部替换为 `SubagentSpec`。
- 检查 `AgentCatalog` 中 `agents` 字段类型是否已更新。
- 确认 `pi-common` 的 import 路径正确。

### 文件

- 所有修改过的文件：`agents.ts`、`manager.ts`、`executor.ts`、`details.ts`、`index.ts`、`render.ts`