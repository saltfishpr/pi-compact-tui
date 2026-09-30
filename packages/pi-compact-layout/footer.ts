import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { type FooterLineConfig } from "./config";
import { LayoutElements } from "./elements";

/** Configurable footer using the same element formatter as the editor. */
export class CompactFooter implements Component {
  constructor(
    private elements: LayoutElements,
    private lines: FooterLineConfig[],
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    if (width <= 0 || this.lines.length === 0) return [];
    const groups = this.elements.renderGroups(...this.lines.flatMap((line) => [line.left, line.right]));
    const rendered: string[] = [];
    for (let i = 0; i < groups.length; i += 2) {
      const left = groups[i];
      const right = groups[i + 1];
      if (left || right) rendered.push(this.composeLine(left, right, width));
    }
    return rendered;
  }

  private composeLine(left: string, right: string, width: number): string {
    const leftWidth = visibleWidth(left);
    const rightWidth = visibleWidth(right);
    const ellipsis = this.elements.theme.fg("dim", "...");
    if (!right) return truncateToWidth(left, width, ellipsis);
    if (!left) {
      if (rightWidth >= width) return truncateToWidth(right, width, "");
      return " ".repeat(width - rightWidth) + right;
    }
    const minPadding = 2;
    if (leftWidth + minPadding + rightWidth <= width) {
      return left + " ".repeat(width - leftWidth - rightWidth) + right;
    }
    const availableForRight = width - leftWidth - minPadding;
    if (availableForRight > 0) {
      const truncatedRight = truncateToWidth(right, availableForRight, "");
      return left + " ".repeat(width - leftWidth - visibleWidth(truncatedRight)) + truncatedRight;
    }
    return truncateToWidth(left, width, ellipsis);
  }
}
