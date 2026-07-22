import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as z from "zod";

const CONFIG_FILE_NAME = "bash-audit.json";

export const bashAuditConfigSchema = z.object({
  model: z
    .string()
    .regex(/^[^/]+\/.+$/, `expected "provider/model-id"`)
    .optional(),
  thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
});

export type BashAuditConfig = z.infer<typeof bashAuditConfigSchema>;

/**
 * loadConfig reads bash-audit.json.
 * Returns an empty config when the file does not exist so callers can fall back to defaults.
 * Throws when the file is present but cannot be parsed or fails schema validation.
 */
export function loadConfig(): BashAuditConfig {
  const path = join(getAgentDir(), "extensions", CONFIG_FILE_NAME);
  if (!existsSync(path)) return {};
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return bashAuditConfigSchema.parse(raw);
}
