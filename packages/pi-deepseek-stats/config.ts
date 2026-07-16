import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as z from "zod";

const CONFIG_FILE_NAME = "deepseek-stats.json";
const STATE_FILE_NAME = "deepseek-stats-state.json";

export const deepSeekStatsConfigSchema = z.object({
  currency: z.enum(["CNY", "USD"]),
});

export type DeepSeekStatsConfig = z.infer<typeof deepSeekStatsConfigSchema>;
export type Currency = DeepSeekStatsConfig["currency"];

const DEFAULT_CONFIG: DeepSeekStatsConfig = {
  currency: "CNY",
};

export function getConfigPath(): string {
  return join(getAgentDir(), "extensions", CONFIG_FILE_NAME);
}

export function getStatePath(): string {
  return join(getAgentDir(), "extensions", STATE_FILE_NAME);
}

export function loadConfig(): DeepSeekStatsConfig {
  const globalPath = getConfigPath();
  ensureDefaultGlobalConfig(globalPath);
  return deepSeekStatsConfigSchema.parse(readConfigFile(globalPath));
}

function ensureDefaultGlobalConfig(path: string): void {
  if (existsSync(path)) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, { flag: "wx" });
  } catch {
    // Continue with schema defaults when the global config cannot be created.
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
