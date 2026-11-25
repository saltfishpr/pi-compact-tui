import {
  DynamicBorder,
  rawKeyHint,
  type ExtensionContext,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  type Component,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

import { formatDuration, formatUsage, shortenSessionId } from "../format";
import type { SubagentService } from "../runtime/service";
import type { SubagentView } from "../types";
import { formatBadges, statusIcon } from "./shared";
import { buildTranscriptLines } from "./transcript";

function getWheelDirection(keyData: string): number | undefined {
  const wheel = /^\x1b\[<(\d+);\d+;\d+[Mm]$/.exec(keyData);
  if (!wheel) return undefined;
  const button = Number.parseInt(wheel[1]!, 10);
  if ((button & 64) === 0) return undefined;
  return (button & 3) === 0 ? -1 : 1;
}

class SubagentsInspectorComponent implements Component {
  private view: "list" | "detail";
  private selectedIndex = 0;
  private listScrollTop = 0;
  private filterQuery = "";
  private filtering = false;
  private pendingCancel?: { childSessionId: string; title: string };

  private activeChildSessionId?: string;
  private detailScrollTop = 0;
  private detailContentHeight = 0;
  private detailViewportHeight = 16;
  private showThinking = false;
  private expandTools = false;
  private followMode = false;

  private cachedDetail?: {
    childSessionId: string;
    width: number;
    showThinking: boolean;
    expandTools: boolean;
    version: number;
    lines: string[];
  };
  private detailVersion = 0;

  private readonly unsubStore: () => void;
  private readonly unsubManager: () => void;
  private readonly border: DynamicBorder;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly service: SubagentService,
    private readonly done: () => void,
    initialChildSessionId?: string,
  ) {
    this.border = new DynamicBorder((text: string) => theme.fg("accent", text));

    if (initialChildSessionId) {
      this.view = "detail";
      this.activeChildSessionId = initialChildSessionId;
      this.followMode = service.isActive(initialChildSessionId);
    } else {
      this.view = "list";
    }

    this.unsubStore = service.subscribeStore(() => {
      this.detailVersion++;
      this.refresh();
    });

    this.unsubManager = service.subscribeManager((event) => {
      if (
        event.type === "session_update" &&
        this.view === "detail" &&
        event.childSessionId === this.activeChildSessionId
      ) {
        this.detailVersion++;
        this.refresh();
      } else if (event.type === "upsert" || event.type === "remove") {
        if (event.type === "remove") {
          if (this.pendingCancel?.childSessionId === event.childSessionId) {
            this.pendingCancel = undefined;
          }
          if (this.view === "detail" && event.childSessionId === this.activeChildSessionId) {
            this.detailVersion++;
          }
        }
        this.refresh();
      }
    });
  }

  dispose(): void {
    this.unsubStore();
    this.unsubManager();
  }

  invalidate(): void {
    this.cachedDetail = undefined;
  }

  private refresh(): void {
    this.cachedDetail = undefined;
    this.tui.requestRender();
  }

  private getFilteredViews(): SubagentView[] {
    const all = this.service.listViews();
    const q = this.filterQuery.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (item) =>
        item.name.toLowerCase().includes(q) ||
        item.title.toLowerCase().includes(q) ||
        item.childSessionId.toLowerCase().includes(q) ||
        item.status.toLowerCase().includes(q),
    );
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== "wheel") return undefined;
    const delta = event.wheelDelta ?? 0;
    if (delta === 0) return undefined;

    if (this.view === "detail") {
      this.scrollDetailBy(delta);
    } else {
      const items = this.getFilteredViews();
      if (items.length > 0) {
        this.selectedIndex = Math.max(0, Math.min(items.length - 1, this.selectedIndex + Math.sign(delta)));
        this.refresh();
      }
    }
    return { handled: true };
  }

  handleInput(data: string): void {
    const wheelDir = getWheelDirection(data);
    if (wheelDir !== undefined) {
      if (this.view === "detail") {
        this.scrollDetailBy(wheelDir * 3);
      } else {
        const items = this.getFilteredViews();
        if (items.length > 0) {
          this.selectedIndex = Math.max(0, Math.min(items.length - 1, this.selectedIndex + wheelDir));
          this.refresh();
        }
      }
      return;
    }

    if (this.view === "list") {
      this.handleListInput(data);
    } else {
      this.handleDetailInput(data);
    }
  }

  private handleListInput(data: string): void {
    const items = this.getFilteredViews();

    if (this.filtering) {
      if (this.keybindings.matches(data, "tui.select.cancel") || data === "\r" || data === "\n") {
        this.filtering = false;
        this.refresh();
        return;
      }
      if (data === "\x7f" || data === "\b") {
        this.filterQuery = this.filterQuery.slice(0, -1);
        this.selectedIndex = 0;
        this.refresh();
        return;
      }
      if (data.length === 1 && data >= " " && data !== "\x7f") {
        this.filterQuery += data;
        this.selectedIndex = 0;
        this.refresh();
        return;
      }
      return;
    }

    if (this.handlePendingCancelInput(data)) return;

    if (data === "q" || this.keybindings.matches(data, "tui.select.cancel")) {
      if (this.filterQuery && data !== "q") {
        this.filterQuery = "";
        this.selectedIndex = 0;
        this.refresh();
        return;
      }
      this.close();
      return;
    }

    if (data === "/") {
      this.filtering = true;
      this.refresh();
      return;
    }

    if (items.length === 0) return;

    if (data === "x") {
      const selected = items[this.selectedIndex];
      if (selected && selected.isActive) {
        this.pendingCancel = {
          childSessionId: selected.childSessionId,
          title: selected.title || selected.name,
        };
        this.refresh();
      }
      return;
    }

    if (data === "b") {
      const selected = items[this.selectedIndex];
      if (selected && this.service.detach(selected.childSessionId)) {
        this.refresh();
      }
      return;
    }

    if (this.keybindings.matches(data, "tui.select.up") || data === "k") {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.refresh();
    } else if (this.keybindings.matches(data, "tui.select.down") || data === "j") {
      this.selectedIndex = Math.min(items.length - 1, this.selectedIndex + 1);
      this.refresh();
    } else if (data === "g") {
      this.selectedIndex = 0;
      this.refresh();
    } else if (data === "G") {
      this.selectedIndex = items.length - 1;
      this.refresh();
    } else if (this.keybindings.matches(data, "tui.select.confirm") || data === "\r" || data === "\n") {
      const selected = items[this.selectedIndex];
      if (selected) {
        this.openDetail(selected.childSessionId);
      }
    }
  }

  private handlePendingCancelInput(data: string): boolean {
    if (!this.pendingCancel) return false;
    if (data === "x") {
      const targetId = this.pendingCancel.childSessionId;
      this.pendingCancel = undefined;
      void this.service.cancel(targetId, { notify: true });
    } else {
      this.pendingCancel = undefined;
    }
    this.refresh();
    return true;
  }

  private renderPendingCancelLine(width: number): string {
    const prompt = this.theme.fg(
      "warning",
      `Press x again to cancel "${this.pendingCancel!.title}" (Esc to keep running)`,
    );
    return truncateToWidth(` ${prompt}`, width);
  }

  private handleDetailInput(data: string): void {
    if (this.handlePendingCancelInput(data)) return;

    if (data === "q") {
      this.close();
      return;
    }

    if (this.keybindings.matches(data, "tui.select.cancel") || data === "\x7f" || data === "\b") {
      this.pendingCancel = undefined;
      this.view = "list";
      this.refresh();
      return;
    }

    if (data === "x" && this.activeChildSessionId && this.service.isActive(this.activeChildSessionId)) {
      const item = this.service.getView(this.activeChildSessionId);
      this.pendingCancel = {
        childSessionId: this.activeChildSessionId,
        title: item?.title || item?.name || this.activeChildSessionId,
      };
      this.refresh();
      return;
    }

    if (data === "b" && this.activeChildSessionId && this.service.detach(this.activeChildSessionId)) {
      this.refresh();
      return;
    }

    if (data === "e") {
      this.expandTools = !this.expandTools;
      this.refresh();
      return;
    }

    if (data === "t") {
      this.showThinking = !this.showThinking;
      this.refresh();
      return;
    }

    if (data === "f" && this.activeChildSessionId && this.service.isActive(this.activeChildSessionId)) {
      this.followMode = !this.followMode;
      if (this.followMode) {
        this.detailScrollTop = Math.max(0, this.detailContentHeight - this.detailViewportHeight);
      }
      this.refresh();
      return;
    }

    const halfPage = Math.max(1, Math.floor(this.detailViewportHeight / 2));
    if (this.keybindings.matches(data, "tui.select.up") || data === "k") {
      this.scrollDetailBy(-1);
    } else if (this.keybindings.matches(data, "tui.select.down") || data === "j") {
      this.scrollDetailBy(1);
    } else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("u"))) {
      this.scrollDetailBy(-halfPage);
    } else if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("d"))) {
      this.scrollDetailBy(halfPage);
    } else if (data === "g") {
      this.followMode = false;
      this.detailScrollTop = 0;
      this.refresh();
    } else if (data === "G") {
      this.detailScrollTop = Math.max(0, this.detailContentHeight - this.detailViewportHeight);
      if (this.activeChildSessionId && this.service.isActive(this.activeChildSessionId)) {
        this.followMode = true;
      }
      this.refresh();
    }
  }

  private scrollDetailBy(delta: number): void {
    const maxScrollTop = Math.max(0, this.detailContentHeight - this.detailViewportHeight);
    const next = Math.max(0, Math.min(maxScrollTop, this.detailScrollTop + delta));
    if (delta < 0) {
      this.followMode = false;
    } else if (next >= maxScrollTop && this.activeChildSessionId && this.service.isActive(this.activeChildSessionId)) {
      this.followMode = true;
    }
    if (next !== this.detailScrollTop) {
      this.detailScrollTop = next;
      this.tui.requestRender();
    }
  }

  private openDetail(childSessionId: string): void {
    this.activeChildSessionId = childSessionId;
    this.view = "detail";
    this.detailScrollTop = 0;
    this.followMode = this.service.isActive(childSessionId);
    this.cachedDetail = undefined;
    this.refresh();
  }

  private close(): void {
    this.dispose();
    this.done();
  }

  render(width: number): string[] {
    return this.view === "list" ? this.renderList(width) : this.renderDetail(width);
  }

  private renderList(width: number): string[] {
    const items = this.getFilteredViews();
    const lines: string[] = [];
    lines.push(...this.border.render(width));

    const header = `${this.theme.fg("accent", this.theme.bold("Subagents"))} ${this.theme.fg("muted", `(${items.length})`)}`;
    lines.push(truncateToWidth(` ${header}`, width));

    if (this.filtering || this.filterQuery) {
      const cursor = this.filtering ? "▎" : "";
      lines.push(
        truncateToWidth(
          ` ${this.theme.fg("muted", "Filter: ")}${this.theme.fg("text", this.filterQuery)}${this.theme.fg("accent", cursor)}`,
          width,
        ),
      );
    }
    lines.push("");

    const maxVisible = Math.max(5, Math.min(14, this.tui.terminal.rows - 10));
    if (items.length === 0) {
      lines.push(this.theme.fg("muted", this.filterQuery ? "  No matching subagents." : "  No subagents recorded in this session."));
    } else {
      this.selectedIndex = Math.max(0, Math.min(items.length - 1, this.selectedIndex));
      if (this.selectedIndex < this.listScrollTop) {
        this.listScrollTop = this.selectedIndex;
      } else if (this.selectedIndex >= this.listScrollTop + maxVisible) {
        this.listScrollTop = this.selectedIndex - maxVisible + 1;
      }
      const slice = items.slice(this.listScrollTop, this.listScrollTop + maxVisible);

      for (let i = 0; i < slice.length; i++) {
        const item = slice[i]!;
        const isSelected = this.listScrollTop + i === this.selectedIndex;
        const prefix = isSelected ? this.theme.fg("accent", "→ ") : "  ";
        const icon = statusIcon(this.theme, item.status);
        const name = this.theme.fg(isSelected ? "accent" : "text", item.name);
        const idText = this.theme.fg("dim", `[${shortenSessionId(item.childSessionId)}]`);
        const badges = formatBadges(this.theme, {
          background: item.background,
          worktreeBranch: item.worktreeBranch,
        });
        const title = item.title ? this.theme.fg("text", ` ${item.title}`) : "";
        const metaParts: string[] = [`${item.turns}t`];
        if (item.durationMs > 0) metaParts.push(formatDuration(item.durationMs));
        const usage = formatUsage(item.usage);
        if (usage) metaParts.push(usage);
        const meta = this.theme.fg("muted", ` · ${metaParts.join(" · ")}`);

        lines.push(truncateToWidth(`${prefix}${icon} ${name} ${idText}${badges}${title}${meta}`, width));
      }

      if (items.length > maxVisible) {
        lines.push(this.theme.fg("dim", `  (${this.selectedIndex + 1}/${items.length})`));
      }
    }

    lines.push("");
    if (this.pendingCancel) {
      lines.push(this.renderPendingCancelLine(width));
    } else {
      const selected = items[this.selectedIndex];
      const hintParts = [
        rawKeyHint("↑↓/jk", "select"),
        rawKeyHint("Enter", "inspect"),
        rawKeyHint("/", "filter"),
      ];
      if (selected?.isActive) {
        if (!selected.background) hintParts.push(rawKeyHint("b", "background"));
        hintParts.push(rawKeyHint("x", "cancel"));
      }
      hintParts.push(rawKeyHint("Esc/q", "close"));
      lines.push(truncateToWidth(` ${hintParts.join("  ")}`, width));
    }
    lines.push(...this.border.render(width));
    return lines;
  }

  private getDetailLines(width: number): string[] {
    const childId = this.activeChildSessionId;
    if (!childId) return [this.theme.fg("muted", "  No subagent selected.")];

    if (
      this.cachedDetail &&
      this.cachedDetail.childSessionId === childId &&
      this.cachedDetail.width === width &&
      this.cachedDetail.showThinking === this.showThinking &&
      this.cachedDetail.expandTools === this.expandTools &&
      this.cachedDetail.version === this.detailVersion
    ) {
      return this.cachedDetail.lines;
    }

    const entries = this.service.loadTranscript(childId);
    const rendered = buildTranscriptLines(entries, this.theme, width, {
      showThinking: this.showThinking,
      expandTools: this.expandTools,
    });

    this.cachedDetail = {
      childSessionId: childId,
      width,
      showThinking: this.showThinking,
      expandTools: this.expandTools,
      version: this.detailVersion,
      lines: rendered,
    };
    return rendered;
  }

  private renderDetail(width: number): string[] {
    const childId = this.activeChildSessionId;
    const item = childId ? this.service.getView(childId) : undefined;
    const isActive = Boolean(item?.isActive);

    const lines: string[] = [];
    lines.push(...this.border.render(width));

    if (item) {
      const icon = statusIcon(this.theme, item.status);
      const badges = formatBadges(this.theme, { background: item.background });
      const titleLine = ` ${icon} ${this.theme.fg("accent", this.theme.bold(item.name))}${badges} ${this.theme.fg("muted", item.title || "(untitled)")}`;
      lines.push(truncateToWidth(titleLine, width));

      const metaParts = [`ID: ${item.childSessionId}`, `${item.turns} turns`];
      if (item.durationMs > 0) metaParts.push(formatDuration(item.durationMs));
      if (item.timeoutSeconds !== undefined) metaParts.push(`timeout: ${formatDuration(item.timeoutSeconds * 1000)}`);
      if (item.model) metaParts.push(item.model);
      const usage = formatUsage(item.usage);
      if (usage) metaParts.push(usage);
      lines.push(truncateToWidth(` ${this.theme.fg("dim", metaParts.join(" · "))}`, width));

      if (item.worktree) {
        lines.push(
          truncateToWidth(
            ` ${this.theme.fg("dim", `Worktree: ${item.worktree.branch} (${item.worktree.rootPath})`)}`,
            width,
          ),
        );
      }

      const flags = [
        `tools: ${this.expandTools ? "expanded" : "collapsed"}`,
        `thinking: ${this.showThinking ? "shown" : "hidden"}`,
      ];
      if (isActive) flags.push(`follow: ${this.followMode ? "on" : "off"}`);
      lines.push(truncateToWidth(` ${this.theme.fg("muted", flags.join(" · "))}`, width));
    } else {
      lines.push(truncateToWidth(` ${this.theme.fg("error", `Subagent "${childId ?? ""}" not found`)}`, width));
    }

    lines.push("");

    this.detailViewportHeight = Math.max(8, this.tui.terminal.rows - 11);
    const bodyLines = this.getDetailLines(Math.max(20, width));
    this.detailContentHeight = bodyLines.length;
    const maxScrollTop = Math.max(0, this.detailContentHeight - this.detailViewportHeight);

    if (this.followMode && isActive) {
      this.detailScrollTop = maxScrollTop;
    } else {
      this.detailScrollTop = Math.max(0, Math.min(maxScrollTop, this.detailScrollTop));
    }

    const visible = bodyLines.slice(this.detailScrollTop, this.detailScrollTop + this.detailViewportHeight);
    lines.push(...visible.map((line) => truncateToWidth(line, width)));

    lines.push("");
    if (this.pendingCancel) {
      lines.push(this.renderPendingCancelLine(width));
    } else {
      const scrollInfo =
        maxScrollTop > 0
          ? ` ${this.theme.fg("dim", `(${this.detailScrollTop + 1}-${Math.min(this.detailContentHeight, this.detailScrollTop + this.detailViewportHeight)}/${this.detailContentHeight})`)}`
          : "";
      const hintParts = [
        rawKeyHint("↑↓/jk/PgUp/PgDn/gG", "scroll"),
        rawKeyHint("e", "tools"),
        rawKeyHint("t", "thinking"),
      ];
      if (isActive) {
        hintParts.push(rawKeyHint("f", "follow"));
        if (!item?.background) hintParts.push(rawKeyHint("b", "background"));
        hintParts.push(rawKeyHint("x", "cancel"));
      }
      hintParts.push(rawKeyHint("Esc", "back"));
      hintParts.push(rawKeyHint("q", "close"));

      lines.push(truncateToWidth(` ${hintParts.join("  ")}${scrollInfo}`, width));
    }
    lines.push(...this.border.render(width));
    return lines;
  }
}

export async function openSubagentsInspector(
  ctx: ExtensionContext,
  service: SubagentService,
  initialChildSessionId?: string,
): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("/subagents inspector is only available in TUI mode", "warning");
    return;
  }

  if (initialChildSessionId && !service.getView(initialChildSessionId)) {
    ctx.ui.notify(`Subagent session "${initialChildSessionId}" not found in this session`, "warning");
    return;
  }

  await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
    const component = new SubagentsInspectorComponent(
      tui,
      theme,
      keybindings,
      service,
      () => done(undefined),
      initialChildSessionId,
    );
    return {
      render: (width: number) => component.render(width),
      invalidate: () => component.invalidate(),
      handleInput: (data: string) => component.handleInput(data),
      handleMouse: (event: TuiMouseEvent) => component.handleMouse(event),
    };
  });
}
