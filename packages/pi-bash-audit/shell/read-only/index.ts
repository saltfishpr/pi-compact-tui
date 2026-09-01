import { validateDate } from "./date";
import { validateEnv } from "./env";
import { validateFd } from "./fd";
import { validateFile } from "./file";
import { validateFind } from "./find";
import { validateGit } from "./git";
import { validateGo } from "./go";
import { validateHostname } from "./hostname";
import { validateRg } from "./rg";
import { validateTree } from "./tree";

const READ_ONLY_COMMANDS = new Set([
  "cat",
  "cd",
  "df",
  "du",
  "echo",
  "grep",
  "head",
  "ls",
  "printenv",
  "printf",
  "ps",
  "pwd",
  "stat",
  "tail",
  "top",
  "type",
  "uptime",
  "wc",
  "whereis",
  "which",
  "whoami",
]);

function isAlwaysReadOnlyCommand(command: string): boolean {
  return READ_ONLY_COMMANDS.has(command);
}

type ReadOnlyArgumentValidator = (args: readonly string[]) => boolean;

const READ_ONLY_COMMAND_VALIDATORS: Record<string, ReadOnlyArgumentValidator> = {
  date: validateDate,
  env: validateEnv,
  fd: validateFd,
  file: validateFile,
  find: validateFind,
  git: validateGit,
  go: validateGo,
  hostname: validateHostname,
  rg: validateRg,
  tree: validateTree,
};

export function isReadOnlyCommand(command: string, args: readonly string[]): boolean {
  if (isAlwaysReadOnlyCommand(command)) return true;
  return READ_ONLY_COMMAND_VALIDATORS[command]?.(args) ?? false;
}
