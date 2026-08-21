import { describe, expect, it } from "vitest";

import type { Rule } from "./config";
import type { CommandPolicy } from "./shell";
import { createRulePolicy } from "./rules";

const fallback: CommandPolicy = {
  evaluate: () => "auto",
};

function evaluate(rules: readonly Rule[], command: string, args: readonly string[]): string {
  return createRulePolicy(rules, fallback).evaluate(command, args);
}

describe("createRulePolicy", () => {
  it("matches commands and literal argument prefixes", () => {
    const rules: Rule[] = [{ command: "git", args: ["status"], except: [], action: "allow" }];

    expect(evaluate(rules, "git", ["status"])).toBe("allow");
    expect(evaluate(rules, "git", ["status", "--short"])).toBe("allow");
    expect(evaluate(rules, "git", ["log"])).toBe("auto");
    expect(evaluate(rules, "rg", ["status"])).toBe("auto");
  });

  it("matches glob, regular expression, and ** patterns", () => {
    const rules: Rule[] = [
      { command: "cat", args: ["*.md"], except: [], action: "allow" },
      { command: "git", args: ["/show|diff/", "**", "--stat"], except: [], action: "prompt" },
    ];

    expect(evaluate(rules, "cat", ["README.md"])).toBe("allow");
    expect(evaluate(rules, "cat", ["README.mdx"])).toBe("auto");
    expect(evaluate(rules, "git", ["show", "HEAD", "--stat"])).toBe("prompt");
    expect(evaluate(rules, "git", ["diff", "--stat"])).toBe("prompt");
    expect(evaluate(rules, "git", ["log", "--stat"])).toBe("auto");
  });

  it("uses the fallback when no rule applies or an exception matches", () => {
    const fallbackPolicy: CommandPolicy = {
      evaluate: (command, args) => (command === "git" && args[0] === "push" ? "prompt" : "auto"),
    };
    const policy = createRulePolicy(
      [
        {
          command: "git",
          args: ["push", "**"],
          except: [{ args: ["push", "origin", "main"] }],
          action: "allow",
        },
      ],
      fallbackPolicy,
    );

    expect(policy.evaluate("git", ["push", "origin", "feature"])).toBe("allow");
    expect(policy.evaluate("git", ["push", "origin", "main"])).toBe("prompt");
    expect(policy.evaluate("git", ["status"])).toBe("auto");
  });

  it("uses the first matching rule", () => {
    const rules: Rule[] = [
      { command: "git", args: ["**"], except: [], action: "prompt" },
      { command: "git", args: ["status"], except: [], action: "allow" },
    ];

    expect(evaluate(rules, "git", ["status"])).toBe("prompt");
  });

  it.each([
    [
      [{ command: "git", args: ["/[/"], except: [], action: "allow" }],
      "rules[0].args[0]",
    ],
    [
      [{ command: "git", args: [], except: [{ args: ["/(/" ] }], action: "allow" }],
      "rules[0].except[0].args[0]",
    ],
  ] satisfies [Rule[], string][])('rejects invalid regular expressions at %s', (rules, location) => {
    expect(() => createRulePolicy(rules, fallback)).toThrow(`Invalid regular expression at ${location}`);
  });
});
