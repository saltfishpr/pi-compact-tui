import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as z from "zod";

const CONFIG_FILE_NAME = "footer.json";

// 内置 element key
const ELEMENT_KEYS = [
  "pwd",
  "branch",
  "sessionName",
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "cacheHitRate",
  "cost",
  "context",
  "provider",
  "model",
  "thinkingLevel",
  "extensionStatuses",
] as const;

const STATUS_ELEMENT_PREFIX = "status:";

export function getStatusKey(element: string): string | undefined {
  return element.startsWith(STATUS_ELEMENT_PREFIX) ? element.slice(STATUS_ELEMENT_PREFIX.length) : undefined;
}

export const lineConfigSchema = z.object({
  left: z.array(z.string()).optional(),
  right: z.array(z.string()).optional(),
});

export type LineConfig = z.infer<typeof lineConfigSchema>;

export const footerConfigSchema = z.object({
  separator: z.string(),
  lines: z.array(lineConfigSchema),
});

export type FooterConfig = z.infer<typeof footerConfigSchema>;

const DEFAULT_CONFIG: FooterConfig = {
  separator: " ",
  lines: [
    {
      left: ["pwd", "branch", "sessionName"],
      right: ["cacheHitRate", "cost", "context"],
    },
    { left: ["extensionStatuses"] },
  ],
};

/**
 * 从 `~/.pi/agent/extensions/footer.json` 加载 pi-compact-footer 的全局配置。
 *
 * @returns 校验后的 {@link FooterConfig}。
 */
export function loadConfig(): FooterConfig {
  const globalPath = join(getAgentDir(), "extensions", CONFIG_FILE_NAME);
  ensureDefaultGlobalConfig(globalPath);
  return footerConfigSchema.parse(readConfigFile(globalPath));
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
