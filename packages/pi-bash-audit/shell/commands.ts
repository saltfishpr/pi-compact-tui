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

type ArgumentValidator = (args: readonly string[]) => boolean;

const VALIDATORS: Partial<Record<string, ArgumentValidator>> = {
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

export function validateCommand(command: string, args: readonly string[]): boolean {
  if (isAlwaysReadOnlyCommand(command)) return true;
  return VALIDATORS[command]?.(args) ?? false;
}
