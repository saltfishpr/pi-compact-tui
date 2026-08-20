import {
  DynamicBorder,
  keyHint,
  rawKeyHint,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, getKeybindings, Key, matchesKey, Spacer, Text, TruncatedText } from "@earendil-works/pi-tui";

/** Configuration for a scrollable selector. */
export type ScrollableSelectorOptions = {
  /** Maximum number of wrapped message rows to display. */
  maxMessageHeight: number;
  /** Maximum number of options to display at once. */
  maxVisibleOptions: number;
  /** Theme used to match pi's built-in selector. */
  theme: Theme;
  /** Keybindings used to match pi's built-in selector. */
  keybindings?: KeybindingsManager;
};

class ScrollableMessage extends Container {
  private readonly text: Text;
  private scrollTop = 0;
  private contentHeight = 0;

  constructor(
    message: string,
    private readonly maxHeight: number,
    private readonly theme: Theme,
  ) {
    super();
    this.text = new Text(message, 1, 0);
    this.addChild(this.text);
  }

  scrollBy(lines: number): void {
    const maxScrollTop = Math.max(0, this.contentHeight - this.maxHeight);
    this.scrollTop = Math.max(0, Math.min(maxScrollTop, this.scrollTop + lines));
  }

  override render(width: number): string[] {
    const lines = this.text.render(width);
    this.contentHeight = lines.length;
    const maxScrollTop = Math.max(0, this.contentHeight - this.maxHeight);
    this.scrollTop = Math.min(this.scrollTop, maxScrollTop);
    const visibleLines = lines.slice(this.scrollTop, this.scrollTop + this.maxHeight);
    if (maxScrollTop > 0) {
      visibleLines.push(this.theme.fg("dim", ` (${this.scrollTop + 1}/${this.contentHeight})`));
    }
    return visibleLines;
  }
}

/**
 * ScrollableSelectorComponent displays a fixed title, a height-limited message, and a windowed option list.
 * Construct it from a `ctx.ui.custom()` factory with that callback's theme and keybindings.
 */
export class ScrollableSelectorComponent extends Container {
  private readonly message: ScrollableMessage;
  private readonly listContainer = new Container();
  private selectedIndex = 0;

  constructor(
    title: string,
    message: string,
    private readonly options: readonly string[],
    private readonly onSelect: (option: string) => void,
    private readonly onCancel: () => void,
    private readonly opts: ScrollableSelectorOptions,
  ) {
    super();

    this.message = new ScrollableMessage(message, normalizeLimit(opts.maxMessageHeight), opts.theme);
    this.addChild(new DynamicBorder((text: string) => opts.theme.fg("accent", text)));
    this.addChild(new Spacer(1));
    this.addChild(new TruncatedText(opts.theme.fg("accent", opts.theme.bold(title)), 1, 0));
    this.addChild(new Spacer(1));
    this.addChild(this.message);
    this.addChild(new Spacer(1));
    this.addChild(this.listContainer);
    this.addChild(new Spacer(1));
    this.addChild(
      new Text(
        rawKeyHint("↑↓", "navigate") +
          "  " +
          rawKeyHint("shift+↑↓", "scroll message") +
          "  " +
          keyHint("tui.select.confirm", "select") +
          "  " +
          keyHint("tui.select.cancel", "cancel"),
        1,
        0,
      ),
    );
    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder((text: string) => opts.theme.fg("accent", text)));
    this.updateList();
  }

  override invalidate(): void {
    super.invalidate();
    this.updateList();
  }

  handleInput(keyData: string): void {
    const wheelDirection = getWheelDirection(keyData);
    if (wheelDirection !== undefined) {
      this.message.scrollBy(wheelDirection);
      return;
    }
    if (matchesKey(keyData, Key.shift("up"))) {
      this.message.scrollBy(-1);
      return;
    }
    if (matchesKey(keyData, Key.shift("down"))) {
      this.message.scrollBy(1);
      return;
    }

    const keybindings = this.opts.keybindings ?? getKeybindings();
    if (keybindings.matches(keyData, "tui.select.up") || keyData === "k") {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.updateList();
    } else if (keybindings.matches(keyData, "tui.select.down") || keyData === "j") {
      this.selectedIndex = Math.min(this.options.length - 1, this.selectedIndex + 1);
      this.updateList();
    } else if (keybindings.matches(keyData, "tui.select.confirm") || keyData === "\n") {
      const selected = this.options[this.selectedIndex];
      if (selected) this.onSelect(selected);
    } else if (keybindings.matches(keyData, "tui.select.cancel")) {
      this.onCancel();
    }
  }

  private updateList(): void {
    this.listContainer.clear();
    const maxVisibleOptions = normalizeLimit(this.opts.maxVisibleOptions);
    const startIndex = Math.min(
      Math.max(0, this.selectedIndex - Math.floor(maxVisibleOptions / 2)),
      Math.max(0, this.options.length - maxVisibleOptions),
    );
    const endIndex = Math.min(this.options.length, startIndex + maxVisibleOptions);

    for (let index = startIndex; index < endIndex; index++) {
      const option = this.options[index]!;
      const isSelected = index === this.selectedIndex;
      const text = isSelected
        ? this.opts.theme.fg("accent", "→ ") + this.opts.theme.fg("accent", option)
        : `  ${this.opts.theme.fg("text", option)}`;
      this.listContainer.addChild(new Text(text, 1, 0));
    }

    if (startIndex > 0 || endIndex < this.options.length) {
      this.listContainer.addChild(
        new Text(this.opts.theme.fg("dim", `  (${this.selectedIndex + 1}/${this.options.length})`), 1, 0),
      );
    }
  }
}

function normalizeLimit(limit: number): number {
  return Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1;
}

function getWheelDirection(keyData: string): number | undefined {
  const wheel = /^\x1b\[<(\d+);\d+;\d+[Mm]$/.exec(keyData);
  if (!wheel) return undefined;

  const button = Number.parseInt(wheel[1]!, 10);
  if ((button & 64) === 0) return undefined;
  return (button & 3) === 0 ? -1 : 1;
}
