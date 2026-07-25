import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import writeFileAtomic from "write-file-atomic";
import * as z from "zod";

import { modelSchema } from "../pi-common";

const CONFIG_FILE_NAME = "bash-audit.json";

export const bashAuditConfigSchema = modelSchema.extend({
  enable: z.boolean().default(true),
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

/** saveConfig atomically overwrites bash-audit.json with canonical fields. */
export function saveConfig(config: BashAuditConfig): void {
  const parsed = bashAuditConfigSchema.parse(config);
  const canonical = {
    enable: parsed.enable,
    model: parsed.model,
    thinkingLevel: parsed.thinkingLevel,
  };
  const path = getConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic.sync(path, `${JSON.stringify(canonical, null, 2)}\n`);
}

function getConfigPath(): string {
  return join(getAgentDir(), "extensions", CONFIG_FILE_NAME);
}
