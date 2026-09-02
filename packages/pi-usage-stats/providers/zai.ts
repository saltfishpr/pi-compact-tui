import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ProviderStatsAdapter } from ".";
import { formatBalanceStatus, updateBalanceState } from "../balance-state";

const PROVIDER = "zai-coding-cn";
const BALANCE_URL = "https://open.bigmodel.cn/api/biz/account/query-customer-account-report";
const CURRENCY = "CNY";
const REQUEST_TIMEOUT_MS = 30_000;

interface AccountReport {
  code?: number;
  data?: {
    balance?: number;
    availableBalance?: number | null;
  };
  success?: boolean;
}

let sessionOpeningBalance: number | undefined;

function parseBalance(response: AccountReport): number {
  if (response.success === false || (response.code !== undefined && response.code !== 200)) {
    throw new Error(response.data ? "账户报告异常" : `code ${response.code ?? "unknown"}`);
  }
  const balance = response.data?.balance;
  if (typeof balance !== "number" || !Number.isFinite(balance)) throw new Error("未返回余额");
  return balance;
}

export const zaiAdapter: ProviderStatsAdapter = {
  label: "Z.ai",
  provider: PROVIDER,
  statusKey: "zai-stats",
  kind: "balance",
  async fetch(ctx: ExtensionContext, signal: AbortSignal): Promise<string | undefined> {
    const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER);
    if (signal.aborted || !apiKey) return undefined;

    const response = await fetch(BALANCE_URL, {
      headers: {
        Accept: "application/json",
        Authorization: apiKey,
      },
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const balance = parseBalance((await response.json()) as AccountReport);
    if (signal.aborted) return undefined;

    sessionOpeningBalance ??= balance;
    const openingBalance = updateBalanceState(PROVIDER, CURRENCY, balance);
    return formatBalanceStatus(ctx.ui.theme, CURRENCY, openingBalance, sessionOpeningBalance, balance);
  },
  resetSession(): void {
    sessionOpeningBalance = undefined;
  },
};
