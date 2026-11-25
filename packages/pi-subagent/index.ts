import type { ExtensionAPI, ExtensionContext, ModelRuntime } from "@earendil-works/pi-coding-agent";

import { loadConfig } from "./config";
import { extractTextContent } from "./format";
import { logger } from "./logger";
import { applyAgentOverrides, discoverAgents } from "./profile/catalog";
import { ProfileTrust } from "./profile/trust";
import { inChildSessionContext } from "./runtime/child-context";
import { SubagentManager } from "./runtime/manager";
import { SubagentService } from "./runtime/service";
import { SubagentStore } from "./runtime/store";
import { registerAgentTool } from "./tools/agent";
import { registerControlTools } from "./tools/control";
import { registerModelsTool } from "./tools/models";
import { buildResultDetails, formatBackgroundNotification } from "./tools/result";
import type { AgentDiagnostic, AgentProfile, AgentToolDetails } from "./types";
import { renderAgentCard } from "./ui/card";
import { openSubagentsInspector } from "./ui/inspector";
import { openProfileTrustDialog } from "./ui/trust-dialog";
import { createSubagentWidget } from "./ui/widget";

const WIDGET_KEY = "pi-subagent";
export const NOTIFICATION_CUSTOM_TYPE = "pi-subagent:notification";
const SUBAGENT_TOOLS = ["agent", "agent_output", "agent_list", "agent_cancel", "agent_steer", "models"];

function getModelRuntime(ctx: ExtensionContext): ModelRuntime | undefined {
  // ModelRegistry does not expose its runtime publicly yet; fall back gracefully if Pi changes its internals.
  return (ctx.modelRegistry as unknown as { runtime?: ModelRuntime }).runtime;
}

function reportDiagnostics(ctx: ExtensionContext, diagnostics: AgentDiagnostic[]): void {
  if (diagnostics.length === 0) return;

  const message = [
    `Skipped ${diagnostics.length} invalid subagent definition${diagnostics.length > 1 ? "s" : ""}:`,
    ...diagnostics.map((diagnostic) => `- ${diagnostic.path}: ${diagnostic.message}`),
  ].join("\n");
  if (ctx.hasUI) {
    ctx.ui.notify(message, "warning");
  } else {
    logger.warn(message);
  }
}

export default function (pi: ExtensionAPI) {
  if (inChildSessionContext()) return;

  let agents: AgentProfile[] = [];
  let service: SubagentService | undefined;
  const profileTrust = new ProfileTrust();

  const getService = () => service;
  registerModelsTool(pi);
  registerControlTools(pi, getService);
  registerAgentTool(pi, getService);

  pi.registerMessageRenderer<AgentToolDetails>(NOTIFICATION_CUSTOM_TYPE, (message, { expanded }, theme) => {
    const rawOutput = extractTextContent(message.content);
    const details = message.details;
    const isError = details?.stopReason === "error" || details?.stopReason === "timeout";
    return renderAgentCard(rawOutput, details, expanded, isError, theme);
  });

  pi.registerCommand("subagents", {
    description: "Inspect subagent sessions and transcripts",
    handler: async (args, ctx) => {
      if (!service) {
        ctx.ui.notify("Subagent manager is not initialized", "warning");
        return;
      }
      const childSessionId = args.trim() || undefined;
      await openSubagentsInspector(ctx, service, childSessionId);
    },
  });

  pi.registerCommand("subagent-trust", {
    description: "Select trusted subagent profiles",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") return;

      const catalog = discoverAgents(ctx.cwd, ctx.isProjectTrusted());
      reportDiagnostics(ctx, catalog.diagnostics);
      if (catalog.diagnostics.length > 0) {
        ctx.ui.notify("Resolve invalid subagent profiles before changing trust", "error");
        return;
      }
      const profiles = [...new Map(catalog.agents.map((profile) => [profile.path, profile])).values()];
      await openProfileTrustDialog(ctx, profiles, profileTrust);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    const previousService = service;
    service = undefined;
    agents = [];
    ctx.ui.setWidget(WIDGET_KEY, undefined);
    if (previousService) {
      void previousService.shutdown();
    }

    const config = loadConfig();
    const activeTools = pi.getActiveTools();
    if (!config.enabled) {
      pi.setActiveTools(activeTools.filter((toolName) => !SUBAGENT_TOOLS.includes(toolName)));
      return;
    }
    const missingTools = SUBAGENT_TOOLS.filter((toolName) => !activeTools.includes(toolName));
    if (missingTools.length > 0) {
      pi.setActiveTools([...activeTools, ...missingTools]);
    }

    const catalog = discoverAgents(ctx.cwd, ctx.isProjectTrusted());
    reportDiagnostics(ctx, catalog.diagnostics);
    if (catalog.agents.length === 0) return;
    agents = applyAgentOverrides(catalog.agents, config);

    const store = new SubagentStore(ctx.cwd, ctx.sessionManager);
    const manager = new SubagentManager(ctx.cwd, config.maxConcurrent, getModelRuntime(ctx), { store });
    const currentService = new SubagentService(store, manager, agents, config, profileTrust);
    service = currentService;

    currentService.subscribeManager((event) => {
      if (event.type !== "background_settled") return;
      // 防止会话切换或重载后，旧 service 的后台任务向新会话串台推送通知。
      if (service !== currentService || currentService.isShuttingDown()) return;
      pi.sendMessage(
        {
          customType: NOTIFICATION_CUSTOM_TYPE,
          content: formatBackgroundNotification(event.name, event.title, event.result, event.triggerTurn),
          display: true,
          details: buildResultDetails(event.name, event.title, event.result),
        },
        // 父会话运行中时，steer 队列会被 Esc 清空而丢通知；改为 triggerTurn:false，
        // Pi 会在本轮结束时直接落盘（不会自动唤醒模型）。空闲时才触发新一轮。
        event.triggerTurn && ctx.isIdle() ? { triggerTurn: true } : { triggerTurn: false },
      );
    });
    ctx.ui.setWidget(WIDGET_KEY, createSubagentWidget(manager), { placement: "aboveEditor" });
  });

  pi.on("before_agent_start", (event) => {
    if (agents.length === 0) return;

    event.systemPromptOptions.sections.available_subagents = agents
      .map((agent) => `- \`${agent.name}\`: ${agent.description}`)
      .join("\n");
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setWidget(WIDGET_KEY, undefined);
    await service?.shutdown();
    service = undefined;
  });
}
