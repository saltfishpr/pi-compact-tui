import { describe, expect, it } from "vitest";

import { validateFd } from "./fd";

describe("validateFd", () => {
  describe("positionals", () => {
    it.each([
      [],
      ["pattern"],
      ["pattern", "./src"],
      ["-"], // 单独的 `-` 视为位置参数
      ["--", "-pattern", "./src"], // `--` 之后全部为位置参数
    ])("allows %j", (...args) => {
      expect(validateFd(args)).toBe(true);
    });
  });

  describe("short flags", () => {
    it.each([
      ["-H"], // hidden
      ["-I"], // no-ignore
      ["-L"], // follow
      ["-a"], // absolute-path
      ["-i"], // ignore-case
      ["-s"], // case-sensitive
      ["-HI"], // 合并
      ["-HIL", "pattern"],
      ["-0", "pattern"],
    ])("allows %j", (...args) => {
      expect(validateFd(args)).toBe(true);
    });

    it.each([
      ["-x"], // 未知短选项
      ["-Hx"], // 合并中包含未知
      ["-Z"],
    ])("rejects %j", (...args) => {
      expect(validateFd(args)).toBe(false);
    });
  });

  describe("short values", () => {
    it.each([
      ["-e", "js"],
      ["-ejs"], // 值紧跟同 token
      ["-t", "f"],
      ["-d", "3"],
      ["-c", "always"],
      ["-Ht", "f"], // flag + value 混合合并
    ])("allows %j", (...args) => {
      expect(validateFd(args)).toBe(true);
    });

    it.each([
      ["-e"], // 缺失取值
      ["-t"],
      ["-Ht"], // 合并末尾是取值型但缺失取值
    ])("rejects %j", (...args) => {
      expect(validateFd(args)).toBe(false);
    });
  });

  describe("long flags", () => {
    it.each([
      ["--hidden"],
      ["--no-ignore"],
      ["--case-sensitive", "pattern"],
      ["--absolute-path"],
      ["--follow"],
      ["--help"],
      ["--version"],
    ])("allows %j", (...args) => {
      expect(validateFd(args)).toBe(true);
    });

    it.each([
      ["--hidden=true"], // 无值长选项不能带 `=`
      ["--unknown"],
    ])("rejects %j", (...args) => {
      expect(validateFd(args)).toBe(false);
    });
  });

  describe("long values", () => {
    it.each([
      ["--type", "f"],
      ["--type=f"],
      ["--extension", "ts"],
      ["--max-depth=3"],
      ["--max-depth", "3"],
      ["--exclude", "node_modules"],
      ["--changed-within", "1d"],
      ["--color=always"],
      ["--threads", "4"],
      ["--type", "f", "--extension", "ts", "pattern", "./src"],
    ])("allows %j", (...args) => {
      expect(validateFd(args)).toBe(true);
    });

    it.each([
      ["--type"], // 缺失取值
      ["--max-depth"],
      ["--unknown", "value"],
    ])("rejects %j", (...args) => {
      expect(validateFd(args)).toBe(false);
    });
  });
});
