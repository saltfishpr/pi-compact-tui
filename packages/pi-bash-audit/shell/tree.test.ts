import { describe, expect, it } from "vitest";

import { validateTree } from "./tree";

describe("validateTree", () => {
  describe("positionals", () => {
    it.each([[], ["./src"], ["a", "b"]])("allows %j", (...args) => {
      expect(validateTree(args)).toBe(true);
    });
  });

  describe("short flags", () => {
    it.each([
      ["-a"],
      ["-d"],
      ["-f"],
      ["-C"],
      ["-adf"], // 合并
      ["-a", "./src"],
    ])("allows %j", (...args) => {
      expect(validateTree(args)).toBe(true);
    });

    it.each([["-z"], ["-aZ"]])("rejects %j", (...args) => {
      expect(validateTree(args)).toBe(false);
    });
  });

  describe("short values", () => {
    it.each([["-L", "3"], ["-L3"], ["-I", "node_modules"], ["-P", "*.ts"]])("allows %j", (...args) => {
      expect(validateTree(args)).toBe(true);
    });

    it.each([["-L"], ["-I"]])("rejects %j", (...args) => {
      expect(validateTree(args)).toBe(false);
    });
  });

  describe("long flags", () => {
    it.each([["--dirsfirst"], ["--gitignore"], ["--noreport"], ["--help"], ["--version"]])("allows %j", (...args) => {
      expect(validateTree(args)).toBe(true);
    });

    it.each([["--dirsfirst=yes"], ["--unknown"]])("rejects %j", (...args) => {
      expect(validateTree(args)).toBe(false);
    });
  });

  describe("long values", () => {
    it.each([
      ["--charset", "utf-8"],
      ["--charset=utf-8"],
      ["--sort", "name"],
      ["--filelimit", "100"],
      ["--timefmt", "%Y"],
    ])("allows %j", (...args) => {
      expect(validateTree(args)).toBe(true);
    });

    it.each([["--charset"], ["--unknown", "value"]])("rejects %j", (...args) => {
      expect(validateTree(args)).toBe(false);
    });
  });
});
