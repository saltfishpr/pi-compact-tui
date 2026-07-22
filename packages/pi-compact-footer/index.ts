import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { type FooterConfig, getStatusKey, loadConfig } from "./config";

function sanitizeStatusText(text: string): string {
  return text
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function formatCwdForFooter(cwd: string, home: string | undefined): string {
  if (!home) return cwd;
  const resolvedCwd = resolve(cwd);
  const resolvedHome = resolve(home);
  const relativeToHome = relative(resolvedHome, resolvedCwd);
  const isInsideHome =
    relativeToHome === "" ||
    (relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
  if (!isInsideHome) return cwd;
  if (relativeToHome === "") return "~";

  const segments = relativeToHome.split(sep);
  const directorySegments = segments
    .slice(0, -1)
    .map((segment) => (segment.startsWith(".") ? segment.slice(0, 2) : segment.slice(0, 1)));
  return ["~", ...directorySegments, segments.at(-1)].join(sep);
}

interface TokenStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  latestCacheHitRate: number | undefined;
}

function collectTokenStats(ctx: ExtensionContext): TokenStats {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;
  let latestCacheHitRate: number | undefined;
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "message") continue;
    if (entry.message.role !== "assistant") continue;
    const usage = entry.message.usage;
    input += usage.input;
    output += usage.output;
    cacheRead += usage.cacheRead;
    cacheWrite += usage.cacheWrite;
    cost += usage.cost.total;
    const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
    latestCacheHitRate = promptTokens > 0 ? (usage.cacheRead / promptTokens) * 100 : undefined;
  }
  return { input, output, cacheRead, cacheWrite, cost, latestCacheHitRate };
}

function dim(theme: Theme, text: string): string {
  return theme.fg("dim", text);
}

class ConfigurableFooter implements Component {
  private ctx: ExtensionContext;
  private footerData: ReadonlyFooterDataProvider;
  private theme: Theme;
  private config: FooterConfig;
  private autoCompactEnabled = true;
  private getThinkingLevel: () => string;
  private positionedStatusKeys: Set<string>;

  constructor(opts: {
    ctx: ExtensionContext;
    footerData: ReadonlyFooterDataProvider;
    theme: Theme;
    config: FooterConfig;
    getThinkingLevel: () => string;
  }) {
    this.ctx = opts.ctx;
    this.footerData = opts.footerData;
    this.theme = opts.theme;
    this.config = opts.config;
    this.getThinkingLevel = opts.getThinkingLevel;
    this.positionedStatusKeys = new Set(
      this.config.lines
        .flatMap((line) => [...(line.left ?? []), ...(line.right ?? [])])
        .flatMap((element) => {
          const key = getStatusKey(element);
          return key === undefined ? [] : [key];
        }),
    );
  }

  setAutoCompactEnabled(enabled: boolean): void {
    this.autoCompactEnabled = enabled;
  }

  invalidate(): void {}

