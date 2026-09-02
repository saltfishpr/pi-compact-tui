import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ProviderStatsAdapter } from ".";
import { formatBalanceStatus, updateBalanceState } from "../balance-state";
import type { Currency, ProviderConfig } from "../config";

const PROVIDER = "deepseek";
const BALANCE_URL = "https://api.deepseek.com/user/balance";
const REQUEST_TIMEOUT_MS = 30_000;

interface BalanceInfo {
  currency: string;
  total_balance: string;
}

interface BalanceResponse {
  is_available?: boolean;
  balance_infos?: BalanceInfo[];
}

let sessionOpeningBalance: number | undefined;

function parseBalance(response: BalanceResponse, currency: Currency): number {
  if (response.is_available === false) throw new Error("余额不可用");
  const value = response.balance_infos?.find((info) => info.currency === currency)?.total_balance;
  const balance = value === undefined ? Number.NaN : Number(value);
  if (!Number.isFinite(balance)) throw new Error(`未返回 ${currency} 余额`);
  return balance;
}

export const deepseekAdapter: ProviderStatsAdapter = {
  label: "DeepSeek",
  provider: PROVIDER,
  statusKey: "deepseek-stats",
  kind: "balance",
  async fetch(ctx: ExtensionContext, signal: AbortSignal, config?: ProviderConfig): Promise<string | undefined> {
    const currency = config?.currency ?? "CNY";
    const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER);
    if (signal.aborted || !apiKey) return undefined;

    const response = await fetch(BALANCE_URL, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const balance = parseBalance((await response.json()) as BalanceResponse, currency);
    if (signal.aborted) return undefined;

    sessionOpeningBalance ??= balance;
    const openingBalance = updateBalanceState(PROVIDER, currency, balance);
    return formatBalanceStatus(ctx.ui.theme, currency, openingBalance, sessionOpeningBalance, balance);
  },
  resetSession(): void {
    sessionOpeningBalance = undefined;
  },
};
