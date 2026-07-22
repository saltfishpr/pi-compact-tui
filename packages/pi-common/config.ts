import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import * as z from "zod";

// 与 `@earendil-works/pi-ai` 的 `ModelThinkingLevel` 保持一致；
// 通过 `satisfies` 让漏项/多项在编译期就被暴露。
export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ModelThinkingLevel[];

export const modelSchema = z.object({
  model: z
    .string()
    .regex(/^[^/]+\/.+$/, `expected "provider/model-id"`)
    .optional(),
  thinkingLevel: z.enum(THINKING_LEVELS).optional(),
});

export type ModelConfig = z.infer<typeof modelSchema>;
