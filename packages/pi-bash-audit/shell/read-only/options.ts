export interface OptionPolicy {
  // 不带值的短选项，例如 `-a`，允许合并成 `-abc`
  shortFlags?: ReadonlySet<string>;
  // 需要一个值的短选项，例如 `-o file`，值可紧跟在同一 token 或下一个 token
  shortValues?: ReadonlySet<string>;
  // 不带值的长选项，例如 `--verbose`
  longFlags?: ReadonlySet<string>;
  // 需要一个值的长选项，例如 `--file=x` 或 `--file x`
  longValues?: ReadonlySet<string>;
  // 是否允许非选项的位置参数（含 `-` 与 `--` 之后的所有 token）
  allowPositionals?: boolean;
}

/**
 * 按 policy 校验 argv 是否全部合法。用于 bash-audit 判断命令行是否只使用了白名单选项。
 * 遇到未知选项、缺失取值、或在不允许位置参数时出现位置参数，都会返回 false。
 */
export function validateOptions(args: readonly string[], policy: OptionPolicy): boolean {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    // `--` 之后的 token 全部视为位置参数，交给 allowPositionals 判定
    if (arg === "--") return Boolean(policy.allowPositionals);
    // `-` 常见于表示 stdin，与其他位置参数一起处理
    if (!arg.startsWith("-") || arg === "-") {
      if (!policy.allowPositionals) return false;
      continue;
    }

    if (arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      const name = arg.slice(2, equals === -1 ? undefined : equals);
      // 无值长选项必须不带 `=`，否则说明使用者塞进了不该有的取值
      if (policy.longFlags?.has(name) && equals === -1) continue;
      if (!policy.longValues?.has(name)) return false;
      // `--name value` 形式：吞掉下一个 token 作为值
      if (equals === -1 && ++index >= args.length) return false;
      continue;
    }

    // 短选项支持合并写法 `-abc`：逐字符扫描，遇到需要取值的短选项则停止合并
    const flags = arg.slice(1);
    for (let flagIndex = 0; flagIndex < flags.length; flagIndex++) {
      const flag = flags[flagIndex];
      if (policy.shortFlags?.has(flag)) continue;
      if (!policy.shortValues?.has(flag)) return false;
      // 取值可以紧跟在同一 token（`-oFILE`）或作为下一个 token（`-o FILE`）
      if (flagIndex === flags.length - 1 && ++index >= args.length) return false;
      break;
    }
  }
  return true;
}

/**
 * 判断 argv 是否恰好等于列出的某个单一选项，用于处理 `--help` / `--version` 之类的独占开关。
 */
export function isExactOption(args: readonly string[], ...options: string[]): boolean {
  return args.length === 1 && options.includes(args[0]);
}

export function setOf(...values: string[]): ReadonlySet<string> {
  return new Set(values);
}
