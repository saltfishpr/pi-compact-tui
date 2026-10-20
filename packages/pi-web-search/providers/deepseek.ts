import * as z from "zod";
import type { SearchProvider, SearchResult } from "../types";

export const deepseekProviderConfigSchema = z.object({
  apiKey: z.string().trim().min(1).optional(),
});

export type DeepSeekProviderConfig = z.infer<typeof deepseekProviderConfigSchema>;

interface DeepSeekResult {
  title: string;
  url: string;
  summary: string;
  snippet: string;
}

interface DeepSeekResponse {
  results: DeepSeekResult[];
}

export function createDeepSeekSearchProvider(
  config: DeepSeekProviderConfig,
  getApiKey: () => Promise<string | undefined>,
): SearchProvider {
  return {
    id: "deepseek",
    async search(request, signal) {
      if (!request.query.trim() || Array.from(request.query).length > 128) {
        throw new Error("DeepSeek search query must contain 1–128 Unicode characters and cannot be blank.");
      }

      const apiKey = config.apiKey ?? (await getApiKey());
      if (!apiKey) {
        throw new Error(
          "No DeepSeek API key available. Configure DeepSeek credentials in Pi or set providers.deepseek.apiKey in web-search.json.",
        );
      }

      const response = await fetch("https://api.deepseek.com/v1/tools/search", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: request.query,
          count: request.maxResults,
          need_content: false,
        }),
        signal,
      });
      if (!response.ok) {
        if (response.status === 401) {
          throw new Error("DeepSeek rejected the API key (401).");
        }
        if (response.status === 402) {
          throw new Error("DeepSeek account balance is insufficient.");
        }
        if (response.status === 429) {
          throw new Error("DeepSeek rate limit exceeded.");
        }
        throw new Error(`DeepSeek search failed (${response.status}): ${await response.text()}`);
      }

      const payload = (await response.json()) as DeepSeekResponse;
      return payload.results.flatMap((result): SearchResult[] => {
        if (!result.title || !result.url) return [];
        return [{ title: result.title, url: result.url, snippet: result.summary || result.snippet || "" }];
      });
    },
  };
}
