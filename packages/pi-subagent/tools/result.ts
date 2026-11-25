import { formatDuration } from "../format";
import { stopReasonToStatus, type AgentToolDetails, type SpawnResult, type WorktreeSummary } from "../types";

export function formatWorktreeSummary(summary: WorktreeSummary): string {
  if (summary.cleanedUp) {
    return "Worktree cleaned up (no changes).";
  }

  const lines = [
    "Worktree preserved (changes detected):",
    `- Path: ${summary.rootPath}`,
    `- Branch: ${summary.branch}`,
  ];

  if (summary.commitCount > 0) {
    const suffix = summary.commitCount > summary.commits.length ? ` (showing ${summary.commits.length})` : "";
    lines.push(`- Commits (${summary.commitCount})${suffix}:`);
    for (const commit of summary.commits) {
      lines.push(`  ${commit}`);
    }
  }

  if (summary.diffStat) {
    lines.push("- Diff stat:");
    for (const line of summary.diffStat.split(/\r?\n/)) {
      lines.push(`  ${line}`);
    }
  }

  if (summary.untrackedFiles.length > 0) {
    lines.push(`- Untracked files (${summary.untrackedFiles.length}):`);
    for (const file of summary.untrackedFiles) {
      lines.push(`  ${file}`);
    }
  }

  return lines.join("\n");
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
