import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ScrollableSelectorComponent } from "./scrollable-selector";

// pi -ne -e packages/pi-common/components/scrollable-selector.manual.ts
export default function (pi: ExtensionAPI) {
  pi.registerCommand("test-scroll-selector", {
    description: "Test ScrollableSelectorComponent",
    async handler(_args, ctx) {
      if (ctx.mode !== "tui") return;

      const message = Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 行测试消息`).join("\n");
      const options = Array.from({ length: 20 }, (_, i) => `选项 ${i + 1}`);

      const selected = await ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
        const selector = new ScrollableSelectorComponent(
          "这是一个非常长的标题，用于验证标题是否会被截断而非撑高组件",
          message,
          options,
          done,
          () => done(undefined),
          {
            maxMessageHeight: 10,
            maxVisibleOptions: 5,
            theme,
            keybindings,
          },
        );

        return {
          render: (width) => selector.render(width),
          invalidate: () => selector.invalidate(),
          handleInput: (data) => {
            selector.handleInput(data);
            tui.requestRender();
          },
        };
      });

      ctx.ui.notify(`选择结果：${selected ?? "取消"}`, "info");
    },
  });
}
