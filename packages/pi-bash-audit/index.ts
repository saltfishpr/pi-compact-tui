import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { type ExtensionAPI, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";

import { createLogger, resolveModel } from "../pi-common";
import { auditCommand } from "./auditor";
import { loadConfig } from "./config";
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

  pi.on("session_start", async (_event, ctx) => {
    const config = loadConfig();

    const resolved = resolveModel(ctx, {
      model: config.model,
      thinkingLevel: config.thinkingLevel,
    });
    if (!resolved) {
      if (config.model) {
        ctx.ui.notify(`[bash-audit] model "${config.model}" not found, bash-audit disabled`, "warning");
      } else {
        ctx.ui.notify(`[bash-audit] no model configured, bash-audit disabled`, "warning");
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
