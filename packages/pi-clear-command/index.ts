import { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

let inheritedSessionSettings:
  | { provider: string; modelId: string; thinkingLevel: NonNullable<ModelThinkingLevel> }
  | undefined;

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "new" || !inheritedSessionSettings) return;

    const settings = inheritedSessionSettings;
    inheritedSessionSettings = undefined;

    const model = ctx.modelRegistry.find(settings.provider, settings.modelId);
    if (model && (await pi.setModel(model))) {
      pi.setThinkingLevel(settings.thinkingLevel);
    }
  });

  pi.registerCommand("clear", {
    description: "Start a fresh session with the current model and thinking level",
    handler: async (_args, ctx) => {
      if (!ctx.model || !ctx.thinkingLevel) {
        await ctx.newSession();
        return;
      }

      inheritedSessionSettings = {
        provider: ctx.model.provider,
        modelId: ctx.model.id,
        thinkingLevel: ctx.thinkingLevel,
      };
      const result = await ctx.newSession();
      if (result.cancelled) inheritedSessionSettings = undefined;
    },
  });
}
