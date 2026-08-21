import {
  parse,
  type Case,
  type Command,
  type DoubleQuotedChild,
  type Node,
  type Redirect,
  type Script,
  type TestExpression,
  type Word,
  type WordPart,
} from "unbash";

import { isReadOnlyCommand } from "./read-only";

export type Action = "allow" | "prompt" | "auto";

export interface CommandPolicy {
  evaluate(command: string, args: readonly string[]): Action;
}

export const defaultPolicy: CommandPolicy = {
  evaluate(command, args) {
    return isReadOnlyCommand(command, args) ? "allow" : "auto";
  },
};

const actionPriority: Record<Action, number> = { allow: 0, auto: 1, prompt: 2 };

/** Returns the strictest action from a set of command evaluations. */
function combineActions(actions: readonly Action[]): Action {
  // prettier-ignore
  return actions.reduce((result, action) => (actionPriority[action] > actionPriority[result] ? action : result), "allow");
}

/** Downgrades an allowed action unless the surrounding syntax is safe for direct execution. */
function restrictAllow(action: Action, isSafeForAllow: boolean): Action {
  if (action !== "allow") return action;
  if (isSafeForAllow) return "allow";
  return "auto";
}

export function createScriptEvaluator(policy: CommandPolicy): (source: string) => Action {
  function evaluateScript(script: Script): Action {
    return combineActions(script.commands.map(evaluateNode));
  }

  function evaluateNode(node: Node): Action {
    switch (node.type) {
      case "Statement":
        // 后台执行与非只读重定向会使本来只读的命令产生不可控行为。
        return restrictAllow(evaluateNode(node.command), !node.background && areReadOnlyRedirects(node.redirects));
      case "Command":
        return evaluateSimpleCommand(node);
      case "Pipeline":
      case "AndOr":
        return node.commands.length > 0 ? combineActions(node.commands.map(evaluateNode)) : "auto";
      case "If":
        return combineActions([
          evaluateNode(node.clause),
          evaluateNode(node.then),
          ...(node.else ? [evaluateNode(node.else)] : []),
        ]);
      case "Subshell":
      case "BraceGroup":
        return evaluateNode(node.body);
      case "CompoundList":
        return combineActions(node.commands.map(evaluateNode));
      case "Case":
        return evaluateCase(node);
      case "TestCommand":
        return isStaticTestExpression(node.expression) ? "allow" : "auto";
      // 循环、函数、协程、算术命令会引入运行时行为，无法可靠匹配。
      case "For":
      case "ArithmeticFor":
      case "Select":
      case "While":
      case "Function":
      case "Coproc":
      case "ArithmeticCommand":
        return "auto";
    }
  }

  function evaluateSimpleCommand(node: Command): Action {
    if (node.prefix.length > 0 || !node.name || !isStaticWord(node.name) || !node.suffix.every(isStaticWord)) {
      return "auto";
    }

    const action = policy.evaluate(
      node.name.value,
      node.suffix.map((word) => word.value),
    );
    // 策略只判断命令和参数；重定向必须额外确认不会读取动态内容或写入文件。
    return restrictAllow(action, areReadOnlyRedirects(node.redirects));
  }

  function evaluateCase(node: Case): Action {
    if (!isStaticWord(node.word)) return "auto";
    return combineActions(
      node.items.map((item) => {
        // case 模式会在分支选择前展开；即使分支体只读，动态模式也可能产生副作用。
        return restrictAllow(evaluateNode(item.body), item.pattern.every(isStaticCasePattern));
      }),
    );
  }

  return (source: string): Action => {
    if (!source.trim()) return "auto";

    try {
      const script = parse(source);
      return !script.errors?.length && script.commands.length > 0 ? evaluateScript(script) : "auto";
    } catch {
      return "auto";
    }
  };
}

// 允许的重定向：
//   - 输入类：<、<<<、<<、<<-，目标必须是静态字面量；
//   - 丢弃输出：>、>>、&>、&>>，目标必须是字面量 /dev/null；
//   - fd 复制：>&、<&，目标必须是 fd 数字（如 2>&1、1>&2）。
// 其余情况一律拒绝，避免通过写入文件或不可预测的路径引入副作用。
function areReadOnlyRedirects(redirects: readonly Redirect[]): boolean {
  return redirects.every(isReadOnlyRedirect);
}

function isReadOnlyRedirect(redirect: Redirect): boolean {
  if (!redirect.target || redirect.variableName) return false;
  if (!isStaticWord(redirect.target)) return false;

  switch (redirect.operator) {
    case "<":
    case "<<<":
      return true;
    case "<<":
    case "<<-":
      return isStaticHeredoc(redirect);
    case ">":
    case ">>":
    case "&>":
    case "&>>":
      return redirect.target.value === "/dev/null";
    case ">&":
    case "<&":
      return /^\d+$/.test(redirect.target.value);
    default:
      return false;
  }
}

