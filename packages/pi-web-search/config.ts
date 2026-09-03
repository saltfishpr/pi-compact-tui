import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as z from "zod";
import { bigmodelProviderConfigSchema } from "./providers/bigmodel";
import { braveProviderConfigSchema } from "./providers/brave";
import { tavilyProviderConfigSchema } from "./providers/tavily";

const CONFIG_FILE_NAME = "web-search.json";

const DEFAULT_BIGMODEL_PROVIDER_CONFIG = bigmodelProviderConfigSchema.parse({});
const DEFAULT_BRAVE_PROVIDER_CONFIG = braveProviderConfigSchema.parse({});
const DEFAULT_TAVILY_PROVIDER_CONFIG = tavilyProviderConfigSchema.parse({});
const DEFAULT_PROVIDERS = {
  bigmodel: DEFAULT_BIGMODEL_PROVIDER_CONFIG,
  brave: DEFAULT_BRAVE_PROVIDER_CONFIG,
  tavily: DEFAULT_TAVILY_PROVIDER_CONFIG,
};

export const webSearchConfigSchema = z.object({
  provider: z.enum(["bigmodel", "brave", "tavily"]).default("brave"),
  maxResults: z.number().int().min(1).max(10).default(5),
  providers: z
    .object({
      bigmodel: bigmodelProviderConfigSchema.default(DEFAULT_BIGMODEL_PROVIDER_CONFIG),
      brave: braveProviderConfigSchema.default(DEFAULT_BRAVE_PROVIDER_CONFIG),
      tavily: tavilyProviderConfigSchema.default(DEFAULT_TAVILY_PROVIDER_CONFIG),
    })
    .default(DEFAULT_PROVIDERS),
});

export type WebSearchConfig = z.infer<typeof webSearchConfigSchema>;

const DEFAULT_CONFIG: WebSearchConfig = webSearchConfigSchema.parse({});

export function loadConfig(): WebSearchConfig {
  const path = join(getAgentDir(), "extensions", CONFIG_FILE_NAME);
  ensureDefaultConfig(path);
  return webSearchConfigSchema.parse(readConfigFile(path));
}

function ensureDefaultConfig(path: string): void {
  if (existsSync(path)) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, { flag: "wx" });
  } catch {
    // The tool reports a missing credential if the default configuration cannot be created.
  }
}

function readConfigFile(path: string): unknown {
  if (!existsSync(path)) return DEFAULT_CONFIG;
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}
