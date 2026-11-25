import {
  getMarkdownTheme,
  keyHint,
  type AgentToolResult,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";

import { createUsageTotals, type UsageTotals } from "../pi-common";
import { formatDuration, formatToolCallSummary, formatUsage, shortenSessionId } from "./format";
import type { AgentThreadSnapshot, SpawnResult, ToolTraceEntry } from "./manager";
import { stopReasonToStatus, type SpawnStopReason, type SubagentActivity } from "./store";
import { formatWorktreeSummary, type WorktreeSummary } from "./worktree";

export interface AgentToolDetails {
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

export function buildBackgroundToolResult(params: {
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

export function formatSpawnResultText(result: SpawnResult): { text: string; isError: boolean } {
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

export function formatBackgroundNotification(
  name: string,
  title: string,
  result: SpawnResult,
  triggerTurn = true,
): string {
  const status = stopReasonToStatus(result.stopReason);
  const header =
    !triggerTurn && result.stopReason === "aborted"
      ? `Background subagent "${name}" (${title}) was cancelled by user.`
      : `Background subagent "${name}" (${title}) finished with status: ${status}.`;
  const { text } = formatSpawnResultText(result);
  return `${header}\n\n${text}`;
}

export function buildResultDetails(name: string, title: string, result: SpawnResult): AgentToolDetails {
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

export function formatActivitySummary(activity?: SubagentActivity): string | undefined {
  if (!activity) return undefined;
  if (activity.type === "toolCall") {
    return formatToolCallSummary(activity.name, activity.args, 80);
  }
  const firstLine = activity.text.split("\n").find((line) => line.trim())?.trim() ?? "";
  if (!firstLine) return undefined;
  return firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine;
}

export function formatActiveSnapshot(snapshot: AgentThreadSnapshot, recentTools: ToolTraceEntry[]): string {
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

export function renderAgentCard(
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
