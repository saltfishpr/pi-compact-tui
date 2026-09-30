import type { ExtensionContext, ReadonlyFooterDataProvider, ThemeColor } from "@earendil-works/pi-coding-agent";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { addUsageToTotals, createUsageTotals, type UsageTotals } from "../pi-common";
import { getStatusKey, type Element, type LayoutConfig } from "./config";

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

/** Formats the same elements for every footer line and editor corner. */
export class LayoutElements {
  private sessionStats?: SessionStats;
  private positionedStatusKeys: Set<string>;

  constructor(
    private opts: {
      ctx: ExtensionContext;
      footerData: ReadonlyFooterDataProvider;
      config: LayoutConfig;
      getAutoCompactEnabled: () => boolean;
      getThinkingLevel: () => string;
    },
  ) {
    const { config } = opts;
    const elements = [
      ...config.footer.flatMap((line) => [...line.left, ...line.right]),
      ...config.editor.topRight,
      ...config.editor.bottomLeft,
      ...config.editor.bottomRight,
    ];
    this.positionedStatusKeys = new Set(
      elements.flatMap((element) => {
        const key = getStatusKey(element);
        return key === undefined ? [] : [key];
      }),
    );
  }

  get theme() {
    return this.opts.ctx.ui.theme;
  }

  // Usage is session-wide; selected models and context limits remain live reads.
  private getSessionStats(): SessionStats {
    const sessionManager = this.opts.ctx.sessionManager;
    // The read-only interface does not expose getEntryCount().
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

    const usageTotals = createUsageTotals();
    let latestCacheHitRate: number | undefined;
    for (const entry of entries) {
      if (entry.type === "usage") {
        addUsageToTotals(usageTotals, entry.usage);
      } else if (entry.type === "message" && entry.message.role === "assistant") {
        const usage = entry.message.usage;
        addUsageToTotals(usageTotals, usage);
        const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
        latestCacheHitRate = promptTokens > 0 ? (usage.cacheRead / promptTokens) * 100 : undefined;
      } else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
        addUsageToTotals(usageTotals, entry.message.usage);
      } else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
        addUsageToTotals(usageTotals, entry.usage);
      }
    }
    this.sessionStats = { sessionManager, sessionId, leafId, entryCount, usageTotals, latestCacheHitRate };
    return this.sessionStats;
  }

  private buildAll(extensionStatuses: ReadonlyMap<string, string>): Record<string, string> {
    const { usageTotals, latestCacheHitRate } = this.getSessionStats();
    const { ctx, footerData, getAutoCompactEnabled, getThinkingLevel } = this.opts;
    const theme = this.theme;
    const pwd = formatCwdForFooter(ctx.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);
    const branch = footerData.getGitBranch();
    const sessionName = ctx.sessionManager.getSessionName();

    const contextUsage = ctx.getContextUsage();
    const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
    const contextPercent = contextUsage?.percent;
    const autoIndicator = getAutoCompactEnabled() ? " (auto)" : "";
    const contextDisplay = `${contextPercent == null ? "?" : `${contextPercent.toFixed(1)}%`}/${formatTokens(contextWindow)}${autoIndicator}`;
    const contextColor = (contextPercent ?? 0) > 90 ? "error" : (contextPercent ?? 0) > 70 ? "warning" : "dim";

    const model = ctx.model;
    const usingSubscription = model
      ? model.provider === "kimi-coding" ||
        (ctx.modelRegistry.isUsingOAuth(model) &&
          ctx.modelRegistry.getProvider(model.provider)?.auth.oauth?.isSubscription === true)
      : false;
    const cost =
      usageTotals.cost || usingSubscription
        ? `$${usageTotals.cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`
        : "";
    const thinkingLevel = getThinkingLevel() || "off";
    const statusText = Array.from(extensionStatuses.entries())
      .filter(([key]) => !this.positionedStatusKeys.has(key))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, text]) => sanitizeStatusText(text))
      .filter(Boolean)
      .join(" ");

    return {
      pwd: theme.fg("dim", pwd),
      branch: branch ? theme.fg("dim", branch) : "",
      sessionName: sessionName ? theme.fg("dim", sessionName) : "",
      inputTokens: usageTotals.input ? theme.fg("dim", `↑${formatTokens(usageTotals.input)}`) : "",
      outputTokens: usageTotals.output ? theme.fg("dim", `↓${formatTokens(usageTotals.output)}`) : "",
      cacheReadTokens: usageTotals.cacheRead ? theme.fg("dim", `R${formatTokens(usageTotals.cacheRead)}`) : "",
      cacheWriteTokens: usageTotals.cacheWrite ? theme.fg("dim", `W${formatTokens(usageTotals.cacheWrite)}`) : "",
      cacheHitRate:
        (usageTotals.cacheRead > 0 || usageTotals.cacheWrite > 0) && latestCacheHitRate !== undefined
          ? theme.fg("dim", `CH${latestCacheHitRate.toFixed(1)}%`)
          : "",
      cost: cost ? theme.fg("dim", cost) : "",
      context: theme.fg(contextColor, contextDisplay),
      provider: model ? theme.fg("dim", model.provider) : "",
      model: theme.fg("dim", model?.id ?? "no-model"),
      thinkingLevel: model?.reasoning ? theme.fg("dim", thinkingLevel) : "",
      extensionStatuses: statusText,
    };
  }

  /** Resolve several groups from one live snapshot, preserving extension-provided ANSI styles. */
  renderGroups(...groups: Element[][]): string[] {
    if (groups.every((group) => group.length === 0)) return groups.map(() => "");
    const theme = this.theme;
    const statuses = this.opts.footerData.getExtensionStatuses();
    const built = this.buildAll(statuses);
    const resolveElement = (element: Element): string => {
      if (typeof element !== "string" && element.kind === "literal") {
        let color = element.color as ThemeColor;
        try {
          theme.getFgAnsi(color);
        } catch {
          color = "dim";
        }
        return theme.fg(color, element.value);
      }
      const value = typeof element === "string" ? element : element.value;
      const key = getStatusKey(element);
      const text = key === undefined ? built[value] : sanitizeStatusText(statuses.get(key) ?? "");
      if (!text || typeof element === "string") return text;
      return theme.fg("dim", element.prefix) + text + theme.fg("dim", element.suffix);
    };
    return groups.map((group) => group.map(resolveElement).filter(Boolean).join(this.opts.config.separator));
  }
}
