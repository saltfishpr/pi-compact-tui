import { getSupportedThinkingLevels, Type, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface ProviderModels {
  id: string;
  name: string;
  models: { id: string; name: string; thinkingLevels: ModelThinkingLevel[] }[];
}

export function registerModelsTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "models",
    label: "Models",
    exposure: "model-only",
    description:
      "Search the chat models available to subagents. Returns model IDs and supported thinking levels for the `agent` tool.",
    promptSnippet: "Find available subagent models and supported thinking levels",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Text to search for in model names and IDs." })),
      provider: Type.Optional(Type.String({ description: "Provider ID or name to filter by." })),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 100,
          default: 20,
          description: "Maximum number of models to return. Defaults to 20.",
        }),
      ),
      offset: Type.Optional(
        Type.Integer({ minimum: 0, default: 0, description: "Number of models to skip for paging through results." }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const query = params.query?.trim().toLowerCase();
      const provider = params.provider?.trim().toLowerCase();
      const currentProvider = ctx.model?.provider;
      const matches = ctx.modelRegistry
        .getAvailable()
        .map((model) => ({
          model,
          id: `${model.provider}/${model.id}`,
          providerName: ctx.modelRegistry.getProviderDisplayName(model.provider),
        }))
        .filter(
          ({ model, id, providerName }) =>
            (!provider || model.provider.toLowerCase() === provider || providerName.toLowerCase() === provider) &&
            (!query || id.toLowerCase().includes(query) || model.name.toLowerCase().includes(query)),
        )
        .sort(
          (a, b) =>
            Number(b.model.provider === currentProvider) - Number(a.model.provider === currentProvider) ||
            a.model.provider.localeCompare(b.model.provider) ||
            a.id.localeCompare(b.id),
        );

      const offset = params.offset ?? 0;
      const end = offset + (params.limit ?? 20);
      const providers = new Map<string, ProviderModels>();
      for (const { model, id, providerName } of matches.slice(offset, end)) {
        let group = providers.get(model.provider);
        if (!group) {
          group = { id: model.provider, name: providerName, models: [] };
          providers.set(model.provider, group);
        }
        group.models.push({ id, name: model.name, thinkingLevels: getSupportedThinkingLevels(model) });
      }

      const details = {
        total: matches.length,
        next: end < matches.length ? end : null,
        providers: [...providers.values()],
      };
      return { content: [{ type: "text", text: JSON.stringify(details) }], details };
    },
  });
}
