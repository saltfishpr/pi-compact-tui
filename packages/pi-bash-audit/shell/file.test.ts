import { describe, expect, it } from "vitest";

import { validateFile } from "./file";

describe("validateFile", () => {
  describe("positionals", () => {
    it.each([["path/to/file"], ["a", "b", "c"], ["-", "path"], ["--", "-weirdname"]])("allows %j", (...args) => {
      expect(validateFile(args)).toBe(true);
    });
  });

  describe("short flags", () => {
    it.each([
      ["-b", "file"],
      ["-h", "file"],
      ["-i", "file"],
      ["-L", "file"],
      ["-bkL", "file"], // 合并
    ])("allows %j", (...args) => {
      expect(validateFile(args)).toBe(true);
    });

    it.each([["-X"], ["-bX"]])("rejects %j", (...args) => {
      expect(validateFile(args)).toBe(false);
    });
  });

  describe("short values", () => {
    it.each([["-F", ","], ["-F,"], ["-e", "soft", "file"], ["-m", "/etc/magic"]])("allows %j", (...args) => {
      expect(validateFile(args)).toBe(true);
    });

    it.each([["-F"], ["-e"]])("rejects %j", (...args) => {
      expect(validateFile(args)).toBe(false);
    });
  });

  describe("long flags", () => {
    it.each([
      ["--brief", "file"],
      ["--mime", "file"],
      ["--mime-type", "file"],
      ["--dereference"],
      ["--help"],
      ["--version"],
    ])("allows %j", (...args) => {
      expect(validateFile(args)).toBe(true);
    });

    it.each([["--brief=yes"], ["--unknown"]])("rejects %j", (...args) => {
      expect(validateFile(args)).toBe(false);
    });
  });

  describe("long values", () => {
    it.each([
      ["--magic-file", "/etc/magic", "file"],
      ["--magic-file=/etc/magic"],
      ["--separator", ":"],
      ["--files-from", "list.txt"],
    ])("allows %j", (...args) => {
      expect(validateFile(args)).toBe(true);
    });

    it.each([["--magic-file"], ["--unknown", "value"]])("rejects %j", (...args) => {
      expect(validateFile(args)).toBe(false);
    });
  });
});
