import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function clearAliasExtension(pi: ExtensionAPI) {
  pi.registerCommand("clear", {
    description: "Alias for /new: start a fresh session",
    handler: async (_args, ctx) => {
      await ctx.newSession();
    },
  });
}
