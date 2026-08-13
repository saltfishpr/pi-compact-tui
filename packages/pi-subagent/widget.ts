import { homedir } from "node:os";

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

import { formatDuration, formatUsage } from "./format";
import type { AgentThreadSnapshot, SubagentManager } from "./manager";

function formatToolCall(theme: Theme, name: string, args: Record<string, unknown>): string {
  const shortenPath = (p: string) => {
    const home = homedir();
    return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  };

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
      let text = theme.fg("accent", `${name} `) + theme.fg("muted", shortenPath(path));
      if (lines > 1) text += theme.fg("muted", ` (${lines} lines)`);
      return text;
    }
    case "grep": {
      const pattern = (args.pattern || "") as string;
      const path = (args.path || ".") as string;
      return theme.fg("accent", `grep /${pattern}/`) + theme.fg("muted", ` in ${shortenPath(path)}`);
    }
    case "find": {
      const pattern = (args.pattern || "*") as string;
      const path = (args.path || ".") as string;
      return theme.fg("accent", `find ${pattern}`) + theme.fg("muted", ` in ${shortenPath(path)}`);
    }
    case "ls": {
      const path = (args.path || ".") as string;
      return theme.fg("accent", `${name} `) + theme.fg("muted", shortenPath(path));
    }
    default: {
      const serialized = JSON.stringify(args);
      const preview = serialized.length > 50 ? `${serialized.slice(0, 50)}...` : serialized;
      return theme.fg("accent", name) + theme.fg("muted", ` ${preview}`);
    }
  }
}

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
      if (event.type === "upsert") this.snapshots.set(event.snapshot.id, event.snapshot);
      else if (event.type === "remove") this.snapshots.delete(event.id);
      this.refresh();
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

    const details = [`"${thread.title}"`, `· ${elapsed}`];
    if (running) {
      details.push(`· ${thread.turns}t`);
      if (thread.model) details.push(`· ${thread.model}`);
      const usage = formatUsage(thread.usage);
      if (usage) details.push(`· ${usage}`);
    }
    return `${this.theme.fg("accent", `${marker} ${thread.name}`)} ${this.theme.fg("muted", details.join(" "))}`;
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
