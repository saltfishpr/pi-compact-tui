import type { Command, DoubleQuotedChild, Node, Redirect, Script, TestExpression, Word, WordPart } from "unbash";
import { parse } from "unbash";

import { validateCommand } from "./commands";

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

// 只允许输入类重定向（<、<<<、<<、<<-）且目标必须是静态字面量，
// 避免通过 >、>>、&> 等写入文件，或通过变量/展开引入不可预测的路径。
function redirectsAreReadOnly(redirects: readonly Redirect[]): boolean {
  return redirects.every((redirect) => {
    if (!redirect.target || redirect.variableName) return false;

    switch (redirect.operator) {
      case "<":
      case "<<<":
        return isStaticWord(redirect.target);
      case "<<":
      case "<<-":
        return isStaticWord(redirect.target) && isStaticHeredoc(redirect);
      default:
        return false;
    }
  });
}

function isStaticWord(word: Word): boolean {
  return wordPartsAreStatic(word.parts) && !hasUnquotedExpansion(word.text);
}

// heredoc 分隔符加引号（如 <<'EOF'）时正文按字面量处理，不做展开；
// 否则正文可能包含参数/命令展开，只有当解析出的 body 全部是静态片段时才认为安全。
function isStaticHeredoc(redirect: Redirect): boolean {
  if (redirect.heredocQuoted === true) return true;
  if (redirect.content === undefined) return false;
  return !redirect.body || wordPartsAreStatic(redirect.body.parts);
}

function isStaticCasePattern(word: Word): boolean {
  return wordPartsAreStatic(word.parts, true) && !hasUnquotedTilde(word.text);
}

function isStaticTestExpression(expression: TestExpression): boolean {
  switch (expression.type) {
    case "TestUnary":
      return isStaticWord(expression.operand);
    case "TestBinary":
      return isStaticWord(expression.left) && isStaticWord(expression.right);
    case "TestLogical":
      return isStaticTestExpression(expression.left) && isStaticTestExpression(expression.right);
    case "TestNot":
      return isStaticTestExpression(expression.operand);
    case "TestGroup":
      return isStaticTestExpression(expression.expression);
  }
}

function wordPartsAreStatic(parts: WordPart[] | undefined, allowPattern = false): boolean {
  if (!parts) return true;

  return parts.every((part) => {
    switch (part.type) {
      case "Literal":
      case "SingleQuoted":
      case "AnsiCQuoted":
        return true;
      case "DoubleQuoted":
        return doubleQuotedPartsAreStatic(part.parts);
      case "ExtendedGlob":
        return allowPattern && isStaticPatternText(part.pattern);
      case "LocaleString":
      case "SimpleExpansion":
      case "ParameterExpansion":
      case "CommandExpansion":
      case "ArithmeticExpansion":
      case "ProcessSubstitution":
      case "BraceExpansion":
        return false;
    }
  });
}

function doubleQuotedPartsAreStatic(parts: DoubleQuotedChild[]): boolean {
  return parts.every((part) => part.type === "Literal");
}

function hasUnquotedExpansion(text: string): boolean {
  return hasUnquotedTilde(text) || !isStaticShellText(text, "word");
}

function hasUnquotedTilde(text: string): boolean {
  return text.startsWith("~");
}

function isStaticPatternText(text: string): boolean {
  return isStaticShellText(text, "pattern");
}

// unbash 解析器已经把展开节点识别出来，但字面量文本里仍可能夹带未被拆分的
// 元字符（如反斜杠转义、双引号内的 `$`、ANSI-C 引用 `$'...'` 中的表达式），
// 这里在原始文本层面再扫一遍，确保没有会引入动态行为的构造。
//
// - "word"：判断普通单词。除展开外，`*`、`?`、`[` 等 glob 通配符也视为非静态。
// - "pattern"：判断 case/glob 模式。此时通配符是合法字面量，只需拒绝
//   参数/命令展开、花括号展开、进程替换以及首字符的 `~`（家目录展开）。
function isStaticShellText(text: string, mode: "word" | "pattern"): boolean {
  let quote: "single" | "double" | "ansi" | undefined;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quote === "single") {
      if (char === "'") quote = undefined;
      continue;
    }
    if (quote) {
      if (char === "\\") {
        index++;
      } else if ((quote === "double" && char === '"') || (quote === "ansi" && char === "'")) {
        quote = undefined;
      } else if (mode === "pattern" && quote === "double" && (char === "$" || char === "`")) {
        return false;
      }
      continue;
    }
    if (char === "\\") {
      index++;
      continue;
    }
    if (char === "$" && text[index + 1] === "'") {
      quote = "ansi";
      index++;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char === "'" ? "single" : "double";
      continue;
    }
    if (mode === "word") {
      if (char === "*" || char === "?" || char === "[") return false;
    } else if (
      char === "$" ||
      char === "`" ||
      char === "{" ||
      (char === "~" && index === 0) ||
      ((char === "<" || char === ">") && text[index + 1] === "(")
    ) {
      return false;
    }
  }
  return true;
}