// heredoc 分隔符加引号（如 <<'EOF'）时正文按字面量处理，不做展开；
// 否则正文可能包含参数/命令展开，只有当解析出的 body 全部是静态片段时才认为安全。
function isStaticHeredoc(redirect: Redirect): boolean {
  if (redirect.heredocQuoted === true) return true;
  if (redirect.content === undefined) return false;
  return !redirect.body || areStaticWordParts(redirect.body.parts);
}

function isStaticWord(word: Word): boolean {
  return areStaticWordParts(word.parts) && !hasUnquotedTilde(word.text) && isStaticShellText(word.text, "word");
}

function isStaticCasePattern(word: Word): boolean {
  return areStaticWordParts(word.parts, true) && !hasUnquotedTilde(word.text);
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

function areStaticWordParts(parts: WordPart[] | undefined, allowPattern = false): boolean {
  if (!parts) return true;
  return parts.every((part) => isStaticWordPart(part, allowPattern));
}

function isStaticWordPart(part: WordPart, allowPattern: boolean): boolean {
  switch (part.type) {
    case "Literal":
    case "SingleQuoted":
    case "AnsiCQuoted":
      return true;
    case "DoubleQuoted":
      return areStaticDoubleQuotedParts(part.parts);
    case "ExtendedGlob":
      return allowPattern && isStaticShellText(part.pattern, "pattern");
    // 以下节点类型都表示某种展开（变量、命令、算术、进程替换、花括号），
    // 结果依赖运行时上下文，一律拒绝。
    case "LocaleString":
    case "SimpleExpansion":
    case "ParameterExpansion":
    case "CommandExpansion":
    case "ArithmeticExpansion":
    case "ProcessSubstitution":
    case "BraceExpansion":
      return false;
  }
}

function areStaticDoubleQuotedParts(parts: DoubleQuotedChild[]): boolean {
  return parts.every((part) => part.type === "Literal");
}

// 允许 `~` 单独出现或以 `~/` 开头（都展开为当前用户 $HOME，可预测）；
// `~+`、`~-`、`~user`、`~user/...` 依赖 shell/系统状态，视为动态展开。
function hasUnquotedTilde(text: string): boolean {
  if (!text.startsWith("~")) return false;
  return text !== "~" && !text.startsWith("~/");
}

type ShellTextMode = "word" | "pattern";
type QuoteState = "single" | "double" | "ansi" | undefined;

// unbash 解析器已经把展开节点识别出来，但字面量文本里仍可能夹带未被拆分的
// 元字符（如反斜杠转义、双引号内的 `$`、ANSI-C 引用 `$'...'` 中的表达式），
// 这里在原始文本层面再扫一遍，确保没有会引入动态行为的构造。
//
// - "word"：判断普通单词。除展开外，`*`、`?`、`[` 等 glob 通配符也视为非静态。
// - "pattern"：判断 case/glob 模式。此时通配符是合法字面量，只需拒绝
//   参数/命令展开、花括号展开、进程替换以及首字符的 `~`（家目录展开）。
function isStaticShellText(text: string, mode: ShellTextMode): boolean {
  let quote: QuoteState = undefined;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];

    if (quote === "single") {
      if (char === "'") quote = undefined;
      continue;
    }

    if (quote) {
      if (char === "\\") {
        index++;
        continue;
      }
      if ((quote === "double" && char === '"') || (quote === "ansi" && char === "'")) {
        quote = undefined;
        continue;
      }
      // 双引号中仅在模式匹配语境下再校验一次 `$` / `` ` ``；
      // 普通词的双引号内容已在 AST 层判定过。
      if (mode === "pattern" && quote === "double" && (char === "$" || char === "`")) {
        return false;
      }
      continue;
    }

    if (char === "\\") {
      index++;
      continue;
    }

    // `$'...'` 是 ANSI-C 引用，开启 ansi 引用态而非动态展开。
    if (char === "$" && text[index + 1] === "'") {
      quote = "ansi";
      index++;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char === "'" ? "single" : "double";
      continue;
    }

    if (isDynamicUnquotedChar(text, index, mode)) return false;
  }

  return true;
}

function isDynamicUnquotedChar(text: string, index: number, mode: ShellTextMode): boolean {
  const char = text[index];

  if (mode === "word") {
    return char === "*" || char === "?" || char === "[";
  }

  if (char === "$" || char === "`" || char === "{") return true;
  if (char === "~" && index === 0) return true;
  if ((char === "<" || char === ">") && text[index + 1] === "(") return true;
  return false;
}
