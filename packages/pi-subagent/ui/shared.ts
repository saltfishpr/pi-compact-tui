import type { Theme } from "@earendil-works/pi-coding-agent";

import { describeToolCall, truncateText } from "../format";
import type { SubagentStatus } from "../types";

export function statusIcon(theme: Theme, status: SubagentStatus): string {
  switch (status) {
    case "running":
      return theme.fg("accent", "●");
    case "pending":
      return theme.fg("muted", "◌");
    case "completed":
      return theme.fg("success", "✓");
    case "max_turns":
      return theme.fg("warning", "⚠");
    case "timeout":
      return theme.fg("warning", "⏱");
    case "aborted":
    case "error":
      return theme.fg("error", "✗");
  }
}

export function formatBadges(
  theme: Theme,
  options: { background?: boolean; worktreeBranch?: string; resumed?: boolean },
): string {
  let out = "";
  if (options.background) out += ` ${theme.fg("accent", "[bg]")}`;
  if (options.worktreeBranch) out += ` ${theme.fg("muted", "[wt]")}`;
  if (options.resumed) out += ` ${theme.fg("muted", "(resumed)")}`;
  return out;
}

export function formatToolCall(theme: Theme, name: string, args: Record<string, unknown>): string {
  const described = describeToolCall(name, args);
  switch (described.kind) {
    case "bash":
      return theme.fg("accent", "$ ") + theme.fg("toolOutput", truncateText(described.command, 60));
    case "file": {
      let text = theme.fg("accent", `${described.name} `) + theme.fg("muted", described.path);
      if (described.lineCount && described.lineCount > 1) {
        text += theme.fg("muted", ` (${described.lineCount} lines)`);
      }
      return text;
    }
    case "other":
      return theme.fg("accent", described.name) + theme.fg("muted", ` ${truncateText(described.argsText, 50)}`);
  }
}
