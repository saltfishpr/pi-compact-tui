import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import winston from "winston";
import DailyRotateFile from "winston-daily-rotate-file";

export interface Logger {
  debug(message: string, ...meta: unknown[]): void;
  info(message: string, ...meta: unknown[]): void;
  warn(message: string, ...meta: unknown[]): void;
  error(message: string, ...meta: unknown[]): void;
}

/** 创建 logger 时可覆盖的滚动/级别相关字段，其余走内部默认。 */
export interface CreateLoggerOptions {
  level?: string;
  datePattern?: string;
  maxSize?: string;
  maxFiles?: string;
  zippedArchive?: boolean;
}

const loggerCache = new Map<string, winston.Logger>();

// 同一进程内多次 createLogger(name) 复用同一底层 winston.Logger，避免重复挂载 transport。
function getOrCreateWinstonLogger(name: string, options: CreateLoggerOptions): winston.Logger {
  const cached = loggerCache.get(name);
  if (cached) return cached;

  const logsDir = join(getAgentDir(), "extensions", "logs");
  mkdirSync(logsDir, { recursive: true });

  const transport = new DailyRotateFile({
    filename: join(logsDir, `${name}-%DATE%.log`),
    datePattern: options.datePattern ?? "YYYY-MM-DD",
    zippedArchive: options.zippedArchive ?? true,
    maxSize: options.maxSize ?? "20m",
    maxFiles: options.maxFiles ?? "14d",
  });

  const logger = winston.createLogger({
    level: options.level ?? process.env.PI_LOG_LEVEL ?? "info",
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
      winston.format.splat(),
      winston.format.label({ label: name }),
      winston.format.json(),
    ),
    transports: [transport],
  });

  loggerCache.set(name, logger);
  return logger;
}

/**
 * 为指定插件创建一个滚动日志记录器。
 *
 * 日志写入 `~/.pi/agent/extensions/logs/<name>-%DATE%.log`，按天切分，
 * 单文件超过 `maxSize` 后再次切分，历史文件保留 `maxFiles`，并 gzip 压缩。
 *
 * 同名多次调用返回复用同一底层 winston.Logger 的窄接口，避免重复挂载 transport。
 */
export function createLogger(name: string, options: CreateLoggerOptions = {}): Logger {
  const inner = getOrCreateWinstonLogger(name, options);
  return {
    debug: (message, ...meta) => inner.debug(message, ...meta),
    info: (message, ...meta) => inner.info(message, ...meta),
    warn: (message, ...meta) => inner.warn(message, ...meta),
    error: (message, ...meta) => inner.error(message, ...meta),
  };
}
