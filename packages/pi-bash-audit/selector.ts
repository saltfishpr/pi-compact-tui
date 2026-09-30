import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { ThinkingSelectorComponent, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { FilterableSelectorComponent } from "../pi-common/components/filterable-selector";

/** selectAuditModel opens the searchable model step of the audit setup flow. */
export function selectAuditModel(
  ctx: ExtensionContext,
  models: readonly Model<Api>[],
  currentModel: Model<Api> | undefined,
): Promise<Model<Api> | undefined> {
  return ctx.ui.custom<Model<Api> | undefined>((_tui, theme, keybindings, done) => {
    return new FilterableSelectorComponent<Model<Api>>({
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
  });
}

/** selectAuditThinkingLevel opens the supported thinking-level step of the audit setup flow. */
export function selectAuditThinkingLevel(
  ctx: ExtensionContext,
  currentLevel: ModelThinkingLevel,
  availableLevels: ModelThinkingLevel[],
): Promise<ModelThinkingLevel | undefined> {
  return ctx.ui.custom<ModelThinkingLevel | undefined>((_tui, _theme, _keybindings, done) => {
    return new ThinkingSelectorComponent(currentLevel, availableLevels, done, () => done(undefined));
  });
}
