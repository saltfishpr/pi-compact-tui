import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createLogger } from "../pi-common";
import { loadInstructions, type InstructionMatch, type ModelIdentity } from "./config";

const SECTION_NAME = "pi_model_instructions";

function report(ctx: ExtensionContext, message: string, level: "info" | "warning"): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, level);
  } else {
    const logger = createLogger("pi-model-instructions");
    if (level === "warning") logger.warn(message);
    else logger.info(message);
  }
}

export default function (pi: ExtensionAPI) {
  let lastDiagnostic: string | undefined;
  let lastInjection: { model: ModelIdentity; match: InstructionMatch } | undefined;

  pi.on("session_start", () => {
    lastDiagnostic = undefined;
    lastInjection = undefined;
  });

  pi.on("before_agent_start", (event, ctx) => {
    delete event.systemPromptOptions.sections[SECTION_NAME];
    const instructions = loadInstructions(ctx.model);
    if (instructions.error && instructions.error !== lastDiagnostic) {
      report(ctx, instructions.error, "warning");
    }
    lastDiagnostic = instructions.error;

    const { model, match, content } = instructions;
    if (!model || !match || content === undefined) return;

    const section = [
      `Model: ${JSON.stringify(`${model.provider}/${model.id}`)}`,
      `Instruction file: ${JSON.stringify(match.file)}`,
      "",
      content,
    ].join("\n");
    const forcedPrompt = event.systemPromptOptions.forceSystemPrompt;
    event.systemPromptOptions.sections[SECTION_NAME] = section;
    lastInjection = { model, match };

    // A previous whole-prompt override bypasses sections when Pi builds the provider request.
    if (forcedPrompt !== undefined) {
      return { systemPrompt: `${forcedPrompt}\n\n<${SECTION_NAME}>\n${section}\n</${SECTION_NAME}>` };
    }
  });

  pi.registerCommand("model-instructions", {
    description: "Preview model-specific instructions and show the last injection",
    handler: async (_args, ctx) => {
      const instructions = loadInstructions(ctx.model);
      const { model, match, content, error } = instructions;
      const lines = [
        `Model: ${model ? `${model.provider}/${model.id}` : "none selected"}`,
        `Configuration: ${instructions.configPath}`,
      ];
      if (match) {
        lines.push(`Next run rule: ${match.rule}`, `Instruction file: ${match.file}`);
      }
      if (error) lines.push(`Next run: no additional instructions. ${error}`);
      else if (!model) lines.push("Next run: no model selected.");
      else if (!match) lines.push("Next run: no matching rule.");
      else if (content === undefined) lines.push("Next run: file is empty; no additional instructions.");
      else lines.push("Next run: instruction file loaded successfully.");

      lines.push(
        lastInjection
          ? `Last injection by this extension: ${lastInjection.model.provider}/${lastInjection.model.id}, rule ${lastInjection.match.rule}, file ${lastInjection.match.file}`
          : "Last injection by this extension: none in this session.",
        "Preview only; later extensions may change the final prompt.",
      );
      report(ctx, lines.join("\n"), error ? "warning" : "info");
    },
  });
}
