import { type OptionPolicy, setOf, validateOptions } from "./options";

const OPTIONS: OptionPolicy = {
  shortFlags: setOf(
    "A",
    "C",
    "D",
    "F",
    "J",
    "N",
    "Q",
    "R",
    "S",
    "U",
    "a",
    "d",
    "f",
    "g",
    "h",
    "i",
    "l",
    "n",
    "p",
    "q",
    "s",
    "u",
    "x",
  ),
  shortValues: setOf("H", "I", "L", "P", "T"),
  longFlags: setOf(
    "dirsfirst",
    "du",
    "fromfile",
    "gitignore",
    "help",
    "inodes",
    "metafirst",
    "noreport",
    "prune",
    "si",
    "version",
    "xml",
  ),
  longValues: setOf("charset", "filelimit", "sort", "timefmt"),
  allowPositionals: true,
};

export function validateTree(args: readonly string[]): boolean {
  return validateOptions(args, OPTIONS);
}
