import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BASE_URL = "https://ark.cn-beijing.volces.com/api/coding/v3";

const ZERO_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

const OPENAI_COMPAT = {
  // Ark Coding Plan exposes an OpenAI-compatible Chat Completions endpoint.
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  maxTokensField: "max_tokens" as const,
  // Avoid requiring stream_options.include_usage from every routed model.
  supportsUsageInStreaming: false,
};

type InputType = "text" | "image";

interface ArkModelOptions {
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  input?: InputType[];
}

function arkModel(id: string, options: ArkModelOptions = {}) {
  return {
    id,
    name: options.name ?? id,

    // Keep this disabled deliberately: models behind ark-code-latest can change,
    // and different upstream models use different reasoning control parameters.
    // The models can still perform their native/default reasoning; Pi simply does
    // not inject reasoning_effort or another provider-specific switch.
    reasoning: false,

    input: options.input ?? (["text"] as InputType[]),
    cost: ZERO_COST,
    contextWindow: options.contextWindow ?? 256_000,
    maxTokens: options.maxTokens ?? 4_096,
    compat: OPENAI_COMPAT,
  };
}

export default function (pi: ExtensionAPI): void {
  pi.registerProvider("ark-coding-plan", {
    name: "Volcengine Ark Coding Plan",
    baseUrl: BASE_URL,
    api: "openai-completions",
    apiKey: "$ARK_API_KEY",
    authHeader: true,
    models: [
      // The actual model is selected in the Ark console. Auto mode is supported
      // through this alias, but not by using "Auto" as a model ID.
      arkModel("ark-code-latest"),

      arkModel("doubao-seed-2.0-code", {
        input: ["text", "image"],
      }),
      arkModel("doubao-seed-2.0-pro", {
        input: ["text", "image"],
      }),
      arkModel("doubao-seed-2.0-lite", {
        input: ["text", "image"],
      }),
      arkModel("doubao-seed-code", {
        input: ["text", "image"],
      }),

      arkModel("minimax-m2.7", {
        contextWindow: 200_000,
      }),
      arkModel("minimax-m3", {
        contextWindow: 200_000,
      }),

      // Ark documents a 1M context window for GLM 5.2 and DeepSeek V4.
      arkModel("glm-5.2", {
        contextWindow: 1_048_576,
      }),
      arkModel("glm-latest", {
        name: "GLM Latest (GLM 5.2)",
        contextWindow: 1_048_576,
      }),
      arkModel("deepseek-v4-flash", {
        contextWindow: 1_048_576,
      }),
      arkModel("deepseek-v4-pro", {
        contextWindow: 1_048_576,
      }),

      arkModel("kimi-k2.6"),
      arkModel("kimi-k2.7-code"),
    ],
  });
}
