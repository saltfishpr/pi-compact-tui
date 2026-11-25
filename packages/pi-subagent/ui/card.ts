import { getMarkdownTheme, keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { Box, Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";

import { formatDuration, formatUsage, shortenSessionId } from "../format";
import type { AgentToolDetails } from "../types";
import { formatBadges } from "./shared";

const COLLAPSED_LINE_COUNT = 5;

export function renderAgentCard(
  rawOutput: string,
  details: Partial<AgentToolDetails> | undefined,
  expanded: boolean,
  isErrorFlag: boolean,
  theme: Theme,
): Box {
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
  const badges = formatBadges(theme, {
    background: details?.background,
    worktreeBranch: details?.worktree?.branch,
    resumed: details?.resumed,
  });
  const title = details?.title ? ` — ${theme.fg("muted", details.title)}` : "";

  if (details?.backgroundStatus === "started" || details?.backgroundStatus === "detached") {
    const statusLabel = details.backgroundStatus === "started" ? "started in background" : "moved to background";
    content.addChild(
      new Text(
        `${theme.fg("toolTitle", theme.bold("agent"))} ${name}${idBadge}${badges}${title} ${theme.fg("dim", `· ${statusLabel}`)}`,
        0,
        0,
      ),
    );
    box.addChild(content);
    return box;
  }

  content.addChild(
    new Text(`${theme.fg("toolTitle", theme.bold("agent"))} ${name}${idBadge}${badges}${title}`, 0, 0),
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
