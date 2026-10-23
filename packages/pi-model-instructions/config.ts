import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import * as z from "zod";

import { getGlobalConfigPath, loadJSONConfig } from "../pi-common";

const configSchema = z.strictObject({
  rules: z
    .array(
      z.strictObject({
        provider: z.string().refine((value) => value.trim().length > 0, "Provider must not be blank"),
        model: z.string().refine((value) => value.trim().length > 0, "Model must not be blank"),
        file: z.string().refine((value) => value.trim().length > 0, "File must not be blank"),
      }),
    )
    .default([]),
});

export interface ModelIdentity {
  provider: string;
  id: string;
}

export interface InstructionMatch {
  rule: number;
  file: string;
}

export interface ModelInstructions {
  configPath: string;
  model?: ModelIdentity;
  match?: InstructionMatch;
  content?: string;
  error?: string;
}

function matches(pattern: string, value: string): boolean {
  const expression = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  // Checking the full match also rejects the trailing newline accepted by the $ anchor.
  return new RegExp(`^${expression}$`, "s").exec(value)?.[0] === value;
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.cause === undefined ? error.message : `${error.message}: ${describeError(error.cause)}`;
}

/** Reload the configuration and selected instruction file for a run or a command preview. */
export function loadInstructions(model: ModelIdentity | undefined): ModelInstructions {
  const configPath = getGlobalConfigPath("model-instructions.json");
  const result: ModelInstructions = {
    configPath,
    model: model ? { provider: model.provider, id: model.id } : undefined,
  };

  try {
    const config = loadJSONConfig(configPath, configSchema);
    if (!model) return result;

    const ruleIndex = config.rules.findIndex(
      (rule) => matches(rule.provider, model.provider) && matches(rule.model, model.id),
    );
    if (ruleIndex === -1) return result;

    const rule = config.rules[ruleIndex];
    const file = rule.file.startsWith("~/")
      ? resolve(homedir(), rule.file.slice(2))
      : resolve(dirname(configPath), rule.file);
    result.match = { rule: ruleIndex + 1, file };

    if (!statSync(file).isFile()) throw new Error("Instruction path is not a regular file");
    const content = readFileSync(file, "utf8");
    if (content.trim()) result.content = content;
  } catch (error) {
    const selection = result.match ? `, rule ${result.match.rule}, file ${result.match.file}` : "";
    const modelName = model ? `${model.provider}/${model.id}` : "no model selected";
    result.error = `Model instructions for ${modelName} (${configPath}${selection}): ${describeError(error)}`;
  }

  return result;
}
