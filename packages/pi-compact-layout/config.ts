import * as z from "zod";
import { getGlobalConfigPath, loadJSONConfig } from "../pi-common";

const singleLineTextSchema = z.string().refine((value) => !/[\r\n\t]/.test(value), "Text must be single-line");

const elementSchema = z.union([
  z.string(),
  z
    .object({
      kind: z.literal("literal"),
      value: singleLineTextSchema.min(1),
      color: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("element"),
      value: z.string().min(1),
      prefix: singleLineTextSchema.default(""),
      suffix: singleLineTextSchema.default(""),
    })
    .strict(),
]);

export type Element = z.infer<typeof elementSchema>;

const footerLineSchema = z
  .object({
    left: z.array(elementSchema).default([]),
    right: z.array(elementSchema).default([]),
  })
  .strict();

export type FooterLineConfig = z.infer<typeof footerLineSchema>;

const editorSchema = z
  .object({
    topRight: z.array(elementSchema).default([]),
    bottomLeft: z.array(elementSchema).default([]),
    bottomRight: z.array(elementSchema).default([]),
  })
  .strict();

export type EditorConfig = z.infer<typeof editorSchema>;

export const layoutConfigSchema = z
  .object({
    separator: z.string().default(" "),
    footer: z.array(footerLineSchema).default([
      {
        left: ["pwd", { kind: "element", value: "branch", prefix: "(", suffix: ")" }, "sessionName"],
        right: ["status:codex-stats", "status:deepseek-stats", "status:zai-stats", "cacheHitRate", "cost", "context"],
      },
      { left: ["extensionStatuses"], right: [] },
    ]),
    editor: editorSchema.default({
      topRight: [
        { kind: "element", value: "provider", prefix: "(", suffix: ")" },
        "model",
        { kind: "element", value: "thinkingLevel", prefix: "• ", suffix: "" },
      ],
      bottomLeft: [],
      bottomRight: [],
    }),
  })
  .strict();

export type LayoutConfig = z.infer<typeof layoutConfigSchema>;

export function getStatusKey(element: Element): string | undefined {
  if (typeof element !== "string" && element.kind === "literal") return undefined;
  const elementKey = typeof element === "string" ? element : element.value;
  return elementKey.startsWith("status:") ? elementKey.slice("status:".length) || undefined : undefined;
}

export function loadConfig(): LayoutConfig {
  return loadJSONConfig(getGlobalConfigPath("compact-layout.json"), layoutConfigSchema);
}
