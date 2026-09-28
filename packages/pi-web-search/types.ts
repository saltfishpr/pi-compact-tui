export type SearchProviderId = string;

export interface SearchRequest {
  query: string;
  maxResults: number;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** Emit a SearchProvider on this channel during session_start to register it for the current session. */
export const REGISTER_SEARCH_PROVIDER_EVENT = "pi-web-search:register:v1";

/** Emit { id } on this channel to remove a registered provider from the current session. */
export const UNREGISTER_SEARCH_PROVIDER_EVENT = "pi-web-search:unregister:v1";

export interface SearchProvider {
  readonly id: SearchProviderId;
  search(request: SearchRequest, signal: AbortSignal): Promise<SearchResult[]>;
}
