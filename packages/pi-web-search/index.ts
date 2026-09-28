import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../pi-common";
import { loadConfig, type WebSearchConfig } from "./config";
import { createBigModelSearchProvider } from "./providers/bigmodel";
import { registerWebSearchTool } from "./tool";
import { REGISTER_SEARCH_PROVIDER_EVENT, type SearchProvider, type SearchProviderId } from "./types";

const logger = createLogger("pi-web-search");

export default function (pi: ExtensionAPI) {
  const providers = new Map<SearchProviderId, SearchProvider>();
  let config: WebSearchConfig = { maxResults: 5, providers: {} };
  registerWebSearchTool(pi, providers, () => config);

  pi.events.on(REGISTER_SEARCH_PROVIDER_EVENT, (data) => {
    if (!isSearchProvider(data)) {
      logger.warn(`Ignoring invalid ${REGISTER_SEARCH_PROVIDER_EVENT} payload`);
      return;
    }
    if (providers.has(data.id)) {
      logger.warn(`Search provider '${data.id}' is already registered`);
      return;
    }
    providers.set(data.id, data);
    registerWebSearchTool(pi, providers, () => config); // refresh tool with new provider

    if (!pi.getActiveTools().includes("web_search")) {
      pi.setActiveTools([...pi.getActiveTools(), "web_search"]);
    }
  });

  pi.on("session_start", () => {
    config = loadConfig();

    if (config.providers.bigmodel) {
      pi.events.emit(REGISTER_SEARCH_PROVIDER_EVENT, createBigModelSearchProvider(config.providers.bigmodel));
    }

    const active = pi.getActiveTools();
    if (providers.size === 0) {
      pi.setActiveTools(active.filter((name) => name !== "web_search"));
    } else if (!active.includes("web_search")) {
      pi.setActiveTools([...active, "web_search"]);
    }
  });
}

function isSearchProvider(value: unknown): value is SearchProvider {
  if (typeof value !== "object" || value === null) return false;
  const provider = value as Partial<SearchProvider>;
  return typeof provider.id === "string" && provider.id.trim().length > 0 && typeof provider.search === "function";
}
