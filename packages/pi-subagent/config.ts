import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import writeFileAtomic from "write-file-atomic";
import * as z from "zod";

import { getGlobalConfigPath, loadJSONConfig, modelSchema, THINKING_LEVELS } from "../pi-common";
import { ISOLATION_MODES } from "./types";

const CONFIG_FILE_NAME = "subagent.json";

export function getSubagentConfigPath(): string {
  return getGlobalConfigPath(CONFIG_FILE_NAME);
}

export const agentOverrideSchema = z.object({
  model: modelSchema.shape.model,
  effort: z.enum(THINKING_LEVELS).optional(),
  maxTurns: z.number().int().positive().optional(),
  timeoutSeconds: z.number().int().positive().optional(),
  isolation: z.enum(ISOLATION_MODES).optional(),
  extensions: z.array(z.string().min(1)).optional(),
});

export type AgentOverride = z.infer<typeof agentOverrideSchema>;

export const subagentConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxConcurrent: z.number().int().min(1).max(32).default(4),
  defaultTimeoutSeconds: z.number().int().positive().optional(),
  agents: z.record(z.string().min(1), agentOverrideSchema).default({}),
  trustedProfiles: z
    .array(
      z.object({
        path: z.string().min(1),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .default([]),
});

export type SubagentConfig = z.infer<typeof subagentConfigSchema>;

export function loadConfig(): SubagentConfig {
  return loadJSONConfig(getSubagentConfigPath(), subagentConfigSchema);
}

export function saveConfig(config: SubagentConfig): void {
  const path = getSubagentConfigPath();
  const validated = subagentConfigSchema.parse(config);
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic.sync(path, `${JSON.stringify(validated, null, 2)}\n`);
}
