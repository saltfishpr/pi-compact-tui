import ms, { type StringValue } from "ms";
import * as z from "zod";
import { getGlobalConfigPath, loadJSONConfig, modelSchema } from "../pi-common";

const CONFIG_FILE_NAME = "recap.json";

// 设置一个下限，避免误配置导致 idle 触发过于频繁。
const MIN_IDLE_MS = 5_000;

export const idleTimeoutSchema = z
  .union([z.number(), z.string()])
  .transform((value, ctx) => {
    if (typeof value === "number") return value;

    let parsed: number;
    try {
      parsed = ms(value as StringValue);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : String(error),
      });
      return z.NEVER;
    }

    if (Number.isNaN(parsed)) {
      ctx.addIssue({
        code: "custom",
        message: `Value is not a valid duration. value=${JSON.stringify(value)}`,
      });
      return z.NEVER;
    }

    return parsed;
  })
  .pipe(z.number().min(MIN_IDLE_MS));

export const recapConfigSchema = modelSchema.extend({
  idle: idleTimeoutSchema.optional(),
});

export type RecapConfig = z.infer<typeof recapConfigSchema>;

export function loadConfig(): RecapConfig {
  const globalPath = getGlobalConfigPath(CONFIG_FILE_NAME);
  return loadJSONConfig(globalPath, recapConfigSchema);
}
