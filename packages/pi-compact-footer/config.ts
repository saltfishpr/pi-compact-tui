import * as z from "zod";
import { getGlobalConfigPath, loadJSONConfig } from "../pi-common";

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

export const literalElementSchema = z
  .object({
    kind: z.literal("literal"),
    value: z
      .string()
      .min(1)
      .refine((value) => !/[\r\n\t]/.test(value), "Literal value must be single-line text"),
    color: z.string(),
  })
  .strict();

export const footerElementSchema = z.union([z.string(), literalElementSchema]);

export type FooterElement = z.infer<typeof footerElementSchema>;

export const lineConfigSchema = z.object({
  left: z.array(footerElementSchema).optional(),
  right: z.array(footerElementSchema).optional(),
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
      right: ["status:codex-stats", "status:deepseek-stats", "status:zai-stats", "cacheHitRate", "cost", "context"],
    },
    { left: ["extensionStatuses"] },
  ],
};

export function loadConfig(): FooterConfig {
  const globalPath = getGlobalConfigPath(CONFIG_FILE_NAME);
  return loadJSONConfig(globalPath, footerConfigSchema, { defaultConfig: DEFAULT_CONFIG });
}
