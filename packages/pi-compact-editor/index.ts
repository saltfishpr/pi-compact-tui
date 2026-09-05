import { CustomEditor, type ExtensionAPI, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { Loader, visibleWidth, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

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

  protected renderTopBorder(width: number, hiddenLineCount: number): string {
    if (width <= 0) return "";
    if (width === 1) return this.borderColor("─");

    const topLeft = this.isWorking ? this.fitBorderLabel(this.renderWorkingLoader(width)) : "";
    const topMiddle = hiddenLineCount > 0 ? this.fitBorderLabel(`↑ ${hiddenLineCount} more`) : "";
    const topRight = this.model ? this.uiTheme.fg("dim", ` ${this.model} `) : "";

    const middleWidth = visibleWidth(topMiddle);
    const labels = [
      { text: topLeft, start: 1 },
      { text: topMiddle, start: Math.floor((width - middleWidth) / 2) },
      { text: topRight, start: width - visibleWidth(topRight) - 1 },
    ].filter((label) => label.text);

    let cursor = 0;
    for (const label of labels) {
      if (label.start < 0 || label.start - cursor < (cursor === 0 ? 0 : 3)) {
        return super.renderTopBorder(width, hiddenLineCount);
      }
      cursor = label.start + visibleWidth(label.text);
    }
    if (cursor > width) return super.renderTopBorder(width, hiddenLineCount);

    let border = "";
    cursor = 0;
    for (const label of labels) {
      border += this.borderColor("─".repeat(label.start - cursor)) + label.text;
      cursor = label.start + visibleWidth(label.text);
    }
    return border + this.borderColor("─".repeat(width - cursor));
  }

  private renderWorkingLoader(width: number): string {
    return this.workingLoader.render(width).join("").trim();
  }

  private fitBorderLabel(text: string): string {
    return text ? this.borderColor(` ${text} `) : "";
  }
}

export default function (pi: ExtensionAPI) {
  let editor: CompactEditor | undefined;
  const runningTools = new Map<string, string>();

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;

    ctx.ui.setWorkingVisible(false);
    const model = formatModel(ctx.model, pi.getThinkingLevel());
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      editor = new CompactEditor(tui, theme, keybindings, ctx.ui.theme, model);
      return editor;
    });
  });

  pi.on("model_select", (event, ctx) => {
    if (!ctx.hasUI) return;

    editor?.setModel(formatModel(event.model, pi.getThinkingLevel()));
  });

  pi.on("thinking_level_select", (event, ctx) => {
    if (!ctx.hasUI) return;

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

  pi.on("agent_settled", () => {
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
