import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
  sliceByColumn,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  type EditorTheme,
  type TUI,
} from "@earendil-works/pi-tui";
import type { EditorConfig } from "./config";
import type { LayoutElements } from "./elements";

// A sliced native border or extension status may leave colors or a hyperlink open.
const RESET_STYLE = "\x1b[0m\x1b]8;;\x07";

type StatusIndicator = Parameters<CustomEditor["setWorkingStatusIndicator"]>[0];

/** Adds configurable labels without replacing native status, scrolling, or input behavior. */
export class CompactEditor extends CustomEditor {
  private statusIndicator: StatusIndicator;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    private elements: LayoutElements,
    private config: EditorConfig,
  ) {
    super(tui, theme, keybindings, { embedWorkingStatus: true });
  }

  override setWorkingStatusIndicator(indicator: StatusIndicator): void {
    super.setWorkingStatusIndicator(indicator);
    this.statusIndicator = indicator;
  }

  protected override renderTopBorder(width: number, hiddenLineCount: number): string {
    const border = super.renderTopBorder(width, hiddenLineCount);
    if (this.config.topRight.length === 0 || width < 5) return border;
    const [right] = this.elements.renderGroups(this.config.topRight);
    return this.addLabels(border, width, "", right, this.getStatusEnd(width, hiddenLineCount));
  }

  protected override renderBottomBorder(width: number, hiddenLineCount: number): string {
    const border = super.renderBottomBorder(width, hiddenLineCount);
    if ((this.config.bottomLeft.length === 0 && this.config.bottomRight.length === 0) || width < 5) return border;
    const [left, right] = this.elements.renderGroups(this.config.bottomLeft, this.config.bottomRight);
    return this.addLabels(border, width, left, right);
  }

  private getStatusEnd(width: number, hiddenLineCount: number): number {
    const indicator = this.statusIndicator;
    if (!indicator) return 0;
    let statusWidth = visibleWidth(indicator.renderInBorder(Math.max(1, width - 5)));
    if (statusWidth === 0) return 0;
    const overflowWidth = hiddenLineCount > 0 ? visibleWidth(` ↑ ${hiddenLineCount} more `) : 0;
    const overflowStart = Math.floor((width - overflowWidth) / 2);
    const canFitOverflow = () =>
      overflowWidth > 0 && overflowWidth + 2 <= width && overflowStart - (3 + statusWidth + 1) >= 1;
    if (overflowWidth > 0 && !canFitOverflow()) {
      statusWidth = visibleWidth(indicator.renderSpinnerInBorder(width));
    }
    if (canFitOverflow() || width >= statusWidth + 5) return 3 + statusWidth + 1;
    statusWidth = visibleWidth(indicator.renderSpinnerInBorder(width));
    return Math.min(3, Math.max(0, width - statusWidth)) + statusWidth;
  }

  /**
   * Inserts padded labels into the border's leading and trailing horizontal strokes.
   * The left label takes priority; both labels are truncated to preserve native border content.
   * statusEnd marks the exclusive end column of a status indicator, whose trailing strokes
   * must not be mistaken for available space. Resets isolate label styles and hyperlinks.
   */
  private addLabels(border: string, width: number, left: string, right: string, statusEnd = 0): string {
    if (!left && !right) return border;
    const plainBorder = stripTerminalSequences(border);
    const leadingFill = plainBorder.match(/^─*/)?.[0].length ?? 0;
    const trailingFill = plainBorder.match(/─*$/)?.[0].length ?? 0;

    // Leave a horizontal stroke at both ends of each available run, plus label padding.
    const leftText = truncateToWidth(left, Math.max(0, leadingFill - 4), "");
    const leftWidth = visibleWidth(leftText);
    const leftEnd = leftWidth > 0 ? leftWidth + 3 : 0;
    // Custom indicator frames may themselves end in ─, so glyph matching alone is insufficient.
    const rightBudget = Math.max(0, Math.min(trailingFill - 4, width - Math.max(leftEnd, statusEnd) - 4));
    const rightText = truncateToWidth(right, rightBudget, "");
    const rightWidth = visibleWidth(rightText);
    const labels = [
      { start: 1, text: leftText, width: leftWidth },
      { start: width - rightWidth - 3, text: rightText, width: rightWidth },
    ].filter((label) => label.width > 0);
    if (labels.length === 0) return border;

    let result = "";
    let cursor = 0;
    for (const label of labels) {
      result += sliceByColumn(border, cursor, label.start - cursor, true);
      result += `${RESET_STYLE} ${label.text}${RESET_STYLE} `;
      cursor = label.start + label.width + 2;
    }
    return result + sliceByColumn(border, cursor, width - cursor, true);
  }
}
