import { describe, expect, it } from "vitest";

import { validateFind } from "./find";

describe("validateFind", () => {
  describe("paths only", () => {
    it.each([[], ["."], [".", "./src"]])("allows %j", (...args) => {
      expect(validateFind(args)).toBe(true);
    });
  });

  describe("global options", () => {
    it.each([["-H"], ["-L"], ["-P"], ["-O2"], ["-D", "search"], [".", "-L", "-name", "*.ts"]])(
      "allows %j",
      (...args) => {
        expect(validateFind(args)).toBe(true);
      },
    );

    it.each([
      ["-D"], // 缺少参数
      ["-X"],
      ["-OO"],
    ])("rejects %j", (...args) => {
      expect(validateFind(args)).toBe(false);
    });
  });

  describe("zero-argument expressions", () => {
    it.each([
      [".", "-print"],
      [".", "-print0"],
      [".", "-empty"],
      [".", "-type", "f", "-a", "-print"],
      [".", "!", "-name", "*.md"],
      [".", "(", "-name", "*.ts", "-o", "-name", "*.tsx", ")"],
    ])("allows %j", (...args) => {
      expect(validateFind(args)).toBe(true);
    });
  });

  describe("one-argument expressions", () => {
    it.each([
      [".", "-name", "*.ts"],
      [".", "-type", "f"],
      [".", "-maxdepth", "3"],
      [".", "-mtime", "-7", "-print"],
      [".", "-regex", ".*\\.ts$"],
    ])("allows %j", (...args) => {
      expect(validateFind(args)).toBe(true);
    });

    it.each([
      [".", "-name"], // 缺失取值
      [".", "-type"],
      [".", "-maxdepth"],
    ])("rejects %j", (...args) => {
      expect(validateFind(args)).toBe(false);
    });
  });

  describe("unsupported actions", () => {
    it.each([
      [".", "-delete"],
      [".", "-exec", "rm", "{}", ";"],
      [".", "-ok", "rm", "{}", ";"],
      [".", "-fprint", "out.txt"],
      [".", "-unknown"],
    ])("rejects %j", (...args) => {
      expect(validateFind(args)).toBe(false);
    });
  });
});
