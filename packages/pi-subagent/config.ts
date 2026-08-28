import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as z from "zod";

import { modelSchema, THINKING_LEVELS } from "../pi-common";

const CONFIG_FILE_NAME = "subagent.json";

export const agentOverrideSchema = z.object({
  model: modelSchema.shape.model,
  effort: z.enum(THINKING_LEVELS).optional(),
  maxTurns: z.number().int().positive().optional(),
});

export type AgentOverride = z.infer<typeof agentOverrideSchema>;

export const subagentConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxConcurrent: z.number().int().min(1).max(32).default(4),
  agents: z.record(z.string().min(1), agentOverrideSchema).default({}),
});

export type SubagentConfig = z.infer<typeof subagentConfigSchema>;

const DEFAULT_CONFIG: SubagentConfig = {
  enabled: true,
  maxConcurrent: 4,
  agents: {},
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read ${path}: ${message}`);
  }
}
