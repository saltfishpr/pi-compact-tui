import * as z from "zod";
import type { SearchProvider, SearchResult } from "../types";

export const bigmodelProviderConfigSchema = z.object({
  apiKey: z.string().trim().min(1),
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

export function createBigModelSearchProvider(config: BigModelProviderConfig): SearchProvider {
  return {
    id: "bigmodel",
    async search(request, signal) {
      const response = await fetch("https://open.bigmodel.cn/api/paas/v4/web_search", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
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
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new Error(`BigModel rejected the API key (${response.status}).`);
        }
        if (response.status === 429) {
          throw new Error("BigModel rate limit exceeded.");
        }
        throw new Error(`BigModel search failed (${response.status}): ${await response.text()}`);
      }

      const payload = (await response.json()) as BigModelResponse;
      return (payload.search_result ?? []).flatMap((result): SearchResult[] => {
        if (!result.title || !result.link) return [];
        return [{ title: result.title, url: result.link, snippet: result.content ?? "" }];
      });
    },
  };
}
