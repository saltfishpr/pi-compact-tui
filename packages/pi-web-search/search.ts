import type { WebSearchConfig } from "./config";
import { bigmodelSearchProvider } from "./providers/bigmodel";
import { braveSearchProvider } from "./providers/brave";
import { tavilySearchProvider } from "./providers/tavily";
import type { SearchProvider, SearchRequest, SearchResponse } from "./types";

export async function searchWeb(
  config: WebSearchConfig,
  query: string,
  maxResults: number | undefined,
  signal: AbortSignal,
): Promise<SearchResponse> {
  if (!config.provider) {
    throw new Error("No web search provider configured");
  }

  const request: SearchRequest = {
    query,
    maxResults: maxResults ?? config.maxResults,
  };
  const searches = {
    bigmodel: () => searchWithProvider(config.providers.bigmodel, bigmodelSearchProvider, request, signal),
    brave: () => searchWithProvider(config.providers.brave, braveSearchProvider, request, signal),
    tavily: () => searchWithProvider(config.providers.tavily, tavilySearchProvider, request, signal),
  };
  const response = await searches[config.provider]();
  return {
    ...response,
    results: response.results.map((result) => ({
      title: result.title,
      url: result.url,
      snippet: result.snippet,
    })),
  };
}

function searchWithProvider<Config>(
  config: Config | undefined,
  provider: SearchProvider<Config>,
  request: SearchRequest,
  signal: AbortSignal,
): Promise<SearchResponse> {
  if (!config) {
    throw new Error(`${provider.id} provider not configured`);
  }
  return provider.search(config, request, signal);
}
