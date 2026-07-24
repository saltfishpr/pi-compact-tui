import { setOf } from "./options";

export function validateGo(args: readonly string[]): boolean {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "version":
      return validateFlags(rest, VERSION_FLAGS, EMPTY, true);
    case "doc":
      return validateFlags(rest, DOC_FLAGS, EMPTY, true);
    case "env":
      return validateFlags(rest, ENV_FLAGS, EMPTY, true);
    case "list":
      return validateFlags(rest, LIST_FLAGS, LIST_VALUES, true);
    case "mod":
      return validateMod(rest);
    default:
      return false;
  }
}

function validateMod(args: readonly string[]): boolean {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "graph":
      return validateFlags(rest, setOf("x"), setOf("go"), false);
    case "why":
      return validateFlags(rest, setOf("m", "vendor"), EMPTY, true);
    case "verify":
      return rest.length === 0;
    default:
      return false;
  }
}

const EMPTY: ReadonlySet<string> = setOf();

const DOC_FLAGS = setOf("all", "c", "cmd", "short", "src", "u");
const ENV_FLAGS = setOf("changed", "json");
const VERSION_FLAGS = setOf("m", "v", "json");
const LIST_FLAGS = setOf("compiled", "deps", "e", "export", "find", "json", "m", "retracted", "test", "u", "versions");
const LIST_VALUES = setOf("f", "pgo");

/**
 * 校验 Go 风格的命令行选项。Go 只用单破折号（`-flag` 或 `-flag=value`），
 * 因此不能复用 options.ts 的短/长选项模型。
 */
function validateFlags(
  args: readonly string[],
  flags: ReadonlySet<string>,
  values: ReadonlySet<string>,
  allowPositionals: boolean,
): boolean {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") return allowPositionals;
    if (!arg.startsWith("-") || arg === "-") {
      if (!allowPositionals) return false;
      continue;
    }

    // 去掉一个或两个前缀破折号，Go 官方推荐单破折号，但也接受 `--flag`
    const stripped = arg.startsWith("--") ? arg.slice(2) : arg.slice(1);
    const equals = stripped.indexOf("=");
    const name = equals === -1 ? stripped : stripped.slice(0, equals);

    if (flags.has(name) && equals === -1) continue;
    if (!values.has(name)) return false;
    // `-name value` 形式：吞掉下一个 token 作为值
    if (equals === -1 && ++index >= args.length) return false;
  }
  return true;
}
