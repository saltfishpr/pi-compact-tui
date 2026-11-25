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

export function shortenPath(filePath: string): string {
  const home = homedir();
  return filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath;
}

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return maxLength <= 1 ? "…" : `${text.slice(0, maxLength - 1)}…`;
}

export function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } =>
      Boolean(
        part &&
        typeof part === "object" &&
        "type" in part &&
        part.type === "text" &&
        typeof (part as { text?: unknown }).text === "string",
      ),
    )
    .map((part) => part.text)
    .join("\n");
}

export type DescribedToolCall =
  | { kind: "bash"; command: string }
  | { kind: "file"; name: "read" | "edit" | "write"; path: string; lineCount?: number }
  | { kind: "other"; name: string; argsText: string };

export function describeToolCall(name: string, args: Record<string, unknown>): DescribedToolCall {
  switch (name) {
    case "bash": {
      const command = typeof args.command === "string" ? collapseWhitespace(args.command) : "...";
      return { kind: "bash", command };
    }
    case "read":
    case "edit": {
      const filePath = (args.file_path || args.path || "...") as string;
      return { kind: "file", name, path: shortenPath(String(filePath)) };
    }
    case "write": {
      const filePath = (args.file_path || args.path || "...") as string;
      const content = typeof args.content === "string" ? args.content : "";
      const lineCount = content ? content.split("\n").length : 0;
      return { kind: "file", name: "write", path: shortenPath(String(filePath)), lineCount };
    }
    default: {
      let serialized: string;
      try {
        serialized = JSON.stringify(args ?? {});
      } catch {
        serialized = "{}";
      }
      return { kind: "other", name, argsText: collapseWhitespace(serialized) };
    }
  }
}

export function formatToolCallSummary(name: string, args: Record<string, unknown>, maxLength = 100): string {
  const described = describeToolCall(name, args);
  let raw: string;
  switch (described.kind) {
    case "bash":
      raw = `$ ${described.command}`;
      break;
    case "file":
      raw = `${described.name} ${described.path}${described.lineCount && described.lineCount > 1 ? ` (${described.lineCount} lines)` : ""}`;
      break;
    case "other":
      raw = `${described.name} ${described.argsText}`;
      break;
  }
  return truncateText(raw, maxLength);
}
