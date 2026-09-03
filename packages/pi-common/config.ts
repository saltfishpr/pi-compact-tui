import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as z from "zod";

export class ConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConfigError";
  }
}

export function getGlobalConfigPath(fileName: string): string {
  return join(getAgentDir(), "extensions", fileName);
}

export function loadJSONConfig<Config>(
  path: string,
  schema: z.ZodType<Config>,
  options?: {
    defaultConfig?: Config; // 为空时使用 schema.parse({})
  },
): Config {
  const defaultConfig = options?.defaultConfig ?? schema.parse({});
  ensureDefaultGlobalConfig(path, defaultConfig);

  try {
    return schema.parse(readConfigFile(path, defaultConfig));
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(`Invalid configuration in ${path}`, { cause: error });
  }
}

function ensureDefaultGlobalConfig<Config>(path: string, defaultConfig: Config): void {
  if (existsSync(path)) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(defaultConfig, null, 2)}\n`, { flag: "wx" });
  } catch {
    // Continue with the in-memory default when the global config cannot be created.
  }
}

function readConfigFile<Config>(path: string, defaultConfig: Config | undefined): Config | unknown {
  if (!existsSync(path)) return defaultConfig;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new ConfigError(`Unable to read configuration from ${path}`, { cause: error });
  }
}
