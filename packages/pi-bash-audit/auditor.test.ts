import { describe, expect, it } from "vitest";

import { isReadOnlyCommand } from "./auditor";

describe("isReadOnlyCommand", () => {
  describe("top-level allowed commands", () => {
    it.each([
      "ls",
      "ls -la",
      "pwd",
      "echo hello world",
      "cat file.txt",
      "grep pattern file",
      "rg foo",
      "find . -name '*.ts'",
      "ps aux",
      "df -h",
    ])("allows %s", (command) => {
      expect(isReadOnlyCommand(command)).toBe(true);
    });
  });

  describe("git subcommands", () => {
    it.each([
      "git status",
      "git diff HEAD",
      "git log --oneline",
      "git show HEAD",
      "git branch -a",
      "git remote -v",
      "git config --get user.email",
    ])("allows %s", (command) => {
      expect(isReadOnlyCommand(command)).toBe(true);
    });

    it("rejects git subcommands not on the list", () => {
      expect(isReadOnlyCommand("git push")).toBe(false);
      expect(isReadOnlyCommand("git commit -m x")).toBe(false);
      expect(isReadOnlyCommand("git checkout main")).toBe(false);
    });

    it("rejects git config without --get (three-token match)", () => {
      expect(isReadOnlyCommand("git config --unset user.email")).toBe(false);
      expect(isReadOnlyCommand("git config user.email foo")).toBe(false);
    });
  });

  describe("compound commands", () => {
    it.each([
      "ls && rm -rf /",
      "ls || echo fail",
      "ls; rm foo",
      "ls | grep foo",
      "echo `whoami`",
      "echo $(whoami)",
      "ls\nrm foo",
    ])("rejects compound: %s", (command) => {
      expect(isReadOnlyCommand(command)).toBe(false);
    });
  });

  describe("unknown commands", () => {
    it.each(["rm foo", "sudo ls", "curl example.com", "chmod 777 file", ""])("rejects %s", (command) => {
      expect(isReadOnlyCommand(command)).toBe(false);
    });
  });

  describe("whitespace handling", () => {
    it("trims leading and trailing whitespace", () => {
      expect(isReadOnlyCommand("  ls -la  ")).toBe(true);
    });

    it("handles multiple internal spaces", () => {
      expect(isReadOnlyCommand("git    status")).toBe(true);
    });

    it("rejects whitespace-only input", () => {
      expect(isReadOnlyCommand("   ")).toBe(false);
    });
  });
});
