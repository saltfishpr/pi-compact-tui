import { getAgentDir } from "@earendil-works/pi-coding-agent";
import ms, { type StringValue } from "ms";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as z from "zod";
import { modelSchema } from "../pi-common";

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

/**
 * 从全局路径 `{getAgentDir()}/extensions/pi-recap.json` 加载 pi-recap 配置。
 *
 * 缺失或解析失败的文件会被视为空对象；若结果不符合 schema 会抛出异常。
 *
 * @returns 校验后的 {@link RecapConfig}。
 */
export function loadConfig(): RecapConfig {
  const globalPath = join(getAgentDir(), "extensions", CONFIG_FILE_NAME);
  return recapConfigSchema.parse(readConfigFile(globalPath));
}

function readConfigFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}
