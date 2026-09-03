import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config";
import { providerStatsAdapters, type ProviderStatsAdapter } from "./providers";

const STATUS_FETCH_INTERVAL_MS = 10_000;

interface StatusCacheEntry {
  lastFetchAt: number;
  status: string | undefined;
}

export default function (pi: ExtensionAPI) {
  let config = loadConfig();
  const statusCache = new Map<ProviderStatsAdapter, StatusCacheEntry>();
  let inflight: AbortController | undefined;

  function clearAll(ctx: ExtensionContext): void {
    inflight?.abort();
    inflight = undefined;
    for (const adapter of providerStatsAdapters) ctx.ui.setStatus(adapter.statusKey, undefined);
  }

  function resetSession(): void {
    for (const adapter of providerStatsAdapters) adapter.resetSession?.();
  }

  function clearInactive(ctx: ExtensionContext, active: ProviderStatsAdapter): void {
    for (const adapter of providerStatsAdapters) {
      if (adapter !== active) ctx.ui.setStatus(adapter.statusKey, undefined);
    }
  }

  async function refresh(ctx: ExtensionContext): Promise<void> {
    if (!ctx.hasUI) return;

    const adapter = providerStatsAdapters.find((candidate) => candidate.provider === ctx.model?.provider);
    if (!adapter) {
      clearAll(ctx);
      return;
    }

    const providerConfig = config.providers[adapter.provider];
    if (providerConfig?.enabled === false) {
      clearAll(ctx);
      return;
    }

    clearInactive(ctx, adapter);

    const cachedStatus = statusCache.get(adapter);
    if (cachedStatus && Date.now() - cachedStatus.lastFetchAt < STATUS_FETCH_INTERVAL_MS) {
      ctx.ui.setStatus(adapter.statusKey, cachedStatus.status);
      return;
    }

    inflight?.abort();
    const controller = new AbortController();
    inflight = controller;

    const lastFetchAt = Date.now();
    statusCache.set(adapter, { lastFetchAt, status: undefined });

    try {
      const status = await adapter.fetch(ctx, controller.signal, providerConfig);
      if (controller.signal.aborted || ctx.model?.provider !== adapter.provider) return;
      statusCache.set(adapter, { lastFetchAt, status });
      ctx.ui.setStatus(adapter.statusKey, status);
    } catch (error) {
      if (controller.signal.aborted || ctx.model?.provider !== adapter.provider) return;
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.setStatus(adapter.statusKey, ctx.ui.theme.fg("error", `${adapter.label} ${message}`));
    } finally {
      if (inflight === controller) inflight = undefined;
    }
  }

  pi.on("session_start", (_event, ctx) => {
    config = loadConfig();
    resetSession();
    void refresh(ctx);
  });

  pi.on("model_select", (_event, ctx) => {
    void refresh(ctx);
  });

  pi.on("agent_settled", (_event, ctx) => {
    void refresh(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    clearAll(ctx);
    resetSession();
  });
}
