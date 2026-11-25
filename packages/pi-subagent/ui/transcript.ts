import type { SessionEntry, Theme } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";

import { extractTextContent } from "../format";
import { formatToolCall } from "./shared";

const COLLAPSED_TOOL_RESULT_LINES = 6;

function wrapBlock(text: string, width: number, indent = "  "): string[] {
  const effectiveWidth = Math.max(10, width - indent.length);
  const out: string[] = [];
  for (const rawLine of text.split("\n")) {
    const wrapped = wrapTextWithAnsi(rawLine, effectiveWidth);
    if (wrapped.length === 0) {
      out.push(indent);
    } else {
      for (const line of wrapped) out.push(`${indent}${line}`);
    }
  }
  return out;
}

export interface TranscriptRenderOptions {
  showThinking: boolean;
  expandTools: boolean;
}

export function buildTranscriptLines(
  entries: readonly SessionEntry[],
  theme: Theme,
  width: number,
  options: TranscriptRenderOptions,
): string[] {
  const lines: string[] = [];
  const toolCallsById = new Map<string, { name: string; args: Record<string, unknown> }>();
  let userTurn = 0;

  for (const entry of entries) {
    if (entry.type === "compaction") {
      lines.push(theme.fg("muted", "── [compaction summary] ──"));
      lines.push(...wrapBlock(theme.fg("dim", entry.summary), width));
      lines.push("");
      continue;
    }

    if (entry.type !== "message") continue;
    const msg = entry.message;

    if (msg.role === "user") {
      userTurn++;
      const label = userTurn === 1 ? "User (#1)" : `User (#${userTurn} · resume)`;
      lines.push(theme.fg("accent", theme.bold(`━━ ${label} ━━`)));
      const text = extractTextContent(msg.content).trim();
      lines.push(...wrapBlock(theme.fg("text", text || "(empty)"), width));
      lines.push("");
      continue;
    }

    if (msg.role === "assistant") {
      lines.push(theme.fg("toolTitle", theme.bold("Assistant")));
      const parts = Array.isArray(msg.content) ? msg.content : [];
      let hasRenderedPart = false;

      for (const part of parts) {
        if (part.type === "thinking") {
          if (options.showThinking && part.thinking?.trim()) {
            hasRenderedPart = true;
            lines.push(theme.fg("dim", "  [thinking]"));
            lines.push(...wrapBlock(theme.fg("dim", part.thinking.trim()), width, "    "));
          }
        } else if (part.type === "text") {
          if (part.text.trim()) {
            hasRenderedPart = true;
            lines.push(...wrapBlock(theme.fg("text", part.text.trim()), width));
          }
        } else if (part.type === "toolCall") {
          hasRenderedPart = true;
          const args = (part.arguments ?? {}) as Record<string, unknown>;
          toolCallsById.set(part.id, { name: part.name, args });
          lines.push(`  ${theme.fg("muted", "→ ")}${formatToolCall(theme, part.name, args)}`);
        }
      }

      if (msg.stopReason === "error" && msg.errorMessage) {
        hasRenderedPart = true;
        lines.push(...wrapBlock(theme.fg("error", `Error: ${msg.errorMessage}`), width));
      } else if (!hasRenderedPart) {
        lines.push(theme.fg("dim", "  (no text output)"));
      }
      lines.push("");
      continue;
    }

    if (msg.role === "toolResult") {
      const icon = msg.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
      const matchedCall = toolCallsById.get(msg.toolCallId);
      const header = matchedCall
        ? `${icon} ${formatToolCall(theme, matchedCall.name, matchedCall.args)}`
        : `${icon} ${theme.fg("accent", msg.toolName)}`;
      lines.push(`  ${header}`);

      const output = extractTextContent(msg.content).trimEnd();
      if (output) {
        const rawLines = output.split("\n");
        const limit = options.expandTools ? rawLines.length : COLLAPSED_TOOL_RESULT_LINES;
        const shown = rawLines.slice(0, limit).join("\n");
        lines.push(...wrapBlock(theme.fg(msg.isError ? "error" : "toolOutput", shown), width, "    "));
        if (!options.expandTools && rawLines.length > limit) {
          lines.push(theme.fg("dim", `    … (${rawLines.length - limit} more lines, press e to expand)`));
        }
      } else {
        lines.push(theme.fg("dim", "    (empty output)"));
      }
      lines.push("");
    }
  }

  if (lines.length === 0) {
    return [theme.fg("muted", "  No messages recorded yet.")];
  }
  return lines;
}
