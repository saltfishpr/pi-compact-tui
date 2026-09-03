import * as z from "zod";
import type { SearchProvider, SearchRequest, SearchResponse, SearchResult } from "../types";

export const bigmodelProviderConfigSchema = z.object({
  apiKey: z.string().optional(),
  searchEngine: z.enum(["search_std", "search_pro", "search_pro_sogou", "search_pro_quark"]).default("search_std"),
});

export type BigModelProviderConfig = z.infer<typeof bigmodelProviderConfigSchema>;

interface BigModelResult {
  title?: string;
  link?: string;
  content?: string;
}

interface BigModelResponse {
  search_result?: BigModelResult[];
}

export const bigmodelSearchProvider: SearchProvider<BigModelProviderConfig> = {
  id: "bigmodel",
  async search(request: SearchRequest, config: BigModelProviderConfig, signal: AbortSignal): Promise<SearchResponse> {
    const apiKey = resolveApiKey(config);
    const response = await fetch("https://open.bigmodel.cn/api/paas/v4/web_search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        search_query: request.query,
        search_engine: config.searchEngine,
        search_intent: false,
        count: request.maxResults,
      }),
      signal,
    });
    await throwForFailedResponse(response, "BigModel");

    const payload = (await response.json()) as BigModelResponse;
    const results = (payload.search_result ?? []).flatMap(toSearchResult);
    return { provider: "bigmodel", query: request.query, results };
  },
};

function resolveApiKey(config: BigModelProviderConfig): string {
  if (!config.apiKey) {
    throw new Error("No API key configured for bigmodel.");
  }
  const apiKey = config.apiKey.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
    (_match, name: string) => process.env[name] ?? "",
  );
  if (!apiKey.trim()) {
    throw new Error("The API key for bigmodel resolves to an empty value.");
  }
  return apiKey;
}

function toSearchResult(result: BigModelResult): SearchResult[] {
  if (!result.title || !result.link) return [];
  return [{ title: result.title, url: result.link, snippet: result.content ?? "" }];
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
