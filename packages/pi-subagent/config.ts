import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as z from "zod";

const CONFIG_FILE_NAME = "subagent.json";

export const subagentConfigSchema = z.object({
  enabled: z.boolean(),
});

export type SubagentConfig = z.infer<typeof subagentConfigSchema>;

const DEFAULT_CONFIG: SubagentConfig = {
  enabled: true,
};

export function getConfigPath(): string {
  return join(getAgentDir(), "extensions", CONFIG_FILE_NAME);
}

export function loadConfig(): SubagentConfig {
  const globalPath = getConfigPath();
  ensureDefaultGlobalConfig(globalPath);
  return subagentConfigSchema.parse(readConfigFile(globalPath));
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
