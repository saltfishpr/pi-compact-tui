import type { Theme } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";

import type { UsageTotals } from "../pi-common";

export function formatTokens(count: number): string {
  if (!count) return "0";
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsage(usage: UsageTotals): string {
  const parts: string[] = [];
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  return parts.join(" ");
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds ? `${minutes}m${seconds.toString().padStart(2, "0")}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return `${hours}h${remMinutes.toString().padStart(2, "0")}m`;
}

export function shortenSessionId(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 4)}…${id.slice(-6)}`;
}

function shortenPath(filePath: string): string {
  const home = homedir();
  return filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return maxLength <= 1 ? "…" : `${text.slice(0, maxLength - 1)}…`;
}

export function formatToolCallSummary(name: string, args: Record<string, unknown>, maxLength = 100): string {
  let raw: string;
  switch (name) {
    case "bash": {
      const command = typeof args.command === "string" ? collapseWhitespace(args.command) : "...";
      raw = `$ ${command}`;
      break;
    }
    case "read":
    case "edit": {
      const filePath = (args.file_path || args.path || "...") as string;
      raw = `${name} ${shortenPath(String(filePath))}`;
      break;
    }
    case "write": {
      const filePath = (args.file_path || args.path || "...") as string;
      const content = typeof args.content === "string" ? args.content : "";
      const lines = content ? content.split("\n").length : 0;
      raw = `${name} ${shortenPath(String(filePath))}${lines > 1 ? ` (${lines} lines)` : ""}`;
      break;
    }
    default: {
      let serialized: string;
      try {
        serialized = JSON.stringify(args ?? {});
      } catch {
        serialized = "{}";
      }
      raw = `${name} ${collapseWhitespace(serialized)}`;
      break;
    }
  }
  return truncateText(raw, maxLength);
}

export function formatToolCall(theme: Theme, name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "bash": {
      const command = typeof args.command === "string" ? collapseWhitespace(args.command) : "...";
      const preview = truncateText(command, 60);
      return theme.fg("accent", "$ ") + theme.fg("toolOutput", preview);
    }
    case "read":
    case "edit": {
      const filePath = (args.file_path || args.path || "...") as string;
      return theme.fg("accent", `${name} `) + theme.fg("muted", shortenPath(String(filePath)));
    }
    case "write": {
      const filePath = (args.file_path || args.path || "...") as string;
      const content = typeof args.content === "string" ? args.content : "";
      const lines = content ? content.split("\n").length : 0;
      let text = theme.fg("accent", `${name} `) + theme.fg("muted", shortenPath(String(filePath)));
      if (lines > 1) text += theme.fg("muted", ` (${lines} lines)`);
      return text;
    }
    default: {
      let serialized: string;
      try {
        serialized = JSON.stringify(args ?? {});
      } catch {
        serialized = "{}";
      }
      const preview = truncateText(collapseWhitespace(serialized), 50);
      return theme.fg("accent", name) + theme.fg("muted", ` ${preview}`);
    }
  }
}
