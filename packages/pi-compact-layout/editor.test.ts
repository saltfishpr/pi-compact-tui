import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import { CompactEditor } from "./editor";

// Exercise the pure border transformation without initializing the interactive editor.
const editor = Object.create(CompactEditor.prototype) as {
  addLabels(border: string, width: number, left: string, right: string, statusEnd?: number): string;
};

function render(border: string, left = "", right = "", statusEnd = 0): string {
  return editor.addLabels(border, visibleWidth(border), left, right, statusEnd);
}

const reset = "\x1b[0m\x1b]8;;\x07";

describe("CompactEditor.addLabels", () => {
  it("returns the original border when no labels are supplied", () => {
    const border = "\x1b[36m────────────────────\x1b[0m";
    expect(render(border)).toBe(border);
  });

  it.each([
    ["left", "", "─ left " + "─".repeat(13)],
    ["", "right", "─".repeat(12) + " right ─"],
    ["left", "right", "─ left ───── right ─"],
  ])("places labels with padding and an outer stroke (%s, %s)", (left, right, expected) => {
    const result = render("─".repeat(20), left, right);
    expect(stripTerminalSequences(result)).toBe(expected);
    expect(visibleWidth(result)).toBe(20);
  });

  it("gives the left label priority and truncates without an ellipsis", () => {
    const result = render("─".repeat(12), "abcdefghijk", "right");
    expect(stripTerminalSequences(result)).toBe("─ abcdefgh ─");
    expect(visibleWidth(result)).toBe(12);
  });

  it("truncates the right label to the remaining space", () => {
    const result = render("─".repeat(16), "left", "abcdefghijk");
    expect(stripTerminalSequences(result)).toBe("─ left ─ abcde ─");
    expect(visibleWidth(result)).toBe(16);
  });

  it.each(["", "─", "──", "───", "────", "─ status ─"])(
    "returns the original border when neither label fits: %s",
    (border) => {
      expect(render(border, "left", "right")).toBe(border);
    },
  );

  it("preserves native content between the leading and trailing strokes", () => {
    const border = "────── ↑ 3 more ──────────";
    const result = render(border, "abcdef", "123456789");
    expect(stripTerminalSequences(result)).toBe("─ ab ─ ↑ 3 more ─ 123456 ─");
    expect(visibleWidth(result)).toBe(visibleWidth(border));
  });

  it("protects status frames ending in a horizontal stroke using statusEnd", () => {
    const border = "─── busy─" + "─".repeat(11);
    const result = render(border, "", "abcdefghij", 10);
    expect(stripTerminalSequences(result)).toBe("─── busy─── abcdef ─");
    expect(visibleWidth(result)).toBe(20);
  });

  it("omits a right label when the status occupies its available space", () => {
    const border = "─".repeat(20);
    expect(render(border, "", "right", 16)).toBe(border);
  });

  it("uses terminal columns rather than string length for wide characters", () => {
    const result = render("─".repeat(14), "中文测试", "右侧");
    expect(stripTerminalSequences(result)).toBe("─ 中文测试 ───");
    expect(visibleWidth(result)).toBe(14);
  });

  it("resets styles and closes hyperlinks before and after each label", () => {
    const border = "\x1b[36m" + "─".repeat(20) + "\x1b[0m";
    const label = "\x1b[31m\x1b]8;;https://example.com\x07link";
    const result = render(border, label, "right");
    expect(result).toContain(`${reset} ${label}${reset} `);
    expect(result).toContain(`${reset} right${reset} `);
    expect(stripTerminalSequences(result)).toBe("─ link ───── right ─");
    expect(visibleWidth(result)).toBe(20);
    expect(result).toContain("\x1b[36m");
  });
});
