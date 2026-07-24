import { isExactOption, setOf, validateOptions } from "./options";

export function validateGit(args: readonly string[]): boolean {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "status":
      return validateOptions(rest, {
        shortFlags: setOf("b", "s", "u", "v"),
        longFlags: setOf(
          "ahead-behind",
          "branch",
          "column",
          "long",
          "no-ahead-behind",
          "no-column",
          "no-renames",
          "porcelain",
          "renames",
          "short",
          "show-stash",
          "untracked-files",
          "verbose",
        ),
        longValues: setOf("find-renames", "ignore-submodules"),
        allowPositionals: true,
      });
    case "diff":
    case "log":
    case "show":
      return validateHistory(rest);
    case "branch":
      return validateBranch(rest);
    case "remote":
      return validateRemote(rest);
    case "config":
      return validateConfig(rest);
    default:
      return false;
  }
}

function validateHistory(args: readonly string[]): boolean {
  if (args.some((arg) => /^-\d+$/.test(arg))) {
    args = args.filter((arg) => !/^-\d+$/.test(arg));
  }

  return validateOptions(args, {
    shortFlags: setOf("b", "m", "p", "s", "t", "w", "z"),
    shortValues: setOf("L", "S", "U", "n"),
    longFlags: setOf(
      "all",
      "binary",
      "cached",
      "check",
      "color",
      "decorate",
      "exit-code",
      "full-diff",
      "full-history",
      "graph",
      "ignore-all-space",
      "ignore-blank-lines",
      "ignore-space-at-eol",
      "ignore-space-change",
      "name-only",
      "name-status",
      "no-color",
      "no-decorate",
      "no-renames",
      "no-walk",
      "oneline",
      "patch",
      "quiet",
      "raw",
      "relative",
      "shortstat",
      "stat",
      "staged",
      "summary",
      "word-diff",
    ),
    longValues: setOf(
      "abbrev",
      "after",
      "author",
      "before",
      "color-moved",
      "diff-filter",
      "find-copies",
      "find-renames",
      "format",
      "grep",
      "max-count",
      "max-depth",
      "pretty",
      "since",
      "stat",
      "until",
      "unified",
      "word-diff",
    ),
    allowPositionals: true,
  });
}

function validateBranch(args: readonly string[]): boolean {
  if (args.length === 0) return true;
  if (args.every((arg) => /^-v+$/.test(arg) || arg === "--verbose")) return true;

  const hasQueryMode = args.some(
    (arg) =>
      arg === "-a" ||
      arg === "-r" ||
      arg === "--all" ||
      arg === "--list" ||
      arg === "--remotes" ||
      arg === "--show-current" ||
      arg.startsWith("--contains") ||
      arg.startsWith("--no-contains") ||
      arg.startsWith("--merged") ||
      arg.startsWith("--no-merged") ||
      /^-[arv]*[ar][arv]*$/.test(arg),
  );
  if (!hasQueryMode) return false;

  return validateOptions(args, {
    shortFlags: setOf("a", "r", "v"),
    longFlags: setOf("all", "column", "list", "no-column", "remotes", "show-current", "verbose"),
    longValues: setOf("contains", "format", "merged", "no-contains", "no-merged", "sort"),
    allowPositionals: true,
  });
}

function validateRemote(args: readonly string[]): boolean {
  if (args.length === 0 || isExactOption(args, "-v", "--verbose")) return true;

  const [subcommand, ...rest] = args;
  if (subcommand === "get-url") {
    return validateOptions(rest, {
      longFlags: setOf("all", "push"),
      allowPositionals: true,
    });
  }
  if (subcommand === "show") {
    return validateOptions(rest, {
      shortFlags: setOf("n"),
      allowPositionals: true,
    });
  }
  return false;
}

function validateConfig(args: readonly string[]): boolean {
  const [action, ...rest] = args;
  switch (action) {
    case "--get":
    case "--get-all":
    case "--get-regexp":
      return rest.length === 1 || rest.length === 2;
    case "--get-urlmatch":
      return rest.length === 2;
    case "--list":
    case "-l":
      return rest.length === 0;
    default:
      return false;
  }
}
