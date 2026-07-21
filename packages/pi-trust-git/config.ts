import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as z from "zod";

const CONFIG_FILE_NAME = "trust.json";

export const trustConfigSchema = z.object({
  domains: z
    .array(z.string())
    .default([])
    .transform((list) => list.map((item) => item.trim().toLowerCase()).filter(Boolean)),
  usernames: z
    .array(z.string())
    .default([])
    .transform((list) => list.map((item) => item.trim().toLowerCase()).filter(Boolean)),
});

export type TrustConfig = z.infer<typeof trustConfigSchema>;

const DEFAULT_CONFIG = {
  domains: [] as string[],
  usernames: [] as string[],
};

/**
 * 从 `~/.pi/agent/extensions/trust.json` 加载 pi-trust-git 的全局配置。
 *
 * @returns 校验后的 {@link TrustConfig}。
 */
export function loadConfig(): TrustConfig {
  const globalPath = join(getAgentDir(), "extensions", CONFIG_FILE_NAME);
  ensureDefaultGlobalConfig(globalPath);
  return trustConfigSchema.parse(readConfigFile(globalPath));
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
