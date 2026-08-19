import { describe, expect, it } from "vitest";

import { createRulePolicy } from "./rules";

describe("createRulePolicy", () => {
  it("rejects commands not covered by a rule", () => {
    const policy = createRulePolicy([]);

    expect(policy.validateCommand("git", ["status"])).toBe(false);
  });

  describe("literal patterns", () => {
    const policy = createRulePolicy([
      { command: "git", args: ["status"], except: [] },
    ]);

    it("matches the configured command and literal argument prefix", () => {
      expect(policy.validateCommand("git", ["status"])).toBe(true);
      expect(policy.validateCommand("git", ["status", "--short"])).toBe(true);
    });

    it("rejects a different command or literal prefix", () => {
      expect(policy.validateCommand("hg", ["status"])).toBe(false);
      expect(policy.validateCommand("git", [])).toBe(false);
      expect(policy.validateCommand("git", ["log"])).toBe(false);
    });
  });

  describe("wildcard patterns", () => {
    it("matches globs against one argument", () => {
      const policy = createRulePolicy([
        { command: "npm", args: ["run", "build-*"], except: [] },
      ]);

      expect(policy.validateCommand("npm", ["run", "build-web"])).toBe(true);
      expect(policy.validateCommand("npm", ["run", "build"])).toBe(false);
      expect(policy.validateCommand("npm", ["run", "build-web", "--watch"])).toBe(false);
    });

    it("lets ** absorb zero or more arguments", () => {
      const policy = createRulePolicy([
        { command: "git", args: ["--no-pager", "**", "log"], except: [] },
      ]);

      expect(policy.validateCommand("git", ["--no-pager", "log"])).toBe(true);
      expect(policy.validateCommand("git", ["--no-pager", "-c", "color.ui=never", "log"])).toBe(true);
      expect(policy.validateCommand("git", ["--no-pager", "log", "--oneline"])).toBe(false);
    });
  });

  describe("regular expression patterns", () => {
    it("matches the complete argument", () => {
      const policy = createRulePolicy([
        { command: "uv", args: ["/sync|check/"], except: [] },
      ]);

      expect(policy.validateCommand("uv", ["sync"])).toBe(true);
      expect(policy.validateCommand("uv", ["check"])).toBe(true);
      expect(policy.validateCommand("uv", ["sync-all"])).toBe(false);
    });

    it("reports the configuration location for invalid regular expressions", () => {
      expect(() =>
        createRulePolicy([{ command: "uv", args: ["/[a-/"], except: [] }]),
      ).toThrow("Invalid regular expression at readOnlyRules[0].args[0]");
    });
  });

  describe("exceptions", () => {
    it("rejects an allowed rule when an exception matches", () => {
      const policy = createRulePolicy([
        {
          command: "pnpm",
          args: ["run", "**"],
          except: [{ args: ["run", "deploy"] }],
        },
      ]);

      expect(policy.validateCommand("pnpm", ["run", "test"])).toBe(true);
      expect(policy.validateCommand("pnpm", ["run", "deploy"])).toBe(false);
      expect(policy.validateCommand("pnpm", ["run", "deploy", "--prod"])).toBe(false);
    });
  });
});