  private buildAll(extensionStatuses: ReadonlyMap<string, string>): Record<string, string> {
    const stats = collectTokenStats(this.ctx);
    const state = this.ctx;
    const theme = this.theme;

    const cwd = state.sessionManager.getCwd();
    const pwd = formatCwdForFooter(cwd, process.env.HOME || process.env.USERPROFILE);

    const branch = this.footerData.getGitBranch();
    const sessionName = state.sessionManager.getSessionName();

    const contextUsage = state.getContextUsage();
    const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
    const contextPercentValue = contextUsage?.percent ?? 0;
    const contextPercentText = contextUsage?.percent != null ? contextPercentValue.toFixed(1) : "?";
    const autoIndicator = this.autoCompactEnabled ? " (auto)" : "";
    const contextDisplay =
      contextPercentText === "?"
        ? `?/${formatTokens(contextWindow)}${autoIndicator}`
        : `${contextPercentText}%/${formatTokens(contextWindow)}${autoIndicator}`;
    let contextStr: string;
    if (contextPercentValue > 90) contextStr = theme.fg("error", contextDisplay);
    else if (contextPercentValue > 70) contextStr = theme.fg("warning", contextDisplay);
    else contextStr = dim(theme, contextDisplay);

    const usingSubscription = state.model ? state.modelRegistry.isUsingOAuth(state.model) : false;
    const costStr =
      stats.cost || usingSubscription ? `$${stats.cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}` : "";

    const providerCount = this.footerData.getAvailableProviderCount();
    const providerStr = state.model && providerCount > 1 ? `(${state.model.provider})` : "";
    const modelStr = state.model?.id ?? "no-model";
    let thinkingLevelText = "";
    if (state.model?.reasoning) {
      const level = this.getThinkingLevel() || "off";
      thinkingLevelText = level === "off" ? "• thinking off" : `• ${level}`;
    }

    let statusText = "";
    if (extensionStatuses.size > 0) {
      statusText = Array.from(extensionStatuses.entries())
        .filter(([key]) => !this.positionedStatusKeys.has(key))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, text]) => sanitizeStatusText(text))
        .join(" ");
    }

    return {
      pwd: dim(theme, pwd),
      branch: branch ? dim(theme, `(${branch})`) : "",
      sessionName: sessionName ? dim(theme, `• ${sessionName}`) : "",
      inputTokens: stats.input ? dim(theme, `↑${formatTokens(stats.input)}`) : "",
      outputTokens: stats.output ? dim(theme, `↓${formatTokens(stats.output)}`) : "",
      cacheReadTokens: stats.cacheRead ? dim(theme, `R${formatTokens(stats.cacheRead)}`) : "",
      cacheWriteTokens: stats.cacheWrite ? dim(theme, `W${formatTokens(stats.cacheWrite)}`) : "",
      cacheHitRate:
        (stats.cacheRead > 0 || stats.cacheWrite > 0) && stats.latestCacheHitRate !== undefined
          ? dim(theme, `CH${stats.latestCacheHitRate.toFixed(1)}%`)
          : "",
      cost: costStr ? dim(theme, costStr) : "",
      context: contextStr,
      provider: providerStr ? dim(theme, providerStr) : "",
      model: modelStr ? dim(theme, modelStr) : "",
      thinkingLevel: thinkingLevelText ? dim(theme, thinkingLevelText) : "",
      extensionStatuses: statusText,
    };
  }

  render(width: number): string[] {
    const extensionStatuses = this.footerData.getExtensionStatuses();
    const built = this.buildAll(extensionStatuses);
    const separator = this.config.separator;
    const lineConfigs = this.config.lines;

    const resolveElement = (element: string): string => {
      const statusKey = getStatusKey(element);
      if (statusKey !== undefined) return sanitizeStatusText(extensionStatuses.get(statusKey) ?? "");
      return built[element] ?? "";
    };

    const lines: string[] = [];
    for (const line of lineConfigs) {
      const leftParts = (line.left ?? []).map(resolveElement).filter((text) => text.length > 0);
      const rightParts = (line.right ?? []).map(resolveElement).filter((text) => text.length > 0);
      const left = leftParts.join(separator);
      const right = rightParts.join(separator);
      if (!left && !right) continue;
      lines.push(this.composeLine(left, right, width));
    }
    return lines;
  }

  private composeLine(left: string, right: string, width: number): string {
    const leftWidth = visibleWidth(left);
    const rightWidth = visibleWidth(right);
    if (!right) {
      return truncateToWidth(left, width, dim(this.theme, "..."));
    }
    if (!left) {
      if (rightWidth >= width) return truncateToWidth(right, width, "");
      return " ".repeat(width - rightWidth) + right;
    }
    const minPadding = 2;
    if (leftWidth + minPadding + rightWidth <= width) {
      return left + " ".repeat(width - leftWidth - rightWidth) + right;
    }
    const availableForRight = width - leftWidth - minPadding;
    if (availableForRight > 0) {
      const truncatedRight = truncateToWidth(right, availableForRight, "");
      const truncatedRightWidth = visibleWidth(truncatedRight);
      return left + " ".repeat(Math.max(0, width - leftWidth - truncatedRightWidth)) + truncatedRight;
    }
    return truncateToWidth(left, width, dim(this.theme, "..."));
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    const config = loadConfig();
    ctx.ui.setFooter((_tui: TUI, theme: Theme, footerData: ReadonlyFooterDataProvider) => {
      return new ConfigurableFooter({
        ctx,
        footerData,
        theme,
        config,
        getThinkingLevel: () => pi.getThinkingLevel(),
      });
    });
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setFooter(undefined);
  });
}
