import { getSupportedThinkingLevels, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { ExtensionContext, isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";

import { createLogger, resolveModel, ScrollableSelectorComponent } from "../pi-common";
import { auditCommand, type AuditModel } from "./auditor";
import { loadConfig, saveConfig, type BashAuditConfig } from "./config";
import { createRulePolicy } from "./rules";
import { selectAuditModel, selectAuditThinkingLevel } from "./selector";
import { createScriptEvaluator, defaultPolicy } from "./shell";

const logger = createLogger("pi-bash-audit");

const ENTRY_TYPE = "pi-bash-audit";

type AuditEntryData = {
  risk: "low" | "medium";
  message: string;
};

export default function (pi: ExtensionAPI) {
  pi.registerEntryRenderer<AuditEntryData>(ENTRY_TYPE, (entry, _options, theme) => {
    const data = entry.data;
    if (!data) return new Container();

    const color = data.risk === "medium" ? "warning" : "dim";
    return new Text(theme.fg(color, `[bash-audit] ${data.message}`), 0, 0);
  });

  // Windows 没有 pi 的 bash 工具，避免注册不可用的审计命令和事件处理器。
  if (process.platform === "win32") return;

  let config = loadConfig();
  let resolvedModel: AuditModel | undefined;
  let thinkingLevel: ModelThinkingLevel = "off";
  let evaluateScript = createScriptEvaluator(defaultPolicy);

  function initializeAudit(auditConfig: BashAuditConfig, ctx: ExtensionContext): void {
    // reset state
    resolvedModel = undefined;
    thinkingLevel = "off";
    evaluateScript = createScriptEvaluator(defaultPolicy);

    if (!auditConfig.enable) return;

    try {
      evaluateScript = createScriptEvaluator(createRulePolicy(auditConfig.rules, defaultPolicy));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`[bash-audit] invalid rules: ${message}`, "error");
      return;
    }

    const resolved = resolveModel(ctx, {
      model: auditConfig.model,
      thinkingLevel: auditConfig.thinkingLevel,
    });
    if (resolved) {
      resolvedModel = resolved.model;
      thinkingLevel = resolved.thinkingLevel;
      return;
    }
    if (auditConfig.model) {
      const [provider, ...modelId] = auditConfig.model.split("/");
      resolvedModel = ctx.modelRegistry.findOfType("classifier", provider, modelId.join("/"));
    }
    if (!resolvedModel) {
      const message = auditConfig.model
        ? `model "${auditConfig.model}" not found, auto bash-audit disabled`
        : 'no model configured, run "/audit" to select one';
      ctx.ui.notify(`[bash-audit] ${message}`, "warning");
    }
  }

  pi.registerCommand("audit", {
    description: "Configure and enable bash command auditing",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        const message = "/audit is only available in TUI mode";
        if (ctx.hasUI) ctx.ui.notify(message, "warning");
        else console.error(message);
        return;
      }

      const classifiers = await ctx.modelRegistry.getAvailableOfType("classifier", undefined, { signal: ctx.signal });
      const models: AuditModel[] = [...ctx.modelRegistry.getAvailable(), ...classifiers];
      if (models.length === 0) {
        ctx.ui.notify("[bash-audit] no audit models available; configure provider authentication first", "warning");
        return;
      }
      const previousModel = models.find((model) => `${model.provider}/${model.id}` === config.model);
      const selectedModel = await selectAuditModel(ctx, models, previousModel);
      if (!selectedModel) return;

      const modelId = `${selectedModel.provider}/${selectedModel.id}`;
      let selectedLevel: ModelThinkingLevel = "off";
      if (selectedModel.type !== "classifier") {
        const availableLevels = getSupportedThinkingLevels(selectedModel);
        const configuredLevel = config.model === modelId ? (config.thinkingLevel ?? "off") : "off";
        const initialLevel = availableLevels.includes(configuredLevel) ? configuredLevel : "off";
        const level = await selectAuditThinkingLevel(ctx, initialLevel, availableLevels);
        if (!level) return;
        selectedLevel = level;
      }
      try {
        saveConfig({
          enable: true,
          model: modelId,
          thinkingLevel: selectedLevel,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`[bash-audit] failed to save configuration: ${message}`, "error");
        return;
      }

      config = loadConfig(); // reload config
      initializeAudit(config, ctx);
      const suffix = selectedModel.type === "classifier" ? "" : ` (${selectedLevel})`;
      ctx.ui.notify(`[bash-audit] enabled with ${modelId}${suffix}`, "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    config = loadConfig();
    initializeAudit(config, ctx);
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;

    const command = event.input.command;
    if (!command) return;

    const action = evaluateScript(command);
    logger.info("evaluate", { cwd: ctx.cwd, command, action, modelAvailable: Boolean(resolvedModel) });

    if (action === "allow") return;

    if (action === "prompt") {
      const proceed = await confirmWithScrollableMessage(
        ctx,
        "This command requires confirmation by rule.",
        `Command:\n${command}\n\nExecute anyway?`,
      );
      return proceed ? undefined : { block: true, reason: "bash-audit: confirmation declined" };
    }

    if (!resolvedModel) {
      const proceed = await confirmWithScrollableMessage(
        ctx,
        "No audit model is available.",
        `Command:\n${command}\n\nExecute anyway?`,
      );
      return proceed ? undefined : { block: true, reason: "bash-audit: confirmation declined" };
    }

    const result = await auditCommand({
      ctx,
      command,
      cwd: ctx.cwd,
      model: resolvedModel,
      thinkingLevel,
      timeoutMs: config.timeoutMs,
      signal: ctx.signal,
    });

    logger.info("audit", {
      cwd: ctx.cwd,
      command,
      kind: result.kind,
      risk: result.kind === "ok" ? result.risk : undefined,
      text: result.kind === "aborted" ? undefined : result.text,
      probability: result.kind === "ok" ? result.probability : undefined,
      reason: result.kind === "aborted" ? undefined : result.reason,
    });

    if (result.kind === "aborted") {
      return { block: true, reason: "bash-audit: aborted by user" };
    }

    if (result.kind === "failed") {
      const proceed = await confirmWithScrollableMessage(
        ctx,
        `Audit failed: ${result.reason}`,
        `Command:\n${command}\n\nExecute anyway?`,
      );
      return proceed ? undefined : { block: true, reason: "bash-audit: confirmation declined" };
    }

    let confirmationReason: string;
    if (result.risk === "high") {
      confirmationReason = `High-risk command: ${result.reason}`;
    } else if (result.probability !== undefined && result.probability < config.minProbability) {
      confirmationReason = `Uncertain audit (requires probability >= ${config.minProbability}): ${result.reason}`;
    } else {
      pi.appendEntry<AuditEntryData>(ENTRY_TYPE, {
        risk: result.risk,
        message: `${result.risk}: ${result.reason}`,
      });
      return;
    }

    const proceed = await confirmWithScrollableMessage(ctx, confirmationReason, `Command:\n${command}\n\nAllow execution?`);
    return proceed ? undefined : { block: true, reason: "bash-audit: confirmation declined" };
  });
}

/** confirmWithScrollableMessage displays a half-height, scrollable confirmation prompt in TUI mode. */
function confirmWithScrollableMessage(ctx: ExtensionContext, reason: string, message: string): Promise<boolean> {
  const title = "Bash command confirmation";
  const content = `${reason}\n\n${message}`;
  if (ctx.mode !== "tui") return ctx.ui.confirm(title, content);

  return ctx.ui.custom<boolean>((tui, theme, keybindings, done) => {
    return new ScrollableSelectorComponent(
      title,
      content,
      ["Yes", "No"],
      (selected) => done(selected === "Yes"),
      () => done(false),
      {
        maxMessageHeight: Math.max(10, Math.floor(tui.terminal.rows / 2)),
        maxVisibleOptions: 2,
        theme,
        keybindings,
      },
    );
  });
}
