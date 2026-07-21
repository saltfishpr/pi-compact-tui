import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { OptionalModelConfig } from "./config";

const DEFAULT_THINKING_LEVEL: ModelThinkingLevel = "off";

type RecapModelSettings = {
  model: Model<Api>;
  thinkingLevel: ModelThinkingLevel;
  warning: string | undefined;
};

type ModelSelection = {
  model: Model<Api>;
  warning: string | undefined;
};

type ThinkingLevelSelection = {
  thinkingLevel: ModelThinkingLevel;
  warning: string | undefined;
};

/**
 * 解析用于 recap 的模型设置。
 *
 * 根据传入的 {@link OptionalModelConfig} 选择目标模型与思考等级：
 * - 若未配置 `model`，则使用当前上下文中的模型。
 * - 若模型不存在或鉴权失败，则回退到当前模型并返回相应的 `warning`。
 * - 思考等级会根据所选模型支持范围进行裁剪，不支持时回退到默认等级并附带 `warning`。
 *
 * 当上下文中没有任何可用模型时，会通过 `ctx.ui.notify` 发出告警并返回 `undefined`。
 *
 * @param pi     扩展 API，用于获取当前思考等级等运行时信息。
 * @param ctx    扩展上下文，提供模型注册表、当前模型及 UI 能力。
 * @param config 用户配置的 recap 模型选项（model 形如 `provider/model`，thinkingLevel 均可选）。
 * @returns      解析后的模型、思考等级与可选的 `warning`；无可用模型时返回 `undefined`。
 */
export async function resolveRecapModelSettings(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  config: OptionalModelConfig,
): Promise<RecapModelSettings | undefined> {
  const fallbackModel = ctx.model;
  if (!fallbackModel) {
    ctx.ui.notify("No model selected for recap", "warning");
    return;
  }

  const { model, warning: modelWarning } = await resolveModelSelection(ctx, config, fallbackModel);
  const { thinkingLevel, warning: thinkingLevelWarning } = resolveThinkingLevel(
    model,
    config.thinkingLevel ?? pi.getThinkingLevel(),
  );

  return {
    model,
    thinkingLevel,
    warning: [modelWarning, thinkingLevelWarning].filter(Boolean).join(" ") || undefined,
  };
}

async function resolveModelSelection(
  ctx: ExtensionContext,
  config: OptionalModelConfig,
  fallbackModel: Model<Api>,
): Promise<ModelSelection> {
  if (!config.model) {
    return {
      model: fallbackModel,
      warning: undefined,
    };
  }

  const [provider, ...rest] = config.model.split("/");
  const modelId = rest.join("/");
  if (!provider || !modelId) {
    return {
      model: fallbackModel,
      warning: `recap.model must be in "provider/model" format; using the current model.`,
    };
  }

  const model = ctx.modelRegistry.find(provider, modelId);
  if (!model) {
    return {
      model: fallbackModel,
      warning: `Model ${formatModel(config.model)} not found; using the current model.`,
    };
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    return {
      model: fallbackModel,
      warning: `Model ${formatModel(config.model)} unavailable: ${auth.error}; using the current model.`,
    };
  }

  return {
    model,
    warning: undefined,
  };
}

function resolveThinkingLevel(model: Model<Api>, requested: ModelThinkingLevel): ThinkingLevelSelection {
  const thinkingLevel = clampThinkingLevel(model, requested);
  if (thinkingLevel === requested) {
    return {
      thinkingLevel,
      warning: undefined,
    };
  }

  const fallback = clampThinkingLevel(model, DEFAULT_THINKING_LEVEL);
  return {
    thinkingLevel: fallback,
    warning: `Thinking level ${requested} is not supported by ${formatModel(`${model.provider}/${model.id}`)}; using ${fallback}.`,
  };
}

function formatModel(model?: string, thinkingLevel?: string): string {
  return model ? `${model}${thinkingLevel ? `:${thinkingLevel}` : ""}` : "no-model";
}
