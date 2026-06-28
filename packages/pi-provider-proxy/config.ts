import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { defu } from "defu";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const proxyConfigSchema = z.object({
  proxies: z.record(z.string(), z.string()).optional(),
});

export type ProxyConfig = z.infer<typeof proxyConfigSchema>;

function readConfigFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) {
    return {};
  }
  const raw = readFileSync(path, "utf-8");
  return JSON.parse(raw);
}

// loadConfig 合并项目配置与全局配置（项目优先），返回校验后的 ProxyConfig。
export function loadConfig(cwd: string): ProxyConfig {
  const globalPath = join(getAgentDir(), "extensions", "proxy.json");
  const projectPath = join(cwd, CONFIG_DIR_NAME, "extensions", "proxy.json");
  const merged = defu(readConfigFile(projectPath), readConfigFile(globalPath));
  return proxyConfigSchema.parse(merged);
}
