# 自定义联网搜索 provider

其他 Pi extension 可以向 `pi-web-search` 注册搜索 provider。至少注册一个 provider 后，`web_search` 工具才可用；调用时可以通过 ID 选择 provider，也可以使用 `~/.pi/agent/extensions/web-search.json` 中配置的默认值。

## 注册 provider

在自动发现目录中创建 extension，例如 `~/.pi/agent/extensions/my-search.ts`，并在 `session_start` 时注册：

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", () => {
    pi.events.emit("pi-web-search:register:v1", {
      id: "my-search",
      async search(request: { query: string; maxResults: number }, signal: AbortSignal) {
        // 改成实际的搜索 API 请求；将 signal 传给 fetch，以便取消请求。
        // 返回 { title: string, url: string, snippet: string } 数组。
        throw new Error("Implement the search API call");
      },
    });
  });
}
```

事件数据必须包含非空且唯一的 `id` 和 `search` 函数。`request.query` 是搜索词，`request.maxResults` 是请求的结果数量上限（1～10）。按相关性顺序返回结果，每条结果包含字符串形式的 `title`、`url` 和 `snippet`。用传入的 `signal` 支持取消请求。工具会将结果数量限制在 `maxResults` 内，并只展示摘要，不提供网页全文。重复注册同一 ID 会被忽略。

要在当前会话中移除 provider，发送 `pi-web-search:unregister:v1` 事件并传入其 ID：

```typescript
pi.events.emit("pi-web-search:unregister:v1", { id: "my-search" });
```

未知 ID 会被忽略。移除最后一个 provider 后，`web_search` 会被禁用；否则会更新可选的 provider 列表。

要将此 provider 设为默认值，在 `~/.pi/agent/extensions/web-search.json` 中设置 `"provider": "my-search"`。不设置默认值时，调用必须传入 `provider: "my-search"`。API Key 和服务专用配置应由你自己的 extension 管理；`web-search.json` 的 `providers` 对象只用于配置内置的 BigModel provider。

Brave 和 Tavily 已不再内置。原有配置若选用这两个服务，需要额外注册具有对应 ID 的 provider，或改用 BigModel。
