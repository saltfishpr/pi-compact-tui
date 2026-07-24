import { type OptionPolicy, setOf, validateOptions } from "./options";

const OPTIONS: OptionPolicy = {
  shortFlags: setOf("0", "D", "I", "L", "N", "Z", "b", "c", "d", "h", "i", "k", "l", "n", "r", "s", "v", "z"),
  shortValues: setOf("F", "M", "P", "e", "f", "m"),
  longFlags: setOf(
    "brief",
    "checking-printout",
    "debug",
    "dereference",
    "extension",
    "help",
    "keep-going",
    "list",
    "mime",
    "mime-encoding",
    "mime-type",
    "no-buffer",
    "no-dereference",
    "no-pad",
    "print0",
    "raw",
    "special-files",
    "uncompress",
    "uncompress-noreport",
    "version",
  ),
  longValues: setOf("exclude", "exclude-quiet", "files-from", "magic-file", "parameter", "separator"),
  allowPositionals: true,
};

export function validateFile(args: readonly string[]): boolean {
  return validateOptions(args, OPTIONS);
}
