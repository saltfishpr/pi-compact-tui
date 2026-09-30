import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
  Theme,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { addUsageToTotals, createUsageTotals, type UsageTotals } from "../pi-common";
import { type FooterConfig, type FooterElement, getStatusKey, loadConfig } from "./config";

/**
 * Sanitize text for display in a single-line status.
 * Removes newlines, tabs, carriage returns, and other control characters.
 */
function sanitizeStatusText(text: string): string {
  // Replace newlines, tabs, carriage returns with space, then collapse multiple spaces
  return text
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

/**
 * Format token counts for compact footer display.
 */
export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

export function formatCwdForFooter(cwd: string, home: string | undefined): string {
  if (!home) return cwd;

  const resolvedCwd = resolve(cwd);
  const resolvedHome = resolve(home);
  const relativeToHome = relative(resolvedHome, resolvedCwd);
  const isInsideHome =
    relativeToHome === "" ||
    (relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));

  if (!isInsideHome) return cwd;
  return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

interface SessionStats {
  sessionManager: ExtensionContext["sessionManager"];
  sessionId: string;
  leafId: string | null;
  entryCount: number;
  usageTotals: UsageTotals;
  latestCacheHitRate: number | undefined;
}

export class ConfigurableFooter implements Component {
  private ctx: ExtensionContext;
  private theme: Theme;
  private footerData: ReadonlyFooterDataProvider;
  private config: FooterConfig;
  private sessionStats?: SessionStats;
  private getAutoCompactEnabled: () => boolean;
  private getThinkingLevel: () => string;
  private positionedStatusKeys: Set<string>;

  constructor(opts: {
    ctx: ExtensionContext;
    theme: Theme;
    footerData: ReadonlyFooterDataProvider;
    config: FooterConfig;
    getAutoCompactEnabled: () => boolean;
    getThinkingLevel: () => string;
  }) {
    this.ctx = opts.ctx;
    this.theme = opts.theme;
    this.footerData = opts.footerData;
    this.config = opts.config;
    this.getAutoCompactEnabled = opts.getAutoCompactEnabled;
    this.getThinkingLevel = opts.getThinkingLevel;
    this.positionedStatusKeys = new Set(
      this.config.lines
        .flatMap((line) => [...(line.left ?? []), ...(line.right ?? [])])
        .flatMap((element) => {
          if (typeof element !== "string") return [];
          const key = getStatusKey(element);
          return key === undefined ? [] : [key];
        }),
    );
  }

  invalidate(): void {}

  dispose(): void {
    // Git watcher cleanup handled by provider
  }

  // Usage is independent of the selected model; context limits are read separately on every render.
  private getSessionStats(): SessionStats {
    const sessionManager = this.ctx.sessionManager;
    // ReadonlySessionManager does not expose getEntryCount(), so keep this snapshot for the scan.
    const entries = sessionManager.getEntries();
    const entryCount = entries.length;
    const sessionId = sessionManager.getSessionId();
    const leafId = sessionManager.getLeafId();
    const cached = this.sessionStats;
    if (
      cached &&
      cached.sessionManager === sessionManager &&
      cached.sessionId === sessionId &&
      cached.leafId === leafId &&
      cached.entryCount === entryCount
    ) {
      return cached;
    }

    // Calculate cumulative usage from ALL session entries (not just post-compaction messages)
    const usageTotals = createUsageTotals();
    let latestCacheHitRate: number | undefined;

    for (const entry of entries) {
      if (entry.type === "usage") {
        addUsageToTotals(usageTotals, entry.usage);
      } else if (entry.type === "message" && entry.message.role === "assistant") {
        addUsageToTotals(usageTotals, entry.message.usage);

        const latestPromptTokens =
          entry.message.usage.input + entry.message.usage.cacheRead + entry.message.usage.cacheWrite;
        latestCacheHitRate =
          latestPromptTokens > 0 ? (entry.message.usage.cacheRead / latestPromptTokens) * 100 : undefined;
      } else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
        addUsageToTotals(usageTotals, entry.message.usage);
      } else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
        addUsageToTotals(usageTotals, entry.usage);
      }
    }

    this.sessionStats = {
      sessionManager,
      sessionId,
      leafId,
      entryCount,
      usageTotals,
      latestCacheHitRate,
    };
    return this.sessionStats;
  }

  private buildAll(extensionStatuses: ReadonlyMap<string, string>): Record<string, string> {
    const { usageTotals, latestCacheHitRate } = this.getSessionStats();
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
    const autoIndicator = this.getAutoCompactEnabled() ? " (auto)" : "";
    const contextDisplay =
      contextPercentText === "?"
        ? `?/${formatTokens(contextWindow)}${autoIndicator}`
        : `${contextPercentText}%/${formatTokens(contextWindow)}${autoIndicator}`;
    let contextStr: string;
    if (contextPercentValue > 90) contextStr = theme.fg("error", contextDisplay);
    else if (contextPercentValue > 70) contextStr = theme.fg("warning", contextDisplay);
    else contextStr = theme.fg("dim", contextDisplay);

    const usingSubscription = state.model
      ? state.model.provider === "kimi-coding" ||
        (state.modelRegistry.isUsingOAuth(state.model) &&
          state.modelRegistry.getProvider(state.model.provider)?.auth.oauth?.isSubscription === true)
      : false;
    const costStr =
      usageTotals.cost || usingSubscription
        ? `$${usageTotals.cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`
        : "";

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
      pwd: theme.fg("dim", pwd),
      branch: branch ? theme.fg("dim", `(${branch})`) : "",
      sessionName: sessionName ? theme.fg("dim", `• ${sessionName}`) : "",
      inputTokens: usageTotals.input ? theme.fg("dim", `↑${formatTokens(usageTotals.input)}`) : "",
      outputTokens: usageTotals.output ? theme.fg("dim", `↓${formatTokens(usageTotals.output)}`) : "",
      cacheReadTokens: usageTotals.cacheRead ? theme.fg("dim", `R${formatTokens(usageTotals.cacheRead)}`) : "",
      cacheWriteTokens: usageTotals.cacheWrite ? theme.fg("dim", `W${formatTokens(usageTotals.cacheWrite)}`) : "",
      cacheHitRate:
        (usageTotals.cacheRead > 0 || usageTotals.cacheWrite > 0) && latestCacheHitRate !== undefined
          ? theme.fg("dim", `CH${latestCacheHitRate.toFixed(1)}%`)
          : "",
      cost: costStr ? theme.fg("dim", costStr) : "",
      context: contextStr,
      provider: providerStr ? theme.fg("dim", providerStr) : "",
      model: modelStr ? theme.fg("dim", modelStr) : "",
      thinkingLevel: thinkingLevelText ? theme.fg("dim", thinkingLevelText) : "",
      extensionStatuses: statusText,
    };
  }

  render(width: number): string[] {
    const extensionStatuses = this.footerData.getExtensionStatuses();
    const built = this.buildAll(extensionStatuses);
    const separator = this.config.separator;
    const lineConfigs = this.config.lines;

    const resolveElement = (element: FooterElement): string => {
      if (typeof element !== "string") {
        const color = element.color as ThemeColor;
        try {
          this.theme.getFgAnsi(color);
          return this.theme.fg(color, element.value);
        } catch {
          return this.theme.fg("dim", element.value);
        }
      }
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
      return truncateToWidth(left, width, this.theme.fg("dim", "..."));
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
    return truncateToWidth(left, width, this.theme.fg("dim", "..."));
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;

    const config = loadConfig();
    ctx.ui.setFooter((_tui: TUI, theme: Theme, footerData: ReadonlyFooterDataProvider) => {
      return new ConfigurableFooter({
        ctx,
        theme,
        footerData,
        config,
        getAutoCompactEnabled: () => pi.getSettings().compaction?.enabled ?? true,
        getThinkingLevel: () => pi.getThinkingLevel(),
      });
    });
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (!ctx.hasUI) return;

    ctx.ui.setFooter(undefined);
  });
}
