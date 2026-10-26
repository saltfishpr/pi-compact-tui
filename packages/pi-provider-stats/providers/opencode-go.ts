import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as z from "zod";
import type { ProviderStatsAdapter } from ".";
import { formatSubscriptionStatus, type SubscriptionUsage } from "../subscription";

const PROVIDER = "opencode-go";
const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const REQUEST_TIMEOUT_MS = 30_000;

const usageWindowSchema = z.object({
  percent: z.number(),
  resetsAt: z.string().optional(),
});

const usageResponseSchema = z.object({
  usage: z.object({
    rolling: usageWindowSchema,
    weekly: usageWindowSchema,
    monthly: usageWindowSchema,
  }),
});

function normalizeUsage(response: unknown, showMonthly: boolean): SubscriptionUsage {
  const parsed = usageResponseSchema.safeParse(response);
  if (!parsed.success) throw new Error("未返回有效额度");

  const { rolling, weekly, monthly } = parsed.data.usage;
  const windows = [
    { usage: rolling, label: "5h" },
    { usage: weekly, label: "7d" },
  ];
  if (showMonthly) windows.push({ usage: monthly, label: "1mo" });
  return {
    windows: windows.map(({ usage, label }) => {
      const resetAtMs = usage.resetsAt === undefined ? Number.NaN : Date.parse(usage.resetsAt);
      return {
        label,
        usedPercent: Math.min(100, Math.max(0, usage.percent)),
        resetAtMs: Number.isFinite(resetAtMs) ? resetAtMs : undefined,
      };
    }),
  };
}

export const opencodeGoAdapter: ProviderStatsAdapter = {
  label: "OpenCode Go",
  provider: PROVIDER,
  statusKey: "opencode-go-stats",
  kind: "subscription",
  async fetch(ctx: ExtensionContext, signal: AbortSignal, config): Promise<string | undefined> {
    const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER);
    if (signal.aborted || !apiKey) return undefined;

    const response = await fetch(USAGE_URL, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const usage = normalizeUsage(await response.json(), config?.showMonthly ?? false);
    if (signal.aborted) return undefined;

    return formatSubscriptionStatus(ctx.ui.theme, usage, {
      showResetTime: config?.showResetTime ?? true,
      now: Date.now(),
    });
  },
};
