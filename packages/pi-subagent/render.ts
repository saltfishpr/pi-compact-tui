import { homedir } from "node:os";

import { Message } from "@earendil-works/pi-ai";
import {
  getMarkdownTheme,
  keyHint,
  type ExtensionContext,
  type Theme,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Markdown, Spacer, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";

import type { RunningSubagent, SubagentResult, UsageStats } from "./runner";

const COLLAPSED_LINE_COUNT = 3;
const SUBAGENT_WIDGET_ID = "subagent-runs";

interface RenderableToolResult {
  content: Array<{ type: string; text?: string }>;
  details?: unknown;
}

interface AgentRenderContext {
  args: { name?: string };
  isError: boolean;
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, unknown> };

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(usage: UsageStats, model?: string): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (model) parts.push(model);
  return parts.join(" ");
}

function shortenPath(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function formatToolCall(name: string, args: Record<string, unknown>, theme: Theme): string {
  switch (name) {
    case "bash": {
      const command = (args.command as string) || "...";
      const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
      return theme.fg("accent", "$ ") + theme.fg("toolOutput", preview);
    }
    case "read":
    case "edit": {
      const path = (args.file_path || args.path || "...") as string;
      return theme.fg("accent", `${name} `) + theme.fg("muted", shortenPath(path));
    }
    case "write": {
      const path = (args.file_path || args.path || "...") as string;
      const content = (args.content || "") as string;
      const lines = content.split("\n").length;
      let text = theme.fg("accent", "write ") + theme.fg("muted", shortenPath(path));
      if (lines > 1) text += theme.fg("dim", ` (${lines} lines)`);
      return text;
    }
    case "grep": {
      const pattern = (args.pattern || "") as string;
      const path = (args.path || ".") as string;
      return theme.fg("accent", `grep /${pattern}/`) + theme.fg("dim", ` in ${shortenPath(path)}`);
    }
    case "find": {
      const pattern = (args.pattern || "*") as string;
      const path = (args.path || ".") as string;
      return theme.fg("accent", `find ${pattern}`) + theme.fg("dim", ` in ${shortenPath(path)}`);
    }
    case "ls": {
      const path = (args.path || ".") as string;
      return theme.fg("accent", "ls ") + theme.fg("muted", shortenPath(path));
    }
    default: {
      const serialized = JSON.stringify(args);
      const preview = serialized.length > 50 ? `${serialized.slice(0, 50)}...` : serialized;
      return theme.fg("accent", name) + theme.fg("muted", ` ${preview}`);
    }
  }
}

function getLastDisplayItem(messages: readonly Message[]): DisplayItem | undefined {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
    const message = messages[messageIndex];
    if (message.role !== "assistant") continue;

    for (let partIndex = message.content.length - 1; partIndex >= 0; partIndex--) {
      const part = message.content[partIndex];
      if (part.type === "text") return { type: "text", text: part.text };
      if (part.type === "toolCall") return { type: "toolCall", name: part.name, args: part.arguments };
    }
  }
  return undefined;
}

function formatDisplayItem(item: DisplayItem, theme: Theme): string {
  switch (item.type) {
    case "text":
      return theme.fg("muted", "← ") + theme.fg("toolOutput", item.text.replace(/\s+/g, " ").trim());
    case "toolCall":
      return theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme);
  }
}

export function updateSubagentWidget(ctx: ExtensionContext, running: ReadonlyMap<string, RunningSubagent>): void {
  if (ctx.mode !== "tui") return;
  if (running.size === 0) {
    ctx.ui.setWidget(SUBAGENT_WIDGET_ID, undefined);
    return;
  }

  // Copy messages to avoid mutation
  const items = [...running.values()].map((item) => ({ ...item, messages: [...item.messages] }));
  ctx.ui.setWidget(SUBAGENT_WIDGET_ID, (_tui, theme) => ({
    render(width: number): string[] {
      const lines = [theme.fg("accent", theme.bold(`Subagents (${items.length} running)`))];
      for (const item of items) {
        const task = item.task.replace(/\s+/g, " ").trim();
        lines.push(theme.fg("accent", `● #${item.number} `) + theme.bold(item.agent) + theme.fg("dim", ` — ${task}`));
        const lastItem = getLastDisplayItem(item.messages);
        lines.push(`  ${lastItem ? formatDisplayItem(lastItem, theme) : theme.fg("muted", "Running...")}`);
      }
      lines.push("");
      return lines.map((line) => truncateToWidth(line, width));
    },
    invalidate() {},
  }));
}

export function renderSubagentCall(): Component {
  return new Container();
}

export function renderSubagentResult(
  result: RenderableToolResult,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: AgentRenderContext,
): Component {
  if (options.isPartial) return new Container();

  const details = result.details as SubagentResult | undefined;
  const fallbackText = result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n")
    .trim();
  const isError = details?.isError ?? context.isError;
  const output = details?.finalOutput.trim() || (!isError ? fallbackText : "");
  const errorMessage = details?.errorMessage || (isError ? fallbackText || "Subagent failed" : "");
  const usage = details?.usage ? formatUsageStats(details.usage, details.model) : "";

  const agentName = details?.agent ?? context.args.name ?? "...";
  const agentNumber = details?.number ? `#${details.number} ` : "";
  const content = new Container();
  content.addChild(
    new Text(`${theme.fg("toolTitle", theme.bold(`agent ${agentNumber}`))}${theme.fg("accent", agentName)}`, 0, 0),
  );
  if (errorMessage) {
    const reason = details?.stopReason ? `[${details.stopReason}] ` : "";
    content.addChild(new Text(theme.fg("error", `${reason}Error: ${errorMessage}`), 0, 0));
  } else if (details?.stopReason === "max_turns") {
    content.addChild(
      new Text(theme.fg("warning", `[max_turns] Stopped after ${details.usage?.turns ?? "?"} turns`), 0, 0),
    );
  }

  if (output) {
    if (errorMessage) content.addChild(new Spacer(1));
    if (options.expanded) {
      content.addChild(new Markdown(output, 0, 0, getMarkdownTheme()));
    } else {
      const outputLines = output.split("\n");
      content.addChild(new Text(theme.fg("toolOutput", outputLines.slice(0, COLLAPSED_LINE_COUNT).join("\n")), 0, 0));
      if (outputLines.length > COLLAPSED_LINE_COUNT) {
        content.addChild(new Text(theme.fg("dim", `(${keyHint("app.tools.expand", "to expand")})`), 0, 0));
      }
    }
  } else if (!errorMessage) {
    content.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
  }

  if (usage) {
    content.addChild(new Spacer(1));
    content.addChild(new Text(theme.fg("dim", usage), 0, 0));
  }

  const box = new Box(1, 1, (text) => theme.bg(isError ? "toolErrorBg" : "toolSuccessBg", text));
  box.addChild(content);
  return box;
}
