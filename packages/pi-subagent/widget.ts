import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

import { formatDuration, formatToolCall, formatUsage } from "./format";
import type { AgentThreadSnapshot, SubagentManager } from "./manager";

class SubagentPanel implements Component {
  private readonly snapshots = new Map<string, AgentThreadSnapshot>();
  private readonly unsubscribe: () => void;
  private readonly timer: ReturnType<typeof setInterval>;
  private cached?: { width: number; lines: string[] };

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly manager: SubagentManager,
  ) {
    this.unsubscribe = manager.subscribe((event) => {
      if (event.type === "upsert") {
        this.snapshots.set(event.snapshot.id, event.snapshot);
        this.refresh();
      } else if (event.type === "remove") {
        this.snapshots.delete(event.id);
        this.refresh();
      }
    });
    this.timer = setInterval(() => this.refresh(), 1000);
  }

  invalidate(): void {
    this.cached = undefined;
  }

  dispose(): void {
    clearInterval(this.timer);
    this.unsubscribe();
  }

  render(width: number): string[] {
    if (this.cached && this.cached.width === width) return this.cached.lines;
    const lines = this.buildLines();
    this.cached = { width, lines };
    return lines;
  }

  private refresh(): void {
    this.invalidate();
    this.tui.requestRender();
  }

  private buildLines(): string[] {
    const threads = [...this.snapshots.values()].sort((a, b) => a.startedAt - b.startedAt);
    if (threads.length === 0) return [];

    const title = this.theme.fg("accent", this.theme.bold("● Subagents"));
    const lines: string[] = [`${title}${this.theme.fg("muted", ` (${threads.length})`)}`];
    threads.forEach((thread, index) => {
      const branch = index === threads.length - 1 ? "└─" : "├─";
      lines.push(`${this.theme.fg("muted", `${branch} `)}${this.renderThread(thread)}`);
      const activity = this.renderActivity(thread);
      if (activity) {
        const prefix = index === threads.length - 1 ? "   └─ " : "│  └─ ";
        lines.push(`${this.theme.fg("muted", prefix)}${activity}`);
      }
    });
    return lines;
  }

  private renderThread(thread: AgentThreadSnapshot): string {
    const running = thread.phase === "running";
    const marker = running ? "●" : "◌";
    const elapsed = formatDuration(Date.now() - (thread.runningSince ?? thread.startedAt));

    const details = [`"${thread.title}"`];
    if (thread.resumed) details.push("(resumed)");
    details.push(`· ${elapsed}`);
    if (running) {
      details.push(`· ${thread.turns}t`);
      if (thread.model) details.push(`· ${thread.model}`);
      const usage = formatUsage(thread.usage);
      if (usage) details.push(`· ${usage}`);
    }
    const bgBadge = thread.background ? ` ${this.theme.fg("accent", "[bg]")}` : "";
    const wtBadge = thread.worktreeBranch ? ` ${this.theme.fg("muted", "[wt]")}` : "";
    return `${this.theme.fg("accent", `${marker} ${thread.name}`)}${bgBadge}${wtBadge} ${this.theme.fg("muted", details.join(" "))}`;
  }

  private renderActivity(thread: AgentThreadSnapshot): string | undefined {
    const activity = thread.lastActivity;
    if (!activity) return undefined;
    if (activity.type === "toolCall") {
      return formatToolCall(this.theme, activity.name, activity.args);
    }
    const text = activity.text.split("\n").find((line) => line.trim()) ?? "";
    if (!text) return undefined;
    const truncated = text.length > 80 ? `${text.slice(0, 80)}…` : text;
    return this.theme.fg("muted", truncated);
  }
}

export function createSubagentWidget(manager: SubagentManager): (tui: TUI, theme: Theme) => Component {
  return (tui, theme) => new SubagentPanel(tui, theme, manager);
}
