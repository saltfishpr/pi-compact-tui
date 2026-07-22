import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface ResolveModelOptions {
  /** 用户显式配置的模型标识，格式为 "<provider>/<modelId>"。 */
  model?: string;
  /** 用户显式配置的推理档位。 */
  thinkingLevel?: ModelThinkingLevel;

  /** 未配置 model 时回退到该模型，通常为 ctx.model。 */
  fallbackModel?: Model<Api>;
  /** 未配置 thinkingLevel 时回退到该档位，默认为 "off"。 */
  fallbackThinkingLevel?: ModelThinkingLevel;
}

export interface ResolvedModel {
  model: Model<Api>;
  thinkingLevel: ModelThinkingLevel;
}

/**
 * 按 "优先使用配置，否则回退" 的规则解析模型与推理档位。
 *
 * - 若 `options.model` 指定但在 registry 中未找到，返回 `undefined`。
 * - 若未配置也未提供 `fallbackModel`，返回 `undefined`。
 * - 返回的 `thinkingLevel` 已根据模型能力 clamp 到合法范围。
 */
export function resolveModel(ctx: ExtensionContext, options: ResolveModelOptions): ResolvedModel | undefined {
  let model: Model<Api> | undefined;
  if (options.model) {
    const [provider, ...modelId] = options.model.split("/");
    model = ctx.modelRegistry.find(provider, modelId.join("/"));
  } else {
    model = options.fallbackModel;
  }
  if (!model) return undefined;

  const requestedLevel = options.thinkingLevel ?? options.fallbackThinkingLevel ?? "off";
  const thinkingLevel = clampThinkingLevel(model, requestedLevel);

  return { model, thinkingLevel };
}
