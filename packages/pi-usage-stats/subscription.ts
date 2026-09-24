import type { Theme } from "@earendil-works/pi-coding-agent";

export interface SubscriptionWindow {
  windowSeconds: number;
  usedPercent?: number;
  resetAtMs?: number;
}

export interface SubscriptionUsage {
  unlimited?: boolean;
  windows: SubscriptionWindow[];
}

export interface SubscriptionFormatOptions {
  showResetTime?: boolean;
  now: number;
}

export function formatSubscriptionStatus(
  theme: Theme,
  usage: SubscriptionUsage,
  options: SubscriptionFormatOptions,
): string {
  if (usage.unlimited === true || usage.windows.every((window) => window.usedPercent === undefined)) {
    return theme.fg("success", "unlimited");
  }

  return usage.windows
    .map((window) => {
      const remainingPercent = window.usedPercent === undefined ? "?" : (100 - window.usedPercent).toFixed(0);
      const quota = `${formatWindow(window.windowSeconds)} ${remainingPercent}% left`;
      const coloredQuota = colorQuota(theme, quota, window.usedPercent);
      if (options.showResetTime === false || window.resetAtMs === undefined) return coloredQuota;
      return `${coloredQuota} ${theme.fg("dim", `🔄${formatRelativeTime(window.resetAtMs, options.now)}`)}`;
    })
    .join(theme.fg("dim", " • "));
}

function colorQuota(theme: Theme, text: string, usedPercent: number | undefined): string {
  if (usedPercent !== undefined && usedPercent > 90) return theme.fg("error", text);
  if (usedPercent !== undefined && usedPercent > 70) return theme.fg("warning", text);
  return theme.fg("success", text);
}

function formatWindow(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
  return `${Math.round(seconds / 60)}m`;
}

function formatRelativeTime(resetAt: number, now: number): string {
  const remainingMs = resetAt - now;
  if (remainingMs <= 0) return "now";

  const totalMinutes = Math.floor(remainingMs / 60_000);
  if (totalMinutes === 0) return "<1m";

  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return hours > 0 ? `${days}d${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}
