import { readStoredCredential, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ProviderStatsAdapter } from ".";
import { formatSubscriptionStatus, type SubscriptionUsage } from "../subscription";

const PROVIDER = "openai-codex";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const REQUEST_TIMEOUT_MS = 30_000;

interface CodexRateWindow {
  limit_window_seconds: number;
  used_percent?: number | string;
  reset_at?: number | string;
  reset_after_seconds?: number | string;
}

interface CodexUsageResponse {
  rate_limit?: {
    primary_window?: CodexRateWindow;
    secondary_window?: CodexRateWindow;
  };
  credits?: { unlimited?: boolean };
}

function parseNumber(value: number | string | undefined): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : undefined;
  return number !== undefined && Number.isFinite(number) ? number : undefined;
}

function parsePercent(value: number | string | undefined): number | undefined {
  const percent = parseNumber(value);
  return percent === undefined ? undefined : Math.min(100, Math.max(0, percent));
}

function parseResetAt(window: CodexRateWindow, fetchedAt: number): number | undefined {
  const resetAt = parseNumber(window.reset_at);
  if (resetAt !== undefined && resetAt > 0) return resetAt * 1_000;

  const resetAfterSeconds = parseNumber(window.reset_after_seconds);
  if (resetAfterSeconds !== undefined && resetAfterSeconds >= 0) return fetchedAt + resetAfterSeconds * 1_000;
  return undefined;
}

function normalizeUsage(usage: CodexUsageResponse, fetchedAt: number): SubscriptionUsage {
  const windows = [usage.rate_limit?.primary_window, usage.rate_limit?.secondary_window]
    .filter((window): window is CodexRateWindow => window != null)
    .map((window) => ({
      windowSeconds: window.limit_window_seconds,
      usedPercent: parsePercent(window.used_percent),
      resetAtMs: parseResetAt(window, fetchedAt),
    }));

  return { unlimited: usage.credits?.unlimited, windows };
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
  async fetch(ctx: ExtensionContext, signal: AbortSignal, config): Promise<string | undefined> {
    const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER);
    if (signal.aborted || !apiKey) return undefined;

    const response = await fetch(USAGE_URL, {
      headers: buildHeaders(apiKey),
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const usage = (await response.json()) as CodexUsageResponse;
    if (signal.aborted) return undefined;

    const fetchedAt = Date.now();
    return formatSubscriptionStatus(ctx.ui.theme, normalizeUsage(usage, fetchedAt), {
      showResetTime: config?.showResetTime ?? true,
      now: fetchedAt,
    });
  },
};
