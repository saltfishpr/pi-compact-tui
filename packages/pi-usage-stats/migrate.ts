import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProviderStatsConfig } from "./config";

const LEGACY_DEEPSEEK_CONFIG_PATH = join(getAgentDir(), "extensions", "deepseek-stats.json");

export function migrateLegacyConfig(path: string, config: ProviderStatsConfig): void {
  const legacy = readJSON(LEGACY_DEEPSEEK_CONFIG_PATH) as { currency?: unknown } | undefined;
  if (!legacy) return;

  if (legacy.currency === "CNY" || legacy.currency === "USD") {
    const deepseek = config.providers.deepseek;
    if (deepseek?.currency === undefined) config.providers.deepseek = { ...deepseek, currency: legacy.currency };
  }

  writeJSON(path, config);
  rmSync(LEGACY_DEEPSEEK_CONFIG_PATH);
}

function readJSON(path: string): unknown {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function writeJSON(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
