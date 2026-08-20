import { type OptionPolicy, setOf, validateOptions } from "./options";

const OPTIONS: OptionPolicy = {
  shortFlags: setOf("0", "F", "H", "I", "L", "a", "g", "i", "l", "p", "q", "s", "u"),
  shortValues: setOf("E", "S", "c", "d", "e", "j", "o", "t"),
  longFlags: setOf(
    "absolute-path",
    "case-sensitive",
    "fixed-strings",
    "follow",
    "full-path",
    "glob",
    "help",
    "hidden",
    "ignore-case",
    "list-details",
    "no-ignore",
    "no-ignore-parent",
    "no-ignore-vcs",
    "one-file-system",
    "print0",
    "quiet",
    "show-errors",
    "strip-cwd-prefix",
    "unrestricted",
    "version",
  ),
  longValues: setOf(
    "base-directory",
    "changed-before",
    "changed-within",
    "color",
    "exclude",
    "extension",
    "format",
    "max-depth",
    "max-results",
    "min-depth",
    "owner",
    "search-path",
    "size",
    "threads",
    "type",
  ),
  allowPositionals: true,
};

export function validateFd(args: readonly string[]): boolean {
  return validateOptions(args, OPTIONS);
}
