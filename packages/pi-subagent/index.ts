import { getSupportedThinkingLevels, StringEnum, Type, type TextContent } from "@earendil-works/pi-ai";
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
  type Theme,
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

import { createUsageTotals, resolveModel, THINKING_LEVELS, type UsageTotals } from "../pi-common";
import { discoverAgents, type AgentDiagnostic, type AgentProfile } from "./agents";
import { inChildSessionContext } from "./child-context";
import { loadConfig, type SubagentConfig } from "./config";
import { formatDuration, formatToolCallSummary, formatUsage, shortenSessionId } from "./format";
import { openSubagentsInspector } from "./inspector";
import { logger } from "./logger";
import {
  SubagentManager,
  type AgentThreadSnapshot,
  type SpawnResult,
  type SpawnStopReason,
  type ToolTraceEntry,
} from "./manager";
import { registerModelsTool } from "./models-tool";
import { runProfileCommands } from "./profile-commands";
import { ProfileTrust } from "./profile-trust";
import { SubagentStore, type SubagentActivity } from "./store";
import { createSubagentWidget } from "./widget";
import {
  formatWorktreeSummary,
  validateGitRepoForWorktree,
  type IsolationMode,
  type SubagentWorktreeState,
  type WorktreeSummary,
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

interface AgentToolDetails {
  childSessionId: string;
  resumed?: boolean;
  background?: boolean;
  backgroundStatus?: "started" | "detached";
  name: string;
  title: string;
  model: string;
  turns: number;
  durationMs: number;
  usage: UsageTotals;
  stopReason: SpawnStopReason;
  persisted?: boolean;
  errorMessage?: string;
  toolTrace?: ToolTraceEntry[];
  toolTraceTotal?: number;
  worktree?: WorktreeSummary;
}

function formatSpawnResultText(result: SpawnResult): { text: string; isError: boolean } {
  const failed = result.stopReason === "error" || result.stopReason === "timeout";
  const worktreeBlock = result.worktree ? `\n\n${formatWorktreeSummary(result.worktree)}` : "";
  const resumeHint = result.persisted
    ? `\n\nChild session ID: ${result.childSessionId}\nThe partial progress was saved. You can pass this ID in \`resume\` to continue or retry from where it stopped.`
    : "";
  const partial = result.text === "(no output)" ? "" : `\n\n${result.text}`;
  if (failed) {
    const timeoutLabel =
      result.timeoutSeconds !== undefined
        ? formatDuration(result.timeoutSeconds * 1000)
        : formatDuration(result.durationMs);
    const headline =
      result.stopReason === "timeout"
        ? `Subagent timed out after ${timeoutLabel} (${result.turns} turns completed)`
        : `Subagent failed: ${result.errorMessage ?? "unknown error"}`;
    return { text: `${headline}${partial}${worktreeBlock}${resumeHint}`, isError: true };
  }
  if (result.stopReason === "max_turns") {
    const headline = `Subagent reached max turns (${result.turns} turns completed).`;
    return { text: `${headline}${partial}${worktreeBlock}${resumeHint}`, isError: false };
  }
  if (result.stopReason === "aborted") {
    const headline = `Subagent was aborted (${result.turns} turns completed).`;
    return { text: `${headline}${partial}${worktreeBlock}${resumeHint}`, isError: false };
  }
  const sessionIdBlock = result.persisted ? `\n\nChild session ID: ${result.childSessionId}` : "";
  return { text: `${result.text}${worktreeBlock}${sessionIdBlock}`, isError: false };
}

function formatBackgroundNotification(
  name: string,
  title: string,
  result: SpawnResult,
  triggerTurn = true,
): string {
  const status = result.stopReason === "stop" ? "completed" : result.stopReason;
  const header =
    !triggerTurn && result.stopReason === "aborted"
      ? `Background subagent "${name}" (${title}) was cancelled by user.`
      : `Background subagent "${name}" (${title}) finished with status: ${status}.`;
  const { text } = formatSpawnResultText(result);
  return `${header}\n\n${text}`;
}

function buildResultDetails(name: string, title: string, result: SpawnResult): AgentToolDetails {
  return {
    childSessionId: result.childSessionId,
    resumed: result.resumed || undefined,
    background: result.background || undefined,
    name,
    title,
    model: result.model,
    turns: result.turns,
    durationMs: result.durationMs,
    usage: result.usage,
    stopReason: result.stopReason,
    persisted: result.persisted,
    errorMessage: result.errorMessage,
    toolTrace: result.toolTrace,
    toolTraceTotal: result.toolTraceTotal,
    worktree: result.worktree,
  };
}

function formatActivitySummary(activity?: SubagentActivity): string | undefined {
  if (!activity) return undefined;
  if (activity.type === "toolCall") {
    return formatToolCallSummary(activity.name, activity.args, 80);
  }
  const firstLine = activity.text.split("\n").find((line) => line.trim())?.trim() ?? "";
  if (!firstLine) return undefined;
  return firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine;
}

function formatActiveSnapshot(snapshot: AgentThreadSnapshot, recentTools: ToolTraceEntry[]): string {
  const elapsed = formatDuration(Date.now() - (snapshot.runningSince ?? snapshot.startedAt));
  const lines = [
    `Subagent ${snapshot.name} [${snapshot.childSessionId}] (${snapshot.title})`,
    `Status: ${snapshot.phase}${snapshot.background ? " (background)" : ""}`,
    `Elapsed: ${elapsed} · Turns: ${snapshot.turns}${snapshot.model ? ` · Model: ${snapshot.model}` : ""}`,
  ];
  if (snapshot.worktreeBranch) lines.push(`Worktree branch: ${snapshot.worktreeBranch}`);
  const activity = formatActivitySummary(snapshot.lastActivity);
  if (activity) lines.push(`Last activity: ${activity}`);
  if (recentTools.length > 0) {
    lines.push("Recent tool calls:");
    for (const tool of recentTools) {
      lines.push(`- ${tool.isError ? "✗" : "✓"} ${tool.summary}`);
    }
  }
  return lines.join("\n");
}

function renderAgentCard(
  rawOutput: string,
  details: Partial<AgentToolDetails> | undefined,
  expanded: boolean,
  isErrorFlag: boolean,
  theme: Theme,
): Box {
  const COLLAPSED_LINE_COUNT = 5;

  const isError =
    isErrorFlag ||
    details?.stopReason === "error" ||
    details?.stopReason === "aborted" ||
    details?.stopReason === "max_turns" ||
    details?.stopReason === "timeout";

  const box = new Box(1, 1, (text) => theme.bg(isError ? "toolErrorBg" : "toolSuccessBg", text));
  const content = new Container();

  const name = details?.name ? theme.fg("accent", details.name) : "";
  const idBadge = details?.childSessionId
    ? ` ${theme.fg("dim", `[${shortenSessionId(details.childSessionId)}]`)}`
    : "";
  const bgBadge = details?.background ? ` ${theme.fg("accent", "[bg]")}` : "";
  const wtBadge = details?.worktree?.branch ? ` ${theme.fg("muted", "[wt]")}` : "";
  const resumedBadge = details?.resumed ? ` ${theme.fg("muted", "(resumed)")}` : "";
  const title = details?.title ? ` — ${theme.fg("muted", details.title)}` : "";

  if (details?.backgroundStatus === "started" || details?.backgroundStatus === "detached") {
    const statusLabel = details.backgroundStatus === "started" ? "started in background" : "moved to background";
    content.addChild(
      new Text(
        `${theme.fg("toolTitle", theme.bold("agent"))} ${name}${idBadge}${bgBadge}${wtBadge}${resumedBadge}${title} ${theme.fg("dim", `· ${statusLabel}`)}`,
        0,
        0,
      ),
    );
    box.addChild(content);
    return box;
  }

  content.addChild(
    new Text(`${theme.fg("toolTitle", theme.bold("agent"))} ${name}${idBadge}${bgBadge}${wtBadge}${resumedBadge}${title}`, 0, 0),
  );

  // 展示层去掉末尾给 LLM 用的 Child session ID 提示行，避免与标题/底部重复
  const output = details?.childSessionId
    ? rawOutput.replace(
        new RegExp(`\\n\\nChild session ID: ${details.childSessionId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*$`),
        "",
      )
    : rawOutput;

  if (expanded) {
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
    content.addChild(new Text(theme.fg("dim", parts.join(" · ")), 0, 0));
    if (details.stopReason === "timeout") content.addChild(new Text(theme.fg("warning", "⏱ timed out"), 0, 0));
  }

  box.addChild(content);
  return box;
}

export default function (pi: ExtensionAPI) {
  if (inChildSessionContext()) return;

  let config = loadConfig();
  let agents: AgentProfile[] = [];
  let store: SubagentStore | undefined;
  let manager: SubagentManager | undefined;
  const profileTrust = new ProfileTrust();

  registerModelsTool(pi);

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
        StringEnum(["none", "worktree"] as const, {
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
        return {
          content: [
            {
              type: "text",
              text: [
                `Subagent "${activeProfile.name}" (${title}) started in background (status: ${phase}).`,
                `Child session ID: ${childSessionId}`,
                "You will be notified automatically when it finishes. Do not poll; use `agent_output`, `agent_cancel`, or `agent_steer` only if you need to wait, cancel, or redirect it.",
              ].join("\n"),
            },
          ],
          details: {
            childSessionId,
            resumed: resumed || undefined,
            background: true,
            backgroundStatus: "started",
            name: activeProfile.name,
            title,
            model: `${resolved.model.provider}/${resolved.model.id}`,
            turns: 0,
            durationMs: 0,
            usage: createUsageTotals(),
            stopReason: "stop",
          },
        };
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
        return {
          content: [
            {
              type: "text",
              text: [
                `Subagent "${activeProfile.name}" (${title}) was moved to background.`,
                `Child session ID: ${childSessionId}`,
                "You will be notified automatically when it finishes. Do not poll; use `agent_output`, `agent_cancel`, or `agent_steer` only if you need to wait, cancel, or redirect it.",
              ].join("\n"),
            },
          ],
          details: {
            childSessionId,
            resumed: resumed || undefined,
            background: true,
            backgroundStatus: "detached",
            name: activeProfile.name,
            title,
            model: `${resolved.model.provider}/${resolved.model.id}`,
            turns: 0,
            durationMs: 0,
            usage: createUsageTotals(),
            stopReason: "stop",
          },
        };
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

  pi.registerTool({
    name: "agent_list",
    label: "List Subagents",
    exposure: "model-only",
    description:
      "List subagents in the current session with their status, turns, duration, model, and last activity. Do not poll in a loop; background subagents notify you automatically on completion.",
    promptSnippet: "List subagents and their statuses in the current session",
    parameters: Type.Object({
      activeOnly: Type.Optional(
        Type.Boolean({
          default: false,
          description: "If true, return only pending or running subagents.",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      if (!manager || !store) {
        throw new Error("Agent manager not initialized");
      }
      const records = store
        .list()
        .filter((record) => !params.activeOnly || record.status === "pending" || record.status === "running");

      if (records.length === 0) {
        return {
          content: [{ type: "text", text: params.activeOnly ? "No active subagents." : "No subagents in this session." }],
          details: {},
        };
      }

      const lines = records.map((record) => {
        const snapshot = manager!.getSnapshot(record.childSessionId);
        const status = snapshot ? snapshot.phase : record.status;
        const background = snapshot?.background ?? record.background ?? false;
        const turns = snapshot ? record.totalTurns + snapshot.turns : record.totalTurns;
        const durationMs = snapshot
          ? record.totalDurationMs + (Date.now() - (snapshot.runningSince ?? snapshot.startedAt))
          : record.totalDurationMs;
        const model = snapshot?.model || record.model || "-";
        const activity = formatActivitySummary(snapshot?.lastActivity ?? record.lastActivity);
        const worktreeBranch = snapshot?.worktreeBranch ?? record.worktree?.branch;
        const parts = [
          `- ${record.childSessionId}`,
          `name=${record.name}`,
          `title=${JSON.stringify(record.title)}`,
          `status=${status}`,
          `background=${background}`,
          `turns=${turns}`,
          `duration=${formatDuration(durationMs)}`,
          `model=${model}`,
        ];
        if (worktreeBranch) parts.push(`worktreeBranch=${worktreeBranch}`);
        if (activity) parts.push(`lastActivity=${JSON.stringify(activity)}`);
        return parts.join(" | ");
      });

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "agent_output",
    label: "Subagent Output",
    exposure: "model-only",
    description:
      "Read a subagent's current status or finished result, or explicitly wait (`block: true`) for a running background subagent to finish. Do not poll in a loop; background subagents notify you automatically.",
    promptSnippet: "Inspect a subagent's status/result or wait for it to finish",
    parameters: Type.Object({
      childSessionId: Type.String({ minLength: 1, description: "Full child session ID." }),
      block: Type.Optional(
        Type.Boolean({
          default: false,
          description: "If true and the subagent is still active, wait until it finishes (or waitSeconds elapses).",
        }),
      ),
      waitSeconds: Type.Optional(
        Type.Integer({
          minimum: 1,
          description:
            "Maximum seconds to wait when `block: true`. Timing out only stops waiting and does NOT abort the subagent.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      if (!manager || !store) {
        throw new Error("Agent manager not initialized");
      }
      const id = params.childSessionId.trim();
      const block = Boolean(params.block);

      if (manager.isChildActive(id)) {
        if (!block) {
          const snapshot = manager.getSnapshot(id)!;
          const recentTools = manager.getRecentToolTrace(id, 5);
          return {
            content: [{ type: "text", text: formatActiveSnapshot(snapshot, recentTools) }],
            details: {},
          };
        }

        const waited = await manager.wait(id, {
          waitSeconds: params.waitSeconds,
          signal,
          consume: true,
        });
        if (!waited) {
          throw new Error(`Unknown subagent session "${id}"`);
        }
        if (waited.done) {
          const { text, isError } = formatSpawnResultText(waited.result);
          const meta = `Turns: ${waited.result.turns} · Duration: ${formatDuration(waited.result.durationMs)}${waited.result.model ? ` · Model: ${waited.result.model}` : ""}`;
          return {
            content: [{ type: "text", text: `${text}\n\n${meta}` }],
            isError: isError ? true : undefined,
            details: {},
          };
        }

        const snapshot = waited.snapshot ?? manager.getSnapshot(id);
        const reasonText =
          waited.reason === "timeout"
            ? `Wait timed out after ${params.waitSeconds}s; the subagent is still running in the background and will notify you when it finishes.`
            : "Wait cancelled; the subagent is still running in the background and will notify you when it finishes.";
        const body = snapshot ? `${reasonText}\n\n${formatActiveSnapshot(snapshot, manager.getRecentToolTrace(id, 5))}` : reasonText;
        return {
          content: [{ type: "text", text: body }],
          details: {},
        };
      }

      const lastResult = manager.getLastResult(id, { consume: true });
      if (lastResult) {
        const { text, isError } = formatSpawnResultText(lastResult);
        const usage = formatUsage(lastResult.usage);
        const meta = [
          `Status: ${lastResult.stopReason === "stop" ? "completed" : lastResult.stopReason}`,
          `Turns: ${lastResult.turns}`,
          `Duration: ${formatDuration(lastResult.durationMs)}`,
          lastResult.model ? `Model: ${lastResult.model}` : "",
          usage ? `Usage: ${usage}` : "",
        ]
          .filter(Boolean)
          .join(" · ");
        return {
          content: [{ type: "text", text: `${text}\n\n${meta}` }],
          isError: isError ? true : undefined,
          details: {},
        };
      }

      const record = store.get(id);
      if (!record) {
        throw new Error(`Unknown subagent session "${id}"`);
      }

      const entries = store.loadTranscript(id);
      let lastText = "";
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i]!;
        if (entry.type === "message" && entry.message.role === "assistant") {
          lastText = entry.message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n")
            .trim();
          break;
        }
      }

      const lines = [
        `Subagent ${record.name} [${record.childSessionId}] (${record.title})`,
        `Status: ${record.status} · Turns: ${record.totalTurns} · Duration: ${formatDuration(record.totalDurationMs)}${record.model ? ` · Model: ${record.model}` : ""}`,
      ];
      if (record.worktree) lines.push(`Worktree: ${record.worktree.branch} (${record.worktree.rootPath})`);
      if (record.lastError) lines.push(`Error: ${record.lastError}`);
      if (lastText) lines.push("", lastText);
      if (record.persisted) lines.push("", `Child session ID: ${record.childSessionId}`);
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "agent_cancel",
    label: "Cancel Subagent",
    exposure: "model-only",
    description: "Cancel a single pending or running subagent without affecting other subagents.",
    promptSnippet: "Cancel a single pending or running subagent",
    parameters: Type.Object({
      childSessionId: Type.String({ minLength: 1, description: "Full child session ID to cancel." }),
    }),
    async execute(_toolCallId, params) {
      if (!manager || !store) {
        throw new Error("Agent manager not initialized");
      }
      const id = params.childSessionId.trim();
      const wasActive = manager.isChildActive(id);
      const recordBefore = store.get(id);
      if (!wasActive && !recordBefore && !manager.getLastResult(id)) {
        throw new Error(`Unknown subagent session "${id}"`);
      }

      if (!wasActive) {
        const status = recordBefore?.status ?? "completed";
        return {
          content: [{ type: "text", text: `Subagent "${id}" has already finished (status: ${status}).` }],
          details: {},
        };
      }

      const result = await manager.cancel(id);
      if (!result) {
        return {
          content: [{ type: "text", text: `Subagent "${id}" cancelled.` }],
          details: {},
        };
      }
      const usage = formatUsage(result.usage);
      const lines = [
        `Subagent cancelled (status: ${result.stopReason === "stop" ? "completed" : result.stopReason}).`,
        `Turns: ${result.turns} · Duration: ${formatDuration(result.durationMs)}${usage ? ` · Usage: ${usage}` : ""}`,
      ];
      if (result.worktree) {
        lines.push("", formatWorktreeSummary(result.worktree));
      }
      if (result.persisted) {
        lines.push(`Child session ID: ${result.childSessionId}`);
        lines.push("Partial progress was saved and can be continued with `resume`.");
      }
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "agent_steer",
    label: "Steer Subagent",
    exposure: "model-only",
    description:
      "Send a mid-run steering instruction to a pending or running subagent without cancelling it. If the subagent already finished, use `agent({ resume, task })` instead.",
    promptSnippet: "Send a steering instruction to an active subagent",
    parameters: Type.Object({
      childSessionId: Type.String({ minLength: 1, description: "Full child session ID." }),
      message: Type.String({ minLength: 1, description: "Non-empty steering instruction for the subagent." }),
    }),
    async execute(_toolCallId, params) {
      if (!manager || !store) {
        throw new Error("Agent manager not initialized");
      }
      const id = params.childSessionId.trim();
      const message = params.message.trim();
      if (!message) {
        throw new Error("Parameter `message` must not be empty");
      }

      const outcome = await manager.steer(id, message);
      if (outcome.ok) {
        const note = outcome.queued
          ? `Steering message queued for subagent "${id}" and will be delivered once its session starts.`
          : `Steering message sent to running subagent "${id}".`;
        return {
          content: [{ type: "text", text: note }],
          details: {},
        };
      }

      if (outcome.reason === "not_active") {
        throw new Error(
          `Subagent "${id}" has already finished (status: ${outcome.status ?? "unknown"}). Use \`agent({ resume: "${id}", task: ... })\` to continue it.`,
        );
      }
      throw new Error(`Unknown subagent session "${id}"`);
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
