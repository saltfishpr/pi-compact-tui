import { CustomEditor, type ExtensionAPI, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

interface WorkingStatusIndicator {
  renderInBorder(width: number): string;
}

class CompactEditor extends CustomEditor {
  private uiTheme: Theme;
  private embeddedWorkingStatusIndicator: WorkingStatusIndicator | undefined;
  private model: string;

  constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, uiTheme: Theme, model = "") {
    super(tui, theme, keybindings, { embedWorkingStatus: true });

    this.uiTheme = uiTheme;
    this.model = model;
  }

  override setWorkingStatusIndicator(indicator: WorkingStatusIndicator | undefined) {
    this.embeddedWorkingStatusIndicator = indicator;
    this.tui.requestRender();
  }

  setModel(model: string) {
    this.model = model;
    this.tui.requestRender();
  }

  protected renderTopBorder(width: number, hiddenLineCount: number): string {
    if (width <= 0) return "";
    if (width === 1) return this.borderColor("─");

    const topLeft = this.embeddedWorkingStatusIndicator
      ? this.fitBorderLabel(this.embeddedWorkingStatusIndicator.renderInBorder(width))
      : "";
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

  private fitBorderLabel(text: string): string {
    return text ? this.borderColor(` ${text} `) : "";
  }
}

export default function (pi: ExtensionAPI) {
  let editor: CompactEditor | undefined;
  const runningTools = new Map<string, string>();

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;

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

  pi.on("agent_start", (_event, ctx) => {
    runningTools.clear();
    ctx.ui.setWorkingMessage("Working");
  });

  pi.on("turn_start", (_event, ctx) => {
    runningTools.clear();
    ctx.ui.setWorkingMessage("Working");
  });

  pi.on("message_update", (event, ctx) => {
    if (runningTools.size > 0) return;

    switch (event.assistantMessageEvent.type) {
      case "thinking_start":
      case "thinking_delta":
      case "thinking_end":
        ctx.ui.setWorkingMessage("Thinking");
        break;
      case "text_start":
      case "text_delta":
      case "text_end":
        ctx.ui.setWorkingMessage("Streaming");
        break;
      default:
        break;
    }
  });

  pi.on("tool_execution_start", (event, ctx) => {
    runningTools.set(event.toolCallId, event.toolName);
    ctx.ui.setWorkingMessage(`Running ${event.toolName}`);
  });

  pi.on("tool_execution_end", (event, ctx) => {
    runningTools.delete(event.toolCallId);
    if (runningTools.size === 0) {
      ctx.ui.setWorkingMessage("Working");
    } else if (runningTools.size === 1) {
      const toolName = Array.from(runningTools.values())[0];
      ctx.ui.setWorkingMessage(`Running ${toolName}`);
    } else {
      ctx.ui.setWorkingMessage(`Running ${runningTools.size} tools`);
    }
  });

  pi.on("agent_settled", () => {
    runningTools.clear();
  });

  pi.on("session_shutdown", () => {
    editor = undefined;
  });
}

function formatModel(model: { provider: string; id: string } | undefined, thinkingLevel = ""): string {
  const base = model ? `(${model.provider}) ${model.id}` : "";
  const level = thinkingLevel && thinkingLevel !== "off" ? ` • ${thinkingLevel}` : "";
  return `${base}${level}`;
}
