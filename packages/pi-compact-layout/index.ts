import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config";
import { CompactEditor } from "./editor";
import { LayoutElements } from "./elements";
import { CompactFooter } from "./footer";
import { migrateConfig } from "./migrate";

export default function (pi: ExtensionAPI) {
  migrateConfig();

  let workingMessage: string | undefined;
  const activeTools = new Set<string>();
  const setWorkingMessage = (ctx: ExtensionContext, message?: string) => {
    if (ctx.mode !== "tui" || workingMessage === message) return;
    workingMessage = message;
    ctx.ui.setWorkingMessage(message);
  };

  pi.on("agent_start", (_event, ctx) => setWorkingMessage(ctx, "Working…"));
  pi.on("turn_start", (_event, ctx) => setWorkingMessage(ctx, "Working…"));
  pi.on("message_start", (event, ctx) => {
    if (event.message.role === "assistant") setWorkingMessage(ctx, "Waiting…");
  });
  pi.on("message_update", (event, ctx) => {
    switch (event.assistantMessageEvent.type) {
      case "thinking_start":
      case "thinking_delta":
        setWorkingMessage(ctx, "Thinking…");
        break;
      case "text_start":
      case "text_delta":
        setWorkingMessage(ctx, "Streaming…");
        break;
      case "toolcall_start":
      case "toolcall_delta":
        setWorkingMessage(ctx, "Preparing tools…");
        break;
    }
  });
  pi.on("message_end", (event, ctx) => {
    if (event.message.role === "assistant") setWorkingMessage(ctx, "Working…");
  });
  pi.on("tool_execution_start", (event, ctx) => {
    if (ctx.mode !== "tui") return;
    activeTools.add(event.toolCallId);
    setWorkingMessage(ctx, "Running tools…");
  });
  pi.on("tool_execution_end", (event, ctx) => {
    if (ctx.mode !== "tui") return;
    activeTools.delete(event.toolCallId);
    if (activeTools.size === 0) setWorkingMessage(ctx, "Working…");
  });
  pi.on("agent_end", (_event, ctx) => {
    activeTools.clear();
    setWorkingMessage(ctx);
  });
  pi.on("agent_settled", (_event, ctx) => {
    activeTools.clear();
    setWorkingMessage(ctx);
  });

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    activeTools.clear();
    setWorkingMessage(ctx);
    const config = loadConfig();
    // Keep the factory even for an empty footer: it provides native Git and extension status data.
    ctx.ui.setFooter((_tui, _theme, footerData) => {
      const elements = new LayoutElements({
        ctx,
        footerData,
        config,
        getAutoCompactEnabled: () => pi.getSettings().compaction?.enabled ?? true,
        getThinkingLevel: () => pi.getThinkingLevel(),
      });
      ctx.ui.setEditorComponent(
        (tui, theme, keybindings) => new CompactEditor(tui, theme, keybindings, elements, config.editor),
      );
      return new CompactFooter(elements, config.footer);
    });
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    activeTools.clear();
    setWorkingMessage(ctx);
    ctx.ui.setFooter(undefined);
    ctx.ui.setEditorComponent(undefined);
  });
}
