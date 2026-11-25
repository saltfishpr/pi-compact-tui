import { getSupportedThinkingLevels, StringEnum, Type, type TextContent } from "@earendil-works/pi-ai";
import {
  DynamicBorder,
  getSettingsListTheme,
  type AgentToolResult,
  type ExtensionAPI,
  type ExtensionContext,
  type ModelRuntime,
  type SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Text, type SettingItem, type TuiMouseEvent } from "@earendil-works/pi-tui";

import { resolveModel, THINKING_LEVELS } from "../pi-common";
import { discoverAgents, type AgentDiagnostic, type AgentProfile } from "./agents";
import { inChildSessionContext } from "./child-context";
import { loadConfig, type SubagentConfig } from "./config";
import { registerControlTools } from "./control-tools";
import { openSubagentsInspector } from "./inspector";
import { logger } from "./logger";
import { SubagentManager, type SpawnResult } from "./manager";
import { registerModelsTool } from "./models-tool";
import { runProfileCommands } from "./profile-commands";
import { ProfileTrust } from "./profile-trust";
import {
  buildBackgroundToolResult,
  buildResultDetails,
  formatBackgroundNotification,
  formatSpawnResultText,
  renderAgentCard,
  type AgentToolDetails,
} from "./result-view";
import { SubagentStore } from "./store";
import { createSubagentWidget } from "./widget";
import {
  ISOLATION_MODES,
  validateGitRepoForWorktree,
  type IsolationMode,
  type SubagentWorktreeState,
} from "./worktree";

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

function applyAgentOverrides(profiles: AgentProfile[], config: SubagentConfig): AgentProfile[] {
  return profiles.map((profile) => {
    const override = config.agents[profile.name];
    if (!override) return profile;
    const merged: AgentProfile = { ...profile };
    if (override.model !== undefined) merged.model = override.model;
    if (override.effort !== undefined) merged.effort = override.effort;
    if (override.maxTurns !== undefined) merged.maxTurns = override.maxTurns;
    if (override.timeoutSeconds !== undefined) merged.timeoutSeconds = override.timeoutSeconds;
    if (override.isolation !== undefined) merged.isolation = override.isolation;
    if (override.extensions !== undefined) merged.extensions = override.extensions;
    return merged;
  });
}

