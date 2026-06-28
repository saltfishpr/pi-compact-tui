import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config";

function setProxy(url: string) {
  process.env.HTTP_PROXY = url;
  process.env.HTTPS_PROXY = url;
}

function clearProxy() {
  delete process.env.HTTP_PROXY;
  delete process.env.HTTPS_PROXY;
}

export default function (pi: ExtensionAPI) {
  function applyProxy(ctx: ExtensionContext) {
    const provider = ctx.model?.provider;
    if (!provider) return;

    const config = loadConfig(ctx.cwd);
    const proxies = config.proxies ?? {};
    const proxyUrl = proxies[provider] ?? proxies["*"];

    if (proxyUrl) {
      setProxy(proxyUrl);
      if (ctx.hasUI) {
        ctx.ui.notify(`provider proxy: ${provider} → ${proxyUrl}`, "info");
      }
    } else {
      clearProxy();
      if (ctx.hasUI) {
        ctx.ui.notify("provider proxy: off", "info");
      }
    }
  }

  pi.on("session_start", (_event, ctx) => {
    applyProxy(ctx);
  });

  pi.on("model_select", (_event, ctx) => {
    applyProxy(ctx);
  });

  pi.on("session_shutdown", () => {
    clearProxy();
  });
}
