import * as z from "zod";
import type { SearchProvider, SearchRequest, SearchResponse, SearchResult } from "../types";

export const braveProviderConfigSchema = z.object({
  apiKey: z.string().optional(),
});

export type BraveProviderConfig = z.infer<typeof braveProviderConfigSchema>;

interface BraveResult {
  title?: string;
  url?: string;
  description?: string;
}

interface BraveResponse {
  web?: {
    results?: BraveResult[];
  };
}

// TODO Agent 生成，暂未测试
export const braveSearchProvider: SearchProvider<BraveProviderConfig> = {
  id: "brave",
  async search(request: SearchRequest, config: BraveProviderConfig, signal: AbortSignal): Promise<SearchResponse> {
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    const apiKey = resolveApiKey(config);
    url.searchParams.set("q", request.query);
    url.searchParams.set("count", String(request.maxResults));

    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": apiKey,
      },
      signal,
    });
    await throwForFailedResponse(response, "Brave");

    const payload = (await response.json()) as BraveResponse;
    const results = (payload.web?.results ?? []).flatMap(toSearchResult);
    return { provider: "brave", query: request.query, results };
  },
};

function resolveApiKey(config: BraveProviderConfig): string {
  if (!config.apiKey) {
    throw new Error(`No API key configured for brave.`);
  }
  const apiKey = config.apiKey.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
    (_match, name: string) => process.env[name] ?? "",
  );
  if (!apiKey.trim()) {
    throw new Error("The API key for brave resolves to an empty value.");
  }
  return apiKey;
}

function toSearchResult(result: BraveResult): SearchResult[] {
  if (!result.title || !result.url) return [];
  return [{ title: result.title, url: result.url, snippet: result.description ?? "" }];
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
