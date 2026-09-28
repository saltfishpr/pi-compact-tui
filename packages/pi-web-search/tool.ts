import { StringEnum, Type } from "@earendil-works/pi-ai";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateHead } from "../pi-common";
import type { WebSearchConfig } from "./config";
import type { SearchProvider, SearchProviderId, SearchResult } from "./types";

export function registerWebSearchTool(
  pi: ExtensionAPI,
  providers: Map<SearchProviderId, SearchProvider>,
  getConfig: () => WebSearchConfig,
): void {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web using a registered provider. Returns up to 10 results with titles, URLs, and snippets, not full page contents.",
    promptSnippet: "Find current information and external sources on the web",
    promptGuidelines: [
      "Use web_search when an answer depends on current information or sources outside the conversation and workspace.",
      "When answering from web_search results, cite their URLs; do not claim to have read the full pages from snippets alone.",
    ],
    parameters: Type.Object({
      query: Type.String({ minLength: 1, description: "Keywords or question to search for on the web." }),
      provider: Type.Optional(
        StringEnum([...providers.keys()], {
          description: "Search provider ID. Omit to use the configured default; required if no default is configured.",
        }),
      ),
      maxResults: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 10,
          description:
            "Maximum number of results to return (1-10). Omit to use the configured default (5 unless changed).",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const config = getConfig();
      const providerId = params.provider ?? config.provider;
      if (!providerId) {
        throw new Error(
          `No default search provider configured. Specify a provider: ${[...providers.keys()].join(", ")}`,
        );
      }
      const provider = providers.get(providerId);
      if (!provider) {
        throw new Error(
          `Search provider '${providerId}' is not registered. Available: ${[...providers.keys()].join(", ")}`,
        );
      }

      const maxResults = params.maxResults ?? config.maxResults;
      const results = (
        await provider.search({ query: params.query, maxResults }, signal ?? new AbortController().signal)
      )
        .slice(0, maxResults)
        .map(({ title, url, snippet }) => ({ title, url, snippet }));
      const text = formatResults(providerId, params.query, results);
      const truncation = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
      return {
        content: [{ type: "text", text: truncation.content }],
        details: { provider: providerId, query: params.query, results },
      };
    },
  });
}

function formatResults(provider: SearchProviderId, query: string, results: SearchResult[]): string {
  if (results.length === 0) return `No ${provider} results found for: ${query}`;
  const items = results.map((result, index) => {
    const snippet = result.snippet ? `\n${result.snippet}` : "";
    return `${index + 1}. ${result.title}\n${result.url}${snippet}`;
  });
  return `Search results for: ${query}\n\n${items.join("\n\n")}`;
}
