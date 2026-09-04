import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { ThinkingSelectorComponent, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { FilterableSelectorComponent } from "../pi-common/components/filterable-selector";

/** selectAuditModel opens the searchable model step of the audit setup flow. */
export function selectAuditModel(
  ctx: ExtensionContext,
  models: readonly Model<Api>[],
  currentModel: Model<Api> | undefined,
): Promise<Model<Api> | undefined> {
  return ctx.ui.custom<Model<Api> | undefined>((tui, theme, keybindings, done) => {
    const selector = new FilterableSelectorComponent<Model<Api>>({
      title: "Configure Bash Audit",
      searchHint: "Search models by provider, id, or name",
      items: models,
      searchText: (model) => `${model.provider} ${model.id} ${model.name}`,
      renderItem: (model) => `${model.id} [${model.provider}] ${model.name}`,
      initialIndex: currentModel ? models.indexOf(currentModel) : undefined,
      onSelect: done,
      onCancel: () => done(undefined),
      theme,
      keybindings,
    });
    return {
      render: (width: number) => selector.render(width),
      invalidate: () => selector.invalidate(),
      handleInput: (data: string) => {
        selector.handleInput(data);
        tui.requestRender();
      },
    };
  });
}

/** selectAuditThinkingLevel opens the supported thinking-level step of the audit setup flow. */
export function selectAuditThinkingLevel(
  ctx: ExtensionContext,
  currentLevel: ModelThinkingLevel,
  availableLevels: ModelThinkingLevel[],
): Promise<ModelThinkingLevel | undefined> {
  return ctx.ui.custom<ModelThinkingLevel | undefined>((tui, _theme, _keybindings, done) => {
    const selector = new ThinkingSelectorComponent(currentLevel, availableLevels, done, () => done(undefined));
    return {
      render: (width: number) => selector.render(width),
      invalidate: () => selector.invalidate(),
      handleInput: (data: string) => {
        selector.getSelectList().handleInput(data);
        tui.requestRender();
      },
    };
  });
}
