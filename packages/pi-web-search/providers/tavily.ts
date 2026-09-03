import * as z from "zod";
import type { SearchProvider, SearchRequest, SearchResponse, SearchResult } from "../types";

export const tavilyProviderConfigSchema = z.object({
  apiKey: z.string().optional(),
  searchDepth: z.enum(["basic", "advanced"]).default("basic"),
});

export type TavilyProviderConfig = z.infer<typeof tavilyProviderConfigSchema>;

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
}

interface TavilyResponse {
  results?: TavilyResult[];
}

// TODO Agent 生成，暂未测试
export const tavilySearchProvider: SearchProvider<TavilyProviderConfig> = {
  id: "tavily",
  async search(request: SearchRequest, config: TavilyProviderConfig, signal: AbortSignal): Promise<SearchResponse> {
    const apiKey = resolveApiKey(config);
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query: request.query,
        max_results: request.maxResults,
        search_depth: config.searchDepth,
      }),
      signal,
    });
    await throwForFailedResponse(response, "Tavily");

    const payload = (await response.json()) as TavilyResponse;
    const results = (payload.results ?? []).flatMap(toSearchResult);
    return { provider: "tavily", query: request.query, results };
  },
};

function resolveApiKey(config: TavilyProviderConfig): string {
  if (!config.apiKey) {
    throw new Error(`No API key configured for tavily.`);
  }
  const apiKey = config.apiKey.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
    (_match, name: string) => process.env[name] ?? "",
  );
  if (!apiKey.trim()) {
    throw new Error("The API key for tavily resolves to an empty value.");
  }
  return apiKey;
}

function toSearchResult(result: TavilyResult): SearchResult[] {
  if (!result.title || !result.url) return [];
  return [{ title: result.title, url: result.url, snippet: result.content ?? "" }];
}

async function throwForFailedResponse(response: Response, provider: string): Promise<void> {
  if (response.ok) return;
  if (response.status === 401 || response.status === 403) {
    throw new Error(`${provider} rejected the API key (${response.status}).`);
  }
  if (response.status === 429) {
    throw new Error(`${provider} rate limit exceeded.`);
  }
  throw new Error(`${provider} search failed (${response.status}): ${await response.text()}`);
}
