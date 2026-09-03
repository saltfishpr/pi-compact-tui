import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import writeFileAtomic from "write-file-atomic";
import * as z from "zod";

import { getGlobalConfigPath, loadJSONConfig, modelSchema } from "../pi-common";

const CONFIG_FILE_NAME = "bash-audit.json";

const readOnlyExceptionSchema = z.object({
  args: z.array(z.string().trim().min(1)).min(1),
});

const ruleSchema = z.object({
  command: z.string().trim().min(1),
  args: z.array(z.string().trim().min(1)).default([]),
  except: z.array(readOnlyExceptionSchema).default([]),
  action: z.enum(["allow", "prompt", "auto"]),
});

export type Rule = z.infer<typeof ruleSchema>;

export const bashAuditConfigSchema = modelSchema.extend({
  enable: z.boolean().default(false),
  rules: z.array(ruleSchema).default([]),
});

export type BashAuditConfig = z.infer<typeof bashAuditConfigSchema>;

export function loadConfig(): BashAuditConfig {
  const path = getGlobalConfigPath(CONFIG_FILE_NAME);
  return loadJSONConfig(path, bashAuditConfigSchema);
}

/**
 * saveConfig atomically merges updates into bash-audit.json and writes canonical fields.
 * Array fields are replaced rather than merged.
 */
export function saveConfig(update: Partial<BashAuditConfig>): void {
  let current: BashAuditConfig;
  try {
    current = loadConfig();
  } catch {
    current = bashAuditConfigSchema.parse({});
  }
  const parsed = bashAuditConfigSchema.parse({ ...current, ...update });
  const path = getGlobalConfigPath(CONFIG_FILE_NAME);
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic.sync(path, `${JSON.stringify(parsed, null, 2)}\n`);
}
