import type { Command, Node, Script } from "unbash";
import { parse } from "unbash";

import { validateCommand } from "./commands";
import { isStaticCasePattern, isStaticTestExpression, isStaticWord, redirectsAreReadOnly } from "./syntax";

// false means "not proven read-only"; callers must send it through LLM review.
export function isReadOnly(source: string): boolean {
  if (!source.trim()) return false;

  try {
    const script = parse(source);
    return !script.errors?.length && script.commands.length > 0 && isReadOnlyScript(script);
  } catch {
    return false;
  }
}

function isReadOnlyScript(script: Script): boolean {
  return script.commands.every(isReadOnlyNode);
}

function isReadOnlyNode(node: Node): boolean {
  switch (node.type) {
    case "Statement":
      return !node.background && redirectsAreReadOnly(node.redirects) && isReadOnlyNode(node.command);
    case "Command":
      return isReadOnlySimpleCommand(node);
    case "Pipeline":
    case "AndOr":
      return node.commands.length > 0 && node.commands.every(isReadOnlyNode);
    case "If":
      return isReadOnlyNode(node.clause) && isReadOnlyNode(node.then) && (!node.else || isReadOnlyNode(node.else));
    case "Subshell":
    case "BraceGroup":
      return isReadOnlyNode(node.body);
    case "CompoundList":
      return node.commands.every(isReadOnlyNode);
    case "Case":
      return (
        isStaticWord(node.word) &&
        node.items.every((item) => item.pattern.every(isStaticCasePattern) && isReadOnlyNode(item.body))
      );
    case "TestCommand":
      return isStaticTestExpression(node.expression);
    case "For":
    case "ArithmeticFor":
    case "Select":
    case "While":
    case "Function":
    case "Coproc":
    case "ArithmeticCommand":
      return false;
  }
}

function isReadOnlySimpleCommand(node: Command): boolean {
  if (node.prefix.length > 0 || !node.name || !isStaticWord(node.name)) return false;
  if (!node.suffix.every(isStaticWord) || !redirectsAreReadOnly(node.redirects)) return false;

  return validateCommand(
    node.name.value,
    node.suffix.map((word) => word.value),
  );
}
