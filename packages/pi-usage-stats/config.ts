import { getGlobalConfigPath, loadJSONConfig } from "../pi-common";
import * as z from "zod";
import { migrateLegacyConfig } from "./migrate";

const CONFIG_FILE_NAME = "provider-stats.json";

export type Currency = "CNY" | "USD";

export const providerConfigSchema = z.object({
  enabled: z.boolean().default(true),
  currency: z.enum(["CNY", "USD"]).optional(),
});

export type ProviderConfig = z.infer<typeof providerConfigSchema>;

export const providerStatsConfigSchema = z.object({
  providers: z.record(z.string(), providerConfigSchema).default({}),
});

export type ProviderStatsConfig = z.infer<typeof providerStatsConfigSchema>;

export function loadConfig(): ProviderStatsConfig {
  const path = getGlobalConfigPath(CONFIG_FILE_NAME);
  const config = loadJSONConfig(path, providerStatsConfigSchema);
  migrateLegacyConfig(path, config);
  return config;
}
