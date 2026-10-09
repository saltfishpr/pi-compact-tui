import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { ThinkingSelectorComponent, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { FilterableSelectorComponent } from "../pi-common/components/filterable-selector";
import type { AuditModel } from "./auditor";

/** selectAuditModel opens the searchable model step of the audit setup flow. */
export function selectAuditModel(
  ctx: ExtensionContext,
  models: readonly AuditModel[],
  currentModel: AuditModel | undefined,
): Promise<AuditModel | undefined> {
  return ctx.ui.custom<AuditModel | undefined>((_tui, theme, keybindings, done) => {
    return new FilterableSelectorComponent<AuditModel>({
      title: "Configure Bash Audit",
      searchHint: "Search models by provider, id, or name",
      items: models,
      searchText: (model) => `${model.provider} ${model.id} ${model.name}`,
      renderItem: (model) =>
        `${model.id} [${model.provider}] ${model.name}${model.type === "classifier" ? " (classifier)" : ""}`,
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
