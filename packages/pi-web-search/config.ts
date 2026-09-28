import * as z from "zod";
import { getGlobalConfigPath, loadJSONConfig } from "../pi-common";
import { bigmodelProviderConfigSchema } from "./providers/bigmodel";

const CONFIG_FILE_NAME = "web-search.json";

const webSearchConfigSchema = z.object({
  provider: z.string().min(1).optional(),
  maxResults: z.number().int().min(1).max(10).default(5),
  providers: z.object({ bigmodel: bigmodelProviderConfigSchema.optional() }).default({}),
});

export type WebSearchConfig = z.infer<typeof webSearchConfigSchema>;

export function loadConfig(): WebSearchConfig {
  return loadJSONConfig(getGlobalConfigPath(CONFIG_FILE_NAME), webSearchConfigSchema);
}
