import { describe, expect, it } from "vitest";

import { isReadOnlyCommand } from "./index";

describe("isReadOnlyCommand", () => {
  describe("read-only commands", () => {
    it.each([
      ["cat", ["file"]],
      ["echo", ["-n", "hello"]],
      ["ls", ["-la", "/tmp"]],
      ["pwd", []],
      ["whoami", []],
      ["grep", ["--any-arg"]], // 读只命令不校验参数
    ])("allows %s %j", (command, args) => {
      expect(isReadOnlyCommand(command, args)).toBe(true);
    });
  });

  describe("dispatches to validators", () => {
    it("delegates to validateGit for git", () => {
      expect(isReadOnlyCommand("git", ["status"])).toBe(true);
      expect(isReadOnlyCommand("git", ["push"])).toBe(false);
    });

    it("delegates to validateFd for fd", () => {
      expect(isReadOnlyCommand("fd", ["--hidden", "pattern"])).toBe(true);
      expect(isReadOnlyCommand("fd", ["--unknown"])).toBe(false);
    });

    it("delegates to validateGo for go", () => {
      expect(isReadOnlyCommand("go", ["version"])).toBe(true);
      expect(isReadOnlyCommand("go", ["build"])).toBe(false);
    });
  });

  describe("unknown commands", () => {
    it.each([
      ["rm", ["-rf", "/"]],
      ["curl", ["https://example.com"]],
      ["ssh", ["host"]],
    ])("rejects %s %j", (command, args) => {
      expect(isReadOnlyCommand(command, args)).toBe(false);
    });
  });
});
