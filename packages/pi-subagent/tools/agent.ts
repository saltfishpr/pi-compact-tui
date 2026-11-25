import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";

import { createUsageTotals, THINKING_LEVELS } from "../../pi-common";
import { extractTextContent } from "../format";
import type { SubagentService } from "../runtime/service";
import { ISOLATION_MODES, type AgentToolDetails } from "../types";
import { renderAgentCard } from "../ui/card";
import { buildResultDetails, formatSpawnResultText } from "./result";

function buildBackgroundToolResult(params: {
  childSessionId: string;
  resumed: boolean;
  backgroundStatus: "started" | "detached";
  headline: string;
  name: string;
  title: string;
  model: string;
}): AgentToolResult<AgentToolDetails> {
  return {
    content: [
      {
        type: "text",
        text: [
          params.headline,
          `Child session ID: ${params.childSessionId}`,
          "You will be notified automatically when it finishes. Do not poll; use `agent_output`, `agent_cancel`, or `agent_steer` only if you need to wait, cancel, or redirect it.",
        ].join("\n"),
      },
    ],
    details: {
      childSessionId: params.childSessionId,
      resumed: params.resumed || undefined,
      background: true,
      backgroundStatus: params.backgroundStatus,
      name: params.name,
      title: params.title,
      model: params.model,
      turns: 0,
      durationMs: 0,
      usage: createUsageTotals(),
      stopReason: "stop",
    },
  };
}

export function registerAgentTool(pi: ExtensionAPI, getService: () => SubagentService | undefined): void {
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
      const service = getService();
      if (!service) {
        throw new Error("Agent manager not initialized");
      }

      const outcome = await service.delegate({ toolCallId, ...params }, ctx, signal);
      if (outcome.kind === "background") {
        const headline =
          outcome.backgroundStatus === "started"
            ? `Subagent "${outcome.name}" (${outcome.title}) started in background (status: ${outcome.phase}).`
            : `Subagent "${outcome.name}" (${outcome.title}) was moved to background.`;
        return buildBackgroundToolResult({
          childSessionId: outcome.childSessionId,
          resumed: outcome.resumed,
          backgroundStatus: outcome.backgroundStatus,
          headline,
          name: outcome.name,
          title: outcome.title,
          model: outcome.model,
        });
      }

      const { text, isError } = formatSpawnResultText(outcome.result);
      return {
        content: [{ type: "text", text }],
        isError: isError ? true : undefined,
        details: buildResultDetails(outcome.name, outcome.title, outcome.result),
      };
    },

    renderCall(_args, _theme) {
      return new Container(); // call 过程中不渲染，展示在 widget 中
    },

    renderResult(result, { expanded, isPartial }, theme, context) {
      if (isPartial) return new Container();
      const rawOutput = extractTextContent(result.content);
      return renderAgentCard(
        rawOutput,
        result.details as Partial<AgentToolDetails> | undefined,
        expanded,
        context.isError,
        theme,
      );
    },
  });
}
