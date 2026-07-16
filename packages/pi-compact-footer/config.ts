import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as z from "zod";

const CONFIG_FILE_NAME = "footer.json";

const STATUS_ELEMENT_PREFIX = "status:";

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

export type BuiltInElementKey = (typeof ELEMENT_KEYS)[number];
export type StatusElementKey = `${typeof STATUS_ELEMENT_PREFIX}${string}`;

const statusElementKeySchema = z.custom<StatusElementKey>(
  (value) =>
    typeof value === "string" && value.startsWith(STATUS_ELEMENT_PREFIX) && value.length > STATUS_ELEMENT_PREFIX.length,
  { message: "Status element must use the format status:<key>" },
);

export const elementKeySchema = z.union([z.enum(ELEMENT_KEYS), statusElementKeySchema]);

export type ElementKey = z.infer<typeof elementKeySchema>;

export function getStatusKey(element: ElementKey): string | undefined {
  return element.startsWith(STATUS_ELEMENT_PREFIX) ? element.slice(STATUS_ELEMENT_PREFIX.length) : undefined;
}

export const lineConfigSchema = z.object({
  left: z.array(elementKeySchema).optional(),
  right: z.array(elementKeySchema).optional(),
});

export type LineConfig = z.infer<typeof lineConfigSchema>;

export const footerConfigSchema = z.object({
  separator: z.string().default(" "),
  lines: z.array(lineConfigSchema).default([
    {
      left: ["pwd", "branch", "sessionName"],
      right: ["cacheHitRate", "cost", "context"],
    },
    { left: ["extensionStatuses"] },
  ]),
});

export type FooterConfig = z.infer<typeof footerConfigSchema>;

/**
 * 加载 pi-compact-footer 的配置，项目级优先。
 *
 * - 全局级路径：`~/.pi/agent/extensions/footer.json`
 * - 项目级路径：`{cwd}/.pi/extensions/footer.json`
 *
 * @param cwd 项目工作目录。
 * @returns   合并并校验后的 {@link FooterConfig}。
 */
export function loadConfig(cwd: string): FooterConfig {
  const globalPath = join(getAgentDir(), "extensions", CONFIG_FILE_NAME);
  const projectPath = join(cwd, CONFIG_DIR_NAME, "extensions", CONFIG_FILE_NAME);

  const merged = mergeConfig(readConfigFile(projectPath), readConfigFile(globalPath));

  return footerConfigSchema.parse(merged);
}

function readConfigFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// 数组语义为“整体覆盖”，对象按 key 浅合并，项目级优先。
function mergeConfig(primary: Record<string, unknown>, fallback: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...fallback };
  for (const [key, value] of Object.entries(primary)) {
    if (value === undefined) continue;
    result[key] = value;
  }
  return result;
}
