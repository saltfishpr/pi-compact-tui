import { readStoredCredential, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import type { ProviderStatsAdapter } from ".";

const PROVIDER = "openai-codex";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const REQUEST_TIMEOUT_MS = 30_000;

interface CodexRateWindow {
  limit_window_seconds: number;
  used_percent?: number | string;
}

interface CodexUsageResponse {
  rate_limit?: {
    primary_window?: CodexRateWindow;
    secondary_window?: CodexRateWindow;
  };
  credits?: { unlimited?: boolean };
}

function formatWindow(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
  return `${Math.round(seconds / 60)}m`;
}

function parsePercent(value: number | string | undefined): number | undefined {
  const percent = typeof value === "number" ? value : typeof value === "string" ? Number(value) : undefined;
  if (percent === undefined || !Number.isFinite(percent)) return undefined;
  return Math.min(100, Math.max(0, percent));
}

function formatUsage(theme: Theme, usage: CodexUsageResponse): string {
  const windows = [usage.rate_limit?.primary_window, usage.rate_limit?.secondary_window].filter(
    (window): window is CodexRateWindow => window != null,
  );

  if (usage.credits?.unlimited === true || windows.every((window) => parsePercent(window.used_percent) === undefined)) {
    return theme.fg("success", "unlimited");
  }

  return windows
    .map((window) => {
      const usedPercent = parsePercent(window.used_percent);
      const remainingPercent = usedPercent === undefined ? "?" : (100 - usedPercent).toFixed(0);
      const text = `${formatWindow(window.limit_window_seconds)} ${remainingPercent}% left`;
      if (usedPercent !== undefined && usedPercent > 90) return theme.fg("error", text);
      if (usedPercent !== undefined && usedPercent > 70) return theme.fg("warning", text);
      return theme.fg("success", text);
    })
    .join(theme.fg("dim", " • "));
}

function buildHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
  const credential = readStoredCredential(PROVIDER);
  const accountId = credential?.type === "oauth" ? credential.accountId : undefined;
  if (typeof accountId === "string") headers["ChatGPT-Account-ID"] = accountId;
  return headers;
}

export const codexAdapter: ProviderStatsAdapter = {
  label: "Codex",
  provider: PROVIDER,
  statusKey: "codex-stats",
  kind: "subscription",
  async fetch(ctx: ExtensionContext, signal: AbortSignal): Promise<string | undefined> {
    const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER);
    if (signal.aborted || !apiKey) return undefined;

    const response = await fetch(USAGE_URL, {
      headers: buildHeaders(apiKey),
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const usage = (await response.json()) as CodexUsageResponse;
    return signal.aborted ? undefined : formatUsage(ctx.ui.theme, usage);
  },
};
