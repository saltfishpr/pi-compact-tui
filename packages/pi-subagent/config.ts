import * as z from "zod";

import { getGlobalConfigPath, loadJSONConfig, modelSchema, THINKING_LEVELS } from "../pi-common";

const CONFIG_FILE_NAME = "subagent.json";

export function getSubagentConfigPath(): string {
  return getGlobalConfigPath(CONFIG_FILE_NAME);
}

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
