# Custom web search providers

`pi-web-search` accepts providers registered by other Pi extensions. The `web_search` tool becomes available as soon as at least one provider registers; a call can choose a provider by ID or use the default in `~/.pi/agent/extensions/web-search.json`.

## Register a provider

Create an extension in an auto-discovered location such as `~/.pi/agent/extensions/my-search.ts` and register it during `session_start`:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", () => {
    pi.events.emit("pi-web-search:register:v1", {
      id: "my-search",
      async search(request: { query: string; maxResults: number }, signal: AbortSignal) {
        // Replace this with a search API call. Pass signal to fetch for cancellation.
        // Return an array of { title: string, url: string, snippet: string }.
        throw new Error("Implement the search API call");
      },
    });
  });
}
```

The event payload must have a nonempty, unique `id` and a `search` function. `request.query` is the search text; `request.maxResults` is the requested result limit (1–10). Return search results in relevance order with `title`, `url`, and `snippet` strings. Use the provided `signal` for cancellation. The tool caps the returned list at `maxResults` and presents snippets, not full page contents. Registration with an ID already in use is ignored.

To make this provider the default, set `"provider": "my-search"` in `~/.pi/agent/extensions/web-search.json`. Without a default, calls must pass `provider: "my-search"`. Keep credentials and service-specific settings in your own extension's configuration: the `providers` object in `web-search.json` only configures the built-in BigModel provider.

Brave and Tavily are no longer built in. Existing configurations that select either service require a separately registered provider with the corresponding ID, or a switch to BigModel.
