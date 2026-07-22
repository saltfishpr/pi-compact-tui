import { clampThinkingLevel, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { type ExtensionAPI, isToolCallEventType } from "@earendil-works/pi-coding-agent";

import { auditCommand, isReadOnlyCommand } from "./auditor";
import { loadConfig } from "./config";

export default function (pi: ExtensionAPI) {
  let resolvedModel: Model<any>;
  let thinkingLevel: ModelThinkingLevel = "off";

  pi.on("session_start", async (_event, ctx) => {
    const config = loadConfig();

    if (config.model) {
      const [provider, ...modelId] = config.model.split("/");
      const found = ctx.modelRegistry.find(provider, modelId.join("/"));
      if (!found) {
        ctx.ui.notify(`[bash-audit] model "${config.model}" not found, falling back to current model`, "warning");
        return;
      }
      resolvedModel = found;
    }
    if (config.thinkingLevel) {
      thinkingLevel = clampThinkingLevel(resolvedModel, config.thinkingLevel);
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;
    if (!resolvedModel) return;

    const command = event.input.command;
    if (!command || isReadOnlyCommand(command)) return;

    const result = await auditCommand({
      ctx,
      command,
      cwd: ctx.cwd,
      model: resolvedModel,
      thinkingLevel,
      signal: ctx.signal,
    });

    if (result.kind === "aborted") {
      return { block: true, reason: "bash-audit aborted by user" };
    }

    if (result.kind === "failed") {
      const proceed = await ctx.ui.confirm(
        "Bash audit failed",
        `Audit could not complete: ${result.reason}\n\nCommand:\n${command}\n\nExecute anyway?`,
      );
      return proceed ? undefined : { block: true, reason: `bash-audit failed: ${result.reason}` };
    }

    if (result.risk === "high") {
      const proceed = await ctx.ui.confirm(
        "High-risk bash command",
        `Reason: ${result.reason}\n\nCommand:\n${command}\n\nAllow execution?`,
      );
      return proceed ? undefined : { block: true, reason: `bash-audit: high risk - ${result.reason}` };
    }

    const level = result.risk === "medium" ? "warning" : "info";
    ctx.ui.notify(`[bash-audit] ${result.risk}: ${result.reason}`, level);
  });
}
