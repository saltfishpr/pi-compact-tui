import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";

const PROVIDER = "openai-codex";
const STATUS_KEY = "codex-stats";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const REQUEST_TIMEOUT_MS = 30_000;

interface CodexRateWindow {
  limit_window_seconds: number;
  used_percent?: number | string;
}

interface CodexUsageResponse {
  rate_limit?: {
    primary_window?: CodexRateWindow | null;
    secondary_window?: CodexRateWindow | null;
  } | null;
  credits?: { unlimited?: boolean } | null;
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

  const values = windows.map((window) => {
    const percent = parsePercent(window.used_percent);
    const text = `${formatWindow(window.limit_window_seconds)} ${percent === undefined ? "?" : percent.toFixed(0)}%`;
    if (percent !== undefined && percent > 90) return theme.fg("error", text);
    if (percent !== undefined && percent > 70) return theme.fg("warning", text);
    return theme.fg("success", text);
  });

  return values.join(" ");
}

function buildHeaders(ctx: ExtensionContext, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
  const credential = ctx.modelRegistry.authStorage.get(PROVIDER);
  const accountId = credential?.type === "oauth" ? credential.accountId : undefined;
  if (typeof accountId === "string") headers["ChatGPT-Account-ID"] = accountId;
  return headers;
}

export default function (pi: ExtensionAPI): void {
  let inflight: AbortController | undefined;

  function clear(ctx: ExtensionContext): void {
    inflight?.abort();
    inflight = undefined;
    ctx.ui.setStatus(STATUS_KEY, undefined);
  }

  async function refresh(ctx: ExtensionContext): Promise<void> {
    if (!ctx.hasUI || ctx.model?.provider !== PROVIDER) {
      clear(ctx);
      return;
    }

    inflight?.abort();
    const controller = new AbortController();
    inflight = controller;

    try {
      const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER);
      if (controller.signal.aborted) return;
      if (!apiKey) {
        ctx.ui.setStatus(STATUS_KEY, undefined);
        return;
      }

      const response = await fetch(USAGE_URL, {
        headers: buildHeaders(ctx, apiKey),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const usage = (await response.json()) as CodexUsageResponse;
      if (controller.signal.aborted || ctx.model?.provider !== PROVIDER) return;
      ctx.ui.setStatus(STATUS_KEY, formatUsage(ctx.ui.theme, usage));
    } catch (error) {
      if (controller.signal.aborted || ctx.model?.provider !== PROVIDER) return;
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("error", `Codex ${message}`));
    } finally {
      if (inflight === controller) inflight = undefined;
    }
  }

  pi.on("session_start", (_event, ctx) => {
    void refresh(ctx);
  });

  pi.on("model_select", (_event, ctx) => {
    void refresh(ctx);
  });

  pi.on("agent_settled", (_event, ctx) => {
    void refresh(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    clear(ctx);
  });
}
