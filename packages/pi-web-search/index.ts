import { Type } from "@earendil-works/pi-ai";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateHead } from "../pi-common";
import { loadConfig } from "./config";
import { searchWeb } from "./search";

export default function (pi: ExtensionAPI) {
  let config = loadConfig();

  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web for current or external information. Returns up to 10 results with titles, URLs, and snippets.",
    promptSnippet: "Search the web for current or external information",
    promptGuidelines: [
      "Use web_search when the answer needs current, external, or independently verifiable information.",
      "Use URLs returned by web_search as citations when answering from search results.",
    ],
    parameters: Type.Object({
      query: Type.String({
        minLength: 1,
        description: "The web search query.",
      }),
      maxResults: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 10,
          description: "Maximum number of results to return. Defaults to the configured value.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const response = await searchWeb(config, params.query, params.maxResults, signal ?? new AbortController().signal);
      const text = formatResults(response);
      const truncation = truncateHead(text, {
        maxBytes: DEFAULT_MAX_BYTES,
        maxLines: DEFAULT_MAX_LINES,
      });

      return {
        content: [{ type: "text", text: truncation.content }],
        details: response,
      };
    },
  });

  pi.on("session_start", () => {
    config = loadConfig();

    const activeTools = pi.getActiveTools();
    if (!config.provider) {
      // 如果没有配置 provider，移除 web_search 工具
      pi.setActiveTools(activeTools.filter((toolName) => toolName !== "web_search"));
    } else {
      // 如果配置了 provider，添加 web_search 工具
      if (!activeTools.includes("web_search")) {
        pi.setActiveTools([...activeTools, "web_search"]);
      }
    }
  });
}

function formatResults(response: Awaited<ReturnType<typeof searchWeb>>): string {
  if (response.results.length === 0) {
    return `No ${response.provider} results found for: ${response.query}`;
  }

  const results = response.results.map((result, index) => {
    const snippet = result.snippet ? `\n${result.snippet}` : "";
    return `${index + 1}. ${result.title}\n${result.url}${snippet}`;
  });
  return `Search results for: ${response.query}\n\n${results.join("\n\n")}`;
}
