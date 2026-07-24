import { setOf } from "./options";

const ZERO_ARGUMENT_TOKENS = setOf(
  "!",
  "(",
  ")",
  ",",
  "-a",
  "-and",
  "-daystart",
  "-depth",
  "-empty",
  "-executable",
  "-false",
  "-follow",
  "-ignore_readdir_race",
  "-ls",
  "-mount",
  "-noignore_readdir_race",
  "-noleaf",
  "-nogroup",
  "-nouser",
  "-not",
  "-o",
  "-or",
  "-print",
  "-print0",
  "-prune",
  "-quit",
  "-readable",
  "-true",
  "-warn",
  "-nowarn",
  "-writable",
  "-xdev",
);

const ONE_ARGUMENT_TOKENS = setOf(
  "-amin",
  "-anewer",
  "-atime",
  "-cmin",
  "-cnewer",
  "-ctime",
  "-fstype",
  "-gid",
  "-group",
  "-ilname",
  "-iname",
  "-inum",
  "-ipath",
  "-iregex",
  "-links",
  "-lname",
  "-maxdepth",
  "-mindepth",
  "-mmin",
  "-mtime",
  "-name",
  "-newer",
  "-path",
  "-perm",
  "-printf",
  "-regex",
  "-regextype",
  "-samefile",
  "-size",
  "-type",
  "-uid",
  "-used",
  "-user",
  "-wholename",
  "-xtype",
);

export function validateFind(args: readonly string[]): boolean {
  let expressionStarted = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!expressionStarted && !arg.startsWith("-") && arg !== "!" && arg !== "(") continue;
    expressionStarted = true;

    if (ZERO_ARGUMENT_TOKENS.has(arg) || /^-[HLP]$/.test(arg) || /^-O[0-9]+$/.test(arg)) continue;
    if (ONE_ARGUMENT_TOKENS.has(arg) || arg === "-D") {
      if (++index >= args.length) return false;
      continue;
    }
    return false;
  }
  return true;
}
