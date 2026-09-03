import { loadConfig } from "./config";
import { bigmodelSearchProvider } from "./providers/bigmodel";
import { braveSearchProvider } from "./providers/brave";
import { tavilySearchProvider } from "./providers/tavily";
import type { SearchRequest, SearchResponse } from "./types";

export async function searchWeb(
  query: string,
  maxResults: number | undefined,
  signal: AbortSignal,
): Promise<SearchResponse> {
  const config = loadConfig();
  const request: SearchRequest = {
    query,
    maxResults: maxResults ?? config.maxResults,
  };
  const response =
    config.provider === "bigmodel"
      ? await bigmodelSearchProvider.search(request, config.providers.bigmodel, signal)
      : config.provider === "brave"
        ? await braveSearchProvider.search(request, config.providers.brave, signal)
        : await tavilySearchProvider.search(request, config.providers.tavily, signal);
  return {
    ...response,
    results: response.results.map((result) => ({
      title: result.title,
      url: result.url,
      snippet: result.snippet,
    })),
  };
}