export default function (pi: ExtensionAPI) {
  if (inChildSessionContext()) return;

  let config = loadConfig();
  let agents: AgentProfile[] = [];
  let store: SubagentStore | undefined;
  let manager: SubagentManager | undefined;
  const profileTrust = new ProfileTrust();

  registerModelsTool(pi);
  registerControlTools(pi, {
    getManager: () => manager,
    getStore: () => store,
  });

  pi.registerTool({
    name: "agent",
    label: "Agent",
    exposure: "model-only",
    description: [
      "Delegate a focused task to a specialized subagent that runs in an isolated context.",
      "The subagent does not see this conversation, so include every piece of context it needs in `task`.",
      "To continue a previous subagent session (for follow-up questions or resuming after `max_turns`), pass its `Child session ID` in `resume`.",
    ].join("\n"),
    promptSnippet: "Delegate a focused task to a specialized subagent that runs in an isolated context",
    promptGuidelines: [
      "Use `agent` to delegate self-contained tasks to a specialized subagent; the subagent does not see the current conversation, so put every needed detail into `task`.",
      "Choose a subagent only when its description matches the task. If none matches, handle the task yourself; do not substitute another role.",
      "To follow up with a previous subagent, ask clarifying questions, or continue a task that stopped at `max_turns`, pass its returned `Child session ID` in `resume` instead of starting from scratch.",
      "Use the `models` tool to find available model IDs and thinking levels before overriding a subagent's model or thinking level.",
      "When spawning multiple `worker` subagents in parallel to edit code, pass `isolation: \"worktree\"` so each runs in its own Git worktree instead of editing overlapping files in the shared working tree.",
      "When running subagents with `background: true`, you will be notified automatically when each task finishes. Do NOT poll in a loop with `agent_list` or `agent_output`; use `agent_output(block: true)`, `agent_cancel`, or `agent_steer` only when you explicitly need to wait, cancel, or redirect a running subagent.",
    ],
    parameters: Type.Object({
      name: Type.Optional(
        Type.String({
          minLength: 1,
          description:
            "Which subagent to run. Required when creating a new subagent; optional when `resume` is provided.",
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
      model: Type.Optional(
        Type.String({
          pattern: "^[^/]+/.+$",
          description:
            "Model ID in `provider/model-id` format from the `models` tool. Overrides the model for this call only.",
        }),
      ),
      thinkingLevel: Type.Optional(
        StringEnum(THINKING_LEVELS, {
          description:
            "Thinking level supported by the selected model. Overrides the thinking level for this call only.",
        }),
      ),
      maxTurns: Type.Optional(
        Type.Integer({ minimum: 1, description: "Override the maximum number of turns for this call only." }),
      ),
      timeoutSeconds: Type.Optional(
        Type.Integer({
          minimum: 1,
          description: "Wall-clock timeout in seconds for this call only. Aborts the subagent if exceeded.",
        }),
      ),
      background: Type.Optional(
        Type.Boolean({
          default: false,
          description:
            "Run the subagent asynchronously in the background and return immediately with its child session ID. You will be notified automatically when it finishes.",
        }),
      ),
      isolation: Type.Optional(
        StringEnum(ISOLATION_MODES, {
          description:
            'Working directory isolation mode. Use "worktree" to run the subagent in an isolated Git worktree (requires a Git repository with at least one commit).',
        }),
      ),
      task: Type.String({
        description: "The full task or follow-up instruction for the subagent, including all needed context",
      }),
    }),
    renderShell: "self",

    async execute(toolCallId, params, signal, _onUpdate, ctx): Promise<AgentToolResult<AgentToolDetails>> {
      const currentManager = manager;
      const currentStore = store;
      if (!currentManager || !currentStore) {
        throw new Error("Agent manager not initialized");
      }

      const resumeId = params.resume?.trim();
      const resumed = Boolean(resumeId);
      const background = Boolean(params.background);

      let profile: AgentProfile | undefined;
      let title: string;
      let child: { childSessionId: string; sessionManager: SessionManager } | undefined;
      let effectiveIsolation: IsolationMode;
      let existingWorktree: SubagentWorktreeState | undefined;

      if (resumeId) {
        if (currentManager.isChildActive(resumeId)) {
          throw new Error(
            `Subagent session "${resumeId}" is already pending or running; concurrent resume is not allowed.`,
          );
        }

        const opened = currentStore.openSessionForResume(resumeId);
        if (params.name && params.name !== opened.record.name) {
          throw new Error(
            `Cannot resume subagent "${resumeId}" (profile "${opened.record.name}") with different profile "${params.name}".`,
          );
        }

        profile = agents.find((agent) => agent.name === opened.record.name);
        if (!profile) {
          throw new Error(`Unknown subagent "${opened.record.name}" for resumed session "${resumeId}"`);
        }

        const previousIsolation: IsolationMode = opened.record.worktree ? "worktree" : "none";
        if (params.isolation !== undefined && params.isolation !== previousIsolation) {
          throw new Error(
            `Cannot change \`isolation\` when resuming subagent "${resumeId}" (was "${previousIsolation}", got "${params.isolation}").`,
          );
        }
        effectiveIsolation = previousIsolation;
        existingWorktree = opened.record.worktree;

        title = params.title?.trim() || opened.record.title || profile.name;
        child = { childSessionId: resumeId, sessionManager: opened.sessionManager };
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

        effectiveIsolation = params.isolation ?? profile.isolation ?? "none";
        title = params.title.trim();
      }

      if (
        params.model &&
        !ctx.modelRegistry.getAvailable().some((model) => `${model.provider}/${model.id}` === params.model)
      ) {
        throw new Error(`Model "${params.model}" is not available. Use the \`models\` tool to find available models.`);
      }
      const resolved = resolveModel(ctx, {
        model: params.model ?? profile.model,
        thinkingLevel: params.thinkingLevel ?? profile.effort,
        fallbackModel: ctx.model,
        fallbackThinkingLevel: ctx.thinkingLevel,
      });
      if (!resolved) {
        throw new Error(`No model available for subagent "${profile.name}"`);
      }
      if (params.thinkingLevel !== undefined) {
        const supported = getSupportedThinkingLevels(resolved.model);
        if (!supported.includes(params.thinkingLevel)) {
          throw new Error(
            `Model "${resolved.model.provider}/${resolved.model.id}" does not support \`thinkingLevel\` "${params.thinkingLevel}". Supported: ${supported.join(", ")}.`,
          );
        }
      }

      const activeProfile = profile;
      if (effectiveIsolation === "worktree") {
        await validateGitRepoForWorktree(ctx.cwd);
      }

      // 后台任务不能在返回后静默弹交互式授权窗，须在返回前同步完成 !cmd 授权。
      if (background && !resumed && activeProfile.commands.length > 0) {
        await profileTrust.authorize(activeProfile, ctx, signal ?? new AbortController().signal);
      }

      const { childSessionId, sessionManager } = child ?? currentStore.createSession(activeProfile.name, title);
      const spawnReq = {
        id: toolCallId,
        childSessionId,
        sessionManager,
        resumed,
        background,
        profile: activeProfile,
        title,
        task: params.task,
        model: resolved.model,
        thinkingLevel: resolved.thinkingLevel,
        maxTurns: params.maxTurns,
        timeoutSeconds: params.timeoutSeconds ?? activeProfile.timeoutSeconds ?? config.defaultTimeoutSeconds,
        isolation: effectiveIsolation,
        existingWorktree,
        projectTrusted: ctx.isProjectTrusted(),
        prepare: async (prepareSignal: AbortSignal, prepareCwd: string) => {
          if (resumed) return "";
          if (!background) {
            await profileTrust.authorize(activeProfile, ctx, prepareSignal);
          }
          if (activeProfile.commands.length === 0) return "";
          return runProfileCommands(activeProfile.commands, prepareCwd, prepareSignal);
        },
      };

      if (background) {
        void currentManager.spawn(spawnReq, undefined).catch(() => undefined);
        const snapshot = currentManager.getSnapshot(childSessionId);
        const phase = snapshot?.phase ?? "pending";
        return buildBackgroundToolResult({
          childSessionId,
          resumed,
          backgroundStatus: "started",
          headline: `Subagent "${activeProfile.name}" (${title}) started in background (status: ${phase}).`,
          name: activeProfile.name,
          title,
          model: `${resolved.model.provider}/${resolved.model.id}`,
        });
      }

      const settledPromise = currentManager.spawn(spawnReq, signal);
      const outcome = await new Promise<{ kind: "settled"; result: SpawnResult } | { kind: "detached" }>(
        (resolve, reject) => {
          const unsub = currentManager.subscribe((event) => {
            if (event.type === "detached" && event.childSessionId === childSessionId) {
              unsub();
              resolve({ kind: "detached" });
            }
          });
          settledPromise.then(
            (result) => {
              unsub();
              resolve({ kind: "settled", result });
            },
            (error) => {
              unsub();
              reject(error);
            },
          );
        },
      );

      if (outcome.kind === "detached") {
        void settledPromise.catch(() => undefined);
        return buildBackgroundToolResult({
          childSessionId,
          resumed,
          backgroundStatus: "detached",
          headline: `Subagent "${activeProfile.name}" (${title}) was moved to background.`,
          name: activeProfile.name,
          title,
          model: `${resolved.model.provider}/${resolved.model.id}`,
        });
      }

      const { result } = outcome;
      const { text: contentText, isError } = formatSpawnResultText(result);
      return {
        content: [{ type: "text", text: contentText }],
        isError: isError ? true : undefined,
        details: buildResultDetails(activeProfile.name, title, result),
      };
    },

    renderCall(_args, _theme) {
      return new Container(); // call 过程中不渲染，展示在 widget 中
    },

    renderResult(result, { expanded, isPartial }, theme, context) {
      if (isPartial) return new Container();
      const rawOutput = result.content
        .filter((part): part is TextContent => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      return renderAgentCard(rawOutput, result.details as Partial<AgentToolDetails> | undefined, expanded, context.isError, theme);
    },
  });

  pi.registerMessageRenderer<AgentToolDetails>(NOTIFICATION_CUSTOM_TYPE, (message, { expanded }, theme) => {
    const rawOutput =
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((part): part is TextContent => part.type === "text")
            .map((part) => part.text)
            .join("\n");
    const details = message.details;
    const isError = details?.stopReason === "error" || details?.stopReason === "timeout";
    return renderAgentCard(rawOutput, details, expanded, isError, theme);
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

    store = new SubagentStore(ctx.cwd, ctx.sessionManager);
    const currentManager = new SubagentManager(ctx.cwd, config.maxConcurrent, getModelRuntime(ctx), { store });
    manager = currentManager;
    currentManager.subscribe((event) => {
      if (event.type !== "background_settled") return;
      // 防止会话切换或重载后，旧 manager 的后台任务向新会话串台推送通知。
      if (manager !== currentManager || currentManager.isShuttingDown()) return;
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
    ctx.ui.setWidget(WIDGET_KEY, createSubagentWidget(currentManager), { placement: "aboveEditor" });
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
