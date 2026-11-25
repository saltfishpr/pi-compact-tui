import { DynamicBorder, getSettingsListTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Text, type SettingItem, type TuiMouseEvent } from "@earendil-works/pi-tui";

import { logger } from "../logger";
import type { ProfileTrust } from "../profile/trust";
import type { AgentProfile } from "../types";

export async function openProfileTrustDialog(
  ctx: ExtensionContext,
  profiles: AgentProfile[],
  profileTrust: ProfileTrust,
): Promise<void> {
  if (ctx.mode !== "tui") return;
  if (profiles.length === 0) {
    ctx.ui.notify("No subagent profiles available", "info");
    return;
  }

  const trusted = profileTrust.list();
  const selectedPaths = new Set(
    profiles
      .filter((profile) => trusted.some((entry) => entry.path === profile.path && entry.sha256 === profile.sha256))
      .map((profile) => profile.path),
  );

  const selection = await ctx.ui.custom<Set<string> | undefined>((_tui, theme, keybindings, done) => {
    const items: SettingItem[] = profiles.map((profile) => ({
      id: profile.path,
      label: `${JSON.stringify(profile.name)} [${profile.source}]`,
      currentValue: selectedPaths.has(profile.path) ? "trusted" : "untrusted",
      values: ["trusted", "untrusted"],
      description: `${JSON.stringify(profile.path)} · ${profile.commands.length} pre-run commands`,
    }));
    const settings = new SettingsList(
      items,
      Math.min(items.length, 8),
      getSettingsListTheme(),
      (path, value) => {
        if (value === "trusted") selectedPaths.add(path);
        else selectedPaths.delete(path);
      },
      () => done(undefined),
      { enableSearch: true },
    );

    const container = new Container();
    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    container.addChild(new Text(theme.fg("accent", theme.bold("Subagent Profile Trust")), 1, 0));
    container.addChild(
      new Text(
        theme.fg(
          "muted",
          "Selected profiles may run ! commands in any working directory. Review files before saving.",
        ),
        1,
        0,
      ),
    );
    container.addChild(settings);

    const hints = (
      [
        ["app.models.enableAll", "trust all"],
        ["app.models.clearAll", "clear all"],
        ["app.models.save", "save"],
      ] as const
    )
      .flatMap(([action, description]) => {
        const keys = keybindings
          .getKeys(action)
          .join("/")
          .replace(/(^|[+/])[a-z]/g, (part) => part.toUpperCase());
        return keys ? [`${keys} to ${description}`] : [];
      })
      .join(" · ");
    container.addChild(new Text(theme.fg("dim", hints), 1, 0));
    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));

    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleMouse: (event: TuiMouseEvent) => container.handleMouse(event),
      handleInput: (data: string) => {
        if (keybindings.matches(data, "app.models.save")) {
          done(new Set(selectedPaths));
        } else if (
          keybindings.matches(data, "app.models.enableAll") ||
          keybindings.matches(data, "app.models.clearAll")
        ) {
          const enable = keybindings.matches(data, "app.models.enableAll");
          for (const profile of profiles) {
            if (enable) selectedPaths.add(profile.path);
            else selectedPaths.delete(profile.path);
            settings.updateValue(profile.path, enable ? "trusted" : "untrusted");
          }
        } else {
          settings.handleInput(data);
        }
      },
    };
  });

  if (!selection) return;

  try {
    await profileTrust.saveSelection(profiles, selection);
    ctx.ui.notify(`Saved trust for ${selection.size} of ${profiles.length} subagent profiles`, "info");
  } catch (error) {
    logger.error("Failed to save subagent profile trust", { error });
    ctx.ui.notify(`Failed to save subagent profile trust: ${String(error)}`, "error");
  }
}
