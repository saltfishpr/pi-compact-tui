import { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type InheritedSessionSettings = {
  previousSessionFile: string | undefined;
  provider: string;
  modelId: string;
  thinkingLevel: NonNullable<ModelThinkingLevel>;
};

let inheritedSessionSettings: InheritedSessionSettings | undefined;

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "new" || !inheritedSessionSettings) return;

    const settings = inheritedSessionSettings;
    if (event.previousSessionFile !== settings.previousSessionFile) return;
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

      const settings: InheritedSessionSettings = {
        previousSessionFile: ctx.sessionManager.getSessionFile(),
        provider: ctx.model.provider,
        modelId: ctx.model.id,
        thinkingLevel: ctx.thinkingLevel,
      };
      inheritedSessionSettings = settings;
      try {
        await ctx.newSession();
      } finally {
        if (inheritedSessionSettings === settings) inheritedSessionSettings = undefined;
      }
    },
  });
}
