import { Type, type TextContent } from "@earendil-works/pi-ai";
import {
  getMarkdownTheme,
  keyHint,
  type AgentToolResult,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";

import { resolveModel, type UsageTotals } from "../pi-common";
import { discoverAgents, type AgentDiagnostic, type AgentProfile } from "./agents";
import { inChildSessionContext } from "./child-context";
import { loadConfig } from "./config";
import { formatDuration, formatUsage } from "./format";
import { SubagentManager, type SpawnStopReason } from "./manager";
import { createSubagentWidget } from "./widget";

const WIDGET_KEY = "pi-subagent";

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

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatAvailableAgents(agents: AgentProfile[]): string {
  const entries = agents
    .map(
      (agent) =>
        `  <subagent>\n    <name>${escapeXml(agent.name)}</name>\n    <description>${escapeXml(agent.description)}</description>\n  </subagent>`,
    )
    .join("\n");
  return `<available_subagents>\n${entries}\n</available_subagents>`;
}

interface AgentToolDetails {
  name: string;
  title: string;
  model: string;
  turns: number;
  durationMs: number;
  usage: UsageTotals;
  stopReason: SpawnStopReason;
}

export default function (pi: ExtensionAPI) {
  if (inChildSessionContext()) return;

  const config = loadConfig();
  if (!config.enabled) return;

  let agents: AgentProfile[] = [];
  let manager: SubagentManager | undefined;

  pi.registerTool({
    name: "agent",
    label: "Agent",
    description: [
      "Delegate a focused task to a specialized subagent that runs in an isolated context.",
      "The subagent does not see this conversation, so include every piece of context it needs in `task`.",
    ].join("\n"),
    promptSnippet: "Delegate a focused task to a specialized subagent that runs in an isolated context",
    promptGuidelines: [
      "Use agent to delegate self-contained tasks to a specialized subagent; the subagent does not see the current conversation, so put every needed detail into `task`.",
      "Use agent when a task matches one of the listed subagents and benefits from an isolated context (e.g. broad research, parallelizable subtasks) — avoid it for trivial lookups you can handle directly.",
    ],
    parameters: Type.Object({
      name: Type.String({
        minLength: 1,
        description: `Which subagent to run.`,
      }),
      title: Type.String({
        description: "A short title shown in the running subagent widget; it is not sent to the subagent",
        minLength: 1,
        maxLength: 60,
        pattern: "^(?=.*\\S)[^\\r\\n]+$",
      }),
      task: Type.String({ description: "The full task for the subagent, including all needed context" }),
    }),
    renderShell: "self",

    async execute(toolCallId, params, signal, _onUpdate, ctx): Promise<AgentToolResult<AgentToolDetails>> {
      if (!manager) {
        throw new Error("Agent manager not initialized");
      }

      const profile = agents.find((agent) => agent.name === params.name);
      if (!profile) {
        throw new Error(`Unknown subagent "${params.name}"`);
      }

      const resolved = resolveModel(ctx, {
        model: profile.model,
        thinkingLevel: profile.effort,
        fallbackModel: ctx.model,
        fallbackThinkingLevel: ctx.thinkingLevel,
      });
      if (!resolved) {
        throw new Error(`No model available for subagent "${profile.name}"`);
      }

      const result = await manager.spawn(
        {
          id: toolCallId,
          profile,
          title: params.title,
          task: params.task,
          model: resolved.model,
          thinkingLevel: resolved.thinkingLevel,
        },
        signal,
      );

      return {
        content: [{ type: "text", text: result.text }],
        details: {
          name: profile.name,
          title: params.title,
          model: result.model,
          turns: result.turns,
          durationMs: result.durationMs,
          usage: result.usage,
          stopReason: result.stopReason,
        },
      };
    },

    renderCall(args, theme) {
      return new Container(); // call 过程中不渲染，展示在 widget 中
    },

    renderResult(result, { expanded, isPartial }, theme, context) {
      if (isPartial) return new Container();

      // 折叠态输出最大行数
      const COLLAPSED_LINE_COUNT = 5;

      const details = result.details as Partial<AgentToolDetails> | undefined;
      const isError = context.isError || details?.stopReason === "aborted" || details?.stopReason === "max_turns";

      const box = new Box(1, 1, (text) => theme.bg(isError ? "toolErrorBg" : "toolSuccessBg", text));
      const content = new Container();

      // 标题行：agent explore — 探索项目结构
      const name = details?.name ? theme.fg("accent", details.name) : "";
      const title = details?.title ? ` — ${theme.fg("muted", details.title)}` : "";
      content.addChild(new Text(`${theme.fg("toolTitle", theme.bold("agent"))} ${name}${title}`, 0, 0));

      const output = result.content
        .filter((part): part is TextContent => part.type === "text")
        .map((part) => part.text)
        .join("\n");

      if (expanded) {
        // 展开态：完整 markdown 渲染
        if (output) content.addChild(new Markdown(output, 0, 0, getMarkdownTheme()));
      } else if (output) {
        // 折叠态：前 5 行用普通文本，超出附展开提示
        const outputLines = output.split("\n");
        content.addChild(new Text(theme.fg("toolOutput", outputLines.slice(0, COLLAPSED_LINE_COUNT).join("\n")), 0, 0));
        if (outputLines.length > COLLAPSED_LINE_COUNT) {
          // 把 `)` 写到外侧 theme.fg("muted", "...)") 有 bug 导致最后一个符号是正常颜色，因此把 `)` 写到 keyHint description 里
          content.addChild(new Text(theme.fg("muted", `(${keyHint("app.tools.expand", "to expand)")}`), 0, 0));
        }
      }

      if (details) {
        content.addChild(new Spacer(1));

        const parts = [formatDuration(details.durationMs ?? 0), `${details.turns ?? 0} turns`];
        if (details.model) parts.push(details.model);
        const usage = details.usage ? formatUsage(details.usage) : "";
        if (usage) parts.push(usage);
        const statusLine = parts.join(" · ");
        content.addChild(new Text(theme.fg("dim", statusLine), 0, 0));
      }

      box.addChild(content);
      return box;
    },
  });

  pi.on("session_start", (_event, ctx) => {
    const catalog = discoverAgents(ctx.cwd, ctx.isProjectTrusted());
    reportDiagnostics(ctx, catalog.diagnostics);
    if (catalog.agents.length === 0) return;
    agents = catalog.agents;

    manager = new SubagentManager(ctx.cwd, config.maxConcurrent);
    ctx.ui.setWidget(WIDGET_KEY, createSubagentWidget(manager), { placement: "aboveEditor" });
  });

  pi.on("before_agent_start", async (event) => {
    if (agents.length === 0) return;

    return { systemPrompt: `${event.systemPrompt}\n\n${formatAvailableAgents(agents)}` };
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setWidget(WIDGET_KEY, undefined);
    await manager?.shutdown();
    manager = undefined;
  });
}
