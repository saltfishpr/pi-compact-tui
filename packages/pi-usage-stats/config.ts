import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

const DEFAULT_CONFIG: ProviderStatsConfig = providerStatsConfigSchema.parse({});

export function getConfigPath(): string {
  return join(getAgentDir(), "extensions", CONFIG_FILE_NAME);
}

export function loadConfig(): ProviderStatsConfig {
  const path = getConfigPath();
  ensureDefaultConfig(path);
  const config = providerStatsConfigSchema.parse(readConfigFile(path));
  migrateLegacyConfig(path, config);
  return config;
}

function ensureDefaultConfig(path: string): void {
  if (existsSync(path)) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, { flag: "wx" });
  } catch {
    // Continue with the in-memory default when the config file cannot be created.
  }
}

function readConfigFile(path: string): unknown {
  if (!existsSync(path)) return DEFAULT_CONFIG;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return DEFAULT_CONFIG;
  }
}
