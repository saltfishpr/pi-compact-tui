import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const PROVIDER = "zai-coding-cn";
const STATUS_KEY = "zai-stats";
const BALANCE_URL = "https://open.bigmodel.cn/api/biz/account/query-customer-account-report";
const CURRENCY = "CNY";
const REQUEST_TIMEOUT_MS = 30_000;
const MIN_REFRESH_INTERVAL_MS = 10_000;
const STATE_FILE_NAME = "zai-stats-state.json";

interface AccountReport {
  code?: number;
  data?: {
    balance?: number;
    availableBalance?: number | null;
  };
  success?: boolean;
}

interface BalanceState {
  date: string;
  openingBalance: number | undefined;
  latestBalance: number;
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
    const value = JSON.parse(readFileSync(path, "utf8")) as BalanceState;
    if (!value.date || typeof value.latestBalance !== "number") return undefined;
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

function updateState(balance: number): BalanceState {
  const date = localDate();
  const previous = readState();
  let state: BalanceState;

  if (previous?.date === date) {
    state = previous;
    state.openingBalance ??= balance;
  } else {
    state = {
      date,
      openingBalance: previous?.latestBalance ?? balance,
      latestBalance: previous?.latestBalance ?? balance,
    };
  }

  state.latestBalance = balance;
  writeState(state);
  return state;
}

function formatMoney(amount: number): string {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: CURRENCY,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

function formatStatus(
  theme: Theme,
  openingBalance: number,
  sessionOpeningBalance: number,
  balance: number,
): string {
  const todayUsage = Math.max(0, openingBalance - balance);
  const sessionUsage = Math.max(0, sessionOpeningBalance - balance);
  return theme.fg(
    "success",
    [
      `📅 ${formatMoney(todayUsage)}`,
      `💬 ${formatMoney(sessionUsage)}`,
      `💰 ${formatMoney(balance)}`,
    ].join(" "),
  );
}

function parseBalance(response: AccountReport): number {
  if (response.success === false || (response.code !== undefined && response.code !== 200)) {
    throw new Error(response.data ? "账户报告异常" : `code ${response.code ?? "unknown"}`);
  }
  const balance = response.data?.balance;
  if (typeof balance !== "number" || !Number.isFinite(balance)) throw new Error("未返回余额");
  return balance;
}

export default function (pi: ExtensionAPI) {
  let inflight: AbortController | undefined;
  let lastRefreshAt = 0;
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

    if (Date.now() - lastRefreshAt < MIN_REFRESH_INTERVAL_MS) return;
    lastRefreshAt = Date.now();

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

      const response = await fetch(BALANCE_URL, {
        headers: {
          Accept: "application/json",
          Authorization: apiKey,
        },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const balance = parseBalance((await response.json()) as AccountReport);
      if (controller.signal.aborted || ctx.model?.provider !== PROVIDER) return;

      sessionOpeningBalance ??= balance;
      const state = updateState(balance);
      const openingBalance = state.openingBalance ?? balance;
      ctx.ui.setStatus(
        STATUS_KEY,
        formatStatus(ctx.ui.theme, openingBalance, sessionOpeningBalance, balance),
      );
    } catch (error) {
      if (controller.signal.aborted || ctx.model?.provider !== PROVIDER) return;
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("error", `Z.ai ${message}`));
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
