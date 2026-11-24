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
  type SessionManager,
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
import { formatDuration, formatUsage, shortenSessionId } from "./format";
import { openSubagentsInspector } from "./inspector";
import { logger } from "./logger";
import { SubagentManager, type SpawnStopReason, type ToolTraceEntry } from "./manager";
import { runProfileCommands } from "./profile-commands";
import { ProfileTrust } from "./profile-trust";
import { SubagentStore } from "./store";
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

function applyAgentOverrides(profiles: AgentProfile[], config: SubagentConfig): AgentProfile[] {
  return profiles.map((profile) => {
    const override = config.agents[profile.name];
    if (!override) return profile;
    const merged: AgentProfile = { ...profile };
    if (override.model !== undefined) merged.model = override.model;
    if (override.effort !== undefined) merged.effort = override.effort;
    if (override.maxTurns !== undefined) merged.maxTurns = override.maxTurns;
    if (override.extensions !== undefined) merged.extensions = override.extensions;
    return merged;
  });
}

interface AgentToolDetails {
  childSessionId: string;
  resumed?: boolean;
  name: string;
  title: string;
  model: string;
  turns: number;
  durationMs: number;
  usage: UsageTotals;
  stopReason: SpawnStopReason;
  toolTrace?: ToolTraceEntry[];
  toolTraceTotal?: number;
}

