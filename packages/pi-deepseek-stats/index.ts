import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type Currency, getStatePath, loadConfig } from "./config";

const PROVIDER = "deepseek";
const STATUS_KEY = "deepseek-stats";
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

interface BalanceState {
  date: string;
  openingBalances: Partial<Record<Currency, number>>;
  latestBalances: Partial<Record<Currency, number>>;
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
    const value = JSON.parse(readFileSync(path, "utf8")) as BalanceState;
    if (!value.date || !value.openingBalances || !value.latestBalances) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

function writeState(state: BalanceState): void {
  const path = getStatePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

function updateState(currency: Currency, balance: number): BalanceState {
  const date = localDate();
  const previous = readState();
  let state: BalanceState;

  if (previous?.date === date) {
    state = previous;
    state.openingBalances[currency] ??= balance;
  } else {
    state = {
      date,
      openingBalances: { ...previous?.latestBalances, [currency]: previous?.latestBalances[currency] ?? balance },
      latestBalances: { ...previous?.latestBalances },
    };
  }

  state.latestBalances[currency] = balance;
  writeState(state);
  return state;
}

function formatMoney(currency: Currency, amount: number): string {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(amount);
}

function formatStatus(
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

function parseBalance(response: BalanceResponse, currency: Currency): number {
  if (response.is_available === false) throw new Error("余额不可用");
  const value = response.balance_infos?.find((info) => info.currency === currency)?.total_balance;
  const balance = value === undefined ? Number.NaN : Number(value);
  if (!Number.isFinite(balance)) throw new Error(`未返回 ${currency} 余额`);
  return balance;
}

export default function (pi: ExtensionAPI): void {
  let inflight: AbortController | undefined;
  let sessionOpeningBalance: number | undefined;

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
      const config = loadConfig();
      const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER);
      if (controller.signal.aborted) return;
      if (!apiKey) {
        ctx.ui.setStatus(STATUS_KEY, undefined);
        return;
      }

      const response = await fetch(BALANCE_URL, {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const balance = parseBalance((await response.json()) as BalanceResponse, config.currency);
      if (controller.signal.aborted || ctx.model?.provider !== PROVIDER) return;

      sessionOpeningBalance ??= balance;
      const state = updateState(config.currency, balance);
      const openingBalance = state.openingBalances[config.currency] ?? balance;
      ctx.ui.setStatus(
        STATUS_KEY,
        formatStatus(ctx.ui.theme, config.currency, openingBalance, sessionOpeningBalance, balance),
      );
    } catch (error) {
      if (controller.signal.aborted || ctx.model?.provider !== PROVIDER) return;
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("error", `DeepSeek ${message}`));
    } finally {
      if (inflight === controller) inflight = undefined;
    }
  }

  pi.on("session_start", (_event, ctx) => {
    sessionOpeningBalance = undefined;
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
    sessionOpeningBalance = undefined;
  });
}
