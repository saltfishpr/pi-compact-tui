import type { Theme } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as z from "zod";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Currency } from "./config";

const STATE_FILE_NAME = "provider-stats-state.json";

const balancesSchema = z.object({
  CNY: z.number().optional(),
  USD: z.number().optional(),
});

const providerBalanceStateSchema = z.object({
  date: z.string(),
  openingBalances: balancesSchema,
});

const balanceStateSchema = z.object({
  providers: z.record(z.string(), providerBalanceStateSchema),
});

export type BalanceState = z.infer<typeof balanceStateSchema>;

/**
 * 记录指定 provider/currency 的最新余额，并返回当日开盘余额。
 *
 * 语义：
 * - 每个 provider 独立按本地日期记录开盘余额。
 * - provider 在新一天首次获取某个 currency 的余额时，将该余额作为开盘余额。
 * - 返回值为该 provider/currency 当日的开盘余额，供调用方计算当日消耗（opening - balance）。
 */
export function updateBalanceState(provider: string, currency: Currency, balance: number): number {
  const date = localDate();
  const state = readState() ?? { providers: {} };
  const providerState = state.providers[provider];
  if (!providerState || providerState.date !== date) {
    state.providers[provider] = { date, openingBalances: { [currency]: balance } };
  } else {
    providerState.openingBalances[currency] ??= balance;
  }
  writeState(state);
  return state.providers[provider].openingBalances[currency] ?? balance;
}

export function formatBalanceStatus(
  theme: Theme,
  currency: Currency,
  openingBalance: number,
  sessionOpeningBalance: number,
  balance: number,
): string {
  const todayUsage = Math.max(0, openingBalance - balance);
  const sessionUsage = Math.max(0, sessionOpeningBalance - balance);
  return theme.fg(
    "success",
    [
      `📅 ${formatMoney(currency, todayUsage)}`,
      `💬 ${formatMoney(currency, sessionUsage)}`,
      `💰 ${formatMoney(currency, balance)}`,
    ].join(" "),
  );
}

function formatMoney(currency: Currency, amount: number): string {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

function getStatePath(): string {
  return join(getAgentDir(), "extensions", STATE_FILE_NAME);
}

function localDate(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function readState(): BalanceState | undefined {
  const path = getStatePath();
  if (!existsSync(path)) return undefined;
  try {
    return balanceStateSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return undefined;
  }
}

function writeState(state: BalanceState): void {
  const path = getStatePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}
