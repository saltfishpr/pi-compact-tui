import { Type, type TextContent } from "@earendil-works/pi-ai";
import {
  DynamicBorder,
  getMarkdownTheme,
  getSettingsListTheme,
  keyHint,
  type AgentToolResult,
  type ExtensionAPI,
  type ExtensionContext,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import {
  Box,
  Container,
  Markdown,
  SettingsList,
  Spacer,
  Text,
  type SettingItem,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";

import { resolveModel, type UsageTotals } from "../pi-common";
import { discoverAgents, type AgentDiagnostic, type AgentProfile } from "./agents";
import { inChildSessionContext } from "./child-context";
import { loadConfig, type SubagentConfig } from "./config";
import { formatDuration, formatUsage } from "./format";
import { logger } from "./logger";
import { SubagentManager, type SpawnStopReason } from "./manager";
import { runProfileCommands } from "./profile-commands";
import { ProfileTrust } from "./profile-trust";
import { createSubagentWidget } from "./widget";

const WIDGET_KEY = "pi-subagent";

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

function applyAgentOverrides(profiles: AgentProfile[], config: SubagentConfig): AgentProfile[] {
  return profiles.map((profile) => {
    const override = config.agents[profile.name];
    if (!override) return profile;
    const merged: AgentProfile = { ...profile };
    if (override.model !== undefined) merged.model = override.model;
    if (override.effort !== undefined) merged.effort = override.effort;
    if (override.maxTurns !== undefined) merged.maxTurns = override.maxTurns;
    return merged;
  });
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

  let config = loadConfig();
  let agents: AgentProfile[] = [];
  let manager: SubagentManager | undefined;
  const profileTrust = new ProfileTrust();

  pi.registerTool({
    name: "agent",
    label: "Agent",
    exposure: "model-only",
    description: [
      "Delegate a focused task to a specialized subagent that runs in an isolated context.",
      "The subagent does not see this conversation, so include every piece of context it needs in `task`.",
    ].join("\n"),
    promptSnippet: "Delegate a focused task to a specialized subagent that runs in an isolated context",
    promptGuidelines: [
      "Use agent to delegate self-contained tasks to a specialized subagent; the subagent does not see the current conversation, so put every needed detail into `task`.",
      "Choose a subagent only when its description matches the task. If none matches, handle the task yourself; do not substitute another role.",
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
          prepare: async (prepareSignal) => {
            await profileTrust.authorize(profile, ctx, prepareSignal);
            if (profile.commands.length === 0) return "";
            return runProfileCommands(profile.commands, ctx.cwd, prepareSignal);
          },
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

  pi.registerCommand("subagent-trust", {
    description: "Select trusted subagent profiles",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        return;
      }

      const catalog = discoverAgents(ctx.cwd, ctx.isProjectTrusted());
      reportDiagnostics(ctx, catalog.diagnostics);
      if (catalog.diagnostics.length > 0) {
        ctx.ui.notify("Resolve invalid subagent profiles before changing trust", "error");
        return;
      }
      const profiles = [...new Map(catalog.agents.map((profile) => [profile.path, profile])).values()];
      if (profiles.length === 0) {
        ctx.ui.notify("No subagent profiles available", "info");
        return;
      }

      const trusted = profileTrust.list();
      const selectedPaths = new Set(
        profiles
          .filter((profile) => trusted.some((entry) => entry.path === profile.path && entry.sha256 === profile.sha256))
          .map((profile) => profile.path),
      );
      const selection = await ctx.ui.custom<Set<string> | undefined>((_tui, theme, keybindings, done) => {
        const items: SettingItem[] = profiles.map((profile) => ({
          id: profile.path,
          label: `${JSON.stringify(profile.name)} [${profile.source}]`,
          currentValue: selectedPaths.has(profile.path) ? "trusted" : "untrusted",
          values: ["trusted", "untrusted"],
          description: `${JSON.stringify(profile.path)} · ${profile.commands.length} pre-run commands`,
        }));
        const settings = new SettingsList(
          items,
          Math.min(items.length, 8),
          getSettingsListTheme(),
          (path, value) => {
            if (value === "trusted") selectedPaths.add(path);
            else selectedPaths.delete(path);
          },
          () => done(undefined),
          { enableSearch: true },
        );
        const container = new Container();
        container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
        container.addChild(new Text(theme.fg("accent", theme.bold("Subagent Profile Trust")), 1, 0));
        container.addChild(
          new Text(
            theme.fg(
              "muted",
              "Selected profiles may run ! commands in any working directory. Review files before saving.",
            ),
            1,
            0,
          ),
        );
        container.addChild(settings);
        const hints = (
          [
            ["app.models.enableAll", "trust all"],
            ["app.models.clearAll", "clear all"],
            ["app.models.save", "save"],
          ] as const
        )
          .flatMap(([action, description]) => {
            const keys = keybindings
              .getKeys(action)
              .join("/")
              .replace(/(^|[+/])[a-z]/g, (part) => part.toUpperCase());
            return keys ? [`${keys} to ${description}`] : [];
          })
          .join(" · ");
        container.addChild(new Text(theme.fg("dim", hints), 1, 0));
        container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));

        return {
          render: (width: number) => container.render(width),
          invalidate: () => container.invalidate(),
          handleMouse: (event: TuiMouseEvent) => container.handleMouse(event),
          handleInput: (data: string) => {
            if (keybindings.matches(data, "app.models.save")) {
              done(new Set(selectedPaths));
            } else if (
              keybindings.matches(data, "app.models.enableAll") ||
              keybindings.matches(data, "app.models.clearAll")
            ) {
              const enable = keybindings.matches(data, "app.models.enableAll");
              for (const profile of profiles) {
                if (enable) selectedPaths.add(profile.path);
                else selectedPaths.delete(profile.path);
                settings.updateValue(profile.path, enable ? "trusted" : "untrusted");
              }
            } else {
              settings.handleInput(data);
            }
          },
        };
      });
      if (!selection) return;

      try {
        await profileTrust.saveSelection(profiles, selection);
        ctx.ui.notify(`Saved trust for ${selection.size} of ${profiles.length} subagent profiles`, "info");
      } catch (error) {
        logger.error("Failed to save subagent profile trust", { error });
        ctx.ui.notify(`Failed to save subagent profile trust: ${String(error)}`, "error");
      }
    },
  });

  pi.on("session_start", (_event, ctx) => {
    config = loadConfig();

    const activeTools = pi.getActiveTools();
    if (!config.enabled) {
      pi.setActiveTools(activeTools.filter((toolName) => toolName !== "agent"));
      return;
    }
    if (!activeTools.includes("agent")) {
      pi.setActiveTools([...activeTools, "agent"]);
    }

    const catalog = discoverAgents(ctx.cwd, ctx.isProjectTrusted());
    reportDiagnostics(ctx, catalog.diagnostics);
    if (catalog.agents.length === 0) return;
    agents = applyAgentOverrides(catalog.agents, config);

    manager = new SubagentManager(ctx.cwd, config.maxConcurrent, getModelRuntime(ctx));
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
