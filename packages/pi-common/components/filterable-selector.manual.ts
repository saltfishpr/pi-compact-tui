import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FilterableSelectorComponent } from "./filterable-selector";

type TestItem = { provider: string; id: string; name: string };

const ITEMS: TestItem[] = [
  { provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus 4.5" },
  { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
  { provider: "anthropic", id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
  { provider: "openai", id: "gpt-5.2", name: "GPT-5.2" },
  { provider: "openai", id: "gpt-5.2-mini", name: "GPT-5.2 mini" },
  { provider: "openai", id: "gpt-5.1-codex", name: "GPT-5.1 Codex" },
  { provider: "google", id: "gemini-3-pro", name: "Gemini 3 Pro" },
  { provider: "google", id: "gemini-3-flash", name: "Gemini 3 Flash" },
  { provider: "volcengine", id: "doubao-seed-code", name: "Doubao Seed Code" },
  { provider: "volcengine", id: "doubao-1.5-pro", name: "Doubao 1.5 Pro" },
  { provider: "deepseek", id: "deepseek-v3.2", name: "DeepSeek V3.2" },
  { provider: "deepseek", id: "deepseek-r1", name: "DeepSeek R1" },
];

// pi -ne -e packages/pi-common/components/filterable-selector.manual.ts
export default function (pi: ExtensionAPI) {
  pi.registerCommand("test-filter-selector", {
    description: "Test FilterableSelectorComponent",
    async handler(_args, ctx) {
      if (ctx.mode !== "tui") return;

      const selected = await ctx.ui.custom<TestItem | undefined>((tui, theme, keybindings, done) => {
        const selector = new FilterableSelectorComponent<TestItem>({
          title: "Test Filterable Selector",
          searchHint: "Search by provider, id, or name (e.g. \"anthropic opus\")",
          items: ITEMS,
          searchText: (item) => `${item.provider} ${item.id} ${item.name}`,
          renderItem: (item) => `${item.id} [${item.provider}] ${item.name}`,
          initialIndex: 2,
          onSelect: done,
          onCancel: () => done(undefined),
          theme,
          keybindings,
          maxVisible: 5,
        });

        return {
          render: (width) => selector.render(width),
          invalidate: () => selector.invalidate(),
          handleInput: (data) => {
            selector.handleInput(data);
            tui.requestRender();
          },
        };
      });

      ctx.ui.notify(`选择结果：${selected ? `${selected.id} [${selected.provider}]` : "取消"}`, "info");
    },
  });
}
