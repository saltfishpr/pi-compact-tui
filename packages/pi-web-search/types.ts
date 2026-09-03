export type SearchProviderId = "bigmodel" | "brave" | "tavily";

export interface SearchRequest {
  query: string;
  maxResults: number;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchResponse {
  provider: SearchProviderId;
  query: string;
  results: SearchResult[];
}

export interface SearchProvider<Config> {
  readonly id: SearchProviderId;
  search(config: Config, request: SearchRequest, signal: AbortSignal): Promise<SearchResponse>;
}
