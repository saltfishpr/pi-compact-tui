import type {
  DoubleQuotedChild,
  Redirect,
  TestExpression,
  Word,
  WordPart,
} from "unbash";

export function redirectsAreReadOnly(redirects: readonly Redirect[]): boolean {
  return redirects.every((redirect) => {
    if (!redirect.target || redirect.variableName) return false;

    switch (redirect.operator) {
      case "<":
      case "<<<":
        return isStaticWord(redirect.target);
      case "<<":
      case "<<-":
        return (
          isStaticWord(redirect.target) &&
          (redirect.heredocQuoted === true ||
            (redirect.content !== undefined &&
              (!redirect.body || isStaticHeredoc(redirect.body))))
        );
      default:
        return false;
    }
  });
}

export function isStaticWord(word: Word): boolean {
  return wordPartsAreStatic(word.parts) && !hasUnquotedExpansion(word.text);
}

export function isStaticCasePattern(word: Word): boolean {
  return wordPartsAreStatic(word.parts, true) && !hasUnquotedTilde(word.text);
}

export function isStaticTestExpression(expression: TestExpression): boolean {
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

function isStaticHeredoc(word: Word): boolean {
  return wordPartsAreStatic(word.parts);
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