export default function (pi: ExtensionAPI) {
  if (inChildSessionContext()) return;

  let config = loadConfig();
  let agents: AgentProfile[] = [];
  let store: SubagentStore | undefined;
  let manager: SubagentManager | undefined;
  const profileTrust = new ProfileTrust();

  pi.registerTool({
    name: "agent",
    label: "Agent",
    exposure: "model-only",
    description: [
      "Delegate a focused task to a specialized subagent that runs in an isolated context.",
      "The subagent does not see this conversation, so include every piece of context it needs in `task`.",
      "To continue a previous subagent session (for follow-up questions or resuming after max_turns), pass its `Child session ID` in `resume`.",
    ].join("\n"),
    promptSnippet: "Delegate a focused task to a specialized subagent that runs in an isolated context",
    promptGuidelines: [
      "Use agent to delegate self-contained tasks to a specialized subagent; the subagent does not see the current conversation, so put every needed detail into `task`.",
      "Choose a subagent only when its description matches the task. If none matches, handle the task yourself; do not substitute another role.",
      "To follow up with a previous subagent, ask clarifying questions, or continue a task that stopped at `max_turns`, pass its returned `Child session ID` in `resume` instead of starting from scratch.",
      "Do not spawn multiple `worker` subagents in parallel to edit overlapping files.",
    ],
    parameters: Type.Object({
      name: Type.Optional(
        Type.String({
          minLength: 1,
          description: "Which subagent to run. Required when creating a new subagent; optional when `resume` is provided.",
        }),
      ),
      resume: Type.Optional(
        Type.String({
          minLength: 1,
          description: "Full child session ID returned by a previous `agent` call to continue that conversation.",
        }),
      ),
      title: Type.Optional(
        Type.String({
          description:
            "A short title shown in the running subagent widget; not sent to the subagent. Required for new subagents; optional on `resume`.",
          minLength: 1,
          maxLength: 60,
          pattern: "^(?=.*\\S)[^\\r\\n]+$",
        }),
      ),
      task: Type.String({ description: "The full task or follow-up instruction for the subagent, including all needed context" }),
    }),
    renderShell: "self",

    async execute(toolCallId, params, signal, _onUpdate, ctx): Promise<AgentToolResult<AgentToolDetails>> {
      if (!manager || !store) {
        throw new Error("Agent manager not initialized");
      }

      const resumeId = params.resume?.trim();
      const resumed = Boolean(resumeId);

      let profile: AgentProfile | undefined;
      let title: string;
      let childSessionId: string;
      let sessionManager: SessionManager;

      if (resumeId) {
        if (manager.isChildActive(resumeId)) {
          throw new Error(
            `Subagent session "${resumeId}" is already pending or running; concurrent resume is not allowed.`,
          );
        }

        const opened = store.openSessionForResume(resumeId);
        if (params.name && params.name !== opened.record.name) {
          throw new Error(
            `Cannot resume subagent "${resumeId}" (profile "${opened.record.name}") with different profile "${params.name}".`,
          );
        }

        profile = agents.find((agent) => agent.name === opened.record.name);
        if (!profile) {
          throw new Error(`Unknown subagent "${opened.record.name}" for resumed session "${resumeId}"`);
        }

        title = params.title?.trim() || opened.record.title || profile.name;
        childSessionId = resumeId;
        sessionManager = opened.sessionManager;
      } else {
        if (!params.name?.trim()) {
          throw new Error("Parameter `name` is required when starting a new subagent");
        }
        if (!params.title?.trim()) {
          throw new Error("Parameter `title` is required when starting a new subagent");
        }

        profile = agents.find((agent) => agent.name === params.name);
        if (!profile) {
          throw new Error(`Unknown subagent "${params.name}"`);
        }

        title = params.title.trim();
        const created = store.createSession(profile.name, title);
        childSessionId = created.childSessionId;
        sessionManager = created.sessionManager;
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

      const activeProfile = profile;
      const result = await manager.spawn(
        {
          id: toolCallId,
          childSessionId,
          sessionManager,
          resumed,
          profile: activeProfile,
          title,
          task: params.task,
          model: resolved.model,
          thinkingLevel: resolved.thinkingLevel,
          projectTrusted: ctx.isProjectTrusted(),
          prepare: async (prepareSignal) => {
            if (resumed) return "";
            await profileTrust.authorize(activeProfile, ctx, prepareSignal);
            if (activeProfile.commands.length === 0) return "";
            return runProfileCommands(activeProfile.commands, ctx.cwd, prepareSignal);
          },
        },
        signal,
      );

      const contentText = `${result.text}\n\nChild session ID: ${result.childSessionId}`;

      return {
        content: [{ type: "text", text: contentText }],
        details: {
          childSessionId: result.childSessionId,
          resumed: result.resumed || undefined,
          name: activeProfile.name,
          title,
          model: result.model,
          turns: result.turns,
          durationMs: result.durationMs,
          usage: result.usage,
          stopReason: result.stopReason,
          toolTrace: result.toolTrace,
          toolTraceTotal: result.toolTraceTotal,
        },
      };
    },

    renderCall(_args, _theme) {
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

      // 标题行：agent explore [xxxx…yyyy] (resumed) — 探索项目结构
      const name = details?.name ? theme.fg("accent", details.name) : "";
      const idBadge = details?.childSessionId
        ? ` ${theme.fg("dim", `[${shortenSessionId(details.childSessionId)}]`)}`
        : "";
      const resumedBadge = details?.resumed ? ` ${theme.fg("muted", "(resumed)")}` : "";
      const title = details?.title ? ` — ${theme.fg("muted", details.title)}` : "";
      content.addChild(
        new Text(`${theme.fg("toolTitle", theme.bold("agent"))} ${name}${idBadge}${resumedBadge}${title}`, 0, 0),
      );

      const rawOutput = result.content
        .filter((part): part is TextContent => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      // 展示层去掉末尾给 LLM 用的 Child session ID 提示行，避免与标题/底部重复
      const output = details?.childSessionId
        ? rawOutput.replace(new RegExp(`\\n\\nChild session ID: ${details.childSessionId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), "")
        : rawOutput;

      if (expanded) {
        // 展开态：完整 markdown 渲染
        if (output) content.addChild(new Markdown(output, 0, 0, getMarkdownTheme()));

        const trace = details?.toolTrace ?? [];
        const totalTools = details?.toolTraceTotal ?? trace.length;
        if (trace.length > 0) {
          content.addChild(new Spacer(1));
          content.addChild(new Text(theme.fg("muted", theme.bold(`Tools (${totalTools})`)), 0, 0));
          const omitted = totalTools - trace.length;
          const headCount = omitted > 0 ? Math.floor(trace.length / 2) : trace.length;

          for (let i = 0; i < trace.length; i++) {
            if (omitted > 0 && i === headCount) {
              content.addChild(new Text(theme.fg("dim", `  … ${omitted} more tool calls omitted`), 0, 0));
            }
            const item = trace[i]!;
            const icon = item.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
            content.addChild(new Text(`  ${icon} ${theme.fg("muted", item.summary)}`, 0, 0));
          }
        }

        if (details?.childSessionId) {
          content.addChild(new Spacer(1));
          content.addChild(
            new Text(theme.fg("dim", `Run /subagents ${details.childSessionId} for full transcript`), 0, 0),
          );
        }
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

        const parts: string[] = [];
        const toolCount = details.toolTraceTotal ?? details.toolTrace?.length ?? 0;
        if (toolCount > 0) parts.push(`${toolCount} tool${toolCount > 1 ? "s" : ""}`);
        parts.push(formatDuration(details.durationMs ?? 0));
        parts.push(`${details.turns ?? 0} turns`);
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

  pi.registerCommand("subagents", {
    description: "Inspect subagent sessions and transcripts",
    handler: async (args, ctx) => {
      if (!store || !manager) {
        ctx.ui.notify("Subagent manager is not initialized", "warning");
        return;
      }
      const childSessionId = args.trim() || undefined;
      await openSubagentsInspector(ctx, store, manager, childSessionId);
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
    const previousManager = manager;
    manager = undefined;
    store = undefined;
    ctx.ui.setWidget(WIDGET_KEY, undefined);
    if (previousManager) {
      void previousManager.shutdown();
    }

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

    store = new SubagentStore(ctx.cwd, ctx.sessionManager);
    manager = new SubagentManager(ctx.cwd, config.maxConcurrent, getModelRuntime(ctx), { store });
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
    await manager?.shutdown();
    manager = undefined;
    store = undefined;
  });
}
