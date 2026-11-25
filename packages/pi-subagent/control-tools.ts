import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { formatDuration, formatUsage } from "./format";
import type { SubagentManager } from "./manager";
import { formatActiveSnapshot, formatActivitySummary, formatSpawnResultText } from "./result-view";
import { stopReasonToStatus, type SubagentStore } from "./store";
import { formatWorktreeSummary } from "./worktree";

export interface ControlToolsDeps {
  getManager: () => SubagentManager | undefined;
  getStore: () => SubagentStore | undefined;
}

export function registerControlTools(pi: ExtensionAPI, deps: ControlToolsDeps): void {
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
      const manager = deps.getManager();
      const store = deps.getStore();
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
        const snapshot = manager.getSnapshot(record.childSessionId);
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
      const manager = deps.getManager();
      const store = deps.getStore();
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
      const manager = deps.getManager();
      const store = deps.getStore();
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
      const manager = deps.getManager();
      const store = deps.getStore();
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
}
