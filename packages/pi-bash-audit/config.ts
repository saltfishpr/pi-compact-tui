import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import writeFileAtomic from "write-file-atomic";
import * as z from "zod";

import { modelSchema } from "../pi-common";

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

/**
 * loadConfig reads bash-audit.json.
 * Returns an empty config when the file does not exist so callers can fall back to defaults.
 * Throws when the file is present but cannot be parsed or fails schema validation.
 */
export function loadConfig(): BashAuditConfig {
  const path = getConfigPath();
  if (!existsSync(path)) return bashAuditConfigSchema.parse({});
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return bashAuditConfigSchema.parse(raw);
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
  const path = getConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic.sync(path, `${JSON.stringify(parsed, null, 2)}\n`);
}

function getConfigPath(): string {
  return join(getAgentDir(), "extensions", CONFIG_FILE_NAME);
}
