import type { Theme } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Currency } from "./config";
import { migrateLegacyBalanceState } from "./migrate";

const STATE_FILE_NAME = "provider-stats-state.json";

type Balances = Partial<Record<Currency, number>>;

export interface ProviderBalanceState {
  openingBalances: Balances;
  latestBalances: Balances;
}

export interface BalanceState {
  date: string;
  providers: Record<string, ProviderBalanceState>;
}

/**
 * 记录指定 provider/currency 的最新余额，并返回当日开盘余额。
 *
 * 语义：
 * - 状态按本地日期分片；跨到新的一天时，用上一日的最新余额作为新一日的开盘余额。
 * - 每个 provider 首次在当日写入某个 currency 时，将当前 balance 作为开盘余额；后续调用只刷新 latestBalance。
 * - 返回值为该 provider/currency 当日的开盘余额，供调用方计算当日消耗（opening - balance）。
 */
export function updateBalanceState(provider: string, currency: Currency, balance: number): number {
  const date = localDate();
  const previous = readState();
  const state = previous?.date === date ? previous : startDay(previous, date);
  const providerState = (state.providers[provider] ??= { openingBalances: {}, latestBalances: {} });
  providerState.openingBalances[currency] ??= providerState.latestBalances[currency] ?? balance;
  providerState.latestBalances[currency] = balance;
  writeState(state);
  return providerState.openingBalances[currency] ?? balance;
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

function startDay(previous: BalanceState | undefined, date: string): BalanceState {
  const providers: Record<string, ProviderBalanceState> = {};
  for (const [provider, state] of Object.entries(previous?.providers ?? {})) {
    providers[provider] = {
      openingBalances: { ...state.latestBalances },
      latestBalances: { ...state.latestBalances },
    };
  }
  return { date, providers };
}

function readState(): BalanceState | undefined {
  const path = getStatePath();
  if (!existsSync(path)) return migrateLegacyBalanceState(path);
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<BalanceState>;
    if (!value.date || !value.providers || typeof value.providers !== "object") return undefined;
    return value as BalanceState;
  } catch {
    return undefined;
  }
}

function writeState(state: BalanceState): void {
  const path = getStatePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}
