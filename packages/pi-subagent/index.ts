import { Message, StringEnum, Type } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { discoverAgents, type AgentDiagnostic, type LoadedAgent } from "./agents";
import { loadConfig } from "./config";
import { renderSubagentCall, renderSubagentResult, updateSubagentWidget } from "./render";
import { runSubagent, type RunningSubagent, type SubagentResult } from "./runner";

function reportDiagnostics(ctx: ExtensionContext, diagnostics: AgentDiagnostic[]): void {
  if (diagnostics.length === 0) return;

  const message = [
    `Skipped ${diagnostics.length} invalid subagent definition${diagnostics.length > 1 ? "s" : ""}:`,
    ...diagnostics.map((diagnostic) => `- ${diagnostic.path}: ${diagnostic.message}`),
  ].join("\n");
  if (ctx.hasUI) {
    ctx.ui.notify(message, "warning");
  } else {
    process.stderr.write(`[pi-subagent] ${message}\n`);
  }
}

function getNextAgentNumber(ctx: ExtensionContext): number {
  let maxNumber = 0;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role !== "toolResult" || message.toolName !== "agent") continue;

    const details = message.details as Partial<SubagentResult> | undefined;
    if (typeof details?.number === "number") maxNumber = Math.max(maxNumber, details.number);
  }
  return maxNumber + 1;
}

function registerAgentTool(
  pi: ExtensionAPI,
  agents: LoadedAgent[],
  running: Map<string, RunningSubagent>,
  initialAgentNumber: number,
): void {
  let nextAgentNumber = initialAgentNumber;
  const description = [
    "Delegate a focused task to a specialized subagent that runs in an isolated context.",
    "The subagent does not see this conversation, so put everything it needs in `prompt`.",
    "Available subagents:",
    ...agents.map((agent) => `- ${agent.name}: ${agent.description}`),
  ].join("\n");

  pi.registerTool({
    name: "agent",
    label: "Agent",
    description,
    parameters: Type.Object({
      name: StringEnum(
        agents.map((agent) => agent.name),
        { description: "Which subagent to run" },
      ),
      title: Type.String({
        description: "A short title shown in the running subagent widget; it is not sent to the subagent",
        minLength: 1,
        maxLength: 60,
        pattern: "^(?=.*\\S)[^\\r\\n]+$",
      }),
      prompt: Type.String({ description: "The full task for the subagent, including all needed context" }),
    }),
    renderShell: "self",

    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const agent = agents.find((candidate) => candidate.name === params.name);
      if (!agent) throw new Error(`Unknown subagent: ${params.name}`);

      const agentNumber = nextAgentNumber++;
      running.set(toolCallId, {
        number: agentNumber,
        agent: agent.name,
        title: params.title.trim(),
        messages: [],
      });
      updateSubagentWidget(ctx, running);

      const onMessage = (message: Message) => {
        const current = running.get(toolCallId);
        if (!current) return;
        current.messages.push(message);
        updateSubagentWidget(ctx, running);
      };

      let model = ctx.model;
      if (agent.model) {
        const [provider, ...modelId] = agent.model.split("/");
        model = ctx.modelRegistry.find(provider, modelId.join("/"));
      }
      const thinkingLevel = agent.effort ?? pi.getThinkingLevel();

      try {
        const result = await runSubagent({
          number: agentNumber,
          agent,
          task: params.prompt,
          signal,
          cwd: ctx.cwd,
          model,
          thinkingLevel,
          onMessage,
        });
        return {
          content: [{ type: "text", text: result.finalOutput || result.errorMessage || "(no output)" }],
          details: result,
        };
      } finally {
        running.delete(toolCallId);
        updateSubagentWidget(ctx, running);
      }
    },

    renderCall: renderSubagentCall,
    renderResult: renderSubagentResult,
  });
}

export default function (pi: ExtensionAPI) {
  let registered = false;
  const running = new Map<string, RunningSubagent>();

  pi.on("session_start", async (_event, ctx) => {
    if (registered) return;

    const config = loadConfig();
    if (!config.enabled) return;

    const catalog = discoverAgents(ctx.cwd, ctx.isProjectTrusted());
    reportDiagnostics(ctx, catalog.diagnostics);
    if (catalog.agents.length === 0) return;

    registerAgentTool(pi, catalog.agents, running, getNextAgentNumber(ctx));
    registered = true;
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    running.clear();
    updateSubagentWidget(ctx, running);
  });
}
