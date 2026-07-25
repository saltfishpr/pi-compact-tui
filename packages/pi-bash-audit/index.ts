import { getSupportedThinkingLevels, type Api, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";

import { createLogger, resolveModel } from "../pi-common";
import { auditCommand } from "./auditor";
import { loadConfig, saveConfig, type BashAuditConfig } from "./config";
import { selectAuditModel, selectAuditThinkingLevel } from "./selector";
import { isReadOnly } from "./shell";

const logger = createLogger("pi-bash-audit");

const ENTRY_TYPE = "pi-bash-audit";

type AuditEntryData = {
  risk: "low" | "medium";
  message: string;
};

export default function (pi: ExtensionAPI) {
  let resolvedModel: Model<Api> | undefined;
  let thinkingLevel: ModelThinkingLevel = "off";

  pi.registerEntryRenderer<AuditEntryData>(ENTRY_TYPE, (entry, _options, theme) => {
    const data = entry.data;
    if (!data) return new Container();

    const color = data.risk === "medium" ? "warning" : "dim";
    return new Text(theme.fg(color, `[bash-audit] ${data.message}`), 0, 0);
  });

  pi.registerCommand("audit", {
    description: "Configure and enable bash command auditing",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        const message = "/audit is only available in TUI mode";
        if (ctx.hasUI) ctx.ui.notify(message, "warning");
        else console.error(message);
        return;
      }

      const models = ctx.modelRegistry.getAvailable();
      if (models.length === 0) {
        ctx.ui.notify("[bash-audit] no available models", "warning");
        return;
      }

      let previousConfig: BashAuditConfig | undefined;
      try {
        previousConfig = loadConfig();
      } catch {
        // A complete selection will replace malformed configuration.
      }

      const previousModel = previousConfig?.model
        ? models.find((model) => `${model.provider}/${model.id}` === previousConfig?.model)
        : undefined;
      const selectedModel = await selectAuditModel(ctx, models, previousModel);
      if (!selectedModel) return;

      const modelId = `${selectedModel.provider}/${selectedModel.id}`;
      const availableLevels = getSupportedThinkingLevels(selectedModel);
      const configuredLevel = previousConfig?.model === modelId ? (previousConfig.thinkingLevel ?? "off") : "off";
      const initialLevel = availableLevels.includes(configuredLevel) ? configuredLevel : "off";
      const selectedLevel = await selectAuditThinkingLevel(ctx, initialLevel, availableLevels);
      if (!selectedLevel) return;

      const config = {
        enable: true,
        model: modelId,
        thinkingLevel: selectedLevel,
      } satisfies BashAuditConfig;
      try {
        saveConfig(config);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`[bash-audit] failed to save configuration: ${message}`, "error");
        return;
      }

      resolvedModel = selectedModel;
      thinkingLevel = selectedLevel;
      ctx.ui.notify(`[bash-audit] enabled with ${modelId} (${selectedLevel})`, "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const config = loadConfig();
    if (!config.enable) return;

    const resolved = resolveModel(ctx, {
      model: config.model,
      thinkingLevel: config.thinkingLevel,
    });
    if (!resolved) {
      if (config.model) {
        ctx.ui.notify(`[bash-audit] model "${config.model}" not found, bash-audit disabled`, "warning");
      } else {
        ctx.ui.notify(`[bash-audit] no model configured, run "/audit" to select one`);
      }
      return;
    }
    resolvedModel = resolved.model;
    thinkingLevel = resolved.thinkingLevel;
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;
    if (!resolvedModel) return;

    const command = event.input.command;
    if (!command || isReadOnly(command)) return;

    const result = await auditCommand({
      ctx,
      command,
      cwd: ctx.cwd,
      model: resolvedModel,
      thinkingLevel,
      signal: ctx.signal,
    });

    logger.info("audit", {
      cwd: ctx.cwd,
      command,
      kind: result.kind,
      risk: result.kind === "ok" ? result.risk : undefined,
      text: result.kind === "aborted" ? undefined : result.text,
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

    pi.appendEntry<AuditEntryData>(ENTRY_TYPE, {
      risk: result.risk,
      message: `${result.risk}: ${result.reason}`,
    });
  });
}
