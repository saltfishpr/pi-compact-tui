import { describe, expect, it } from "vitest";

import { validateCommand } from "./commands";

describe("validateCommand", () => {
  describe("read-only commands", () => {
    it.each([
      ["cat", ["file"]],
      ["echo", ["-n", "hello"]],
      ["ls", ["-la", "/tmp"]],
      ["pwd", []],
      ["whoami", []],
      ["grep", ["--any-arg"]], // 读只命令不校验参数
    ])("allows %s %j", (command, args) => {
      expect(validateCommand(command, args)).toBe(true);
    });
  });

  describe("dispatches to validators", () => {
    it("delegates to validateGit for git", () => {
      expect(validateCommand("git", ["status"])).toBe(true);
      expect(validateCommand("git", ["push"])).toBe(false);
    });

    it("delegates to validateFd for fd", () => {
      expect(validateCommand("fd", ["--hidden", "pattern"])).toBe(true);
      expect(validateCommand("fd", ["--unknown"])).toBe(false);
    });

    it("delegates to validateGo for go", () => {
      expect(validateCommand("go", ["version"])).toBe(true);
      expect(validateCommand("go", ["build"])).toBe(false);
    });
  });

  describe("unknown commands", () => {
    it.each([
      ["rm", ["-rf", "/"]],
      ["curl", ["https://example.com"]],
      ["ssh", ["host"]],
    ])("rejects %s %j", (command, args) => {
      expect(validateCommand(command, args)).toBe(false);
    });
  });
});
