import {
  DynamicBorder,
  rawKeyHint,
  type ExtensionContext,
  type KeybindingsManager,
  type SessionEntry,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Key,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

import { formatDuration, formatToolCall, formatUsage, shortenSessionId } from "./format";
import type { SubagentManager } from "./manager";
import type { SubagentRecord, SubagentStatus, SubagentStore } from "./store";

const COLLAPSED_TOOL_RESULT_LINES = 6;

function statusIcon(theme: Theme, status: SubagentStatus): string {
  switch (status) {
    case "running":
      return theme.fg("accent", "●");
    case "pending":
      return theme.fg("muted", "◌");
    case "completed":
      return theme.fg("success", "✓");
    case "max_turns":
      return theme.fg("warning", "⚠");
    case "aborted":
    case "error":
      return theme.fg("error", "✗");
  }
}

function getWheelDirection(keyData: string): number | undefined {
  const wheel = /^\x1b\[<(\d+);\d+;\d+[Mm]$/.exec(keyData);
  if (!wheel) return undefined;
  const button = Number.parseInt(wheel[1]!, 10);
  if ((button & 64) === 0) return undefined;
  return (button & 3) === 0 ? -1 : 1;
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } => Boolean(part && part.type === "text" && typeof part.text === "string"))
    .map((part) => part.text)
    .join("\n");
}

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
      const text = extractTextFromContent(msg.content).trim();
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

      const output = extractTextFromContent(msg.content).trimEnd();
      if (output) {
        const rawLines = output.split("\n");
        const limit = options.expandTools ? rawLines.length : COLLAPSED_TOOL_RESULT_LINES;
        const shown = rawLines.slice(0, limit).join("\n");
        lines.push(...wrapBlock(theme.fg(msg.isError ? "error" : "toolOutput", shown), width, "    "));
        if (!options.expandTools && rawLines.length > limit) {
          lines.push(
            theme.fg("dim", `    … (${rawLines.length - limit} more lines, press e to expand)`),
          );
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

class SubagentsInspectorComponent implements Component {
  private view: "list" | "detail";
  private selectedIndex = 0;
  private listScrollTop = 0;
  private filterQuery = "";
  private filtering = false;

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
    private readonly store: SubagentStore,
    private readonly manager: SubagentManager,
    private readonly done: () => void,
    initialChildSessionId?: string,
  ) {
    this.border = new DynamicBorder((text: string) => theme.fg("accent", text));

    if (initialChildSessionId) {
      this.view = "detail";
      this.activeChildSessionId = initialChildSessionId;
      this.followMode = manager.isChildActive(initialChildSessionId);
    } else {
      this.view = "list";
    }

    this.unsubStore = store.subscribe(() => {
      this.detailVersion++;
      this.refresh();
    });

    this.unsubManager = manager.subscribe((event) => {
      if (
        event.type === "session_update" &&
        this.view === "detail" &&
        event.childSessionId === this.activeChildSessionId
      ) {
        this.detailVersion++;
        this.refresh();
      } else if (event.type === "upsert" || event.type === "remove") {
        if (this.view === "detail" && event.type === "remove" && event.childSessionId === this.activeChildSessionId) {
          this.detailVersion++;
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

  private getFilteredRecords(): SubagentRecord[] {
    const all = this.store.list();
    const q = this.filterQuery.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (record) =>
        record.name.toLowerCase().includes(q) ||
        record.title.toLowerCase().includes(q) ||
        record.childSessionId.toLowerCase().includes(q) ||
        record.status.toLowerCase().includes(q),
    );
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== "wheel") return undefined;
    const delta = event.wheelDelta ?? 0;
    if (delta === 0) return undefined;

    if (this.view === "detail") {
      this.scrollDetailBy(delta);
    } else {
      const records = this.getFilteredRecords();
      if (records.length > 0) {
        this.selectedIndex = Math.max(0, Math.min(records.length - 1, this.selectedIndex + Math.sign(delta)));
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
        const records = this.getFilteredRecords();
        if (records.length > 0) {
          this.selectedIndex = Math.max(0, Math.min(records.length - 1, this.selectedIndex + wheelDir));
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
    const records = this.getFilteredRecords();

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

    if (records.length === 0) return;

    if (this.keybindings.matches(data, "tui.select.up") || data === "k") {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.refresh();
    } else if (this.keybindings.matches(data, "tui.select.down") || data === "j") {
      this.selectedIndex = Math.min(records.length - 1, this.selectedIndex + 1);
      this.refresh();
    } else if (data === "g") {
      this.selectedIndex = 0;
      this.refresh();
    } else if (data === "G") {
      this.selectedIndex = records.length - 1;
      this.refresh();
    } else if (this.keybindings.matches(data, "tui.select.confirm") || data === "\r" || data === "\n") {
      const selected = records[this.selectedIndex];
      if (selected) {
        this.openDetail(selected.childSessionId);
      }
    }
  }

  private handleDetailInput(data: string): void {
    if (data === "q") {
      this.close();
      return;
    }

    if (this.keybindings.matches(data, "tui.select.cancel") || data === "\x7f" || data === "\b") {
      this.view = "list";
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

    if (data === "f" && this.activeChildSessionId && this.manager.isChildActive(this.activeChildSessionId)) {
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
      if (this.activeChildSessionId && this.manager.isChildActive(this.activeChildSessionId)) {
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
    } else if (next >= maxScrollTop && this.activeChildSessionId && this.manager.isChildActive(this.activeChildSessionId)) {
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
    this.followMode = this.manager.isChildActive(childSessionId);
    this.cachedDetail = undefined;
    this.refresh();
  }

  private close(): void {
    this.dispose();
    this.done();
  }

  render(width: number): string[] {
    if (this.view === "list") {
      return this.renderList(width);
    }
    return this.renderDetail(width);
  }

  private renderList(width: number): string[] {
    const records = this.getFilteredRecords();
    const lines: string[] = [];
    lines.push(...this.border.render(width));

    const header = `${this.theme.fg("accent", this.theme.bold("Subagents"))} ${this.theme.fg("muted", `(${records.length})`)}`;
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
    if (records.length === 0) {
      lines.push(this.theme.fg("muted", this.filterQuery ? "  No matching subagents." : "  No subagents recorded in this session."));
    } else {
      this.selectedIndex = Math.max(0, Math.min(records.length - 1, this.selectedIndex));
      if (this.selectedIndex < this.listScrollTop) {
        this.listScrollTop = this.selectedIndex;
      } else if (this.selectedIndex >= this.listScrollTop + maxVisible) {
        this.listScrollTop = this.selectedIndex - maxVisible + 1;
      }
      const slice = records.slice(this.listScrollTop, this.listScrollTop + maxVisible);

      for (let i = 0; i < slice.length; i++) {
        const record = slice[i]!;
        const isSelected = this.listScrollTop + i === this.selectedIndex;
        const prefix = isSelected ? this.theme.fg("accent", "→ ") : "  ";
        const icon = statusIcon(this.theme, record.status);
        const name = this.theme.fg(isSelected ? "accent" : "text", record.name);
        const idText = this.theme.fg("dim", `[${shortenSessionId(record.childSessionId)}]`);
        const title = record.title ? this.theme.fg("text", ` ${record.title}`) : "";
        const metaParts: string[] = [];
        metaParts.push(`${record.totalTurns}t`);
        if (record.totalDurationMs > 0) metaParts.push(formatDuration(record.totalDurationMs));
        const usage = formatUsage(record.totalUsage);
        if (usage) metaParts.push(usage);
        const meta = this.theme.fg("muted", ` · ${metaParts.join(" · ")}`);

        lines.push(truncateToWidth(`${prefix}${icon} ${name} ${idText}${title}${meta}`, width));
      }

      if (records.length > maxVisible) {
        lines.push(this.theme.fg("dim", `  (${this.selectedIndex + 1}/${records.length})`));
      }
    }

    lines.push("");
    const hints = [
      rawKeyHint("↑↓/jk", "select"),
      rawKeyHint("Enter", "inspect"),
      rawKeyHint("/", "filter"),
      rawKeyHint("Esc/q", "close"),
    ].join("  ");
    lines.push(truncateToWidth(` ${hints}`, width));
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

    const entries = this.manager.getActiveBranch(childId) ?? this.store.loadTranscript(childId);
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
    const record = childId ? this.store.get(childId) : undefined;
    const isActive = childId ? this.manager.isChildActive(childId) : false;

    const lines: string[] = [];
    lines.push(...this.border.render(width));

    if (record) {
      const icon = statusIcon(this.theme, record.status);
      const titleLine = ` ${icon} ${this.theme.fg("accent", this.theme.bold(record.name))} ${this.theme.fg("muted", record.title || "(untitled)")}`;
      lines.push(truncateToWidth(titleLine, width));

      const metaParts = [`ID: ${record.childSessionId}`, `${record.totalTurns} turns`];
      if (record.totalDurationMs > 0) metaParts.push(formatDuration(record.totalDurationMs));
      if (record.model) metaParts.push(record.model);
      const usage = formatUsage(record.totalUsage);
      if (usage) metaParts.push(usage);
      lines.push(truncateToWidth(` ${this.theme.fg("dim", metaParts.join(" · "))}`, width));

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
    const scrollInfo =
      maxScrollTop > 0
        ? ` ${this.theme.fg("dim", `(${this.detailScrollTop + 1}-${Math.min(this.detailContentHeight, this.detailScrollTop + this.detailViewportHeight)}/${this.detailContentHeight})`)}`
        : "";
    const hintParts = [
      rawKeyHint("↑↓/jk/PgUp/PgDn/gG", "scroll"),
      rawKeyHint("e", "tools"),
      rawKeyHint("t", "thinking"),
    ];
    if (isActive) hintParts.push(rawKeyHint("f", "follow"));
    hintParts.push(rawKeyHint("Esc", "back"));
    hintParts.push(rawKeyHint("q", "close"));

    lines.push(truncateToWidth(` ${hintParts.join("  ")}${scrollInfo}`, width));
    lines.push(...this.border.render(width));
    return lines;
  }
}

export async function openSubagentsInspector(
  ctx: ExtensionContext,
  store: SubagentStore,
  manager: SubagentManager,
  initialChildSessionId?: string,
): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("/subagents inspector is only available in TUI mode", "warning");
    return;
  }

  if (initialChildSessionId && !store.get(initialChildSessionId)) {
    ctx.ui.notify(`Subagent session "${initialChildSessionId}" not found in this session`, "warning");
    return;
  }

  await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
    const component = new SubagentsInspectorComponent(
      tui,
      theme,
      keybindings,
      store,
      manager,
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
