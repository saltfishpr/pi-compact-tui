import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ProviderConfig } from "../config";
import { codexAdapter } from "./codex";
import { deepseekAdapter } from "./deepseek";
import { zaiAdapter } from "./zai";

export type ProviderStatsKind = "balance" | "subscription";

export interface ProviderStatsAdapter {
  /** Label prefix for error messages, e.g. "Codex". */
  label: string;
  /** Provider id, matched against ctx.model.provider. */
  provider: string;
  /** Status bar key, kept stable so footer.json status:<key> entries keep working. */
  statusKey: string;
  /** Determines whether the adapter reports a balance or subscription quota. */
  kind: ProviderStatsKind;
  /** Returns the formatted status text, or undefined to hide the status entry. */
  fetch(ctx: ExtensionContext, signal: AbortSignal, config?: ProviderConfig): Promise<string | undefined>;
  /** Resets per-session state (called on session_start and session_shutdown). */
  resetSession?(): void;
}

export const providerStatsAdapters: ProviderStatsAdapter[] = [codexAdapter, deepseekAdapter, zaiAdapter];
