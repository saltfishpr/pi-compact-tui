import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { extractTextContent, formatDuration, formatToolCallSummary, formatUsage } from "../format";
import type { SubagentService } from "../runtime/service";
import { stopReasonToStatus, type AgentThreadSnapshot, type SubagentActivity, type ToolTraceEntry } from "../types";
import { formatSpawnResultText, formatWorktreeSummary } from "./result";

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

export function registerControlTools(pi: ExtensionAPI, getService: () => SubagentService | undefined): void {
  const requireService = (): SubagentService => {
    const service = getService();
    if (!service) {
      throw new Error("Agent manager not initialized");
    }
    return service;
  };

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
      const service = requireService();
      const views = service.listViews({ activeOnly: Boolean(params.activeOnly) });

      if (views.length === 0) {
        return {
          content: [{ type: "text", text: params.activeOnly ? "No active subagents." : "No subagents in this session." }],
          details: {},
        };
      }

      const lines = views.map((view) => {
        const activity = formatActivitySummary(view.lastActivity);
        const parts = [
          `- ${view.childSessionId}`,
          `name=${view.name}`,
          `title=${JSON.stringify(view.title)}`,
          `status=${view.status}`,
          `background=${view.background}`,
          `turns=${view.turns}`,
          `duration=${formatDuration(view.durationMs)}`,
          `model=${view.model || "-"}`,
        ];
        if (view.worktreeBranch) parts.push(`worktreeBranch=${view.worktreeBranch}`);
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
      const service = requireService();
      const id = params.childSessionId.trim();
      const block = Boolean(params.block);

      if (service.isActive(id)) {
        if (!block) {
          const snapshot = service.getSnapshot(id)!;
          const recentTools = service.getRecentToolTrace(id, 5);
          return {
            content: [{ type: "text", text: formatActiveSnapshot(snapshot, recentTools) }],
            details: {},
          };
        }

        const waited = await service.wait(id, {
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

        const snapshot = waited.snapshot ?? service.getSnapshot(id);
        const reasonText =
          waited.reason === "timeout"
            ? `Wait timed out after ${params.waitSeconds}s; the subagent is still running in the background and will notify you when it finishes.`
            : "Wait cancelled; the subagent is still running in the background and will notify you when it finishes.";
        const body = snapshot
          ? `${reasonText}\n\n${formatActiveSnapshot(snapshot, service.getRecentToolTrace(id, 5))}`
          : reasonText;
        return {
          content: [{ type: "text", text: body }],
          details: {},
        };
      }

      const lastResult = service.getLastResult(id, { consume: true });
      if (lastResult) {
        const { text, isError } = formatSpawnResultText(lastResult);
        const usage = formatUsage(lastResult.usage);
        const meta = [
          `Status: ${stopReasonToStatus(lastResult.stopReason)}`,
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

      const view = service.getView(id);
      if (!view) {
        throw new Error(`Unknown subagent session "${id}"`);
      }

      const entries = service.loadTranscript(id);
      let lastText = "";
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i]!;
        if (entry.type === "message" && entry.message.role === "assistant") {
          lastText = extractTextContent(entry.message.content).trim();
          break;
        }
      }

      const lines = [
        `Subagent ${view.name} [${view.childSessionId}] (${view.title})`,
        `Status: ${view.status} · Turns: ${view.turns} · Duration: ${formatDuration(view.durationMs)}${view.model ? ` · Model: ${view.model}` : ""}`,
      ];
      if (view.worktree) lines.push(`Worktree: ${view.worktree.branch} (${view.worktree.rootPath})`);
      if (view.lastError) lines.push(`Error: ${view.lastError}`);
      if (lastText) lines.push("", lastText);
      if (view.persisted) lines.push("", `Child session ID: ${view.childSessionId}`);
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
      const service = requireService();
      const id = params.childSessionId.trim();
      const wasActive = service.isActive(id);
      const viewBefore = service.getView(id);
      if (!wasActive && !viewBefore && !service.getLastResult(id)) {
        throw new Error(`Unknown subagent session "${id}"`);
      }

      if (!wasActive) {
        const status = viewBefore?.status ?? "completed";
        return {
          content: [{ type: "text", text: `Subagent "${id}" has already finished (status: ${status}).` }],
          details: {},
        };
      }

      const result = await service.cancel(id);
      if (!result) {
        return {
          content: [{ type: "text", text: `Subagent "${id}" cancelled.` }],
          details: {},
        };
      }
      const usage = formatUsage(result.usage);
      const lines = [
        `Subagent cancelled (status: ${stopReasonToStatus(result.stopReason)}).`,
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
      const service = requireService();
      const id = params.childSessionId.trim();
      const message = params.message.trim();
      if (!message) {
        throw new Error("Parameter `message` must not be empty");
      }

      const outcome = await service.steer(id, message);
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
}
