import {
  DynamicBorder,
  keyHint,
  rawKeyHint,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  CURSOR_MARKER,
  fuzzyFilter,
  getKeybindings,
  Input,
  Spacer,
  Text,
  truncateToWidth,
  visibleWidth,
  type Focusable,
} from "@earendil-works/pi-tui";

/** Configuration for a filterable selector. */
export type FilterableSelectorOptions<T> = {
  /** Bold accent title shown above the search input. */
  title: string;
  /** Dim hint displayed in the empty search input. */
  searchHint: string;
  /** Full item list to filter. */
  items: readonly T[];
  /** Text of an item that participates in fuzzy matching. */
  searchText: (item: T) => string;
  /** Display text of an item (the selected arrow prefix is added by the component). */
  renderItem: (item: T) => string;
  /** Index selected when no filter has been applied yet. */
  initialIndex?: number;
  /** Called with the highlighted item on confirm. */
  onSelect: (item: T) => void;
  /** Called on cancel. */
  onCancel: () => void;
  theme: Theme;
  /** Keybindings used to match pi's built-in selector; defaults to getKeybindings(). */
  keybindings?: KeybindingsManager;
  /** Maximum number of options to display at once; defaults to 10. */
  maxVisible?: number;
  /** Message shown when nothing matches; defaults to "No matching items". */
  emptyText?: string;
};

/**
 * FilterableSelectorComponent displays a search input over a fuzzy-filtered, windowed option list.
 * Construct it from a `ctx.ui.custom()` factory with that callback's theme and keybindings.
 */
export class FilterableSelectorComponent<T> extends Container implements Focusable {
  private readonly searchInput: PlaceholderInput;
  private readonly listContainer = new Container();
  private readonly items: readonly T[];
  private filteredItems: readonly T[];
  private selectedIndex: number;
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }

  constructor(private readonly opts: FilterableSelectorOptions<T>) {
    super();
    this.items = opts.items;
    this.searchInput = new PlaceholderInput(opts.searchHint, opts.theme);
    this.filteredItems = this.items;
    this.selectedIndex = normalizeIndex(opts.initialIndex, this.items.length);

    this.addChild(new DynamicBorder((text: string) => opts.theme.fg("accent", text)));
    this.addChild(new Text(opts.theme.fg("accent", opts.theme.bold(opts.title)), 2, 0));
    this.addChild(this.searchInput);
    this.addChild(new Spacer(1));
    this.addChild(this.listContainer);
    this.addChild(new Spacer(1));
    this.addChild(
      new Text(
        rawKeyHint("↑↓", "navigate") +
          "  " +
          keyHint("tui.select.confirm", "select") +
          "  " +
          keyHint("tui.select.cancel", "cancel"),
        1,
        0,
      ),
    );
    this.addChild(new DynamicBorder((text: string) => opts.theme.fg("accent", text)));
    this.updateList();
  }

  handleInput(keyData: string): void {
    const keybindings = this.opts.keybindings ?? getKeybindings();

    if (keybindings.matches(keyData, "tui.select.up")) {
      if (this.filteredItems.length > 0) {
        this.selectedIndex = this.selectedIndex === 0 ? this.filteredItems.length - 1 : this.selectedIndex - 1;
        this.updateList();
      }
      return;
    }

    if (keybindings.matches(keyData, "tui.select.down")) {
      if (this.filteredItems.length > 0) {
        this.selectedIndex = this.selectedIndex === this.filteredItems.length - 1 ? 0 : this.selectedIndex + 1;
        this.updateList();
      }
      return;
    }

    if (keybindings.matches(keyData, "tui.select.confirm")) {
      const selected = this.filteredItems[this.selectedIndex];
      if (selected !== undefined) this.opts.onSelect(selected);
      return;
    }

    if (keybindings.matches(keyData, "tui.select.cancel")) {
      this.opts.onCancel();
      return;
    }

    const previousQuery = this.searchInput.getValue();
    this.searchInput.handleInput(keyData);
    const query = this.searchInput.getValue();
    if (query !== previousQuery) this.filterItems(query);
  }

  private filterItems(query: string): void {
    this.filteredItems = fuzzyFilter([...this.items], query, (item) => this.opts.searchText(item));
    this.selectedIndex = 0;
    this.updateList();
  }

  private updateList(): void {
    this.listContainer.clear();
    const theme = this.opts.theme;
    if (this.filteredItems.length === 0) {
      this.listContainer.addChild(
        new Text(theme.fg("warning", `  ${this.opts.emptyText ?? "No matching items"}`), 0, 0),
      );
      return;
    }

    const maxVisible = normalizeLimit(this.opts.maxVisible ?? 10);
    const startIndex = Math.min(
      Math.max(0, this.selectedIndex - Math.floor(maxVisible / 2)),
      Math.max(0, this.filteredItems.length - maxVisible),
    );
    const endIndex = Math.min(this.filteredItems.length, startIndex + maxVisible);

    for (let index = startIndex; index < endIndex; index++) {
      const item = this.filteredItems[index];
      if (item === undefined) continue;
      const isSelected = index === this.selectedIndex;
      const line = `${isSelected ? "→" : " "} ${this.opts.renderItem(item)}`;
      this.listContainer.addChild(new Text(isSelected ? theme.fg("accent", line) : line, 0, 0));
    }

    if (startIndex > 0 || endIndex < this.filteredItems.length) {
      this.listContainer.addChild(
        new Text(theme.fg("dim", `  (${this.selectedIndex + 1}/${this.filteredItems.length})`), 0, 0),
      );
    }
  }
}

class PlaceholderInput extends Input {
  constructor(
    private readonly placeholder: string,
    private readonly theme: Theme,
  ) {
    super();
  }

  render(width: number): string[] {
    if (this.getValue()) return super.render(width);

    const prompt = "> ";
    const availableWidth = width - prompt.length;
    if (availableWidth <= 0) return [prompt];

    const hint = truncateToWidth(this.placeholder, availableWidth);
    const firstCharacter = [...hint][0] ?? " ";
    const rest = hint.slice(firstCharacter.length);
    const marker = this.focused ? CURSOR_MARKER : "";
    const cursor = `\x1b[7m${firstCharacter}\x1b[27m`;
    const padding = " ".repeat(Math.max(0, availableWidth - visibleWidth(hint)));
    return [`${prompt}${this.theme.fg("dim", `${marker}${cursor}${rest}`)}${padding}`];
  }
}

function normalizeIndex(index: number | undefined, length: number): number {
  if (index === undefined || !Number.isInteger(index) || index < 0 || index >= length) return 0;
  return index;
}

function normalizeLimit(limit: number): number {
  return Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1;
}
