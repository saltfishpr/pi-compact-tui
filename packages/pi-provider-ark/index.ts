import { createProvider, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as z from "zod";

const PROVIDER_ID = "ark-coding-plan";
const PROVIDER_NAME = "Ark Coding Plan";
const BASE_URL = "https://ark.cn-beijing.volces.com/api/coding/v3";
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;

const ZERO_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

const OPENAI_COMPAT = {
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  supportsUsageInStreaming: false,
  maxTokensField: "max_tokens" as const,
};

const arkModelSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  status: z.string().optional(),
  features: z
    .object({
      tools: z.object({ function_calling: z.boolean().optional() }).optional(),
    })
    .optional(),
  modalities: z
    .object({
      input_modalities: z.array(z.string()).optional(),
      output_modalities: z.array(z.string()).optional(),
    })
    .optional(),
  token_limits: z
    .object({
      context_window: z.number().positive().optional(),
      max_output_token_length: z.number().positive().optional(),
    })
    .optional(),
});

const arkModelsResponseSchema = z.object({
  data: z.array(arkModelSchema),
});

type ArkModel = z.infer<typeof arkModelSchema>;

function isAvailableChatModel(model: ArkModel): boolean {
  const outputModalities = model.modalities?.output_modalities;
  return (
    model.status !== "Shutdown" &&
    model.features?.tools?.function_calling === true &&
    (!outputModalities || outputModalities.length === 0 || outputModalities.includes("text"))
  );
}

function toPiModel(model: ArkModel): Model<"openai-completions"> {
  const inputModalities = model.modalities?.input_modalities;
  const input: Model<"openai-completions">["input"] = inputModalities?.includes("image") ? ["text", "image"] : ["text"];

  return {
    id: model.id,
    name: model.name ?? model.id,
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl: BASE_URL,
    // Ark routes multiple model families with different reasoning controls.
    reasoning: false,
    input,
    cost: ZERO_COST,
    contextWindow: model.token_limits?.context_window ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: model.token_limits?.max_output_token_length ?? DEFAULT_MAX_TOKENS,
    compat: OPENAI_COMPAT,
  };
}

export default function registerArkProvider(pi: ExtensionAPI): void {
  pi.registerProvider(
    createProvider<"openai-completions">({
      id: PROVIDER_ID,
      name: PROVIDER_NAME,
      api: openAICompletionsApi(),
      baseUrl: BASE_URL,
      auth: {
        apiKey: {
          name: "Volcengine Ark API Key",
          async login(interaction) {
            return {
              type: "api_key",
              key: await interaction.prompt({ type: "secret", message: "Ark API Key" }),
            };
          },
          async resolve({ ctx, credential }) {
            const key = credential?.key ?? (await ctx.env("ARK_API_KEY"));
            if (!key) return undefined;
            return {
              auth: { apiKey: key },
              source: credential?.key ? "stored Ark API key" : "ARK_API_KEY",
            };
          },
        },
      },
      models: [],
      async fetchModels({ credential, signal }) {
        if (credential?.type !== "api_key" || !credential.key) {
          throw new Error("Ark API key is required to fetch models");
        }

        const response = await fetch(`${BASE_URL}/models`, {
          headers: { Authorization: `Bearer ${credential.key}` },
          signal,
        });
        if (!response.ok) {
          throw new Error(`Failed to fetch Ark models: HTTP ${response.status}`);
        }

        const payload = arkModelsResponseSchema.parse(await response.json());
        return payload.data.filter(isAvailableChatModel).map(toPiModel);
      },
    }),
  );
}
