import { describe, expect, it } from "vitest";

import { validateRg } from "./rg";

describe("validateRg", () => {
  describe("positionals", () => {
    it.each([[], ["pattern"], ["pattern", "./src"], ["--", "-notaflag"]])("allows %j", (...args) => {
      expect(validateRg(args)).toBe(true);
    });
  });

  describe("short flags", () => {
    it.each([
      ["-i", "pattern"],
      ["-n", "pattern"],
      ["-l", "pattern"],
      ["-c", "pattern"],
      ["-inw", "pattern"], // 合并
      ["-F", "text"],
    ])("allows %j", (...args) => {
      expect(validateRg(args)).toBe(true);
    });

    it.each([["-Z"], ["-iZ"]])("rejects %j", (...args) => {
      expect(validateRg(args)).toBe(false);
    });
  });

  describe("short values", () => {
    it.each([
      ["-A", "3", "pattern"],
      ["-A3", "pattern"],
      ["-B", "2", "pattern"],
      ["-C", "2", "pattern"],
      ["-e", "pat1", "-e", "pat2"],
      ["-t", "ts", "pattern"],
      ["-g", "*.ts", "pattern"],
    ])("allows %j", (...args) => {
      expect(validateRg(args)).toBe(true);
    });

    it.each([
      ["-A"],
      ["-e"],
      ["-iA"], // 合并末尾取值缺失
    ])("rejects %j", (...args) => {
      expect(validateRg(args)).toBe(false);
    });
  });

  describe("long flags", () => {
    it.each([
      ["--ignore-case", "pattern"],
      ["--hidden", "pattern"],
      ["--no-ignore", "pattern"],
      ["--json", "pattern"],
      ["--files"],
      ["--help"],
      ["--version"],
    ])("allows %j", (...args) => {
      expect(validateRg(args)).toBe(true);
    });

    it.each([["--ignore-case=true"], ["--unknown"]])("rejects %j", (...args) => {
      expect(validateRg(args)).toBe(false);
    });
  });

  describe("long values", () => {
    it.each([
      ["--type", "ts", "pattern"],
      ["--type=ts", "pattern"],
      ["--max-count", "10", "pattern"],
      ["--glob", "*.ts", "pattern"],
      ["--color=never"],
      ["--regexp", "foo"],
      ["--max-depth=3", "pattern"],
    ])("allows %j", (...args) => {
      expect(validateRg(args)).toBe(true);
    });

    it.each([["--type"], ["--max-count"], ["--unknown", "value"]])("rejects %j", (...args) => {
      expect(validateRg(args)).toBe(false);
    });
  });
});
