import {
  getAgentDir,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
  type PackageSource,
} from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config";
import { IdleListener } from "./idle";
import { RecapManager } from "./manager";

export default function (pi: ExtensionAPI) {
  let idleListener: IdleListener<ExtensionContext> | undefined = undefined;
  let recapManager: RecapManager | undefined = undefined;

  pi.on("session_start", (event, ctx) => {
    if (!ctx.hasUI) return;
    // 若用户已安装独立的 saltfishpr/pi-recap 插件，则让位给它，避免重复注册。
    const settings = SettingsManager.create(ctx.cwd, getAgentDir(), {
      // 未信任项目时，不读取 .pi/settings.json
      projectTrusted: ctx.isProjectTrusted(),
    });
    if (settings.getPackages().some(isStandalonePiRecap)) return;

    const config = loadConfig(ctx.cwd);

    recapManager = new RecapManager(pi, config);

    pi.registerCommand("recap", {
      description: "Generate a short recap of the current session",
      handler: async () => await recapManager?.run(ctx, { force: true }),
    });

    idleListener = new IdleListener((c) => `idle:${c.isIdle()};editor:${c.ui.getEditorText()}`, config.idle);
    idleListener.on("enter", (c) => recapManager?.run(c));
    idleListener.on("wake", (c) => recapManager?.clear(c));

    if (event.reason === "resume" || event.reason === "fork") {
      idleListener.watch(ctx);
    }
  });

  pi.on("input", (_event, ctx) => {
    idleListener?.wake(ctx);
  });

  pi.on("user_bash", (_event, ctx) => {
    idleListener?.wake(ctx);
  });

  pi.on("agent_start", (_event, ctx) => {
    idleListener?.wake(ctx);
  });

  pi.on("session_before_compact", (_event, ctx) => {
    idleListener?.wake(ctx);
  });

  pi.on("session_before_tree", (_event, ctx) => {
    idleListener?.wake(ctx);
  });

  pi.on("agent_end", (_event, ctx) => {
    idleListener?.watch(ctx);
  });

  pi.on("session_compact", (_event, ctx) => {
    idleListener?.watch(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    idleListener?.watch(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    recapManager?.clear(ctx);
    recapManager = undefined;

    idleListener?.dispose();
    idleListener = undefined;
  });
}

// 匹配 npm/git 两种安装方式下的独立 saltfishpr/pi-recap 插件。
function isStandalonePiRecap(pkg: PackageSource): boolean {
  const source = typeof pkg === "string" ? pkg : pkg.source;
  return source.includes("saltfishpr/pi-recap");
}
