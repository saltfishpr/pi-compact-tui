import {
  CONFIG_DIR_NAME,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

type Settings = {
  compaction?: {
    enabled?: boolean;
  };
};

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    ctx.ui.setFooter((tui, theme, footerData) => ({
      dispose: footerData.onBranchChange(() => tui.requestRender()),
      invalidate() {},
      render(width: number): string[] {
        const pwd = formatCwd(ctx.sessionManager.getCwd());
        const branch = footerData.getGitBranch();
        const sessionName = ctx.sessionManager.getSessionName();

        const left = sanitize(`${pwd}${branch ? ` (${branch})` : ""}${sessionName ? ` • ${sessionName}` : ""}`);
        const right = sanitize(`${formatCost(ctx)} ${formatContext(ctx)}`);

        return [theme.fg("dim", alignFooter(left, right, width))];
      },
    }));
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    ctx.ui.setFooter(undefined);
  });
}

function formatCwd(cwd: string): string {
  const home = process.env.HOME || process.env.USERPROFILE;
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

function formatCost(ctx: ExtensionContext): string {
  let totalCost = 0;

  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const cost = entry.message.usage?.cost?.total;
    if (typeof cost === "number") totalCost += cost;
  }

  const usingSubscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
  return `$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`;
}

function formatContext(ctx: ExtensionContext): string {
  const usage = ctx.getContextUsage();
  const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow;
  const percent = usage?.percent === null || usage?.percent === undefined ? "?" : `${Math.round(usage.percent)}%`;
  const auto = isAutoCompactionEnabled(ctx) ? " (auto)" : "";

  return `${percent}/${contextWindow ? formatTokens(contextWindow) : "?"}${auto}`;
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function isAutoCompactionEnabled(ctx: ExtensionContext): boolean {
  let enabled = readCompactionEnabled(join(getAgentDir(), "settings.json")) ?? true;

  if (ctx.isProjectTrusted()) {
    enabled = readCompactionEnabled(join(ctx.cwd, CONFIG_DIR_NAME, "settings.json")) ?? enabled;
  }

  return enabled;
}

function readCompactionEnabled(path: string): boolean | undefined {
  if (!existsSync(path)) return undefined;

  try {
    const settings = JSON.parse(readFileSync(path, "utf8")) as Settings;
    return settings.compaction?.enabled;
  } catch {
    return undefined;
  }
}

function alignFooter(left: string, right: string, width: number): string {
  if (width <= 0) return "";
  if (!right) return truncateToWidth(left, width, "…");

  const minimumGap = 2;
  const rightWidth = visibleWidth(right);
  if (rightWidth + minimumGap >= width) return truncateToWidth(right, width, "");

  const maxLeftWidth = width - rightWidth - minimumGap;
  const fittedLeft = truncateToWidth(left, maxLeftWidth, "…");
  const padding = " ".repeat(Math.max(minimumGap, width - visibleWidth(fittedLeft) - rightWidth));

  return truncateToWidth(`${fittedLeft}${padding}${right}`, width, "");
}

function sanitize(text: string): string {
  return text
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}
