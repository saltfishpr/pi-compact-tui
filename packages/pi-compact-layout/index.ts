import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config";
import { CompactEditor } from "./editor";
import { LayoutElements } from "./elements";
import { CompactFooter } from "./footer";
import { migrateConfig } from "./migrate";

export default function (pi: ExtensionAPI) {
  migrateConfig();

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
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
    ctx.ui.setFooter(undefined);
    ctx.ui.setEditorComponent(undefined);
  });
}
