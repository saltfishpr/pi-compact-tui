import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  DynamicBorder,
  ThinkingSelectorComponent,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  fuzzyMatch,
  Input,
  Spacer,
  Text,
  type Focusable,
  type KeybindingsManager,
} from "@earendil-works/pi-tui";

const MAX_VISIBLE_MODELS = 10;

class AuditModelSelector extends Container implements Focusable {
  private readonly searchInput = new Input();
  private readonly list = new Container();
  private readonly models: Model<Api>[];
  private filteredModels: Model<Api>[];
  private selectedIndex: number;
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }

  constructor(
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    models: readonly Model<Api>[],
    currentModel: Model<Api> | undefined,
    private readonly onSelect: (model: Model<Api>) => void,
    private readonly onCancel: () => void,
  ) {
    super();
    this.models = [...models];
    this.filteredModels = this.models;
    const currentIndex = currentModel ? this.models.indexOf(currentModel) : -1;
    this.selectedIndex = currentIndex >= 0 ? currentIndex : 0;

    this.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    this.addChild(new Text(theme.fg("accent", theme.bold("Configure Bash Audit")), 1, 0));
    this.addChild(new Text(theme.fg("dim", "Search models by provider, id, or name"), 1, 0));
    this.addChild(this.searchInput);
    this.addChild(new Spacer(1));
    this.addChild(this.list);
    this.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 1, 0));
    this.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    this.updateList();
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.up")) {
      if (this.filteredModels.length > 0) {
        this.selectedIndex = this.selectedIndex === 0 ? this.filteredModels.length - 1 : this.selectedIndex - 1;
        this.updateList();
      }
      return;
    }

    if (this.keybindings.matches(data, "tui.select.down")) {
      if (this.filteredModels.length > 0) {
        this.selectedIndex = this.selectedIndex === this.filteredModels.length - 1 ? 0 : this.selectedIndex + 1;
        this.updateList();
      }
      return;
    }

    if (this.keybindings.matches(data, "tui.select.confirm")) {
      const model = this.filteredModels[this.selectedIndex];
      if (model) this.onSelect(model);
      return;
    }

    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.onCancel();
      return;
    }

    const previousQuery = this.searchInput.getValue();
    this.searchInput.handleInput(data);
    const query = this.searchInput.getValue();
    if (query !== previousQuery) this.filterModels(query);
  }

  private filterModels(query: string): void {
    const terms = query
      .trim()
      .split(/[\s/]+/)
      .filter(Boolean);
    this.filteredModels = this.models.filter((model) => {
      const searchText = `${model.provider} ${model.id} ${model.name}`;
      return terms.every((term) => fuzzyMatch(term, searchText).matches);
    });
    this.selectedIndex = 0;
    this.updateList();
  }

  private updateList(): void {
    this.list.clear();
    if (this.filteredModels.length === 0) {
      this.list.addChild(new Text(this.theme.fg("warning", "  No matching models"), 0, 0));
      return;
    }

    const startIndex = Math.max(
      0,
      Math.min(
        this.selectedIndex - Math.floor(MAX_VISIBLE_MODELS / 2),
        this.filteredModels.length - MAX_VISIBLE_MODELS,
      ),
    );
    const endIndex = Math.min(startIndex + MAX_VISIBLE_MODELS, this.filteredModels.length);
    for (let index = startIndex; index < endIndex; index++) {
      const model = this.filteredModels[index];
      if (!model) continue;
      const line = `${index === this.selectedIndex ? "→" : " "} ${model.id} [${model.provider}] ${model.name}`;
      this.list.addChild(new Text(index === this.selectedIndex ? this.theme.fg("accent", line) : line, 0, 0));
    }

    if (startIndex > 0 || endIndex < this.filteredModels.length) {
      this.list.addChild(
        new Text(this.theme.fg("dim", `  (${this.selectedIndex + 1}/${this.filteredModels.length})`), 0, 0),
      );
    }
  }
}

/** selectAuditModel opens the searchable model step of the audit setup flow. */
export function selectAuditModel(
  ctx: ExtensionContext,
  models: readonly Model<Api>[],
  currentModel: Model<Api> | undefined,
): Promise<Model<Api> | undefined> {
  return ctx.ui.custom<Model<Api> | undefined>((tui, theme, keybindings, done) => {
    const selector = new AuditModelSelector(theme, keybindings, models, currentModel, done, () => done(undefined));
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
