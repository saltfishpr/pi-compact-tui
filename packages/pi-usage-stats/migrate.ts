import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BalanceState, ProviderBalanceState } from "./balance-state";
import type { ProviderStatsConfig } from "./config";

const EXTENSIONS_DIR = join(getAgentDir(), "extensions");
const LEGACY_DEEPSEEK_CONFIG_PATH = join(EXTENSIONS_DIR, "deepseek-stats.json");
const LEGACY_DEEPSEEK_STATE_PATH = join(EXTENSIONS_DIR, "deepseek-stats-state.json");
const LEGACY_ZAI_STATE_PATH = join(EXTENSIONS_DIR, "zai-stats-state.json");

export function migrateLegacyConfig(path: string, config: ProviderStatsConfig): void {
  const legacy = readJSON(LEGACY_DEEPSEEK_CONFIG_PATH) as { currency?: unknown } | undefined;
  if (!legacy) return;

  if (legacy.currency === "CNY" || legacy.currency === "USD") {
    const deepseek = config.providers.deepseek;
    if (deepseek?.currency === undefined) config.providers.deepseek = { ...deepseek, currency: legacy.currency };
  }

  writeJSON(path, config);
  rmSync(LEGACY_DEEPSEEK_CONFIG_PATH);
}

export function migrateLegacyBalanceState(path: string): BalanceState | undefined {
  const deepseek = readLegacyDeepSeekState();
  const zai = readLegacyZaiState();
  const states = [deepseek, zai].filter((state): state is LegacyProviderState => state !== undefined);
  if (states.length === 0) return undefined;

  const date = localDate();
  const state: BalanceState = {
    date,
    providers: Object.fromEntries(
      states.map(({ date: legacyDate, provider, balanceState }) => [
        provider,
        legacyDate === date
          ? balanceState
          : { openingBalances: { ...balanceState.latestBalances }, latestBalances: { ...balanceState.latestBalances } },
      ]),
    ),
  };
  writeJSON(path, state);
  if (deepseek) rmSync(LEGACY_DEEPSEEK_STATE_PATH);
  if (zai) rmSync(LEGACY_ZAI_STATE_PATH);
  return state;
}

interface LegacyProviderState {
  date: string;
  provider: string;
  balanceState: ProviderBalanceState;
}

function readLegacyDeepSeekState(): LegacyProviderState | undefined {
  const value = readJSON(LEGACY_DEEPSEEK_STATE_PATH) as
    | { date?: unknown; openingBalances?: unknown; latestBalances?: unknown }
    | undefined;
  if (!value || typeof value.date !== "string") return undefined;
  const openingBalances = readBalances(value.openingBalances);
  const latestBalances = readBalances(value.latestBalances);
  if (!openingBalances || !latestBalances) return undefined;
  return { date: value.date, provider: "deepseek", balanceState: { openingBalances, latestBalances } };
}

function readLegacyZaiState(): LegacyProviderState | undefined {
  const value = readJSON(LEGACY_ZAI_STATE_PATH) as
    | { date?: unknown; openingBalance?: unknown; latestBalance?: unknown }
    | undefined;
  if (!value || typeof value.date !== "string" || typeof value.latestBalance !== "number") return undefined;
  const openingBalance = typeof value.openingBalance === "number" ? value.openingBalance : value.latestBalance;
  return {
    date: value.date,
    provider: "zai-coding-cn",
    balanceState: {
      openingBalances: { CNY: openingBalance },
      latestBalances: { CNY: value.latestBalance },
    },
  };
}

function localDate(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function readBalances(value: unknown): ProviderBalanceState["openingBalances"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const balances: ProviderBalanceState["openingBalances"] = {};
  for (const currency of ["CNY", "USD"] as const) {
    const balance = (value as Record<string, unknown>)[currency];
    if (balance !== undefined && (typeof balance !== "number" || !Number.isFinite(balance))) return undefined;
    if (typeof balance === "number") balances[currency] = balance;
  }
  return balances;
}

function readJSON(path: string): unknown {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function writeJSON(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
