import { StringEnum, Type } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  keyHint,
  type ExtensionAPI,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, hyperlink, Spacer, stripTerminalSequences, Text, TruncatedText } from "@earendil-works/pi-tui";
import { truncateHead } from "../pi-common";
import type { WebSearchConfig } from "./config";
import type { SearchProvider, SearchProviderId, SearchResult } from "./types";

const COLLAPSED_RESULT_COUNT = 3;
const MAX_EXPANDED_SNIPPET_LENGTH = 500;

interface WebSearchDetails {
  provider: SearchProviderId;
  query: string;
  results: SearchResult[];
}

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
        details: { provider: providerId, query: params.query, results } satisfies WebSearchDetails,
      };
    },
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("web_search"));
      const query = sanitizeInlineText(args.query);
      if (query) text += ` ${theme.fg("accent", JSON.stringify(query))}`;

      const options: string[] = [];
      if (args.provider) options.push(sanitizeInlineText(args.provider));
      if (options.length > 0) text += theme.fg("dim", ` · ${options.join(" · ")}`);

      return new TruncatedText(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme, context) {
      if (isPartial) return new Text(theme.fg("warning", "Searching…"), 0, 0);

      if (context.isError) {
        const message =
          sanitizeInlineText(getTextContent(result.content)).replace(/^Error:\s*/i, "") || "Unknown error";
        return new Text(theme.fg("error", `Search failed: ${message}`), 0, 0);
      }

      const details = isWebSearchDetails(result.details) ? result.details : undefined;
      if (!details) {
        return new Text(theme.fg("toolOutput", sanitizeDisplayText(getTextContent(result.content))), 0, 0);
      }

      const provider = sanitizeInlineText(details.provider);
      if (details.results.length === 0) {
        return new Text(theme.fg("dim", `No results${provider ? ` · ${provider}` : ""}`), 0, 0);
      }

      const content = new Container();
      const resultCount = details.results.length;
      const resultLabel = `${resultCount} ${resultCount === 1 ? "result" : "results"}`;
      content.addChild(
        new Text(theme.fg("success", resultLabel) + (provider ? theme.fg("dim", ` · ${provider}`) : ""), 0, 0),
      );

      if (expanded) {
        content.addChild(new Spacer(1));
        details.results.forEach((result, index) => {
          if (index > 0) content.addChild(new Spacer(1));
          content.addChild(new Text(formatExpandedResult(result, index, theme), 0, 0));
        });
        return content;
      }

      const visibleResults = details.results.slice(0, COLLAPSED_RESULT_COUNT);
      visibleResults.forEach((result, index) => {
        content.addChild(new TruncatedText(formatCollapsedResult(result, index, theme), 0, 0));
      });

      const remaining = details.results.length - visibleResults.length;
      if (remaining > 0) {
        const hint = keyHint("app.tools.expand", "to expand");
        content.addChild(new Text(`${theme.fg("dim", `… ${remaining} more (`)}${hint}${theme.fg("dim", ")")}`, 0, 0));
      }

      return content;
    },
  });
}

function formatCollapsedResult(result: SearchResult, index: number, theme: Theme): string {
  const title = sanitizeInlineText(result.title) || "Untitled result";
  const url = getSafeHttpUrl(result.url);
  const source = url ? new URL(url).hostname : sanitizeInlineText(result.url);
  const styledTitle = theme.fg("accent", title);
  const linkedTitle = url ? hyperlink(styledTitle, url) : styledTitle;
  return `${theme.fg("dim", `${index + 1}.`)} ${linkedTitle}${source ? theme.fg("dim", ` — ${source}`) : ""}`;
}

function formatExpandedResult(result: SearchResult, index: number, theme: Theme): string {
  const title = sanitizeInlineText(result.title) || "Untitled result";
  const urlText = sanitizeInlineText(result.url);
  const url = getSafeHttpUrl(result.url);
  const snippet = truncateText(sanitizeInlineText(result.snippet), MAX_EXPANDED_SNIPPET_LENGTH);
  const styledTitle = theme.fg("accent", title);
  const lines = [`${theme.fg("dim", `${index + 1}.`)} ${url ? hyperlink(styledTitle, url) : styledTitle}`];

  if (urlText) {
    const styledUrl = theme.fg("muted", `   ${urlText}`);
    lines.push(url ? hyperlink(styledUrl, url) : styledUrl);
  }
  if (snippet) lines.push(theme.fg("toolOutput", `   ${snippet}`));

  return lines.join("\n");
}

function getSafeHttpUrl(value: string): string | undefined {
  const sanitized = stripTerminalSequences(value)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .trim();
  try {
    const url = new URL(sanitized);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function sanitizeDisplayText(value: string): string {
  return stripTerminalSequences(value)
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}

function sanitizeInlineText(value: unknown): string {
  if (typeof value !== "string") return "";
  return sanitizeDisplayText(value).replace(/\s+/g, " ").trim();
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

function getTextContent(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function isWebSearchDetails(value: unknown): value is WebSearchDetails {
  if (typeof value !== "object" || value === null) return false;
  const details = value as Partial<WebSearchDetails>;
  return (
    typeof details.provider === "string" &&
    typeof details.query === "string" &&
    Array.isArray(details.results) &&
    details.results.every(
      (result) =>
        typeof result === "object" &&
        result !== null &&
        typeof result.title === "string" &&
        typeof result.url === "string" &&
        typeof result.snippet === "string",
    )
  );
}

function formatResults(provider: SearchProviderId, query: string, results: SearchResult[]): string {
  if (results.length === 0) return `No ${provider} results found for: ${query}`;
  const items = results.map((result, index) => {
    const snippet = result.snippet ? `\n${result.snippet}` : "";
    return `${index + 1}. ${result.title}\n${result.url}${snippet}`;
  });
  return `Search results for: ${query}\n\n${items.join("\n\n")}`;
}
