import { CustomEditor, type ExtensionAPI, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { Loader, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

function fitBorder(
  left: string,
  right: string,
  width: number,
  border: (text: string) => string,
  fill: (text: string) => string = border,
): string {
  if (width <= 0) return "";
  if (width === 1) return border("─");

  let leftText = left;
  let rightText = right;
  const fixedWidth = 2;
  const minimumGap = 3;

  while (
    fixedWidth + visibleWidth(leftText) + visibleWidth(rightText) + minimumGap > width &&
    visibleWidth(rightText) > 0
  ) {
    rightText = truncateToWidth(rightText, Math.max(0, visibleWidth(rightText) - 1), "");
  }
  while (
    fixedWidth + visibleWidth(leftText) + visibleWidth(rightText) + minimumGap > width &&
    visibleWidth(leftText) > 0
  ) {
    leftText = truncateToWidth(leftText, Math.max(0, visibleWidth(leftText) - 1), "");
  }

  const gapWidth = Math.max(0, width - fixedWidth - visibleWidth(leftText) - visibleWidth(rightText));
  return `${border("─")}${leftText}${fill("─".repeat(gapWidth))}${rightText}${border("─")}`;
}

class CompactEditor extends CustomEditor {
  private uiTheme: Theme;
  private workingLoader: Loader;
  private isWorking: boolean;
  private model: string;

  constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, uiTheme: Theme, model = "") {
    super(tui, theme, keybindings);

    this.uiTheme = uiTheme;
    this.workingLoader = new Loader(
      tui,
      (text) => text,
      (text) => text,
      "",
      {
        intervalMs: 80,
      },
    );
    this.workingLoader.stop();
    this.isWorking = false;
    this.model = model;
  }

  startWorking(message: string = "Working") {
    this.isWorking = true;
    this.workingLoader.setMessage(message);
    this.workingLoader.start();
  }

  stopWorking() {
    this.isWorking = false;
    this.workingLoader.stop();
    this.workingLoader.setMessage("");
  }

  setWorkingMessage(message: string) {
    if (!this.isWorking) return;
    this.workingLoader.setMessage(message);
  }

  setModel(model: string) {
    this.model = model;
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const lines = super.render(width);
    if (lines.length < 2) return lines;

    const topRight = this.fitLabel(this.model);
    const topLeft = this.isWorking ? this.fitLabel(this.renderWorkingLoader(width)) : "";

    const borderColor = (text: string) => this.borderColor(text);

    lines[0] = fitBorder(topLeft, topRight, width, borderColor);
    return lines;
  }

  private renderWorkingLoader(width: number): string {
    return this.workingLoader.render(width).join("").trim();
  }

  private fitLabel(text: string): string {
    return text ? this.uiTheme.fg("dim", ` ${text} `) : "";
  }
}

export default function (pi: ExtensionAPI) {
  let editor: CompactEditor | undefined;
  const runningTools = new Map<string, string>();

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    ctx.ui.setWorkingVisible(false);
    const model = formatModel(ctx.model, pi.getThinkingLevel());
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      editor = new CompactEditor(tui, theme, keybindings, ctx.ui.theme, model);
      return editor;
    });
  });

  pi.on("model_select", (event, ctx) => {
    if (ctx.mode !== "tui") return;

    editor?.setModel(formatModel(event.model, pi.getThinkingLevel()));
  });

  pi.on("thinking_level_select", (event, ctx) => {
    if (ctx.mode !== "tui") return;

    editor?.setModel(formatModel(ctx.model, event.level));
  });

  pi.on("agent_start", () => {
    runningTools.clear();
    editor?.startWorking();
  });

  pi.on("turn_start", () => {
    runningTools.clear();
    editor?.setWorkingMessage("Working");
  });

  pi.on("message_update", (event) => {
    if (runningTools.size > 0) return;

    switch (event.assistantMessageEvent.type) {
      case "thinking_start":
      case "thinking_delta":
      case "thinking_end":
        editor?.setWorkingMessage("Thinking");
        break;
      case "text_start":
      case "text_delta":
      case "text_end":
        editor?.setWorkingMessage("Streaming");
        break;
      default:
        break;
    }
  });

  pi.on("tool_execution_start", (event) => {
    runningTools.set(event.toolCallId, event.toolName);
    editor?.setWorkingMessage(`Running ${event.toolName}`);
  });

  pi.on("tool_execution_end", (event) => {
    runningTools.delete(event.toolCallId);
    if (runningTools.size === 0) {
      editor?.setWorkingMessage("Working");
    } else if (runningTools.size === 1) {
      const toolName = Array.from(runningTools.values())[0];
      editor?.setWorkingMessage(`Running ${toolName}`);
    } else {
      editor?.setWorkingMessage(`Running ${runningTools.size} tools`);
    }
  });

  pi.on("agent_end", () => {
    runningTools.clear();
    editor?.stopWorking();
  });

  pi.on("session_shutdown", () => {
    editor?.stopWorking();
    editor = undefined;
  });
}

function formatModel(model: { provider: string; id: string } | undefined, thinkingLevel = ""): string {
  const base = model ? `(${model.provider}) ${model.id}` : "";
  const level = thinkingLevel && thinkingLevel !== "off" ? ` • ${thinkingLevel}` : "";
  return `${base}${level}`;
}
