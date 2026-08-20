import type { ReadOnlyRule } from "./config";
import type { ReadOnlyPolicy } from "./shell";

type ArgumentPattern =
  | { kind: "any" }
  | { kind: "literal"; value: string }
  | { kind: "matcher"; matches: (argument: string) => boolean };

type CompiledRule = {
  command: string;
  args: readonly ArgumentPattern[];
  except: readonly (readonly ArgumentPattern[])[];
};

/**
 * createRulePolicy compiles configured read-only rules into a command policy.
 * Invalid regular expressions throw immediately so a malformed configuration never widens the allowlist.
 */
export function createRulePolicy(rules: readonly ReadOnlyRule[]): ReadOnlyPolicy {
  const compiledRules = rules.map(compileRule);

  return {
    isReadOnlyCommand(command, args) {
      return compiledRules.some(
        (rule) =>
          rule.command === command &&
          matches(rule.args, args) &&
          !rule.except.some((exception) => matches(exception, args)),
      );
    },
  };
}

function compileRule(rule: ReadOnlyRule, ruleIndex: number): CompiledRule {
  return {
    command: rule.command,
    args: compilePatterns(rule.args, `readOnlyRules[${ruleIndex}].args`),
    except: rule.except.map((exception, exceptionIndex) =>
      compilePatterns(exception.args, `readOnlyRules[${ruleIndex}].except[${exceptionIndex}].args`),
    ),
  };
}

function compilePatterns(patterns: readonly string[], location: string): readonly ArgumentPattern[] {
  const compiled = patterns.map((pattern, index) => compilePattern(pattern, `${location}[${index}]`));
  return compiled.every((pattern) => pattern.kind === "literal") ? [...compiled, { kind: "any" }] : compiled;
}

function compilePattern(pattern: string, location: string): ArgumentPattern {
  if (pattern === "**") return { kind: "any" };
  if (isRegexPattern(pattern)) return compileRegex(pattern, location);
  if (pattern.includes("*")) return compileGlob(pattern);
  return { kind: "literal", value: pattern };
}

function isRegexPattern(pattern: string): boolean {
  return pattern.startsWith("/") && pattern.endsWith("/") && pattern.length >= 2;
}

function compileRegex(pattern: string, location: string): ArgumentPattern {
  try {
    const matcher = new RegExp(`^(?:${pattern.slice(1, -1)})$`);
    return { kind: "matcher", matches: (argument) => matcher.test(argument) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid regular expression at ${location}: ${pattern} (${message})`);
  }
}

function compileGlob(pattern: string): ArgumentPattern {
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"))
    .join(".*");
  const matcher = new RegExp(`^${source}$`);
  return { kind: "matcher", matches: (argument) => matcher.test(argument) };
}

function matches(patterns: readonly ArgumentPattern[], args: readonly string[]): boolean {
  const visited = new Set<string>();

  function match(patternIndex: number, argumentIndex: number): boolean {
    const state = `${patternIndex}:${argumentIndex}`;
    if (visited.has(state)) return false;
    visited.add(state);

    if (patternIndex === patterns.length) return argumentIndex === args.length;

    const pattern = patterns[patternIndex];
    if (pattern.kind === "any") {
      return (
        match(patternIndex + 1, argumentIndex) ||
        (argumentIndex < args.length && match(patternIndex, argumentIndex + 1))
      );
    }

    return (
      argumentIndex < args.length &&
      matchesArgument(pattern, args[argumentIndex]) &&
      match(patternIndex + 1, argumentIndex + 1)
    );
  }

  return match(0, 0);
}

function matchesArgument(pattern: Exclude<ArgumentPattern, { kind: "any" }>, argument: string): boolean {
  return pattern.kind === "literal" ? pattern.value === argument : pattern.matches(argument);
}
