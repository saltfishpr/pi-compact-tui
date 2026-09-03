import { getGlobalConfigPath, loadJSONConfig } from "../pi-common";
import * as z from "zod";
import { bigmodelProviderConfigSchema } from "./providers/bigmodel";
import { braveProviderConfigSchema } from "./providers/brave";
import { tavilyProviderConfigSchema } from "./providers/tavily";

const CONFIG_FILE_NAME = "web-search.json";

export const webSearchConfigSchema = z.object({
  provider: z.enum(["bigmodel", "brave", "tavily"]).optional(),
  maxResults: z.number().int().min(1).max(10).default(5),
  providers: z
    .object({
      bigmodel: bigmodelProviderConfigSchema.optional(),
      brave: braveProviderConfigSchema.optional(),
      tavily: tavilyProviderConfigSchema.optional(),
    })
    .default({}),
});

export type WebSearchConfig = z.infer<typeof webSearchConfigSchema>;

export function loadConfig(): WebSearchConfig {
  const path = getGlobalConfigPath(CONFIG_FILE_NAME);
  return loadJSONConfig(path, webSearchConfigSchema);
}
